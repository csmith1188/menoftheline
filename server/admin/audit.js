import { writeAdminAudit, writeAdminEvent } from "../db.js";
import { logger } from "../logger.js";
import { requestClientIp } from "../hardening.js";

export async function auditAdmin(req, {
  action,
  targetType = null,
  targetId = null,
  reason = null,
  before = null,
  after = null,
}) {
  const adminAccountId = req.adminAccount?.id
    || (req.session && req.session.accountId)
    || null;
  const ip = requestClientIp(req);
  const id = await writeAdminAudit({
    adminAccountId,
    action,
    targetType,
    targetId,
    reason,
    before,
    after,
    ip,
  });
  logger.info({
    event: "admin_action",
    action,
    adminUserId: adminAccountId,
    targetType,
    targetId,
    reason: reason || undefined,
  }, String(action));
  await writeAdminEvent({
    level: "info",
    event: "admin_action",
    module: "admin",
    accountId: adminAccountId,
    message: action,
    meta: { targetType, targetId, reason, auditId: id },
  }).catch(() => {});
  return id;
}
