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
  /** How many banks sit above each capital. */
  bankCount: 3,
  /** Gold to unlock the first bank. */
  bankBaseCost: 240,
  /** Extra gold per bank already unlocked on that side. */
  bankCostStep: 240,
  /** Gold/sec granted per unlock, times current unlocked count. */
  bankIncomePer: 2,
  /**
   * Mass tax per second: this fraction of a living unit's gold cost,
   * times its remaining health (current hp / max hp).
   */
  massTaxRate: 0.01,
  /** Match time (seconds) when each bank becomes purchasable. */
  bankUnlockAt: [0, 120, 240],

  // Upgrades

  /** Land price of the first rank of speed, armor, or damage. */
  upgradeBaseCost: 150,
  /** Extra land added to the upgrade price for each rank already owned. */
  upgradeCostStep: 150,
  /** Highest rank for speed, armor, and damage. */
  upgradeMax: 5,
  /** Added to the side speed multiplier per speed purchase. */
  speedUpgradeAmount: 0.1,
  /** Extra attack-rate fraction per speed upgrade. */
  speedAttackFactor: 0.05,
  /** Extra outgoing damage per damage purchase. */
  damageUpgradeAmount: 0.1,
  /** Incoming damage reduction per armor purchase. */
  armorPerUpgrade: 0.1,
  /** Armor cannot reduce incoming damage below this remainder. */
  armorCap: 0.7,
  /** Land price to unlock one unit variant for the match. */
  variantUnlockCost: 350,

  // Interface

  /** Bank button width and height, in pixels, before UI scale. */
  bankButtonSize: 40,
  /** Gap between bank buttons, in pixels, before UI scale. */
  bankButtonGap: 8,
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
  capitalCannonDamage: 50,
  /** Seconds between keep-gun shots. */
  capitalCannonAttackCooldown: 0.5,

  // Combat rules (not per-unit stats)

  /**
   * Extra pixels past a body-touch that still count as melee. Chargers halt
   * at the enemy edge and would never overlap without this slack.
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
  fatigueIdleRate: 1,
  /** Fatigue per second while charging or in melee contact (not stacked). */
  fatigueCombatRate: 4,
  /** Flat fatigue added when hit by a ranged shot. */
  fatigueOnShot: 2,
  /** Fatigue lost per second inside own keep cannon range. */
  fatigueRecoverRate: 4,
  /** Progress from each keep to that side's cover line. */
  quarterMark: 0.25,
  /** Extra armor while a troop's body overlaps its own side's fort line. */
  quarterArmor: 0.2,
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

  // Bot

  /** Bot dragoon support / threat radius for fallback, charge, and reform. */
  dragoonSupportRange: 100,
  /** Seconds a bot unit must wait before it can change orders again. */
  botOrderCooldown: 2.5,

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

/** Keep the full damage calc, then chop to two decimal places for HP. */
export function truncateDamage(amount) {
  return Math.trunc(amount * 100) / 100;
}

/** Hit-splat display: round the truncated applied damage. */
export function splatDamage(amount) {
  return Math.round(amount);
}
