import {
  adjustTicketsAdmin,
  banAccount,
  bumpSessionEpoch,
  countOpenPlayerReports,
  findPaypalPurchaseByOrderOrCapture,
  FALLEN_SOLDIER,
  getAccount,
  getDeletedAccountIdentity,
  isAccountBanned,
  isAccountDeleted,
  listAccountGames,
  listAdminAudit,
  listPaypalPurchasesForAccount,
  listPlayerReports,
  listTicketLedger,
  normalizeAccountRole,
  publicDisplayName,
  searchAccounts,
  setAccountDisplayName,
  setAccountRole,
  setAdminNotes,
  setEmailVerified,
  unbanAccount,
} from "../db.js";
import { assertNotSelfTarget } from "./auth.js";

export {
  searchAccounts,
  listTicketLedger,
  listAccountGames,
  isAccountBanned,
  findPaypalPurchaseByOrderOrCapture,
};

export function publicAccount(account) {
  if (!account) return null;
  const { password_hash: _ph, ...rest } = account;
  if (isAccountDeleted(account)) {
    return {
      ...rest,
      name: FALLEN_SOLDIER,
      email: null,
      formbar_id: null,
      discord_id: null,
      password_hash: undefined,
    };
  }
  return {
    ...rest,
    name: publicDisplayName(account),
  };
}

export async function getUserDetail(accountId) {
  const account = await getAccount(accountId);
  if (!account) return null;
  const [
    ledger,
    games,
    audit,
    reportsAgainst,
    reportsFiled,
    openReportsAgainst,
    paypalPurchases,
    deletedIdentity,
  ] = await Promise.all([
    listTicketLedger(account.id, { limit: 50 }),
    listAccountGames(account.id, { limit: 20 }),
    listAdminAudit({
      targetType: "account",
      targetId: String(account.id),
      pageSize: 30,
    }),
    listPlayerReports({ reportedAccountId: account.id, status: "all", limit: 30 }),
    listPlayerReports({ reporterAccountId: account.id, status: "all", limit: 20 }),
    countOpenPlayerReports(account.id),
    listPaypalPurchasesForAccount(account.id, { limit: 50 }),
    isAccountDeleted(account) ? getDeletedAccountIdentity(account.id) : null,
  ]);
  return {
    account: publicAccount(account),
    ledger,
    games,
    audit: audit.rows,
    reportsAgainst,
    reportsFiled,
    openReportsAgainst,
    paypalPurchases,
    banned: isAccountBanned(account),
    deleted: isAccountDeleted(account),
    formerName: deletedIdentity && deletedIdentity.former_name
      ? String(deletedIdentity.former_name)
      : null,
    deletedAt: deletedIdentity ? deletedIdentity.deleted_at : (account.deleted_at || null),
    deletedVia: deletedIdentity ? deletedIdentity.deleted_via : null,
  };
}

export async function adminSetRole(actorId, targetId, role, reason) {
  const self = assertNotSelfTarget(actorId, targetId);
  if (!self.ok) return self;
  if (!reason || !String(reason).trim()) return { ok: false, error: "reason_required" };
  const next = normalizeAccountRole(role);
  return setAccountRole(targetId, next);
}

export async function adminBan(actorId, targetId, { reason, durationMs = null } = {}) {
  const self = assertNotSelfTarget(actorId, targetId);
  if (!self.ok) return self;
  if (!reason || !String(reason).trim()) return { ok: false, error: "reason_required" };
  const expiresAt = durationMs != null && Number(durationMs) > 0
    ? Date.now() + Number(durationMs)
    : null;
  return banAccount(targetId, {
    reason: String(reason).trim(),
    expiresAt,
    bannedBy: actorId,
  });
}

export async function adminUnban(actorId, targetId, reason) {
  const self = assertNotSelfTarget(actorId, targetId);
  if (!self.ok) return self;
  if (!reason || !String(reason).trim()) return { ok: false, error: "reason_required" };
  return unbanAccount(targetId);
}

export async function adminAdjustTickets(actorId, targetId, delta, reason) {
  if (!reason || !String(reason).trim()) return { ok: false, error: "reason_required" };
  return adjustTicketsAdmin(targetId, delta, {
    actorAccountId: actorId,
    reason: String(reason).trim(),
  });
}

export async function adminVerifyEmail(actorId, targetId, reason) {
  if (!reason || !String(reason).trim()) return { ok: false, error: "reason_required" };
  const account = await getAccount(targetId);
  if (!account) return { ok: false, error: "not_found" };
  if (!account.email) return { ok: false, error: "no_email" };
  const ok = await setEmailVerified(targetId, Date.now(), {
    verifiedBy: actorId,
    reason: String(reason).trim(),
  });
  return { ok, account: ok ? await getAccount(targetId) : account };
}

export async function adminForceLogout(actorId, targetId) {
  const self = assertNotSelfTarget(actorId, targetId);
  if (!self.ok) return self;
  const ok = await bumpSessionEpoch(targetId);
  return { ok };
}

export async function adminRename(actorId, targetId, name, reason) {
  if (!reason || !String(reason).trim()) return { ok: false, error: "reason_required" };
  const result = await setAccountDisplayName(targetId, name);
  return result;
}

export async function adminUpdateNotes(targetId, notes) {
  const ok = await setAdminNotes(targetId, notes);
  return { ok };
}
