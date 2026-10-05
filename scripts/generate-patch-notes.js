#!/usr/bin/env node
/**
 * Compare shared/config.js and shared/units.js against a git base (default HEAD)
 * and prepend a human-readable news entry to data/news.json.
 *
 * Usage:
 *   npm run patch-notes
 *   npm run patch-notes -- --dry-run
 *   npm run patch-notes -- --base HEAD~1 --title "Balance Pass" --summary "Tweaks."
 *   npm run patch-notes -- --yes
 *
 * Flags:
 *   --base <ref>     Git ref for the "before" values (default: HEAD)
 *   --dry-run        Print the entry without writing news.json
 *   --yes            Skip interactive confirm (uses --title/--summary or defaults)
 *   --title <text>   News title
 *   --summary <text> News summary
 *   --date <YYYY-MM-DD>  Entry date (default: today, local)
 */

import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import { execFileSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NEWS_PATH = path.join(ROOT, "data", "news.json");
const CONFIG_REL = "shared/config.js";
const UNITS_REL = "shared/units.js";

/**
 * Short player-facing names for CONFIG keys. Prefer these over raw JSDoc
 * when present so patch lines read like news copy.
 */
const CONFIG_SHORT_LABELS = {
  canvasWidth: "Canvas width",
  canvasHeight: "Canvas height",
  capitalRadius: "Keep size",
  startGold: "Starting gold",
  baseIncome: "Base gold income",
  centerIncome: "Top-lane gold income pool",
  centerLand: "Bottom-lane land income pool",
  laneCenterEase: "Lane-center easing time",
  bankCount: "Banks per side",
  bankBaseCost: "First bank cost",
  bankCostStep: "Extra cost per bank already unlocked",
  bankIncomePer: "Gold income per unlocked bank",
  massTaxRate: "Unit upkeep (fraction of gold cost per second)",
  bankUnlockAt: "Bank unlock times",
  upgradeBaseCost: "First upgrade land cost",
  upgradeCostStep: "Extra land cost per upgrade rank",
  upgradeMax: "Max upgrade rank",
  speedUpgradeAmount: "Speed gained per upgrade",
  damageUpgradeAmount: "Damage gained per upgrade",
  armorPerUpgrade: "Armor gained per upgrade",
  armorCap: "Maximum armor damage reduction",
  unitLandCostRatio: "Elite (yellow) alternate land cost (fraction of gold cost)",
  lightUnitLandCostRatio: "Light (white) alternate land cost (fraction of gold cost)",
  townProduceRate: "Town research land per second",
  uiScale: "HUD scale",
  touchTargetPx: "Minimum touch target size",
  capitalHP: "Keep hit points",
  capitalCannonRange: "Keep gun range",
  capitalCannonDamage: "Keep gun damage",
  capitalCannonAttackCooldown: "Keep gun reload time",
  keepTargetDistanceOffsetPaces: "Keep target-distance offset",
  meleeSlack: "Melee reach slack",
  minDamageFactor: "Minimum ranged damage at max range",
  damageVariance: "Random damage variance",
  fatigueIdleRate: "Fatigue recovered while halted",
  fatigueCombatRate: "Fatigue gained while charging or in melee",
  fatigueOnShot: "Fatigue added when shot",
  fatigueRecoverRate: "Fatigue recovered near own keep",
  topLanePaces: "Top lane length (paces)",
  bottomLanePaces: "Bottom lane length (paces)",
  perfectLinePaces: "Perfect-line window",
  inLinePaces: "In-line window",
  footprintPaces: "Unit footprint length",
  gunPenetratePaces: "Field gun bounce gap",
  crossLaneMaxPaces: "Max cross-lane shot path",
  fortDistancePaces: "Fort distance from keep",
  officerRestorePaces: "Officer / Color Guard restore reach",
  keepRestoreBase: "Keep aura restore rate",
  keepAuraPaces: "Keep restore aura bands",
  missingHealthDamageRatio: "Damage loss from missing health",
  fatigueOnMelee: "Fatigue added on melee",
  pushbackPerPace: "Pushback needed per pace back",
  fatiguePerPace: "Fatigue when a pushback pace is blocked",
  quarterMark: "Fort / cover line position",
  quarterArmor: "Fort cover armor",
  woodsCover: "Woods cover",
  hillCover: "Hill cover",
  peakCover: "Peak cover",
  fortColorSlow: "Enemy speed in a fort's colored band",
  reformSpeedFactor: "Reform speed factor",
  checkpointCount: "Town count",
  captureRadius: "Town capture radius",
};

/** Layman labels for unit-stat keys (units.js has no per-key JSDoc). */
const UNIT_STAT_LABELS = {
  hp: "hit points",
  rangedDamage: "ranged damage",
  meleeDamage: "melee damage",
  range: "shooting range",
  engageRange: "engage range (fraction of max range before opening fire)",
  chargeSpeed: "charge speed multiplier",
  flankMultiplier: "flank damage multiplier",
  chargeMultiplier: "charge damage multiplier",
  rangedCooldown: "seconds between shots",
  meleeCooldown: "seconds between melee hits",
  speed: "move speed",
  cost: "gold cost",
  lineBonus: "perfect-line damage bonus",
  fightsMelee: "fights in melee",
  splash: "splash (bounce) fraction",
  restoreRange: "restore aura range",
  restoreRate: "restore rate",
  restoreHealth: "restores health (not only fatigue)",
  officerDamageMultiplier: "damage vs officers",
  shootingPushback: "pushback from shots",
  meleePushback: "pushback from charge melee",
  pushbackTakenFactor: "pushback taken multiplier",
  projectileSize: "projectile size",
  projectileSpeed: "projectile speed",
  projectileColor: "projectile color",
  radius: "unit radius",
  fatigue: "fatigue pool",
  landCost: "land cost",
};

const UNIT_NAME_FALLBACKS = {
  troop: "Troop",
  skirmisher: "Skirmisher",
  dragoon: "Dragoon",
  cannon: "Field Gun",
  officer: "Officer",
  grenadier: "Grenadier",
  rifle: "Rifles",
  lancer: "Lancer",
  howitzer: "Howitzer",
  colorGuard: "Color Guard",
};

function parseArgs(argv) {
  const out = {
    base: "HEAD",
    dryRun: false,
    yes: false,
    title: null,
    summary: null,
    date: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--yes" || arg === "-y") out.yes = true;
    else if (arg === "--base") out.base = argv[++i];
    else if (arg === "--title") out.title = argv[++i];
    else if (arg === "--summary") out.summary = argv[++i];
    else if (arg === "--date") out.date = argv[++i];
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function usage() {
  console.log(`Generate patch notes from config.js / units.js changes and prepend to news.json.

Usage:
  npm run patch-notes -- [options]

Options:
  --base <ref>           Compare against this git ref (default: HEAD)
  --dry-run              Show the entry without writing
  --yes, -y              Write without interactive confirm
  --title <text>         News title
  --summary <text>       News summary
  --date <YYYY-MM-DD>    Entry date (default: today)
  --help                 Show this help`);
}

function gitShow(ref, relPath) {
  try {
    return execFileSync("git", ["show", `${ref}:${relPath}`], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    const msg = err.stderr || err.message || String(err);
    throw new Error(`Could not read ${relPath} at ${ref}: ${msg}`);
  }
}

function readWorking(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

async function importFromSource(configSource, unitsSource) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "motl-patch-notes-"));
  const shared = path.join(dir, "shared");
  fs.mkdirSync(shared);
  const configPath = path.join(shared, "config.js");
  const unitsPath = path.join(shared, "units.js");
  fs.writeFileSync(configPath, configSource);
  fs.writeFileSync(unitsPath, unitsSource);
  try {
    const bust = `?t=${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const configMod = await import(pathToFileURL(configPath).href + bust);
    const unitsMod = await import(pathToFileURL(unitsPath).href + bust);
    return {
      CONFIG: configMod.CONFIG,
      UNIT_STATS: unitsMod.UNIT_STATS,
      UNIT_LABELS: unitsMod.UNIT_LABELS || {},
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Pull JSDoc text immediately above each `key:` in source (including nested). */
function extractJsdocLabels(source) {
  const labels = new Map();
  const re = /\/\*\*([\s\S]*?)\*\/\s*([A-Za-z_][\w]*)\s*:/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const raw = match[1]
      .split("\n")
      .map((line) => line.replace(/^\s*\*\s?/, "").trim())
      .filter((line) => line && !line.startsWith("@"))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (raw) labels.set(match[2], raw);
  }
  return labels;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function valuesEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => valuesEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (!valuesEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

function formatScalar(value) {
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value);
    if (Number.isInteger(value)) return String(value);
    const fixed = Number(value.toPrecision(6));
    return String(fixed);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(formatScalar).join(", ")}]`;
  if (isPlainObject(value)) return JSON.stringify(value);
  return String(value);
}

function humanizeKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
}

function stripTrailingPeriod(text) {
  return String(text || "").replace(/\.\s*$/, "").trim();
}

function configLabel(pathKeys, jsdoc) {
  const leaf = pathKeys[pathKeys.length - 1];
  const root = pathKeys[0];
  if (pathKeys.length === 1 && CONFIG_SHORT_LABELS[root]) {
    return CONFIG_SHORT_LABELS[root];
  }
  if (pathKeys.length > 1 && CONFIG_SHORT_LABELS[root]) {
    return `${CONFIG_SHORT_LABELS[root]} (${humanizeKey(leaf)})`;
  }
  const rootDoc = jsdoc.get(root);
  if (pathKeys.length === 1) {
    return stripTrailingPeriod(rootDoc) || humanizeKey(root);
  }
  const leafDoc = jsdoc.get(leaf);
  if (leafDoc) return stripTrailingPeriod(leafDoc);
  if (rootDoc) {
    return `${stripTrailingPeriod(rootDoc)} (${humanizeKey(leaf)})`;
  }
  return pathKeys.map(humanizeKey).join(" › ");
}

function unitStatLabel(key) {
  return UNIT_STAT_LABELS[key] || humanizeKey(key);
}

function unitDisplayName(type, labels) {
  return labels[type] || UNIT_NAME_FALLBACKS[type] || humanizeKey(type);
}

function changeVerb(before, after) {
  if (typeof before === "number" && typeof after === "number") {
    if (after > before) return "increased";
    if (after < before) return "decreased";
  }
  if (typeof before === "boolean" && typeof after === "boolean") {
    return after ? "enabled" : "disabled";
  }
  return "changed";
}

function sentenceForChange(label, before, after) {
  if (before === undefined) {
    return `${capitalize(label)} added (${formatScalar(after)}).`;
  }
  if (after === undefined) {
    return `${capitalize(label)} removed (was ${formatScalar(before)}).`;
  }
  if (typeof before === "boolean" && typeof after === "boolean") {
    return `${capitalize(label)} ${after ? "enabled" : "disabled"}.`;
  }
  const verb = changeVerb(before, after);
  return `${capitalize(label)} ${verb} from ${formatScalar(before)} to ${formatScalar(after)}.`;
}

function capitalize(text) {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function collectLeafChanges(before, after, pathKeys, out) {
  if (valuesEqual(before, after)) return;

  const beforeObj = isPlainObject(before);
  const afterObj = isPlainObject(after);
  if (beforeObj || afterObj) {
    const keys = new Set([
      ...Object.keys(beforeObj ? before : {}),
      ...Object.keys(afterObj ? after : {}),
    ]);
    for (const key of keys) {
      collectLeafChanges(
        beforeObj ? before[key] : undefined,
        afterObj ? after[key] : undefined,
        [...pathKeys, key],
        out,
      );
    }
    return;
  }

  out.push({ pathKeys, before, after });
}

function diffConfig(beforeConfig, afterConfig, jsdoc) {
  const leaves = [];
  collectLeafChanges(beforeConfig, afterConfig, [], leaves);
  return leaves.map(({ pathKeys, before, after }) =>
    sentenceForChange(configLabel(pathKeys, jsdoc), before, after),
  );
}

function flattenUnitStats(stats) {
  const out = {};
  for (const [key, value] of Object.entries(stats || {})) {
    if (isPlainObject(value)) continue;
    out[key] = value;
  }
  return out;
}

function diffUnits(beforeStats, afterStats, unitLabels) {
  const types = new Set([
    ...Object.keys(beforeStats || {}),
    ...Object.keys(afterStats || {}),
  ]);
  /** @type {Map<string, { key: string, before: unknown, after: unknown, units: string[] }>} */
  const groups = new Map();

  for (const type of types) {
    const beforeUnit = beforeStats[type];
    const afterUnit = afterStats[type];
    if (!beforeUnit && afterUnit) {
      const name = unitDisplayName(type, unitLabels);
      groups.set(`__added__:${type}`, {
        key: "__added__",
        before: undefined,
        after: true,
        units: [name],
        custom: `${name} added as a unit type.`,
      });
      continue;
    }
    if (beforeUnit && !afterUnit) {
      const name = unitDisplayName(type, unitLabels);
      groups.set(`__removed__:${type}`, {
        key: "__removed__",
        before: true,
        after: undefined,
        units: [name],
        custom: `${name} removed as a unit type.`,
      });
      continue;
    }

    const beforeFlat = flattenUnitStats(beforeUnit);
    const afterFlat = flattenUnitStats(afterUnit);
    const keys = new Set([...Object.keys(beforeFlat), ...Object.keys(afterFlat)]);
    const name = unitDisplayName(type, unitLabels);
    for (const key of keys) {
      const b = beforeFlat[key];
      const a = afterFlat[key];
      if (valuesEqual(b, a)) continue;
      const sig = `${key}\0${JSON.stringify(b)}\0${JSON.stringify(a)}`;
      let group = groups.get(sig);
      if (!group) {
        group = { key, before: b, after: a, units: [] };
        groups.set(sig, group);
      }
      group.units.push(name);
    }
  }

  const allNames = [...types]
    .filter((t) => beforeStats[t] && afterStats[t])
    .map((t) => unitDisplayName(t, unitLabels));

  const items = [];
  for (const group of groups.values()) {
    if (group.custom) {
      items.push(group.custom);
      continue;
    }
    const label = unitStatLabel(group.key);
    const who =
      group.units.length === allNames.length && allNames.length > 1
        ? "All units"
        : group.units.length > 3
          ? `${group.units.slice(0, 3).join(", ")} (+${group.units.length - 3} more)`
          : group.units.join(", ");
    items.push(sentenceForChange(`${who} ${label}`, group.before, group.after));
  }

  items.sort((a, b) => a.localeCompare(b));
  return items;
}

function todayLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function defaultTitle(configItems, unitItems) {
  if (configItems.length && unitItems.length) return "Balance and Unit Tweaks";
  if (unitItems.length) return "Unit Balance";
  if (configItems.length) return "Gameplay Balance";
  return "Patch Notes";
}

function defaultSummary(configItems, unitItems) {
  const parts = [];
  if (configItems.length) {
    parts.push(
      `${configItems.length} config ${configItems.length === 1 ? "change" : "changes"}`,
    );
  }
  if (unitItems.length) {
    parts.push(
      `${unitItems.length} unit-stat ${unitItems.length === 1 ? "change" : "changes"}`,
    );
  }
  if (!parts.length) return "No balance changes detected.";
  return parts.join("; ") + ".";
}

function ask(rl, question, fallback) {
  const hint = fallback != null && fallback !== "" ? ` [${fallback}]` : "";
  return new Promise((resolve) => {
    rl.question(`${question}${hint}: `, (answer) => {
      const trimmed = String(answer || "").trim();
      resolve(trimmed || fallback || "");
    });
  });
}

function loadNews() {
  const raw = fs.readFileSync(NEWS_PATH, "utf8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error("news.json must be a JSON array");
  return data;
}

function writeNews(entries) {
  fs.writeFileSync(NEWS_PATH, `${JSON.stringify(entries, null, 2)}\n`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }

  const beforeConfigSrc = gitShow(opts.base, CONFIG_REL);
  const beforeUnitsSrc = gitShow(opts.base, UNITS_REL);
  const afterConfigSrc = readWorking(CONFIG_REL);
  const afterUnitsSrc = readWorking(UNITS_REL);

  if (beforeConfigSrc === afterConfigSrc && beforeUnitsSrc === afterUnitsSrc) {
    console.error(
      `No changes in ${CONFIG_REL} or ${UNITS_REL} compared to ${opts.base}.`,
    );
    process.exitCode = 1;
    return;
  }

  const before = await importFromSource(beforeConfigSrc, beforeUnitsSrc);
  const after = await importFromSource(afterConfigSrc, afterUnitsSrc);
  const jsdoc = extractJsdocLabels(afterConfigSrc);
  // Prefer newer docs; fall back to base for removed keys.
  for (const [key, label] of extractJsdocLabels(beforeConfigSrc)) {
    if (!jsdoc.has(key)) jsdoc.set(key, label);
  }

  const unitLabels = { ...before.UNIT_LABELS, ...after.UNIT_LABELS };
  const configItems =
    beforeConfigSrc === afterConfigSrc
      ? []
      : diffConfig(before.CONFIG, after.CONFIG, jsdoc);
  const unitItems =
    beforeUnitsSrc === afterUnitsSrc
      ? []
      : diffUnits(before.UNIT_STATS, after.UNIT_STATS, unitLabels);

  const items = [...configItems, ...unitItems];
  if (!items.length) {
    console.error(
      "Files differ from the base, but no CONFIG / UNIT_STATS value changes were detected.",
    );
    process.exitCode = 1;
    return;
  }

  let title = opts.title || defaultTitle(configItems, unitItems);
  let summary = opts.summary || defaultSummary(configItems, unitItems);
  let date = opts.date || todayLocal();

  console.log("\nProposed patch notes:\n");
  console.log(`  date:    ${date}`);
  console.log(`  title:   ${title}`);
  console.log(`  summary: ${summary}`);
  console.log("  items:");
  for (const item of items) console.log(`    - ${item}`);
  console.log("");

  if (!opts.yes && !opts.dryRun && process.stdin.isTTY) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      title = await ask(rl, "Title", title);
      summary = await ask(rl, "Summary", summary);
      date = await ask(rl, "Date (YYYY-MM-DD)", date);
      const confirm = await ask(rl, "Write to news.json? (y/N)", "N");
      if (!/^y(es)?$/i.test(confirm)) {
        console.log("Aborted; news.json unchanged.");
        return;
      }
    } finally {
      rl.close();
    }
  } else if (!opts.yes && !opts.dryRun && !process.stdin.isTTY) {
    console.error("Non-interactive stdin: pass --yes or --dry-run.");
    process.exitCode = 1;
    return;
  }

  const entry = { date, title, summary, items };

  if (opts.dryRun) {
    console.log("Dry run — would prepend:\n");
    console.log(JSON.stringify(entry, null, 2));
    return;
  }

  const news = loadNews();
  news.unshift(entry);
  writeNews(news);
  console.log(`Prepended "${title}" to ${path.relative(ROOT, NEWS_PATH)}.`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
