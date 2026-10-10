#!/usr/bin/env node
/**
 * Separate Discord bot process for Men of the Line.
 * Calls authenticated /api/v1/bot/* on the game server. Run exactly one instance.
 *
 * Env: DISCORD_BOT_TOKEN, DISCORD_BOT_API_TOKEN, MOTL_API_URL (or THIS_URL)
 * Optional: DISCORD_BOT_GUILD_ID (slash commands + verified role guild)
 * Optional: DISCORD_VERIFIED_ROLE_ID — assign role when MOTL email is verified
 *
 *   npm run discord-bot
 */

import "../server/load-env.js";
import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { asErr, child as childLogger, logger } from "../server/logger.js";
import { discordLoginEnabled } from "../server/auth.js";

const log = childLogger(logger, { component: "discord_bot" });

function requireEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    log.error({ event: "discord_bot_missing_env", key: name }, `missing ${name}`);
    process.exit(1);
  }
  return value;
}

function apiBaseUrl() {
  const raw = String(process.env.MOTL_API_URL || process.env.THIS_URL || "").trim();
  if (!raw) {
    log.error({ event: "discord_bot_missing_env", key: "MOTL_API_URL" }, "missing MOTL_API_URL");
    process.exit(1);
  }
  return raw.replace(/\/$/, "");
}

const BOT_TOKEN = requireEnv("DISCORD_BOT_TOKEN");
const API_TOKEN = requireEnv("DISCORD_BOT_API_TOKEN");
const API_BASE = apiBaseUrl();
const GUILD_ID = String(process.env.DISCORD_BOT_GUILD_ID || "").trim();
const VERIFIED_ROLE_ID = String(process.env.DISCORD_VERIFIED_ROLE_ID || "").trim();
const VERIFIED_ROLE_SYNC_MS = Math.max(
  60_000,
  Number(process.env.DISCORD_VERIFIED_ROLE_SYNC_MS) || 5 * 60_000,
);

const COMMANDS = [
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Men of the Line server health (games, queues, uptime)")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("profile")
    .setDescription("Show a linked Men of the Line profile")
    .addUserOption((opt) => opt
      .setName("user")
      .setDescription("Discord user (defaults to you)")
      .setRequired(false))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("wareffort")
    .setDescription("Community funding and development priorities")
    .toJSON(),
];

async function motlFetch(path) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${API_TOKEN}` },
  });
  if (!res.ok) {
    const err = new Error(`MOTL API ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function formatUptime(sec) {
  const n = Math.max(0, Math.floor(Number(sec) || 0));
  const d = Math.floor(n / 86400);
  const h = Math.floor((n % 86400) / 3600);
  const m = Math.floor((n % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Mirror server/db.js formatPlayDuration without opening SQLite in the bot process. */
function formatPlayDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "—";
  const totalMin = Math.floor(n / 60_000);
  if (totalMin < 1) {
    const sec = Math.floor(n / 1000);
    return sec <= 0 ? "0m" : `${sec}s`;
  }
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

function statusEmbed(snap) {
  const queues = snap.queues || {};
  // snap also includes version, nodeEnv, sockets, matchmakingPaused, workerIndex, pid — kept for later use
  const maint = snap.maintenanceMessage
    ? String(snap.maintenanceMessage).slice(0, 200)
    : "—";
  return new EmbedBuilder()
    .setTitle("Men of the Line — Status")
    .setColor(0x2f5d3a)
    .addFields(
      { name: "Uptime", value: formatUptime(snap.uptimeSec), inline: true },
      {
        name: "Rooms",
        value: [
          `Total ${snap.rooms ?? 0}`,
          `Playing ${snap.playing ?? 0}`,
          `Waiting ${snap.waiting ?? 0}`,
          `Countdown ${snap.countdown ?? 0}`,
        ].join(" · "),
        inline: false,
      },
      {
        name: "Queues",
        value: `Casual ${queues.casual ?? 0} · Ranked ${queues.ranked ?? 0} · Training ${queues.training ?? 0}`,
        inline: false,
      },
      { name: "Listed lobbies", value: String(snap.lobbies ?? 0), inline: true },
      { name: "Maintenance", value: maint, inline: false },
    )
    .setTimestamp();
}

function profileEmbed(profile, base) {
  // profile.tickets / profile.held still come back for self lookups — kept for later use
  const mmrValue = profile.mmrHidden || profile.mmr == null
    ? (profile.placementProgress && profile.placementProgress.label) || "Hidden"
    : String(profile.mmr);
  return new EmbedBuilder()
    .setTitle(profile.name || "Player")
    .setURL(`${base}${profile.profilePath}`)
    .setColor(0x3a4a6b)
    .addFields(
      { name: "Rank", value: String(profile.officerRankLabel || "Ensign"), inline: true },
      { name: "MMR", value: mmrValue, inline: true },
      { name: "Wins", value: String(profile.wins ?? 0), inline: true },
      { name: "Losses", value: String(profile.losses ?? 0), inline: true },
      { name: "Ranked games", value: String(profile.rankedGames ?? 0), inline: true },
      {
        name: "Time played",
        value: formatPlayDuration(profile.timePlayedMs),
        inline: true,
      },
    )
    .setTimestamp();
}

function clip(text, max = 200) {
  const s = String(text || "").trim();
  if (!s) return "—";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function warEffortEmbed(data, base) {
  const fields = [];
  const funding = data.funding || [];
  for (let i = 0; i < funding.length; i += 1) {
    const g = funding[i];
    if (!g) {
      fields.push({ name: `Funding ${i + 1}`, value: "Not configured", inline: false });
      continue;
    }
    const badges = [];
    if (g.goalReached) badges.push("goal reached");
    if (g.status === "fulfilled") badges.push("fulfilled");
    const badgeSuffix = badges.length ? ` · ${badges.join(", ")}` : "";
    fields.push({
      name: `Funding: ${clip(g.title, 80)}`,
      value: [
        clip(g.description),
        `${g.contributedTickets ?? 0}/${g.targetTickets ?? 0} tickets (${g.percentOfTarget ?? 0}%)${badgeSuffix}`,
      ].join("\n"),
      inline: false,
    });
  }
  const development = data.development || [];
  for (let i = 0; i < development.length; i += 1) {
    const d = development[i];
    if (!d) {
      fields.push({ name: `Development ${i + 1}`, value: "Not configured", inline: false });
      continue;
    }
    fields.push({
      name: `Dev: ${clip(d.title, 80)}`,
      value: [
        clip(d.description),
        `${d.percent ?? 0}% · ${d.contributedTickets ?? 0} tickets`,
      ].join("\n"),
      inline: false,
    });
  }
  if (!fields.length) {
    fields.push({ name: "Status", value: "No goals configured yet.", inline: false });
  }
  const embed = new EmbedBuilder()
    .setTitle("War Effort")
    .setURL(`${base}/games`)
    .setColor(0x6b4a2a)
    .addFields(fields)
    .setTimestamp();
  if (data.disclaimer) {
    embed.setFooter({ text: clip(data.disclaimer, 200) });
  }
  return embed;
}

async function registerCommands(client) {
  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
  const appId = client.application?.id;
  if (!appId) {
    throw new Error("Discord application id unavailable");
  }
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(appId, GUILD_ID), { body: COMMANDS });
    log.info({ event: "discord_bot_commands_guild", guildId: GUILD_ID }, "registered guild commands");
  } else {
    await rest.put(Routes.applicationCommands(appId), { body: COMMANDS });
    log.info({ event: "discord_bot_commands_global" }, "registered global commands");
  }
}

async function handleStatus(interaction) {
  await interaction.deferReply();
  try {
    const snap = await motlFetch("/api/v1/bot/status");
    await interaction.editReply({ embeds: [statusEmbed(snap)] });
  } catch (err) {
    log.warn({ event: "discord_bot_status_failed", err: asErr(err) }, "status command failed");
    await interaction.editReply({ content: "Men of the Line server unreachable." });
  }
}

async function handleProfile(interaction) {
  await interaction.deferReply();
  const target = interaction.options.getUser("user") || interaction.user;
  const self = target.id === interaction.user.id;
  try {
    const qs = new URLSearchParams({
      discordId: target.id,
      self: self ? "1" : "0",
    });
    const profile = await motlFetch(`/api/v1/bot/profile?${qs}`);
    if (!profile.linked) {
      const loginHint = discordLoginEnabled()
        ? `Link Discord at ${API_BASE}/login?discord=1 (or Profile → Link Discord).`
        : "Discord login is disabled on this server.";
      await interaction.editReply({
        content: `${target.id === interaction.user.id ? "You have" : "That user has"} no linked Men of the Line account. ${loginHint}`,
      });
      return;
    }
    await interaction.editReply({ embeds: [profileEmbed(profile, API_BASE)] });
  } catch (err) {
    log.warn({ event: "discord_bot_profile_failed", err: asErr(err) }, "profile command failed");
    await interaction.editReply({ content: "Men of the Line server unreachable." });
  }
}

async function handleWarEffort(interaction) {
  await interaction.deferReply();
  try {
    const data = await motlFetch("/api/v1/bot/wareffort");
    if (!data.enabled) {
      await interaction.editReply({ content: "War Effort is not enabled on this server." });
      return;
    }
    await interaction.editReply({ embeds: [warEffortEmbed(data, API_BASE)] });
  } catch (err) {
    log.warn({ event: "discord_bot_wareffort_failed", err: asErr(err) }, "wareffort command failed");
    await interaction.editReply({ content: "Men of the Line server unreachable." });
  }
}

function verifiedRoleSyncEnabled() {
  return Boolean(GUILD_ID && VERIFIED_ROLE_ID);
}

async function applyVerifiedRole(member, eligible) {
  if (!member || !VERIFIED_ROLE_ID) return;
  const has = member.roles.cache.has(VERIFIED_ROLE_ID);
  if (eligible && !has) {
    await member.roles.add(VERIFIED_ROLE_ID, "MOTL verified email");
    log.info({ event: "discord_verified_role_add", userId: member.id }, "added verified role");
  } else if (!eligible && has) {
    await member.roles.remove(VERIFIED_ROLE_ID, "MOTL email no longer verified");
    log.info({ event: "discord_verified_role_remove", userId: member.id }, "removed verified role");
  }
}

async function syncMemberVerifiedRole(member) {
  if (!verifiedRoleSyncEnabled() || !member || member.user?.bot) return;
  try {
    const data = await motlFetch(
      `/api/v1/bot/discord-verified?discordId=${encodeURIComponent(member.id)}`,
    );
    await applyVerifiedRole(member, Boolean(data.eligible));
  } catch (err) {
    log.warn({
      event: "discord_verified_role_member_failed",
      userId: member.id,
      err: asErr(err),
    }, "verified role member sync failed");
  }
}

async function syncVerifiedRoles(client) {
  if (!verifiedRoleSyncEnabled()) return;
  let guild;
  try {
    guild = await client.guilds.fetch(GUILD_ID);
  } catch (err) {
    log.warn({ event: "discord_verified_role_guild_failed", err: asErr(err) }, "guild fetch failed");
    return;
  }
  let want;
  try {
    const data = await motlFetch("/api/v1/bot/discord-verified");
    want = new Set((data.discordIds || []).map(String));
  } catch (err) {
    log.warn({ event: "discord_verified_role_list_failed", err: asErr(err) }, "verified list fetch failed");
    return;
  }

  let added = 0;
  let removed = 0;
  for (const discordId of want) {
    try {
      const member = await guild.members.fetch(discordId);
      if (!member.roles.cache.has(VERIFIED_ROLE_ID)) {
        await member.roles.add(VERIFIED_ROLE_ID, "MOTL verified email");
        added += 1;
      }
    } catch {
      // Member not in guild or role hierarchy error — skip
    }
  }

  try {
    await guild.members.fetch();
    const role = await guild.roles.fetch(VERIFIED_ROLE_ID);
    if (role) {
      for (const member of role.members.values()) {
        if (member.user?.bot) continue;
        if (!want.has(member.id)) {
          try {
            await member.roles.remove(VERIFIED_ROLE_ID, "MOTL email no longer verified");
            removed += 1;
          } catch {
            // ignore
          }
        }
      }
    }
  } catch (err) {
    log.warn({ event: "discord_verified_role_sweep_failed", err: asErr(err) }, "verified role sweep failed");
  }

  log.info({
    event: "discord_verified_role_sync",
    eligible: want.size,
    added,
    removed,
  }, "verified role sync complete");
}

async function main() {
  const intents = [GatewayIntentBits.Guilds];
  if (verifiedRoleSyncEnabled()) {
    intents.push(GatewayIntentBits.GuildMembers);
  }
  const client = new Client({ intents });

  client.once(Events.ClientReady, async () => {
    log.info({ event: "discord_bot_ready", user: client.user?.tag }, "Discord bot ready");
    try {
      await registerCommands(client);
    } catch (err) {
      log.error({ event: "discord_bot_register_failed", err: asErr(err) }, "command registration failed");
    }
    if (verifiedRoleSyncEnabled()) {
      log.info({
        event: "discord_verified_role_enabled",
        guildId: GUILD_ID,
        roleId: VERIFIED_ROLE_ID,
        syncMs: VERIFIED_ROLE_SYNC_MS,
      }, "verified role sync enabled");
      syncVerifiedRoles(client).catch((err) => {
        log.warn({ event: "discord_verified_role_sync_failed", err: asErr(err) }, "initial verified sync failed");
      });
      const timer = setInterval(() => {
        syncVerifiedRoles(client).catch((err) => {
          log.warn({ event: "discord_verified_role_sync_failed", err: asErr(err) }, "verified sync failed");
        });
      }, VERIFIED_ROLE_SYNC_MS);
      timer.unref?.();
    } else if (VERIFIED_ROLE_ID && !GUILD_ID) {
      log.warn({
        event: "discord_verified_role_needs_guild",
      }, "DISCORD_VERIFIED_ROLE_ID set but DISCORD_BOT_GUILD_ID missing; role sync disabled");
    }
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    if (String(member.guild?.id) !== GUILD_ID) return;
    await syncMemberVerifiedRole(member);
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      if (interaction.commandName === "status") await handleStatus(interaction);
      else if (interaction.commandName === "profile") await handleProfile(interaction);
      else if (interaction.commandName === "wareffort") await handleWarEffort(interaction);
    } catch (err) {
      log.error({ event: "discord_bot_interaction_failed", err: asErr(err) }, "interaction failed");
      const msg = { content: "Something went wrong.", ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(msg).catch(() => {});
      } else {
        await interaction.reply(msg).catch(() => {});
      }
    }
  });

  client.on("error", (err) => {
    log.error({ event: "discord_bot_client_error", err: asErr(err) }, "Discord client error");
  });

  await client.login(BOT_TOKEN);
}

main().catch((err) => {
  log.fatal({ event: "discord_bot_fatal", err: asErr(err) }, "Discord bot failed to start");
  process.exit(1);
});
