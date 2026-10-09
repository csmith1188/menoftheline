/**
 * Resolve a deploy-scoped asset version for cache busting (?v=) and /api/v1/version.
 * Prefer ASSET_VERSION env, then git short SHA, then CLIENT_VERSION.
 */
import { execFileSync } from "node:child_process";
import { CLIENT_VERSION } from "../shared/protocol.js";

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   root?: string,
 *   execGit?: (root: string) => string,
 * }} [opts]
 * @returns {string}
 */
export function resolveAssetVersion(opts = {}) {
  const env = opts.env || process.env;
  const fromEnv = String(env.ASSET_VERSION || "").trim();
  if (fromEnv) return fromEnv;

  const root = opts.root || process.cwd();
  const execGit = opts.execGit || defaultExecGit;
  try {
    const sha = String(execGit(root) || "").trim();
    if (sha) return sha;
  } catch {
    // no git / bare deploy
  }

  return String(CLIENT_VERSION || "0").trim() || "0";
}

/** @param {string} root */
function defaultExecGit(root) {
  return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000,
  });
}
