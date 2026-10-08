import {
  getAccount,
  isAdminRole,
  isStaffRole,
  normalizeAccountRole,
} from "../db.js";
import { logger } from "../logger.js";
import { requestClientIp } from "../hardening.js";

/** @param {object|null} account */
export function roleOf(account) {
  return normalizeAccountRole(account && account.role);
}

/** @param {object|null} account */
export function accountIsAdmin(account) {
  return isAdminRole(roleOf(account));
}

/** @param {object|null} account */
export function accountIsStaff(account) {
  return isStaffRole(roleOf(account));
}

/**
 * Load the session account and return its role.
 * @returns {Promise<{ account: object|null, role: string }>}
 */
export async function getStaffContext(sess) {
  if (!sess || !sess.accountId) return { account: null, role: "player" };
  const account = await getAccount(sess.accountId);
  if (!account) return { account: null, role: "player" };
  return { account, role: roleOf(account) };
}

export async function sessionIsAdmin(sess) {
  const { role } = await getStaffContext(sess);
  return role === "admin";
}

export async function sessionIsStaff(sess) {
  const { role } = await getStaffContext(sess);
  return role === "admin" || role === "moderator";
}

export function denyAdmin(req, res, reason = "admin access denied") {
  logger.warn({
    event: "authz_denied",
    path: req.path,
    ip: requestClientIp(req),
    accountId: req.session && req.session.accountId,
  }, reason);
  res.redirect("/");
  return false;
}

/** Require role === admin. Returns account or false after redirect. */
export async function requireAdmin(req, res) {
  const { account, role } = await getStaffContext(req.session);
  if (!account || role !== "admin") {
    denyAdmin(req, res);
    return false;
  }
  req.adminAccount = account;
  return account;
}

/** Require admin or moderator. */
export async function requireStaff(req, res) {
  const { account, role } = await getStaffContext(req.session);
  if (!account || (role !== "admin" && role !== "moderator")) {
    denyAdmin(req, res, "staff access denied");
    return false;
  }
  req.adminAccount = account;
  req.staffRole = role;
  return account;
}

export function assertNotSelfTarget(actorAccountId, targetAccountId) {
  if (Number(actorAccountId) === Number(targetAccountId)) {
    return { ok: false, error: "self_target" };
  }
  return { ok: true };
}
