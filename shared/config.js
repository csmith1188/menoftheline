/** Tunable prototype numbers. Referenced by economy, combat, and drawing. */
export const CONFIG = {
  canvasWidth: 960,
  canvasHeight: 620,

  /** Player keep, left side of the top band. */
  playerCapital: { x: 72, y: 150 },
  /** Enemy keep, right side of the top band. */
  enemyCapital: { x: 888, y: 150 },
  capitalRadius: 34,

  /** Vertical thickness of the parallel top lane. */
  topLaneHeight: 112,
  /** Parallel travel rows in the top lane. */
  topSublaneCount: 5,
  /** Distance from lane center to the outermost top sublane. */
  topSublaneSpread: 40,

  /** Parallel travel rows on the bottom (concentric half-circles). */
  bottomSublaneCount: 3,
  /** Radial gap between bottom half-circles. Close enough for adjacent melee. */
  bottomSublaneSpread: 22,
  /** How many segments approximate each bottom arc for movement. */
  bottomArcSegments: 32,
  /** Stroke width used when drawing one bottom sublane. */
  bottomSublaneWidth: 18,
  /** Stroke width used when drawing one top sublane. */
  topSublaneWidth: 14,

  startGold: 500,
  troopCost: 100,
  /** Gold price of a skirmisher (long range, light hits). */
  skirmisherCost: 50,
  /** Gold price of a dragoon (weaker shots, extra flanking damage). */
  dragoonCost: 200,
  /** Gold price of a cannon (ranged, fires over the line). */
  cannonCost: 300,
  /** Gold per second with zero checkpoints. */
  baseIncome: 10,
  /** Extra gold per second split by the top-lane center ratio. */
  centerIncome: 10,
  /** Land per second split by the bottom-lane center ratio. */
  centerLand: 10,
  /** Extra gold per second for each owned checkpoint. */
  incomePerCheckpoint: 1,
  /** How many banks sit above each capital. */
  bankCount: 3,
  /** Gold to unlock the first bank. */
  bankBaseCost: 100,
  /** Extra gold per bank already unlocked on that side. */
  bankCostStep: 100,
  /** Gold/sec granted per unlock, times current unlocked count. */
  bankIncomePer: 1,
  bankButtonSize: 40,
  bankButtonGap: 8,
  buyButtonW: 96,
  buyButtonH: 22,
  buyButtonGap: 4,
  /** Multiplier for on-canvas HUD, banks, and buy buttons. */
  uiScale: 1.25,
  /** Minimum on-screen tap size in CSS pixels. */
  touchTargetPx: 44,
  /** Match time (seconds) when each bank becomes purchasable. */
  bankUnlockAt: [120, 240, 360],
  upgradeBaseCost: 150,
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
  /** Progress from each keep to that side's cover line. */
  quarterMark: 0.25,
  /** Extra armor while a troop's body overlaps a quarter line. */
  quarterArmor: 0.2,

  capitalHP: 500,
  troopHP: 200,
  troopRangedDamage: 10,
  troopMeleeDamage: 10,
  /** Skirmisher starts at 2x troop range and 25% troop damage. */
  skirmisherHP: 100,
  skirmisherRangedDamage: 4,
  skirmisherMeleeDamage: 4,
  skirmisherRange: 400,
  skirmisherAttackCooldown: 0.6,
  skirmisherRadius: 10,
  dragoonRangedDamage: 5,
  dragoonMeleeDamage: 20,
  /** Extra multiplier on a dragoon's flanking hits, on top of the shared flank bonus. */
  dragoonFlankBonus: 1.5,
  troopRange: 200,
  /** Open fire at this fraction of attack range unless a line-mate is already shooting. */
  openFireFactor: 0.5,
  troopAttackCooldown: 1,
  /** Base pixels-per-second along a path or while strafing. */
  troopSpeed: 20,
  /** Extra walk speed for a dragoon that is not lined with melee troops. */
  dragoonOpenSpeed: 2,
  /** Bot dragoon support / threat radius for fallback, charge, and reform. */
  dragoonSupportRange: 100,
  /** Seconds a bot unit must wait before it can change orders again. */
  botOrderCooldown: 2.5,
  /** How long a shot slows an advancing or charging troop. */
  shotSlowDuration: 0.6,
  /** Walk-speed multiplier while that shot slow is active. */
  shotSlowFactor: 0.4,
  troopRadius: 10,
  /** Pixels of drag before a click becomes a sublane-change order. */
  laneDragMin: 12,
  /**
   * Extra pixels past a body-touch that still count as melee. Chargers halt
   * at the enemy edge and would never overlap without this slack.
   */
  meleeSlack: 6,

  /** How close a friendly ahead must be before it counts as a blocker. */
  blockGap: 22,
  /**
   * Max along-centerline error (px) still treated as perfectly parallel
   * on the top lane.
   */
  parallelEpsilon: 3,
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
  /** Floor for ranged falloff (1 at point-blank, this at max range). */
  minDamageFactor: 0.25,
  /** Charge and flanking each multiply outgoing damage by this. */
  doubleDamageMultiplier: 1.2,
  /** Walk-speed multiplier while charging. Cannons and dragoons are excluded. */
  chargeSpeedFactor: 1.2,
  /** An enemy troop must be at least this close for the charge speed bonus. */
  chargeSpeedRange: 100,
  /** Extra outgoing damage per other melee troop sharing this line. */
  lineDamageBonus: 0.2,
  /** Random extra or less damage applied before rounding. */
  damageVariance: 0.1,

  cannonRange: 500,
  cannonDamage: 100,
  cannonAttackCooldown: 4,
  /** Keep gun: same role as a field cannon, with its own numbers. */
  capitalCannonRange: 200,
  capitalCannonDamage: 50,
  capitalCannonAttackCooldown: 0.5,
  cannonRadius: 10,
  projectileSpeed: 220,
  projectileRadius: 4,
  /** Seconds a damage number stays on screen. */
  splatLife: 0.7,
  /** Pixels per second the splat rises. */
  splatRise: 36,

  checkpointCount: 5,
  checkpointRadius: 14,
  /** How far a checkpoint circle crosses the inner edge of the bottom lane. */
  checkpointLaneOverlap: 6,
  captureRadius: 28,

  colors: {
    bg: "#172c20",
    topLane: "#244c3f",
    topSublane: "#3a7a6a",
    bottomLane: "#3a3128",
    bottomSublane: "#6a5640",
    player: "#4aa3ff",
    enemy: "#e85d4c",
    playerDark: "#16385f",
    enemyDark: "#6e241c",
    gold: "#e8c36a",
    neutral: "#c4b48a",
    text: "#e8eef6",
    projectile: "#f3d27a",
    reform: "#9ee07a",
    halt: "#e8b04a",
    charge: "#ff0000",
    fallback: "#6ec8e0",
    splatShoot: "#ffe27a",
    splatMelee: "#ff5a4a",
    splatStroke: "#3a1c10",
    laneHover: "#9ee8ff",
    laneCenter: "#e8c36a",
  },
};

/** Lane-buy catalog drawn on the canvas. */
export const BUY_UNITS = [
  { type: "melee", label: "Troop", costKey: "troopCost", fill: "#2a4158", stroke: "#3d5a7a" },
  { type: "skirmisher", label: "Skirmish", costKey: "skirmisherCost", fill: "#243a32", stroke: "#3a6a5a" },
  { type: "dragoon", label: "Dragoon", costKey: "dragoonCost", fill: "#322848", stroke: "#5a4a7a" },
  { type: "cannon", label: "Cannon", costKey: "cannonCost", fill: "#3a3428", stroke: "#6a5a3a" },
];
