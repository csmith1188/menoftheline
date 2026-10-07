import { generateKeyPairSync } from "crypto";
import jwt from "jsonwebtoken";

const primary = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });

export const publicPem = primary.publicKey.export({ type: "spki", format: "pem" });
export const privatePem = primary.privateKey.export({ type: "pkcs8", format: "pem" });
export const otherPrivatePem = other.privateKey.export({ type: "pkcs8", format: "pem" });
export const publicKeyB64 = Buffer.from(publicPem).toString("base64");

export function signFormbar(payload, key = privatePem, options = {}) {
  return jwt.sign(payload, key, { algorithm: "RS256", ...options });
}

export function unsignedFormbar(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.`;
}
