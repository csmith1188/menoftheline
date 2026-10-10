import { randomBytes } from "crypto";

const DISCORD_AUTHORIZE = "https://discord.com/api/oauth2/authorize";
const DISCORD_TOKEN = "https://discord.com/api/oauth2/token";
const DISCORD_ME = "https://discord.com/api/users/@me";
/** identify for profile; email for accounts.email (Discord may omit if unavailable). */
const SCOPES = "identify email";

export function discordClientId() {
  return String(process.env.DISCORD_CLIENT_ID || "").trim();
}

export function discordClientSecret() {
  return String(process.env.DISCORD_CLIENT_SECRET || "").trim();
}

/** Client id + secret present (required to run the OAuth exchange). */
export function discordConfigured() {
  return Boolean(discordClientId() && discordClientSecret());
}

export function newDiscordOAuthState() {
  return randomBytes(24).toString("base64url");
}

export function discordAuthorizeUrl(redirectUri, state) {
  const params = new URLSearchParams({
    client_id: discordClientId(),
    response_type: "code",
    redirect_uri: String(redirectUri),
    scope: SCOPES,
    state: String(state),
  });
  return `${DISCORD_AUTHORIZE}?${params}`;
}

/**
 * Exchange an authorization code for a Discord user profile.
 * With DISCORD_OAUTH_MOCK=1, `code` is base64url JSON `{ id, username?, global_name? }`.
 */
export async function fetchDiscordUserFromCode(code, redirectUri) {
  if (process.env.DISCORD_OAUTH_MOCK === "1") {
    try {
      const raw = Buffer.from(String(code || ""), "base64url").toString("utf8");
      const data = JSON.parse(raw);
      const id = data && data.id != null ? String(data.id).trim() : "";
      if (!id) throw new Error("invalid_mock_code");
      return normalizeDiscordProfile({
        id,
        username: String(data.username || "Discord").trim() || "Discord",
        global_name: data.global_name != null ? String(data.global_name).trim() : null,
        email: data.email,
        verified: data.verified,
      });
    } catch {
      throw new Error("invalid_mock_code");
    }
  }

  if (!discordConfigured()) {
    throw new Error("discord_not_configured");
  }

  const body = new URLSearchParams({
    client_id: discordClientId(),
    client_secret: discordClientSecret(),
    grant_type: "authorization_code",
    code: String(code || ""),
    redirect_uri: String(redirectUri),
  });
  const tokenRes = await fetch(DISCORD_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!tokenRes.ok) {
    throw new Error("discord_token_failed");
  }
  const tokenJson = await tokenRes.json();
  const access = tokenJson && tokenJson.access_token;
  if (!access) throw new Error("discord_token_failed");

  const meRes = await fetch(DISCORD_ME, {
    headers: { authorization: `Bearer ${access}` },
  });
  if (!meRes.ok) throw new Error("discord_user_failed");
  const me = await meRes.json();
  const id = me && me.id != null ? String(me.id).trim() : "";
  if (!id) throw new Error("discord_user_failed");
  return normalizeDiscordProfile({
    id,
    username: String(me.username || "Discord").trim() || "Discord",
    global_name: me.global_name != null ? String(me.global_name).trim() : null,
    email: me.email,
    verified: me.verified,
  });
}

/** Normalize Discord @me / mock payload into the fields we persist. */
function normalizeDiscordProfile({ id, username, global_name, email, verified }) {
  const rawEmail = email != null ? String(email).trim() : "";
  return {
    id: String(id),
    username: String(username || "Discord").trim() || "Discord",
    global_name: global_name != null ? String(global_name).trim() : null,
    email: rawEmail || null,
    verified: verified === true || verified === 1 || verified === "true",
  };
}

/** Prefer global display name, then username. */
export function discordDisplayName(user) {
  if (!user) return "Discord";
  const global = String(user.global_name || "").trim();
  if (global) return global;
  return String(user.username || "Discord").trim() || "Discord";
}
