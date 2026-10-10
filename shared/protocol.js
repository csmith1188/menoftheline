/**
 * Client/server wire protocol versioning for packaged shells.
 * Bump PROTOCOL_VERSION on breaking snapshot, command, or /api/v1 shape changes.
 * Additive JSON fields do not require a bump; older clients ignore unknown keys.
 */

export const PROTOCOL_VERSION = 2;

/** Semver string for packaged client builds (also written into dist/client/boot.json). */
export const CLIENT_VERSION = "0.1.0";

/**
 * @param {unknown} value
 * @returns {number|null} finite protocol integer, or null if absent/invalid
 */
export function parseProtocol(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

/**
 * Missing protocol = legacy client (website cookie sockets, older native builds) → allow.
 * Present but below min → outdated.
 * @param {number|null|undefined} clientProtocol
 * @param {number} minProtocol
 */
export function isClientOutdated(clientProtocol, minProtocol) {
  if (clientProtocol == null) return false;
  return clientProtocol < minProtocol;
}
