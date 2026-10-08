import { Router } from "express";
import {
  archiveSuggestion,
  claimSuggestionReward,
  claimWikiReward,
  completeSuggestionReward,
  completeWikiReward,
  confirmWikiRevision,
  countOpenPlayerReports,
  exportAccountsRows,
  exportGamesRows,
  exportLedgerRows,
  exportPaypalPurchaseRows,
  getSuggestion,
  getWikiRevision,
  listAdminAudit,
  listOpenWikiRevisions,
  listPlayerReports,
  listSuggestions,
  releaseSuggestionReward,
  releaseWikiReward,
  resolvePlayerReport,
  resolvePlayerReportsForUser,
  systemStats,
  undoWikiRevision,
  wikiRewardAmount,
} from "../db.js";
import { rateLimit, validateDisplayName } from "../auth.js";
import { requestClientIp } from "../hardening.js";
import { logger } from "../logger.js";
import { report as metricsReport, ensureMetrics, metricsEnabled } from "../metrics.js";
import { wikiLineDiff } from "../wiki-diff.js";
import { requireAdmin, requireStaff } from "./auth.js";
import { auditAdmin } from "./audit.js";
import { buildAnalytics, barRows } from "./analytics.js";
import { eventsToCsv, listAdminEvents, retainAdminEvents } from "./events.js";
import {
  enrichActiveList,
  historicalGame,
  listRecentGames,
  liveGameChat,
  queueSnapshot,
  terminateMatch,
} from "./matches.js";
import {
  accountsToCsv,
  configHealth,
  gamesToCsv,
  ledgerToCsv,
  paypalPurchasesToCsv,
  readNews,
  saveNews,
  setMaintenance,
} from "./ops.js";
import {
  adminAdjustTickets,
  adminBan,
  adminForceLogout,
  adminRename,
  adminSetRole,
  adminUnban,
  adminUpdateNotes,
  adminVerifyEmail,
  findPaypalPurchaseByOrderOrCapture,
  getUserDetail,
  searchAccounts,
} from "./users.js";
import { reconcileStalePaypalPurchases } from "../paypal.js";

function routeId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function takeNotice(req) {
  const notice = req.session && req.session.notice;
  if (req.session) req.session.notice = null;
  return notice || null;
}

function adminLimited(req) {
  const accountId = req.session && req.session.accountId;
  const key = accountId ? `admin:${accountId}` : `admin-ip:${requestClientIp(req)}`;
  const max = Number(process.env.RATE_ADMIN_MAX);
  const ok = rateLimit(key, {
    max: Number.isInteger(max) && max > 0 ? max : 60,
    windowMs: 60 * 1000,
  });
  if (!ok) {
    logger.warn({
      event: "admin_rate_limited",
      accountId: accountId || undefined,
      ip: requestClientIp(req),
      path: req.path,
    }, "admin rate limited");
  }
  return ok;
}

function confirmed(body) {
  return body && (body.confirm === "1" || body.confirm === "on" || body.confirm === true);
}

/** Only allow redirects back into /admin. */
function safeAdminNext(value, fallback = "/admin/reports") {
  const raw = String(value || "").trim();
  if (!raw.startsWith("/admin")) return fallback;
  if (raw.startsWith("//") || raw.includes("://")) return fallback;
  return raw.slice(0, 200) || fallback;
}

function reportsListQuery({ status = "open", reported = "" } = {}) {
  const params = new URLSearchParams();
  params.set("status", status || "open");
  if (reported) params.set("reported", String(reported));
  const q = params.toString();
  return q ? `/admin/reports?${q}` : "/admin/reports";
}

function parseDurationMs(body) {
  const unit = String(body.durationUnit || "").toLowerCase();
  const n = Number(body.durationValue);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (unit === "hours") return Math.round(n * 60 * 60 * 1000);
  if (unit === "days") return Math.round(n * 24 * 60 * 60 * 1000);
  if (unit === "permanent" || unit === "") return null;
  return null;
}

/**
 * @param {object} deps
 * @param {import('../matchmaking.js').Matchmaker} deps.matchmaker
 * @param {function} deps.pageViewer
 * @param {object} deps.formbarSocket
 * @param {function} deps.rewardFromPool
 * @param {function} [deps.issueVerifyEmail]
 * @param {function} [deps.ioStats]
 * @param {string} deps.ambiguousTransfer
 */
export function createAdminRouter(deps) {
  const router = Router();
  const {
    matchmaker,
    pageViewer,
    formbarSocket,
    rewardFromPool,
    issueVerifyEmail,
    ioStats,
    ambiguousTransfer,
  } = deps;

  async function baseLocals(req, extra = {}) {
    const viewer = await pageViewer(req);
    const { getStaffContext } = await import("./auth.js");
    const staff = await getStaffContext(req.session);
    const openReportCount = await countOpenPlayerReports();
    return {
      nav: "admin",
      viewer,
      notice: takeNotice(req),
      staffRole: staff.role,
      isAdmin: staff.role === "admin",
      isModerator: staff.role === "moderator" || staff.role === "admin",
      openReportCount,
      ...extra,
    };
  }

  // ----- Overview -----
  router.get("/", async (req, res, next) => {
    try {
      if (!(await requireStaff(req, res))) return;
      const stats = await systemStats();
      const games = enrichActiveList(matchmaker);
      const queues = queueSnapshot(matchmaker);
      const health = await configHealth();
      const data = await baseLocals(req, {
        admin: { games, stats: { ...stats, active: games.length }, queues, health },
        adminSection: "overview",
      });
      req.session.save(() => res.render("admin/index", data));
    } catch (err) {
      next(err);
    }
  });

  // ----- Audit -----
  router.get("/audit", async (req, res, next) => {
    try {
      if (!(await requireAdmin(req, res))) return;
      const page = Number(req.query.page) || 1;
      const audit = await listAdminAudit({ page, pageSize: 50 });
      const data = await baseLocals(req, { audit, adminSection: "audit" });
      req.session.save(() => res.render("admin/audit", data));
    } catch (err) {
      next(err);
    }
  });

  // ----- Users -----
  router.get("/users", async (req, res, next) => {
    try {
      if (!(await requireStaff(req, res))) return;
      const result = await searchAccounts({
        q: req.query.q,
        filter: req.query.filter,
        sort: req.query.sort,
        page: req.query.page,
      });
      const data = await baseLocals(req, {
        users: result,
        query: {
          q: req.query.q || "",
          filter: req.query.filter || "",
          sort: req.query.sort || "created_desc",
        },
        adminSection: "users",
      });
      req.session.save(() => res.render("admin/users", data));
    } catch (err) {
      next(err);
    }
  });

  router.get("/users/:id", async (req, res, next) => {
    try {
      if (!(await requireStaff(req, res))) return;
      const id = routeId(req.params.id);
      const detail = id ? await getUserDetail(id) : null;
      if (!detail) {
        req.session.notice = "Account not found.";
        req.session.save(() => res.redirect("/admin/users"));
        return;
      }
      const data = await baseLocals(req, {
        detail,
        adminSection: "users",
      });
      req.session.save(() => res.render("admin/user", data));
    } catch (err) {
      next(err);
    }
  });

  async function userMutation(req, res, next, handler) {
    try {
      if (!(await requireAdmin(req, res))) return;
      if (!adminLimited(req)) {
        req.session.notice = "Too many admin actions. Try again in a minute.";
        req.session.save(() => res.redirect(req.get("referer") || "/admin/users"));
        return;
      }
      const id = routeId(req.params.id);
      if (!id) {
        req.session.notice = "Account not found.";
        req.session.save(() => res.redirect("/admin/users"));
        return;
      }
      await handler(id);
    } catch (err) {
      next(err);
    }
  }

  router.post("/users/:id/role", (req, res, next) => userMutation(req, res, next, async (id) => {
    if (!confirmed(req.body)) {
      req.session.notice = "Confirmation required.";
      req.session.save(() => res.redirect(`/admin/users/${id}`));
      return;
    }
    const before = (await getUserDetail(id))?.account;
    const result = await adminSetRole(req.adminAccount.id, id, req.body.role, req.body.reason);
    if (!result.ok) {
      req.session.notice = result.error === "last_admin"
        ? "Cannot demote the last admin."
        : result.error === "self_target"
          ? "Cannot change your own role."
          : "Could not change role.";
      req.session.save(() => res.redirect(`/admin/users/${id}`));
      return;
    }
    await auditAdmin(req, {
      action: "role_change",
      targetType: "account",
      targetId: id,
      reason: req.body.reason,
      before: { role: result.before },
      after: { role: result.after },
    });
    req.session.notice = `Role set to ${result.after}.`;
    req.session.save(() => res.redirect(`/admin/users/${id}`));
  }));

  router.post("/users/:id/ban", (req, res, next) => userMutation(req, res, next, async (id) => {
    if (!confirmed(req.body)) {
      req.session.notice = "Confirmation required.";
      req.session.save(() => res.redirect(`/admin/users/${id}`));
      return;
    }
    const result = await adminBan(req.adminAccount.id, id, {
      reason: req.body.reason,
      durationMs: parseDurationMs(req.body),
    });
    if (!result.ok) {
      req.session.notice = result.error === "last_admin"
        ? "Cannot ban the last admin."
        : result.error === "self_target"
          ? "Cannot ban your own account."
          : "Could not ban account.";
      req.session.save(() => res.redirect(`/admin/users/${id}`));
      return;
    }
    await auditAdmin(req, {
      action: "ban",
      targetType: "account",
      targetId: id,
      reason: req.body.reason,
      after: {
        banned_at: result.account.banned_at,
        ban_expires_at: result.account.ban_expires_at,
      },
    });
    if (typeof deps.disconnectBannedAccount === "function") {
      await deps.disconnectBannedAccount(id);
    }
    req.session.notice = "Account banned.";
    req.session.save(() => res.redirect(`/admin/users/${id}`));
  }));

  router.post("/users/:id/unban", (req, res, next) => userMutation(req, res, next, async (id) => {
    const result = await adminUnban(req.adminAccount.id, id, req.body.reason);
    if (!result.ok) {
      req.session.notice = "Could not unban account.";
      req.session.save(() => res.redirect(`/admin/users/${id}`));
      return;
    }
    await auditAdmin(req, {
      action: "unban",
      targetType: "account",
      targetId: id,
      reason: req.body.reason,
    });
    req.session.notice = "Account unbanned.";
    req.session.save(() => res.redirect(`/admin/users/${id}`));
  }));

  router.post("/users/:id/tickets", (req, res, next) => userMutation(req, res, next, async (id) => {
    if (!confirmed(req.body)) {
      req.session.notice = "Confirmation required.";
      req.session.save(() => res.redirect(`/admin/users/${id}`));
      return;
    }
    const delta = Number(req.body.delta);
    const result = await adminAdjustTickets(
      req.adminAccount.id,
      id,
      delta,
      req.body.reason,
    );
    if (!result.ok) {
      req.session.notice = result.error === "below_held"
        ? `Cannot reduce below held tickets (${result.held}).`
        : "Could not adjust tickets.";
      req.session.save(() => res.redirect(`/admin/users/${id}`));
      return;
    }
    await auditAdmin(req, {
      action: "ticket_adjust",
      targetType: "account",
      targetId: id,
      reason: req.body.reason,
      before: { tickets: result.before },
      after: { tickets: result.after },
    });
    req.session.notice = `Tickets adjusted by ${delta}.`;
    req.session.save(() => res.redirect(`/admin/users/${id}`));
  }));

  router.post("/users/:id/verify", (req, res, next) => userMutation(req, res, next, async (id) => {
    const result = await adminVerifyEmail(req.adminAccount.id, id, req.body.reason);
    if (!result.ok) {
      req.session.notice = result.error === "no_email"
        ? "Account has no local email."
        : "Could not verify email.";
      req.session.save(() => res.redirect(`/admin/users/${id}`));
      return;
    }
    await auditAdmin(req, {
      action: "email_verify_manual",
      targetType: "account",
      targetId: id,
      reason: req.body.reason,
      after: { email_verified_at: result.account.email_verified_at },
    });
    req.session.notice = "Email marked verified.";
    req.session.save(() => res.redirect(`/admin/users/${id}`));
  }));

  router.post("/users/:id/resend-verify", (req, res, next) => userMutation(req, res, next, async (id) => {
    const detail = await getUserDetail(id);
    if (!detail?.account?.email) {
      req.session.notice = "Account has no local email.";
      req.session.save(() => res.redirect(`/admin/users/${id}`));
      return;
    }
    if (!issueVerifyEmail) {
      req.session.notice = "Verify email helper unavailable.";
      req.session.save(() => res.redirect(`/admin/users/${id}`));
      return;
    }
    try {
      await issueVerifyEmail(detail.account);
      await auditAdmin(req, {
        action: "email_verify_resend",
        targetType: "account",
        targetId: id,
        reason: req.body.reason || "admin resend",
      });
      req.session.notice = "Verification email sent.";
    } catch {
      req.session.notice = "Failed to send verification email.";
    }
    req.session.save(() => res.redirect(`/admin/users/${id}`));
  }));

  router.post("/users/:id/logout", (req, res, next) => userMutation(req, res, next, async (id) => {
    const result = await adminForceLogout(req.adminAccount.id, id);
    if (!result.ok) {
      req.session.notice = result.error === "self_target"
        ? "Cannot force-logout your own session this way."
        : "Could not revoke sessions.";
      req.session.save(() => res.redirect(`/admin/users/${id}`));
      return;
    }
    await auditAdmin(req, {
      action: "force_logout",
      targetType: "account",
      targetId: id,
      reason: req.body.reason || "admin force logout",
    });
    req.session.notice = "Sessions revoked.";
    req.session.save(() => res.redirect(`/admin/users/${id}`));
  }));

  router.post("/users/:id/name", (req, res, next) => userMutation(req, res, next, async (id) => {
    const check = validateDisplayName(req.body.name);
    if (!check.ok) {
      req.session.notice = check.error;
      req.session.save(() => res.redirect(`/admin/users/${id}`));
      return;
    }
    const before = (await getUserDetail(id))?.account?.name;
    const result = await adminRename(req.adminAccount.id, id, check.name, req.body.reason);
    if (!result.ok) {
      req.session.notice = result.error === "taken" ? "Name taken." : "Could not rename.";
      req.session.save(() => res.redirect(`/admin/users/${id}`));
      return;
    }
    await auditAdmin(req, {
      action: "rename",
      targetType: "account",
      targetId: id,
      reason: req.body.reason,
      before: { name: before },
      after: { name: check.name },
    });
    req.session.notice = "Display name updated.";
    req.session.save(() => res.redirect(`/admin/users/${id}`));
  }));

  router.post("/users/:id/notes", (req, res, next) => userMutation(req, res, next, async (id) => {
    await adminUpdateNotes(id, req.body.notes);
    await auditAdmin(req, {
      action: "notes_update",
      targetType: "account",
      targetId: id,
      after: { notes: String(req.body.notes || "").slice(0, 200) },
    });
    req.session.notice = "Notes saved.";
    req.session.save(() => res.redirect(`/admin/users/${id}`));
  }));

  // ----- Analytics -----
  router.get("/analytics", async (req, res, next) => {
    try {
      if (!(await requireAdmin(req, res))) return;
      const range = String(req.query.range || "30d");
      const analytics = await buildAnalytics(range);
      const data = await baseLocals(req, {
        analytics,
        range,
        charts: {
          gamesByMode: barRows(analytics.games.byMode, "n", "mode"),
          registrations: barRows(analytics.registrations, "n", "day"),
          gamesPerDay: barRows(analytics.games.perDay, "n", "day"),
          mmr: barRows(analytics.mmrBuckets, "n", "bucket"),
        },
        adminSection: "analytics",
      });
      req.session.save(() => res.render("admin/analytics", data));
    } catch (err) {
      next(err);
    }
  });

  // ----- Logs -----
  router.get("/logs", async (req, res, next) => {
    try {
      if (!(await requireAdmin(req, res))) return;
      await retainAdminEvents().catch(() => {});
      const events = await listAdminEvents({
        page: req.query.page,
        level: req.query.level || null,
        event: req.query.event || null,
        module: req.query.module || null,
        accountId: req.query.accountId || null,
        matchId: req.query.matchId || null,
      });
      let metrics = null;
      if (metricsEnabled() && ioStats) {
        ensureMetrics();
        metrics = metricsReport(ioStats());
      }
      const data = await baseLocals(req, {
        events,
        metrics,
        metricsEnabled: metricsEnabled(),
        filters: {
          level: req.query.level || "",
          event: req.query.event || "",
          module: req.query.module || "",
          accountId: req.query.accountId || "",
          matchId: req.query.matchId || "",
        },
        adminSection: "logs",
      });
      req.session.save(() => res.render("admin/logs", data));
    } catch (err) {
      next(err);
    }
  });

  router.get("/logs/download", async (req, res, next) => {
    try {
      if (!(await requireAdmin(req, res))) return;
      const events = await listAdminEvents({
        page: 1,
        pageSize: 10000,
        level: req.query.level || null,
        event: req.query.event || null,
        module: req.query.module || null,
        accountId: req.query.accountId || null,
        matchId: req.query.matchId || null,
      });
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=\"admin-events.csv\"");
      res.send(eventsToCsv(events.rows));
    } catch (err) {
      next(err);
    }
  });

  // ----- Games -----
  router.get("/games", async (req, res, next) => {
    try {
      if (!(await requireStaff(req, res))) return;
      const live = enrichActiveList(matchmaker);
      const recent = await listRecentGames({ mode: req.query.mode || null, limit: 40 });
      const queues = queueSnapshot(matchmaker);
      const data = await baseLocals(req, {
        live,
        recent,
        queues,
        adminSection: "games",
      });
      req.session.save(() => res.render("admin/games", data));
    } catch (err) {
      next(err);
    }
  });

  router.get("/games/:id", async (req, res, next) => {
    try {
      if (!(await requireStaff(req, res))) return;
      const live = enrichActiveList(matchmaker).find((g) => g.id === req.params.id);
      const hist = await historicalGame(req.params.id);
      if (!live && !hist) {
        req.session.notice = "Game not found.";
        req.session.save(() => res.redirect("/admin/games"));
        return;
      }
      const liveChat = live ? liveGameChat(matchmaker, req.params.id) : null;
      const chat = (liveChat && liveChat.length)
        ? liveChat
        : (hist && hist.chat) || [];
      const data = await baseLocals(req, {
        live,
        hist,
        chat,
        adminSection: "games",
      });
      req.session.save(() => res.render("admin/game", data));
    } catch (err) {
      next(err);
    }
  });

  router.post("/games/:id/terminate", async (req, res, next) => {
    try {
      if (!(await requireAdmin(req, res))) return;
      if (!adminLimited(req)) {
        req.session.notice = "Too many admin actions.";
        req.session.save(() => res.redirect("/admin/games"));
        return;
      }
      if (!confirmed(req.body)) {
        req.session.notice = "Confirmation required.";
        req.session.save(() => res.redirect(`/admin/games/${req.params.id}`));
        return;
      }
      const result = await terminateMatch(matchmaker, req.params.id, {
        reason: req.body.reason,
        adminAccountId: req.adminAccount.id,
      });
      if (!result.ok) {
        req.session.notice = result.error === "reason_required"
          ? "Reason required."
          : "Match not found or already ended.";
        req.session.save(() => res.redirect("/admin/games"));
        return;
      }
      await auditAdmin(req, {
        action: "match_terminate",
        targetType: "match",
        targetId: req.params.id,
        reason: req.body.reason,
        after: result,
      });
      req.session.notice = "Match terminated.";
      req.session.save(() => res.redirect("/admin/games"));
    } catch (err) {
      next(err);
    }
  });

  // ----- Ops -----
  router.get("/ops", async (req, res, next) => {
    try {
      if (!(await requireAdmin(req, res))) return;
      const health = await configHealth();
      const news = readNews();
      const paypalLookup = req.session && req.session.paypalLookup
        ? req.session.paypalLookup
        : null;
      if (req.session) req.session.paypalLookup = null;
      const data = await baseLocals(req, {
        health,
        news,
        paypalLookup,
        adminSection: "ops",
      });
      req.session.save(() => res.render("admin/ops", data));
    } catch (err) {
      next(err);
    }
  });

  router.post("/ops/paypal-lookup", async (req, res, next) => {
    try {
      if (!(await requireAdmin(req, res))) return;
      const q = String(req.body && req.body.query || "").trim();
      const row = q ? await findPaypalPurchaseByOrderOrCapture(q) : null;
      req.session.paypalLookup = row
        ? { ok: true, purchase: row }
        : { ok: false, query: q, error: "not_found" };
      req.session.save(() => res.redirect("/admin/ops"));
    } catch (err) {
      next(err);
    }
  });

  router.post("/ops/paypal-reconcile", async (req, res, next) => {
    try {
      if (!(await requireAdmin(req, res))) return;
      const result = await reconcileStalePaypalPurchases({
        olderThanMs: 60_000,
        limit: 50,
      });
      req.session.notice = `PayPal reconcile: processed ${result.processed} of ${result.considered} stale rows.`;
      await auditAdmin(req, {
        action: "paypal_reconcile",
        targetType: "site",
        targetId: "paypal",
        after: result,
      });
      req.session.save(() => res.redirect("/admin/ops"));
    } catch (err) {
      next(err);
    }
  });

  router.post("/ops/maintenance", async (req, res, next) => {
    try {
      if (!(await requireAdmin(req, res))) return;
      if (!adminLimited(req)) {
        req.session.notice = "Too many admin actions.";
        req.session.save(() => res.redirect("/admin/ops"));
        return;
      }
      const paused = req.body.paused === "1" || req.body.paused === "on";
      await setMaintenance({
        message: req.body.message || "",
        paused,
        updatedBy: req.adminAccount.id,
      });
      await auditAdmin(req, {
        action: "maintenance_update",
        targetType: "site",
        targetId: "maintenance",
        reason: req.body.reason || null,
        after: { paused, message: req.body.message || "" },
      });
      req.session.notice = paused
        ? "Matchmaking paused for new joins."
        : "Maintenance settings updated.";
      req.session.save(() => res.redirect("/admin/ops"));
    } catch (err) {
      next(err);
    }
  });

  router.post("/ops/news", async (req, res, next) => {
    try {
      if (!(await requireAdmin(req, res))) return;
      if (!adminLimited(req)) {
        req.session.notice = "Too many admin actions.";
        req.session.save(() => res.redirect("/admin/ops"));
        return;
      }
      let items;
      try {
        items = JSON.parse(String(req.body.newsJson || "[]"));
      } catch {
        req.session.notice = "Invalid JSON.";
        req.session.save(() => res.redirect("/admin/ops"));
        return;
      }
      saveNews(items, req.adminAccount.id);
      await auditAdmin(req, {
        action: "news_update",
        targetType: "site",
        targetId: "news",
        after: { count: items.length },
      });
      req.session.notice = "News updated.";
      req.session.save(() => res.redirect("/admin/ops"));
    } catch (err) {
      next(err);
    }
  });

  router.get("/export/:kind.csv", async (req, res, next) => {
    try {
      if (!(await requireAdmin(req, res))) return;
      const kind = String(req.params.kind || "");
      if (kind === "accounts") {
        const rows = await exportAccountsRows();
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", "attachment; filename=\"accounts.csv\"");
        res.send(accountsToCsv(rows));
        return;
      }
      if (kind === "games") {
        const rows = await exportGamesRows();
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", "attachment; filename=\"games.csv\"");
        res.send(gamesToCsv(rows));
        return;
      }
      if (kind === "tickets" || kind === "ticket_ledger") {
        const rows = await exportLedgerRows();
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", "attachment; filename=\"ticket_ledger.csv\"");
        res.send(ledgerToCsv(rows));
        return;
      }
      if (kind === "paypal" || kind === "paypal_purchases") {
        const rows = await exportPaypalPurchaseRows();
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", "attachment; filename=\"paypal_purchases.csv\"");
        res.send(paypalPurchasesToCsv(rows));
        return;
      }
      res.status(404).send("Unknown export");
    } catch (err) {
      next(err);
    }
  });

  // ----- Player reports (staff) -----
  router.get("/reports", async (req, res, next) => {
    try {
      if (!(await requireStaff(req, res))) return;
      const statusRaw = String(req.query.status || "open").toLowerCase();
      const status = ["open", "resolved", "dismissed", "all"].includes(statusRaw)
        ? statusRaw
        : "open";
      const reportedFilter = routeId(req.query.reported) || "";
      const reports = await listPlayerReports({
        status,
        reportedAccountId: reportedFilter || null,
        limit: 200,
      });
      const listQuery = reportsListQuery({ status, reported: reportedFilter });
      const data = await baseLocals(req, {
        reports,
        status,
        reportedFilter,
        listQuery,
        adminSection: "reports",
      });
      req.session.save(() => res.render("admin/reports", data));
    } catch (err) {
      next(err);
    }
  });

  router.post("/reports/:id/resolve", async (req, res, next) => {
    try {
      if (!(await requireStaff(req, res))) return;
      const back = safeAdminNext(req.body && req.body.next);
      if (!adminLimited(req)) {
        req.session.notice = "Too many admin actions. Try again in a minute.";
        req.session.save(() => res.redirect(back));
        return;
      }
      const reportId = routeId(req.params.id);
      if (!reportId) {
        req.session.notice = "Report not found.";
        req.session.save(() => res.redirect(back));
        return;
      }
      const status = String(req.body.status || "resolved") === "dismissed"
        ? "dismissed"
        : "resolved";
      const ok = await resolvePlayerReport(reportId, {
        status,
        resolvedBy: req.adminAccount.id,
        note: req.body.note,
      });
      if (!ok) {
        req.session.notice = "Report already closed or not found.";
        req.session.save(() => res.redirect(back));
        return;
      }
      await auditAdmin(req, {
        action: status === "dismissed" ? "report_dismiss" : "report_resolve",
        targetType: "player_report",
        targetId: reportId,
        reason: req.body.note || null,
      });
      req.session.notice = status === "dismissed" ? "Report dismissed." : "Report resolved.";
      req.session.save(() => res.redirect(back));
    } catch (err) {
      next(err);
    }
  });

  router.post("/reports/user/:id/resolve-all", async (req, res, next) => {
    try {
      if (!(await requireStaff(req, res))) return;
      const back = safeAdminNext(req.body && req.body.next);
      if (!adminLimited(req)) {
        req.session.notice = "Too many admin actions. Try again in a minute.";
        req.session.save(() => res.redirect(back));
        return;
      }
      const accountId = routeId(req.params.id);
      if (!accountId) {
        req.session.notice = "Account not found.";
        req.session.save(() => res.redirect(back));
        return;
      }
      const status = String(req.body.status || "resolved") === "dismissed"
        ? "dismissed"
        : "resolved";
      const n = await resolvePlayerReportsForUser(accountId, {
        status,
        resolvedBy: req.adminAccount.id,
        note: req.body.note,
      });
      await auditAdmin(req, {
        action: status === "dismissed" ? "report_dismiss_all" : "report_resolve_all",
        targetType: "account",
        targetId: accountId,
        reason: req.body.note || null,
        after: { count: n },
      });
      req.session.notice = n
        ? `${n} report${n === 1 ? "" : "s"} ${status}.`
        : "No open reports for that user.";
      req.session.save(() => res.redirect(back));
    } catch (err) {
      next(err);
    }
  });

  router.post("/reports/user/:id/ban", async (req, res, next) => {
    try {
      if (!(await requireAdmin(req, res))) return;
      const back = safeAdminNext(req.body && req.body.next);
      if (!adminLimited(req)) {
        req.session.notice = "Too many admin actions. Try again in a minute.";
        req.session.save(() => res.redirect(back));
        return;
      }
      const accountId = routeId(req.params.id);
      if (!accountId) {
        req.session.notice = "Account not found.";
        req.session.save(() => res.redirect(back));
        return;
      }
      if (!confirmed(req.body)) {
        req.session.notice = "Confirmation required.";
        req.session.save(() => res.redirect(back));
        return;
      }
      const result = await adminBan(req.adminAccount.id, accountId, {
        reason: req.body.reason,
        durationMs: parseDurationMs(req.body),
      });
      if (!result.ok) {
        req.session.notice = result.error === "last_admin"
          ? "Cannot ban the last admin."
          : result.error === "self_target"
            ? "Cannot ban your own account."
            : "Could not ban account.";
        req.session.save(() => res.redirect(back));
        return;
      }
      await auditAdmin(req, {
        action: "ban",
        targetType: "account",
        targetId: accountId,
        reason: req.body.reason,
        after: {
          banned_at: result.account.banned_at,
          ban_expires_at: result.account.ban_expires_at,
          from_report: routeId(req.body.reportId) || null,
        },
      });
      if (typeof deps.disconnectBannedAccount === "function") {
        await deps.disconnectBannedAccount(accountId);
      }
      let notice = "Account banned.";
      if (req.body.resolveAll === "1" || req.body.resolveAll === "on") {
        const n = await resolvePlayerReportsForUser(accountId, {
          status: "resolved",
          resolvedBy: req.adminAccount.id,
          note: req.body.reason || "Banned from report tools",
        });
        if (n) {
          await auditAdmin(req, {
            action: "report_resolve_all",
            targetType: "account",
            targetId: accountId,
            reason: req.body.reason || null,
            after: { count: n, with_ban: true },
          });
          notice = `Account banned; ${n} open report${n === 1 ? "" : "s"} resolved.`;
        }
      }
      req.session.notice = notice;
      req.session.save(() => res.redirect(back));
    } catch (err) {
      next(err);
    }
  });

  // ----- Suggestions (staff) -----
  router.get("/suggestions", async (req, res, next) => {
    try {
      if (!(await requireStaff(req, res))) return;
      const suggestions = await listSuggestions({ archived: false });
      const data = await baseLocals(req, {
        suggestions,
        rewardAmount: wikiRewardAmount(),
        adminSection: "suggestions",
      });
      req.session.save(() => res.render("admin/suggestions", data));
    } catch (err) {
      next(err);
    }
  });

  router.post("/suggestions/:id/archive", async (req, res, next) => {
    try {
      if (!(await requireStaff(req, res))) return;
      if (!adminLimited(req)) {
        req.session.notice = "Too many admin actions. Try again in a minute.";
        req.session.save(() => res.redirect("/admin/suggestions"));
        return;
      }
      const suggestionId = routeId(req.params.id);
      if (!suggestionId) {
        req.session.notice = "Suggestion not found.";
        req.session.save(() => res.redirect("/admin/suggestions"));
        return;
      }
      await archiveSuggestion(suggestionId);
      await auditAdmin(req, {
        action: "suggestion_archive",
        targetType: "suggestion",
        targetId: suggestionId,
      });
      req.session.notice = "Suggestion archived.";
      req.session.save(() => res.redirect("/admin/suggestions"));
    } catch (err) {
      next(err);
    }
  });

  router.post("/suggestions/:id/archive-reward", async (req, res, next) => {
    try {
      if (!(await requireAdmin(req, res))) return;
      if (!adminLimited(req)) {
        req.session.notice = "Too many admin actions. Try again in a minute.";
        req.session.save(() => res.redirect("/admin/suggestions"));
        return;
      }
      const suggestionId = routeId(req.params.id);
      const suggestion = suggestionId ? await getSuggestion(suggestionId) : null;
      if (!suggestion || suggestion.archived_at || suggestion.rewarded_at || suggestion.reward_status === "pending") {
        req.session.notice = suggestion && suggestion.reward_status === "pending"
          ? ambiguousTransfer
          : "Suggestion not found.";
        req.session.save(() => res.redirect("/admin/suggestions"));
        return;
      }
      if (suggestion.formbar_id <= 0) {
        req.session.notice = "This suggestion cannot be rewarded.";
        req.session.save(() => res.redirect("/admin/suggestions"));
        return;
      }
      const claimed = await claimSuggestionReward(suggestion.id);
      if (!claimed) {
        req.session.notice = "Suggestion not found.";
        req.session.save(() => res.redirect("/admin/suggestions"));
        return;
      }
      const amount = wikiRewardAmount();
      const transfer = await rewardFromPool(formbarSocket, {
        userId: suggestion.formbar_id,
        amount,
        reason: "MOTL Suggestion Reward",
      });
      if (transfer.ambiguous) {
        req.session.notice = ambiguousTransfer;
        req.session.save(() => res.redirect("/admin/suggestions"));
        return;
      }
      if (!transfer.success) {
        await releaseSuggestionReward(suggestion.id);
        req.session.notice = transfer.message || "Reward transfer failed.";
        req.session.save(() => res.redirect("/admin/suggestions"));
        return;
      }
      await completeSuggestionReward(suggestion.id);
      await auditAdmin(req, {
        action: "suggestion_reward",
        targetType: "suggestion",
        targetId: suggestion.id,
        after: { amount, formbarId: suggestion.formbar_id },
      });
      req.session.notice = `Archived and sent ${amount} digipogs to ${suggestion.name}.`;
      req.session.save(() => res.redirect("/admin/suggestions"));
    } catch (err) {
      next(err);
    }
  });

  // ----- Wiki (staff) -----
  router.get("/wiki", async (req, res, next) => {
    try {
      if (!(await requireStaff(req, res))) return;
      const revisions = (await listOpenWikiRevisions()).map((item) => ({
        ...item,
        isCreate: item.previous_body == null,
        diff: wikiLineDiff(item.previous_body, item.body),
      }));
      const data = await baseLocals(req, {
        revisions,
        rewardAmount: wikiRewardAmount(),
        adminSection: "wiki",
      });
      req.session.save(() => res.render("admin/wiki", data));
    } catch (err) {
      next(err);
    }
  });

  router.post("/wiki/:id/confirm", async (req, res, next) => {
    try {
      if (!(await requireStaff(req, res))) return;
      if (!adminLimited(req)) {
        req.session.notice = "Too many admin actions.";
        req.session.save(() => res.redirect("/admin/wiki"));
        return;
      }
      const revisionId = routeId(req.params.id);
      const ok = await confirmWikiRevision(revisionId);
      if (ok) {
        await auditAdmin(req, {
          action: "wiki_confirm",
          targetType: "wiki_revision",
          targetId: revisionId,
        });
      }
      req.session.notice = ok ? "Revision confirmed." : "Revision not found.";
      req.session.save(() => res.redirect("/admin/wiki"));
    } catch (err) {
      next(err);
    }
  });

  router.post("/wiki/:id/undo", async (req, res, next) => {
    try {
      if (!(await requireStaff(req, res))) return;
      if (!adminLimited(req)) {
        req.session.notice = "Too many admin actions.";
        req.session.save(() => res.redirect("/admin/wiki"));
        return;
      }
      const revisionId = routeId(req.params.id);
      const result = await undoWikiRevision(revisionId);
      if (!result.ok) {
        req.session.notice = result.error || "Could not undo.";
      } else if (result.deleted) {
        await auditAdmin(req, {
          action: "wiki_undo_delete",
          targetType: "wiki_revision",
          targetId: revisionId,
        });
        req.session.notice = "Page deleted.";
      } else {
        await auditAdmin(req, {
          action: "wiki_undo",
          targetType: "wiki_revision",
          targetId: revisionId,
        });
        req.session.notice = "Revision undone.";
      }
      req.session.save(() => res.redirect("/admin/wiki"));
    } catch (err) {
      next(err);
    }
  });

  router.post("/wiki/:id/reward", async (req, res, next) => {
    try {
      if (!(await requireAdmin(req, res))) return;
      if (!adminLimited(req)) {
        req.session.notice = "Too many admin actions. Try again in a minute.";
        req.session.save(() => res.redirect("/admin/wiki"));
        return;
      }
      const revisionId = routeId(req.params.id);
      const revision = revisionId ? await getWikiRevision(revisionId) : null;
      if (!revision || revision.undone_at) {
        req.session.notice = "Revision not found.";
        req.session.save(() => res.redirect("/admin/wiki"));
        return;
      }
      if (revision.rewarded_at || revision.reward_status === "completed") {
        req.session.notice = "Already rewarded.";
        req.session.save(() => res.redirect("/admin/wiki"));
        return;
      }
      if (revision.reward_status === "pending") {
        req.session.notice = ambiguousTransfer;
        req.session.save(() => res.redirect("/admin/wiki"));
        return;
      }
      if (revision.formbar_id <= 0) {
        req.session.notice = "System revisions cannot be rewarded.";
        req.session.save(() => res.redirect("/admin/wiki"));
        return;
      }
      const claimed = await claimWikiReward(revision.id);
      if (!claimed) {
        req.session.notice = "Already rewarded.";
        req.session.save(() => res.redirect("/admin/wiki"));
        return;
      }
      const amount = wikiRewardAmount();
      const transfer = await rewardFromPool(formbarSocket, {
        userId: revision.formbar_id,
        amount,
        reason: `MOTL Wiki Reward: ${revision.title}`,
      });
      if (transfer.ambiguous) {
        req.session.notice = ambiguousTransfer;
        req.session.save(() => res.redirect("/admin/wiki"));
        return;
      }
      if (!transfer.success) {
        await releaseWikiReward(revision.id);
        req.session.notice = transfer.message || "Reward transfer failed.";
        req.session.save(() => res.redirect("/admin/wiki"));
        return;
      }
      await completeWikiReward(revision.id);
      await auditAdmin(req, {
        action: "wiki_reward",
        targetType: "wiki_revision",
        targetId: revision.id,
        after: { amount, formbarId: revision.formbar_id },
      });
      req.session.notice = `Sent ${amount} digipogs to ${revision.name}.`;
      req.session.save(() => res.redirect("/admin/wiki"));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
