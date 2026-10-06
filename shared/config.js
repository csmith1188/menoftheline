/** Tunable match numbers for the board, economy, combat rules, and UI. */
export const CONFIG = {
  // Board

  /** Match canvas width, in pixels. */
  canvasWidth: 960,
  /** Match canvas height, in pixels. */
  canvasHeight: 620,
  /** Player keep, left side of the top band. */
  playerCapital: { x: 72, y: 150 },
  /** Enemy keep, right side of the top band. */
  enemyCapital: { x: 888, y: 150 },
  /** Keep circle radius, in pixels. */
  capitalRadius: 34,

  // Top lane

  /** Vertical thickness of the parallel top lane. */
  topLaneHeight: 112,
  /** Parallel travel rows in the top lane. */
  topSublaneCount: 5,
  /** Distance from lane center to the outermost top sublane. */
  topSublaneSpread: 40,
  /** Stroke width used when drawing one top sublane. */
  topSublaneWidth: 14,

  // Bottom lane

  /** Parallel travel rows on the bottom (concentric half-circles). */
  bottomSublaneCount: 3,
  /** Radial gap between bottom half-circles. Close enough for adjacent melee. */
  bottomSublaneSpread: 22,
  /** How many segments approximate each bottom arc for movement. */
  bottomArcSegments: 32,
  /** Stroke width used when drawing one bottom sublane. */
  bottomSublaneWidth: 18,

  // Gold, land, and banks

  /** Gold each side starts with. */
  startGold: 600,
  /** Gold per second before the top-lane share and banks. */
  baseIncome: 10,
  /** Extra gold per second split by the top-lane center ratio. */
  centerIncome: 10,
  /** Land per second split by the bottom-lane center ratio. */
  centerLand: 10,
  /**
   * Time constant, in seconds, for the lane-center line. Each interval
   * of this length closes about two thirds of the gap after a sudden
   * change in push. Gold and land use this eased share. The client
   * also glides the drawn line between snapshots using this pace.
   */
  laneCenterEase: 1.0,
  /** How many banks sit above each capital. */
  bankCount: 3,
  /** Gold to unlock the first bank. */
  bankBaseCost: 240,
  /** Extra gold per bank already unlocked on that side. */
  bankCostStep: 120,
  /** Gold/sec granted per unlock, times current unlocked count. */
  bankIncomePer: 3,
  /** Mass tax per second: this fraction of a living unit's gold cost. */
  massTaxRate: 0.005,
  /** Match time (seconds) when each bank becomes purchasable. */
  bankUnlockAt: [0, 120, 240],

  // Upgrades

  /** Land price of the first rank of speed, armor, or damage. */
  upgradeBaseCost: 120,
  /** Extra land added to the upgrade price for each rank already owned. */
  upgradeCostStep: 60,
  /** Highest rank for speed, armor, and damage. */
  upgradeMax: 5,
  /** Added to the side speed multiplier per speed purchase. */
  speedUpgradeAmount: 0.1,
  /** Extra outgoing damage per damage purchase. */
  damageUpgradeAmount: 0.05,
  /** Incoming damage reduction per armor purchase. */
  armorPerUpgrade: 0.05,
  /** Armor cannot reduce incoming damage below this remainder. */
  armorCap: 0.7,
  /** Elite (yellow) alternate land price as a fraction of its gold cost. */
  unitLandCostRatio: 0.2,
  /** Light (white) alternate land price as a fraction of its gold cost. */
  lightUnitLandCostRatio: 0.1,
  /** Hussar melee pack bonus per other Hussar in melee reach. */
  cavalryPackBonus: 0.25,
  /** Guerilla stealth: hidden unless a viewer is this close (paces). */
  guerrillaStealthPaces: 50,
  /** Guerilla stealth: remain revealed this long after shooting (seconds). */
  guerrillaShotRevealSec: 1,
  /** Land invested per second by one producing town. */
  townProduceRate: 2,

  // Interface

  /** Bank button width and height, in pixels, before UI scale. */
  bankButtonSize: 40,
  /** Gap between bank buttons, in pixels, before UI scale. */
  bankButtonGap: 8,
  /** Enemy bank buttons are smaller so the settings gear fits top-right. */
  enemyBankScale: 0.62,
  /** Logical canvas pixels kept free on the right for the settings gear. */
  gearReserve: 56,
  /** Buy-button width, in pixels, before UI scale. */
  buyButtonW: 80,
  /** Buy-button height, in pixels, before UI scale. Name and cost stack as two rows. */
  buyButtonH: 64,
  /** Gap between buy buttons, in pixels, before UI scale. */
  buyButtonGap: 4,
  /** Multiplier for on-canvas HUD, banks, and buy buttons. */
  uiScale: 1.25,
  /** Minimum on-screen tap size in CSS pixels. */
  touchTargetPx: 44,
  /** Minimum drag, in canvas pixels, before a pull changes sublane. */
  laneDragMin: 12,

  // Keeps

  /** Hit points of a keep. */
  capitalHP: 500,
  /** Farthest the keep gun can shoot, in pixels. */
  capitalCannonRange: 200,
  /** Shell damage of the keep gun before falloff. */
  capitalCannonDamage: 30,
  /** Seconds between keep-gun shots. */
  capitalCannonAttackCooldown: 1,
  /** Paces subtracted from Keep distance when ranking ranged targets only. */
  keepTargetDistanceOffsetPaces: 50,
  /**
   * When true, after picking the closest eligible target (or best
   * Skirmisher/Rifles tier), if other eligible targets share an In Line
   * station with that pick, aim at the one whose row is closest to the
   * shooter. Equal row distance breaks by closer shot paces. Spreads
   * volleys across a facing line instead of stacking on one body.
   */
  preferNearestRowAmongAlignedTargets: true,

  // Combat rules (not per-unit stats)

  /**
   * Extra paces past footprint-touch that still count as melee. Chargers
   * stop outside footprints and would never lock without this slack.
   */
  meleeSlack: 6,
  /** Floor for ranged falloff (1 at point-blank, this at max range). */
  minDamageFactor: 0.25,
  /** Random extra or less damage applied before truncating to two decimals. */
  damageVariance: 0.1,
  /**
   * Fatigue lost per second while halted (outside own keep range).
   * Charge or melee contact uses fatigueCombatRate to gain instead.
   */
  fatigueIdleRate: 2,
  /** Fatigue per second while charging or in melee contact (not stacked). */
  fatigueCombatRate: 4,
  /** Flat fatigue added when hit by a ranged shot. */
  fatigueOnShot: 4,
  /** Fatigue lost per second inside own keep cannon range. */
  fatigueRecoverRate: 4,
  /** Gameplay length of the straight top lane, in paces. */
  topLanePaces: 1000,
  /** Gameplay length of the bottom lane, in paces. The arc is only how it is drawn. */
  bottomLanePaces: 1500,
  /** Along-lane reach from a unit's center that still counts as a perfect line, in paces. */
  perfectLinePaces: 1,
  /** Along-lane reach from a unit's center that still counts as one line, in paces. */
  inLinePaces: 8,
  /**
   * Troop shooting line bonus per other eligible troop in the line.
   * Scaled by Perfect→In Line neighbor quality before it is applied.
   */
  troopLineBonus: 0.25,
  /** Along-lane reach from a unit's center that its footprint covers, in paces. */
  footprintPaces: 12,
  /** Gun shell: max gap between footprint edges to continue to the next body. */
  gunPenetratePaces: 24,
  /** Cross-lane shots must also be shorter than this path back through your keep. */
  crossLaneMaxPaces: 200,
  /** Fort center, in paces forward from each keep. */
  fortDistancePaces: 200,
  /** Officer and color-guard restore reach, in paces along the lane. */
  officerRestorePaces: 60,
  /**
   * Keep aura restore uses this base rate × band multiplier (3 / 2 / 1).
   * Kept separate from Officer/Color Guard restoreRate so keep strength
   * does not change when those units are balanced.
   */
  keepRestoreBase: 4,
  /** Keep restore bands, in paces from that side's keep. Inner band is the strongest. */
  keepAuraPaces: [40, 80, 120],
  /**
   * Missing-health damage loss: each 2% of health missing costs 1% damage.
   * At 50% health, damage is reduced by 25%. Color Guard aura negates this.
   */
  missingHealthDamageRatio: 0.5,
  /** Flat fatigue added when hit in melee or when making a melee attack. */
  fatigueOnMelee: 2,
  /** Pushback counter points needed to force one pace back. */
  pushbackPerPace: 2,
  /** Fatigue added when a melee/hit pushback pace is blocked behind. */
  fatiguePerPace: 0.5,
  /** Progress from each keep to that side's cover line on the top lane (250/1000). */
  quarterMark: 0.25,
  /**
   * Incoming damage removed while a friendly unit stands in its own fort
   * footprint and the attacker is outside that same footprint.
   */
  quarterArmor: 0.2,

  // Terrain

  /** Named map preset used when a match does not pick another. */
  defaultMapId: "default",
  /**
   * Hill slope speed delta while walking away from own keep: before the
   * hill center ×(1 − this), after ×(1 + this). A step back toward own
   * keep flips those sides. At exact center ×1.
   */
  hillSlope: 0.5,
  /** Extra shoot range while a unit's centerline is on a hill footprint. */
  hillRangeBonus: 0.1,
  /** Engineer officer-aura multiplier while on a hill or peak footprint. */
  engineerElevationAuraFactor: 3,
  /**
   * Cover while a unit's centerline is on woods, a peak, or a hill.
   * Each applies only against an attacker outside that same footprint.
   */
  woodsCover: 0.1,
  hillCover: 0.2,
  peakCover: 0.3,
  /** Move speed while an enemy's center is in a fort's colored band. */
  fortColorSlow: 0.5,
  /** Move speed multiplier while on woods. */
  woodsSlow: 0.5,
  /** Move speed multiplier for infantry on peaks (cavalry/artillery blocked). */
  peakSlow: 0.5,
  /** Move speed multiplier for infantry crossing a river. */
  riverInfantrySlow: 0.5,
  /** Move speed multiplier for cavalry crossing a river (artillery blocked). */
  riverCavalrySlow: 0.25,
  /** Seconds a damage number stays on screen. */
  splatLife: 0.7,
  /** Pixels per second the splat rises. */
  splatRise: 36,

  // Movement and lines

  /** How close a friendly ahead must be before it counts as a blocker. */
  blockGap: 22,
  /**
   * Max along-centerline error (px) still treated as perfectly parallel
   * on the top lane.
   */
  parallelEpsilon: 1,
  /**
   * How close along the centerline two top-lane rows must be to share
   * a click order. On the bottom this is the same gap as an angle about
   * the shared center.
   */
  lineWindow: 10,
  /**
   * Along-track window for a side-by-side flank. Wider than the line
   * window so an adjacent melee, which can connect while staggered,
   * still counts.
   */
  flankWindow: 36,
  /** Each ahead trooper walks at this fraction of the next one behind. */
  reformSpeedFactor: 0.5,

  // Bot — decision timing

  /** Seconds between full bot reassessments, by difficulty. */
  botThinkInterval: { simple: 1.25, hard: 0.5 },
  /** Seconds a bot unit must wait before it can change orders again. */
  botOrderCooldown: 2.5,
  /** Max sim steps per wall tick when game speed is above 1×. */
  botSpeedStepCap: 4,

  // Bot — lane posture and keep threat

  /** Friendly/enemy combat value below this enters Defend. */
  botDefendEnterRatio: 0.75,
  /** Defend holds until the ratio climbs back above this. */
  botDefendExitRatio: 0.95,
  /** Friendly/enemy combat value above this can enter Attack. */
  botAttackEnterRatio: 1.35,
  /** Attack holds until the ratio falls below this. */
  botAttackExitRatio: 1.15,
  /** Lane share required before Attack, so an empty lane does not rush. */
  botAttackShare: 0.55,
  /** Proximity-weighted enemy value that makes a lane Defend / desperate. */
  botKeepThreatDefend: 150,
  /** Threat must fall under this before a lane leaves Defend. */
  botKeepThreatClear: 80,
  /** Keep-gun reach multiplier for threat. The rim of this band scores low. */
  botKeepThreatReachScale: 1.15,
  /** Own keep HP fraction that makes every lane desperate. */
  botDesperateKeepHp: 0.4,

  // Bot — local assessment

  /** Paces around a unit that count as immediate contact. */
  botContactPaces: 90,
  /** Paces that count as nearby support (about one troop volley). */
  botSupportPaces: 260,
  /** Hard only: fraction of combat value removed at full fatigue. */
  botFatigueWeight: 0.45,
  /** Combat-value multiplier for a broken unit. Purchases still count it. */
  botBrokenFactor: 0.15,
  /** Vitality (hp% − fatigue%) that peels one body out. */
  botSurvivalVitality: 0.25,
  /** A vitality peel holds until vitality reaches this. */
  botSurvivalClear: 0.4,
  /** Hard contact-band weights. Support range uses 1 for every role. */
  botRoleContact: {
    troop: 1,
    grenadier: 1.1,
    skirmisher: 0.6,
    rifle: 0.55,
    dragoon: 1.25,
    lancer: 1.35,
    cannon: 0.4,
    howitzer: 0.45,
    officer: 0.25,
    colorGuard: 0.25,
    militia: 0.9,
    guerrilla: 0.5,
    hussar: 1.15,
    horseGun: 0.42,
    engineer: 0.25,
  },

  // Bot — composition

  /** Desired share of army gold by base type. Must sum to 1. */
  botComposition: {
    troop: 0.42,
    skirmisher: 0.18,
    dragoon: 0.18,
    cannon: 0.12,
    officer: 0.10,
  },
  /**
   * Until the army is worth this much gold, cannon demand is zero and that
   * share goes to skirmishers and dragoons. Field guns wait for a formed army.
   */
  botCannonArmyValue: 900,
  /** Fraction of the early cannon share that becomes skirmishers; the rest is dragoons. */
  botEarlyCannonToSkirmisher: 0.55,
  /** Largest add to one desired fraction before renormalizing. */
  botCounterCap: 0.12,
  /**
   * Added to skirmishers when the enemy army is entirely cavalry.
   * A smaller cavalry share adds proportionally, and never past botCounterCap.
   */
  botCounterCavalry: 0.12,
  /**
   * Added to cannons when the enemy army is entirely troops.
   * A smaller troop share adds proportionally, and never past botCounterCap.
   */
  botCounterInfantry: 0.12,
  /**
   * Added to dragoons when the enemy army is entirely guns and officers.
   * A smaller support share adds proportionally, and never past botCounterCap.
   */
  botCounterSupport: 0.12,
  /** Added to officers once the friendly troop count fills a line. */
  botCounterOfficer: 0.08,
  /** Friendly troop bodies that start raising officer demand. */
  botOfficerLineCount: 4,
  /** Buy troops into a lane until it can hold a line. */
  botMinTroopsBeforeSupport: 3,
  /** Bodies kept on the top lane before any bottom-lane seeding. The top lane is the short path to the keep. */
  botTopGarrison: 4,
  /** Urgency of filling that garrison. Beats the bottom seed bonus. */
  botTopGarrisonUrgency: 80,
  /** Bottom units bought to start town income, then the bonus turns off. */
  botBottomSeed: 2,
  /** Simple cannon bump when the enemy army is mostly infantry. */
  botSimpleCannonBump: 0.06,
  /** Enemy troop gold share that triggers the simple cannon bump. */
  botSimpleCannonTroopShare: 0.55,
  /** Enemy troop share above this is a wall: do not buy lancers into it. */
  botTroopWallShare: 0.45,

  // Bot — lane urgency

  /** Multiplier on proximity-weighted keep threat. */
  botUrgencyThreat: 1,
  /** Multiplier on enemy combat-value lead, in troop-costs. One troop beats lane stickiness. */
  botUrgencyDisadvantage: 40,
  /** Multiplier on how far lane share sits below one half. */
  botUrgencyShare: 80,
  /** Bonus for an unseeded bottom lane (land income). */
  botUrgencyEconomy: 55,
  /** Hard bonus for a town grab or a committed keep attack. */
  botUrgencyOpportunity: 40,
  /** Keep the previous buy lane unless another lane wins by this much. */
  botLaneStickiness: 20,

  // Bot — role positioning and hysteresis

  /** How far ahead of friendly infantry a skirmisher tries to sit, in paces. */
  botSkirmishOffset: 100,
  /** Paces of slack around the skirmisher screen offset. */
  botSkirmishBand: 25,
  /** Local support ratio below this starts a retreat. */
  botRetreatRatio: 0.7,
  /** A retreat holds until the local ratio reaches this. */
  botResumeRatio: 1,
  /** Desperate lanes wait until the ratio is this bad before retreating. */
  botRetreatRatioDesperate: 0.45,
  /** Fraction of weapon range. Halt once the target is inside this. */
  botCannonHaltBand: 0.85,
  /** Fraction of weapon range. Advance again only once the target is beyond this. */
  botCannonAdvanceBand: 1.15,
  /** Leave cannon fallback only after the enemy is this many times contact range away. */
  botCannonFallbackClear: 1.35,
  /** Officer stands this many paces behind the front rank. */
  botOfficerStandoff: 30,
  /** Hard infantry charges only inside contact and above this local ratio. */
  botInfantryChargeRatio: 1.6,

  // Bot — cavalry charge score (Hard)

  /** Score required to start a charge. */
  botChargeScore: 1,
  /** A charge holds until the score falls under this. */
  botChargeAbort: 0.4,
  /** Isolated cannon or officer. */
  botChargeSupportBonus: 1.2,
  /** Target under half hit points. */
  botChargeWeakBonus: 0.6,
  /** Target already falling back or retreating. */
  botChargeRetreatBonus: 0.5,
  /** No enemy troop inside support of the target. */
  botChargeIsolatedBonus: 0.8,
  /** Enemy troop mass in contact outweighs friendly support. */
  botChargeBlobPenalty: 2.5,

  // Bot — economy

  /** Gold kept back when buying a bank so one troop can still be bought. */
  botBankReserve: 100,
  /** Income at or under tax plus this still buys a bank. */
  botTaxMargin: 0.01,
  /** Hard skips a town while a composition deficit is larger than this. */
  botUpgradeDeficitSkip: 0.18,
  /** Army gold required before a second support unit can be a color guard. */
  botColorGuardMinValue: 800,
  /** Enemy rows in the buy lane before a cannon buy becomes a howitzer. */
  botHowitzerMinRows: 3,

  // Bot — keep attack

  /** Local friendly/enemy value required to commit to the enemy keep. */
  botKeepCommitRatio: 1.4,
  /** Commitment holds until the ratio falls under this. */
  botKeepAbortRatio: 0.9,
  /** Friendly combat value that must sit near the enemy keep. */
  botKeepCommitValue: 400,
  /** Simple commit: friendly front progress along the lane (0–1). */
  botKeepCommitProgress: 0.72,

  // Checkpoints

  /** Towns spaced along the bottom lane. */
  checkpointCount: 5,
  /** Town circle radius, in pixels, before UI scale. */
  checkpointRadius: 14,
  /** How far a checkpoint circle crosses the inner edge of the bottom lane. */
  checkpointLaneOverlap: 6,
  /** How close along its row a bottom-lane unit must be to claim a town, in pixels. */
  captureRadius: 28,

  // Colors

  colors: {
    /** Canvas background. */
    bg: "#172c20",
    /** Top-lane band fill. */
    topLane: "#244c3f",
    /** Top-lane row stroke. */
    topSublane: "#3a7a6a",
    /** Bottom-lane ground fill. */
    bottomLane: "#3a3128",
    /** Bottom-lane ring stroke. */
    bottomSublane: "#6a5640",
    /** Player units, keep, and fort line. */
    player: "#4aa3ff",
    /** Enemy units, keep, and fort line. */
    enemy: "#e85d4c",
    /** Darker player keep fill. */
    playerDark: "#16385f",
    /** Darker enemy keep fill. */
    enemyDark: "#6e241c",
    /** Gold prices, income, and bank buttons. */
    gold: "#e8c36a",
    /** Yellow (elite) alternate unit badge. */
    yellowAlternate: "#e6c84a",
    /** White (light) alternate unit badge. */
    whiteAlternate: "#ffffff",
    /** Unowned checkpoint. */
    neutral: "#c4b48a",
    /** HUD and announcement text. */
    text: "#e8eef6",
    /** Reform order outline. */
    reform: "#9ee07a",
    /** Halt order outline. */
    halt: "#e8b04a",
    /** Charge order outline. */
    charge: "#ff0000",
    /** Fallback order outline. */
    fallback: "#6ec8e0",
    /** Retreat order outline. */
    retreat: "#b07cff",
    /** Damage number for a shot. */
    splatShoot: "#ffe27a",
    /** Damage number for a melee hit. */
    splatMelee: "#ff5a4a",
    /** Heal + for health restore (keeps / officers / color guard). */
    splatHeal: "#9ee07a",
    /** Fatigue + while recovering from Halt. */
    splatFatigue: "#7ec8ff",
    /** Unit fatigue bar fill. */
    fatigue: "#5b9fd4",
    /** Outline behind a damage number. */
    splatStroke: "#3a1c10",
    /** Highlighted sublane while dragging. */
    laneHover: "#9ee8ff",
    /** Lane-center income divider. */
    laneCenter: "#e8c36a",
  },
};

/**
 * World-space pad past a unit/town body for pointer hits.
 * `zoom` is telescope camera scale (1 in overview). Keeps the on-screen
 * ring stable when zoomed so lane pans are not stolen by oversized taps.
 */
export function pointerHitReach({
  cssScale = 1,
  zoom = 1,
  coarse = false,
  telescope = false,
  kind = "unit",
} = {}) {
  const screen = Math.max(1e-3, (cssScale || 1) * (zoom || 1));
  let padCss = 24;
  if (telescope) {
    const factor = kind === "unit" && coarse ? 0.28 : 0.4;
    padCss = Math.max(8, CONFIG.touchTargetPx * factor);
  }
  const floor = kind === "town" ? 6 : 4;
  return Math.max(floor, padCss / screen);
}

/** Keep the full damage calc, then chop to two decimal places for HP. */
export function truncateDamage(amount) {
  return Math.trunc(amount * 100) / 100;
}

/** Hit-splat display: round the truncated applied damage. */
export function splatDamage(amount) {
  return Math.round(amount);
}
