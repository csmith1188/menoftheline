/**
 * Centralized Pino logger for Men of the Line.
 * JSON to stdout (and warn+ to stderr) so PM2 can capture and rotate logs.
 * Never pass passwords, tokens, PINs, or session secrets into log fields.
 */

import pino from "pino";

const REDACT_PATHS = [
  "password",
  "passwordHash",
  "password_hash",
  "pin",
  "token",
  "authorization",
  "cookie",
  "smtpPass",
  "SMTP_PASS",
  "apiKey",
  "API_KEY",
  "sessionSecret",
  "SESSION_SECRET",
  "client_secret",
  "access_token",
  "refresh_token",
  "csrfToken",
  "_csrf",
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "headers.cookie",
  "headers.api",
];

function resolveLevel() {
  const raw = String(process.env.LOG_LEVEL || "").trim().toLowerCase();
  if (raw) return raw;
  return "info";
}

function usePretty() {
  if (process.env.NODE_ENV === "production") return false;
  if (process.env.LOG_PRETTY === "0" || process.env.LOG_PRETTY === "false") return false;
  if (process.env.LOG_PRETTY === "1" || process.env.LOG_PRETTY === "true") return true;
  return process.env.NODE_ENV === "development" && Boolean(process.stdout.isTTY);
}

function buildStreams(level) {
  if (usePretty()) {
    return [
      {
        level,
        stream: pino.transport({
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname,app,env",
          },
        }),
      },
    ];
  }
  // dedupe: warn+ only hits stderr; info/debug only stdout (no duplicate lines).
  return [
    { level, stream: process.stdout },
    { level: "warn", stream: process.stderr },
  ];
}

const level = resolveLevel();

const base = pino(
  {
    level,
    base: {
      app: "motl",
      env: process.env.NODE_ENV || "development",
    },
    redact: {
      paths: REDACT_PATHS,
      censor: "[Redacted]",
    },
    serializers: {
      err: pino.stdSerializers.err,
    },
  },
  pino.multistream(buildStreams(level), { dedupe: true }),
);

/** Root logger. Prefer child() for matchId / userId / socketId context. */
export const logger = base;

/** Create a child logger with structured bindings. */
export function child(bindings) {
  return base.child(bindings || {});
}

/**
 * Log without throwing. Use from match tick / command paths so a bad
 * serialize or stream error cannot interrupt a game.
 */
export function safeLog(log, levelName, obj, msg) {
  try {
    const target = log && typeof log[levelName] === "function" ? log : base;
    if (msg === undefined) target[levelName](obj);
    else target[levelName](obj, msg);
  } catch {
    // Logging must never crash the process or a match.
  }
}

/** Normalize an unknown thrown value for the `err` serializer. */
export function asErr(err) {
  if (err instanceof Error) return err;
  const wrapped = new Error(err == null ? "unknown error" : String(err));
  return wrapped;
}

/** Sampled warn helper: logs the first hit and then every `every` thereafter (1, 1+N, …). */
export function createSampler(every = 50) {
  let count = 0;
  const n = Math.max(1, Number(every) || 50);
  return () => {
    count += 1;
    return count === 1 || (count - 1) % n === 0;
  };
}

export default logger;
