#!/usr/bin/env node
/**
 * Debug SMTP / verification mail delivery using the same env as the app.
 *
 * Usage:
 *   node scripts/send-test-email.js
 *   node scripts/send-test-email.js you@example.com
 *   npm run mail-test -- you@example.com
 *   npm run mail-test -- you@example.com --via-app
 *   npm run mail-test -- info@menoftheline.com
 *
 * Flags:
 *   --to <email>   Recipient (default: SMTP_USER, else SMTP_FROM)
 *   <email>        Same as --to (handy when npm drops flags on Windows)
 *   --verify-only  Only run transporter.verify(); do not send
 *   --force        Send even when AUTH_EMAIL is off (still needs SMTP_*)
 *   --via-app      Send through server/mail.js sendVerifyEmail (same as signup/resend)
 *   --self         Also send a second copy to SMTP_FROM (inbox/bounce check)
 *
 * A 250 "queued" from SMTP means DreamHost accepted the message. If it never
 * arrives, check spam, the From inbox for bounces, and DreamHost mail logs.
 */

import nodemailer from "nodemailer";
import dns from "dns/promises";
import "../server/load-env.js";
import { authEmailEnabled, smtpConfigured } from "../server/auth.js";

function parseArgs(argv) {
  const out = {
    to: null,
    verifyOnly: false,
    force: false,
    viaApp: false,
    self: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--verify-only") out.verifyOnly = true;
    else if (arg === "--force") out.force = true;
    else if (arg === "--via-app") out.viaApp = true;
    else if (arg === "--self") out.self = true;
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
      console.log(
        "Usage: node scripts/send-test-email.js [email|--to email] [--verify-only] [--force] [--via-app] [--self]",
      );
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

function printSendResult(info) {
  console.log("OK — message accepted by SMTP server.");
  console.log(`  messageId: ${info.messageId || "(none)"}`);
  if (info.response) console.log(`  response:  ${info.response}`);
  if (Array.isArray(info.accepted) && info.accepted.length) {
    console.log(`  accepted:  ${info.accepted.join(", ")}`);
  }
  if (Array.isArray(info.rejected) && info.rejected.length) {
    console.warn(`  rejected:  ${info.rejected.join(", ")}`);
  }
}

async function lookupTxt(name) {
  try {
    const rows = await dns.resolveTxt(name);
    return rows.map((parts) => parts.join("")).join(" | ") || "(empty)";
  } catch (err) {
    if (err && (err.code === "ENODATA" || err.code === "ENOTFOUND")) {
      return "(missing)";
    }
    return `(error: ${err && err.code ? err.code : err})`;
  }
}

async function printDnsHints(from) {
  const domain = from.includes("@") ? from.split("@").pop() : "";
  if (!domain) return;
  console.log("=== DNS (delivery reputation) ===");
  console.log(`SPF (${domain}):              ${await lookupTxt(domain)}`);
  console.log(`DMARC (_dmarc.${domain}):     ${await lookupTxt(`_dmarc.${domain}`)}`);
  console.log(
    `DKIM (dreamhost._domainkey): ${await lookupTxt(`dreamhost._domainkey.${domain}`)}`,
  );
  console.log("");
}

function printDiagnostics(settings) {
  const capturePath = env("AUTH_MAIL_CAPTURE_PATH");
  const thisUrl = env("THIS_URL") || "(unset)";
  console.log("=== Auth / SMTP config ===");
  console.log(`AUTH_EMAIL:            ${flagLabel(authEmailEnabled())}`);
  console.log(`smtpConfigured():      ${smtpConfigured() ? "yes" : "no"} (needs SMTP_HOST + SMTP_FROM)`);
  console.log(`THIS_URL:              ${thisUrl}`);
  if (/localhost|127\.0\.0\.1/i.test(thisUrl)) {
    console.warn(
      "  Note: verify links use THIS_URL. Localhost links look phishing-like to Gmail;",
    );
    console.warn("  the message can still be accepted by SMTP and then filtered or dropped.");
  }
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

function printDeliveryChecklist(to, from) {
  console.log("=== If the inbox stays empty ===");
  console.log("SMTP accepted the message (handed off). Next checks:");
  console.log(`  1. Spam / Promotions for ${to}`);
  console.log(`  2. Bounce / reject mail in the ${from} DreamHost inbox`);
  console.log("  3. DreamHost panel → Mail → logs for that messageId");
  console.log(`  4. Retest to your own domain: npm run mail-test -- ${from}`);
  console.log("     (if that arrives, Gmail is filtering; if not, DreamHost is not delivering)");
  console.log("");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const settings = smtpSettings();
  printDiagnostics(settings);
  await printDnsHints(settings.from);

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
    console.error("No valid recipient. Pass an email address.");
    process.exit(1);
  }

  const recipients = [to];
  if (args.self && settings.from && settings.from.toLowerCase() !== to.toLowerCase()) {
    recipients.push(settings.from);
  }

  for (const recipient of recipients) {
    console.log("=== Send test message ===");
    console.log(`To: ${recipient}${args.viaApp ? " (via server/mail.js sendVerifyEmail)" : ""}`);
    try {
      let info;
      if (args.viaApp) {
        const { sendVerifyEmail } = await import("../server/mail.js");
        const thisUrl = env("THIS_URL") || "http://localhost:3000";
        info = await sendVerifyEmail({
          to: recipient,
          name: "Mail Test",
          verifyUrl: `${thisUrl}/verify?token=mail-test-token`,
        });
      } else {
        info = await transporter.sendMail({
          from: settings.from,
          to: recipient,
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
      }
      printSendResult(info);
    } catch (err) {
      console.error("FAILED — sendMail rejected:");
      console.error(`  ${err && err.message ? err.message : err}`);
      if (err && err.response) console.error(`  response: ${err.response}`);
      if (err && err.code) console.error(`  code: ${err.code}`);
      process.exit(1);
    }
    console.log("");
  }

  printDeliveryChecklist(to, settings.from);

  if (!authEmailEnabled()) {
    console.warn("SMTP works, but set AUTH_EMAIL=1 in .env for the app to send verification emails.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
