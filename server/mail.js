import fs from "fs";
import nodemailer from "nodemailer";
import { authEmailEnabled, smtpConfigured } from "./auth.js";
import { asErr, logger } from "./logger.js";

/** Captured messages when set (tests). */
let capture = null;
let transporter = null;

export function setMailCapture(fn) {
  capture = typeof fn === "function" ? fn : null;
}

export function clearMailCapture() {
  capture = null;
}

function recordMessage(message) {
  if (capture) capture(message);
  const path = String(process.env.AUTH_MAIL_CAPTURE_PATH || "").trim();
  if (path) {
    fs.appendFileSync(path, `${JSON.stringify(message)}\n`);
  }
}

function getTransporter() {
  if (transporter) return transporter;
  const host = String(process.env.SMTP_HOST || "").trim();
  const port = Number(process.env.SMTP_PORT) || 587;
  const secure = ["1", "true", "yes", "on"].includes(
    String(process.env.SMTP_SECURE || "").trim().toLowerCase(),
  );
  const user = String(process.env.SMTP_USER || "").trim();
  const pass = String(process.env.SMTP_PASS || "");
  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass } : undefined,
  });
  return transporter;
}

export function mailReady() {
  return authEmailEnabled() && smtpConfigured();
}

export async function sendMail({ to, subject, text, html }) {
  if (!authEmailEnabled()) {
    throw new Error("Email auth is disabled");
  }
  if (!smtpConfigured()) {
    throw new Error("SMTP is not configured");
  }
  const from = String(process.env.SMTP_FROM || "").trim();
  if (!from) {
    throw new Error("SMTP_FROM is empty");
  }
  const message = { from, to, subject, text, html };
  if (capture || String(process.env.AUTH_MAIL_CAPTURE_PATH || "").trim()) {
    recordMessage(message);
    return { messageId: "capture" };
  }
  const toDomain = String(to || "").includes("@")
    ? String(to).split("@").pop()
    : undefined;
  try {
    const info = await getTransporter().sendMail(message);
    logger.info({
      event: "mail_send_ok",
      toDomain,
      messageId: info && info.messageId,
      response: info && info.response,
      accepted: info && info.accepted,
      rejected: info && info.rejected,
    }, "SMTP send accepted");
    return info;
  } catch (err) {
    logger.error({
      event: "mail_send_failed",
      err: asErr(err),
      errCode: err && err.code,
      responseCode: err && err.responseCode,
      toDomain,
    }, "SMTP send failed");
    throw err;
  }
}

export async function sendVerifyEmail({ to, name, verifyUrl }) {
  const subject = "Verify your Men Of The Line account";
  const text = [
    `Hi ${name},`,
    "",
    "Confirm your email to finish creating your account:",
    verifyUrl,
    "",
    "If you did not sign up, you can ignore this message.",
  ].join("\n");
  const html = `<p>Hi ${escapeHtml(name)},</p>
<p>Confirm your email to finish creating your account:</p>
<p><a href="${escapeAttr(verifyUrl)}">${escapeHtml(verifyUrl)}</a></p>
<p>If you did not sign up, you can ignore this message.</p>`;
  return sendMail({ to, subject, text, html });
}

export async function sendResetEmail({ to, name, resetUrl }) {
  const subject = "Reset your Men Of The Line password";
  const text = [
    `Hi ${name},`,
    "",
    "Use this link to choose a new password (expires soon):",
    resetUrl,
    "",
    "If you did not ask for a reset, you can ignore this message.",
  ].join("\n");
  const html = `<p>Hi ${escapeHtml(name)},</p>
<p>Use this link to choose a new password (expires soon):</p>
<p><a href="${escapeAttr(resetUrl)}">${escapeHtml(resetUrl)}</a></p>
<p>If you did not ask for a reset, you can ignore this message.</p>`;
  return sendMail({ to, subject, text, html });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
