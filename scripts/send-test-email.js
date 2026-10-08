#!/usr/bin/env node
/**
 * Debug SMTP / verification mail delivery using the same env as the app.
 *
 * Usage:
 *   node scripts/send-test-email.js
 *   node scripts/send-test-email.js you@example.com
 *   node scripts/send-test-email.js --to you@example.com
 *   npm run mail-test -- you@example.com
 *
 * Flags:
 *   --to <email>   Recipient (default: SMTP_USER, else SMTP_FROM)
 *   <email>        Same as --to (handy when npm drops flags on Windows)
 *   --verify-only  Only run transporter.verify(); do not send
 *   --force        Send even when AUTH_EMAIL is off (still needs SMTP_*)
 *
 * Prints AUTH_EMAIL / SMTP_* diagnostics (passwords masked), then
 * nodemailer verify + an optional test message.
 */

import nodemailer from "nodemailer";
import "../server/load-env.js";
import { authEmailEnabled, smtpConfigured } from "../server/auth.js";

function parseArgs(argv) {
  const out = { to: null, verifyOnly: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--verify-only") out.verifyOnly = true;
    else if (arg === "--force") out.force = true;
    else if (arg === "--to") {
      out.to = String(argv[++i] || "").trim();
      if (!out.to) {
        console.error("Missing value for --to");
        process.exit(1);
      }
    } else if (arg.startsWith("--to=")) {
      out.to = arg.slice("--to=".length).trim();
      if (!out.to) {
        console.error("Missing value for --to");
        process.exit(1);
      }
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/send-test-email.js [email|--to email] [--verify-only] [--force]`);
      process.exit(0);
    } else if (!arg.startsWith("-") && arg.includes("@")) {
      out.to = arg.trim();
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return out;
}

function env(name) {
  return String(process.env[name] || "").trim();
}

function mask(value) {
  if (!value) return "(empty)";
  if (value.length <= 4) return "*".repeat(value.length);
  return `${value.slice(0, 2)}…${value.slice(-2)} (${value.length} chars)`;
}

function flagLabel(on) {
  return on ? "on" : "off";
}

function smtpSettings() {
  const host = env("SMTP_HOST");
  const port = Number(process.env.SMTP_PORT) || 587;
  const secure = ["1", "true", "yes", "on"].includes(env("SMTP_SECURE").toLowerCase());
  const user = env("SMTP_USER");
  const pass = String(process.env.SMTP_PASS || "");
  const from = env("SMTP_FROM");
  return { host, port, secure, user, pass, from };
}

function printDiagnostics(settings) {
  const capturePath = env("AUTH_MAIL_CAPTURE_PATH");
  console.log("=== Auth / SMTP config ===");
  console.log(`AUTH_EMAIL:            ${flagLabel(authEmailEnabled())}`);
  console.log(`smtpConfigured():      ${smtpConfigured() ? "yes" : "no"} (needs SMTP_HOST + SMTP_FROM)`);
  console.log(`AUTH_MAIL_CAPTURE_PATH:${capturePath || "(unset)"}`);
  if (capturePath) {
    console.warn("  Note: when set, server/mail.js records messages to this file and does NOT send SMTP.");
  }
  console.log(`SMTP_HOST:             ${settings.host || "(empty)"}`);
  console.log(`SMTP_PORT:             ${settings.port}`);
  console.log(`SMTP_SECURE:           ${settings.secure}`);
  console.log(`SMTP_USER:             ${settings.user || "(empty)"}`);
  console.log(`SMTP_PASS:             ${mask(settings.pass)}`);
  console.log(`SMTP_FROM:             ${settings.from || "(empty)"}`);
  console.log("");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const settings = smtpSettings();
  printDiagnostics(settings);

  const problems = [];
  if (!authEmailEnabled() && !args.force) {
    problems.push("AUTH_EMAIL is off — the app will not send verify/reset mail. Use --force to test SMTP anyway.");
  }
  if (!settings.host) problems.push("SMTP_HOST is empty.");
  if (!settings.from) problems.push("SMTP_FROM is empty.");
  if (settings.user && !settings.pass) problems.push("SMTP_USER is set but SMTP_PASS is empty.");
  if (!settings.user) {
    console.warn("SMTP_USER is empty — connecting without auth (ok for some local relays).");
  }

  if (problems.length) {
    console.error("Config problems:");
    for (const line of problems) console.error(`  - ${line}`);
    console.error("");
  }

  if (!settings.host || !settings.from) {
    console.error("Cannot continue without SMTP_HOST and SMTP_FROM. Fill them in .env and retry.");
    process.exit(1);
  }

  if (!authEmailEnabled() && !args.force) {
    console.error("Refusing to send while AUTH_EMAIL is off. Re-run with --force to probe SMTP only.");
    process.exit(1);
  }

  const transporter = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: settings.user ? { user: settings.user, pass: settings.pass } : undefined,
  });

  console.log("=== SMTP verify() ===");
  try {
    await transporter.verify();
    console.log("OK — server accepted the connection/auth.");
  } catch (err) {
    console.error("FAILED — transporter.verify() rejected:");
    console.error(`  ${err && err.message ? err.message : err}`);
    if (err && err.response) console.error(`  response: ${err.response}`);
    if (err && err.code) console.error(`  code: ${err.code}`);
    process.exit(1);
  }
  console.log("");

  if (args.verifyOnly) {
    console.log("Done (--verify-only).");
    return;
  }

  const to = args.to || settings.user || settings.from;
  if (!to.includes("@")) {
    console.error("No valid recipient. Pass --to you@example.com");
    process.exit(1);
  }

  console.log("=== Send test message ===");
  console.log(`To: ${to}`);
  try {
    const info = await transporter.sendMail({
      from: settings.from,
      to,
      subject: "Men Of The Line — SMTP test",
      text: [
        "This is a test message from scripts/send-test-email.js.",
        "",
        `Host: ${settings.host}:${settings.port} (secure=${settings.secure})`,
        `From: ${settings.from}`,
        `Time: ${new Date().toISOString()}`,
      ].join("\n"),
      html: `<p>This is a test message from <code>scripts/send-test-email.js</code>.</p>
<p>Host: ${settings.host}:${settings.port} (secure=${settings.secure})<br>
From: ${settings.from}<br>
Time: ${new Date().toISOString()}</p>`,
    });
    console.log("OK — message accepted by SMTP server.");
    console.log(`  messageId: ${info.messageId || "(none)"}`);
    if (info.response) console.log(`  response:  ${info.response}`);
    if (Array.isArray(info.accepted) && info.accepted.length) {
      console.log(`  accepted:  ${info.accepted.join(", ")}`);
    }
    if (Array.isArray(info.rejected) && info.rejected.length) {
      console.warn(`  rejected:  ${info.rejected.join(", ")}`);
    }
  } catch (err) {
    console.error("FAILED — sendMail rejected:");
    console.error(`  ${err && err.message ? err.message : err}`);
    if (err && err.response) console.error(`  response: ${err.response}`);
    if (err && err.code) console.error(`  code: ${err.code}`);
    process.exit(1);
  }

  if (!authEmailEnabled()) {
    console.log("");
    console.warn("SMTP works, but set AUTH_EMAIL=1 in .env for the app to send verification emails.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
