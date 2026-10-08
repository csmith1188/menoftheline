import {
  listAdminEvents,
  purgeAdminEvents,
  writeAdminEvent,
} from "../db.js";

export { listAdminEvents, writeAdminEvent };

export function adminEventRetainDays() {
  const n = Number(process.env.ADMIN_EVENT_RETAIN_DAYS);
  return Number.isInteger(n) && n > 0 ? n : 14;
}

export async function retainAdminEvents() {
  return purgeAdminEvents(adminEventRetainDays());
}

export function eventsToCsv(rows) {
  const header = ["id", "created_at", "level", "event", "module", "account_id", "match_id", "message"];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push([
      row.id,
      row.created_at,
      csvEscape(row.level),
      csvEscape(row.event),
      csvEscape(row.module),
      row.account_id ?? "",
      csvEscape(row.match_id),
      csvEscape(row.message),
    ].join(","));
  }
  return `${lines.join("\n")}\n`;
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}
