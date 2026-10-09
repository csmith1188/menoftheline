import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  getSiteSetting,
  getSiteSettings,
  setSiteSetting,
} from "../db.js";
import { loadNews } from "../news.js";
import { saveNewsArray } from "../newsStore.js";
import { asErr, logger } from "../logger.js";
import {
  anyLoginEnabled,
  authEmailEnabled,
  discordLoginEnabled,
  formbarLoginEnabled,
  localAccountsEnabled,
  noFreePlayEnabled,
} from "../auth.js";
import { mailReady } from "../mail.js";
import { metricsEnabled } from "../metrics.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export async function isMatchmakingPaused() {
  const row = await getSiteSetting("matchmaking_paused");
  return row && (row.value === "1" || row.value === "true");
}

export async function getMaintenanceMessage() {
  const row = await getSiteSetting("maintenance_message");
  return row && row.value ? String(row.value) : "";
}

export async function setMaintenance({ message = "", paused = false, updatedBy = null } = {}) {
  await setSiteSetting("maintenance_message", message || "", updatedBy);
  await setSiteSetting("matchmaking_paused", paused ? "1" : "0", updatedBy);
}

export function readNews() {
  return loadNews();
}

export function saveNews(items, updatedBy = null) {
  return saveNewsArray(items, updatedBy);
}

export async function configHealth() {
  const settings = await getSiteSettings([
    "maintenance_message",
    "matchmaking_paused",
  ]);
  const map = Object.fromEntries(settings.map((s) => [s.key, s.value]));
  const warnings = [];
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    if (process.env.NODE_ENV === "production") {
      warnings.push("SESSION_SECRET looks weak for production");
    }
  }
  if (!anyLoginEnabled()) warnings.push("No login providers enabled");
  if (authEmailEnabled() && !mailReady()) warnings.push("AUTH_EMAIL on but SMTP not ready");
  if (!process.env.ADMIN_BOOTSTRAP_ACCOUNT_ID && !process.env.ADMIN_USER_ID) {
    warnings.push("No admin bootstrap env set (ok if admins already exist in DB)");
  }

  let version = "unknown";
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    version = pkg.version || pkg.name || "unknown";
  } catch (err) {
    logger.warn({ event: "version_read_failed", err: asErr(err) }, "package.json read failed");
  }

  return {
    version: process.env.APP_VERSION || version,
    uptimeSec: Math.floor(process.uptime()),
    nodeEnv: process.env.NODE_ENV || "development",
    localAccounts: localAccountsEnabled(),
    formbarLogin: formbarLoginEnabled(),
    discordLogin: discordLoginEnabled(),
    authEmail: authEmailEnabled(),
    noFree: noFreePlayEnabled(),
    mailReady: mailReady(),
    metrics: metricsEnabled(),
    maintenanceMessage: map.maintenance_message || "",
    matchmakingPaused: map.matchmaking_paused === "1" || map.matchmaking_paused === "true",
    warnings,
  };
}

export function accountsToCsv(rows) {
  const header = [
    "id", "name", "role", "email", "formbar_id", "discord_id",
    "mmr", "tickets", "held", "wins", "losses",
    "email_verified_at", "banned_at", "created_at", "last_seen_at",
  ];
  return toCsv(header, rows);
}

export function gamesToCsv(rows) {
  const header = [
    "id", "mode", "name_a", "name_b", "account_a", "account_b",
    "winner_side", "win_reason", "outcome", "created_at", "ended_at",
  ];
  return toCsv(header, rows);
}

export function ledgerToCsv(rows) {
  const header = [
    "id", "account_id", "delta", "balance_after", "held_after",
    "kind", "ref_type", "ref_id", "actor_account_id", "reason", "created_at",
  ];
  return toCsv(header, rows);
}

export function paypalPurchasesToCsv(rows) {
  const header = [
    "id", "account_id", "package_id", "amount_value", "currency", "tickets",
    "paypal_order_id", "paypal_capture_id", "status",
    "clawback_applied", "clawback_shortfall",
    "created_at", "updated_at", "credited_at", "refunded_at",
  ];
  return toCsv(header, rows);
}

function toCsv(header, rows) {
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(header.map((key) => csvEscape(row[key])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}
