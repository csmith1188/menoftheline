/** Tunable match numbers, grouped for the board, economy, units, and combat. */
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
  /** Gold price of a melee troop. */
  troopCost: 120,
  /** Gold price of a skirmisher (long range, light hits). */
  skirmisherCost: 60,
  /** Gold price of a dragoon (weaker shots, extra flanking damage). */
  dragoonCost: 240,
  /** Gold price of a cannon (ranged, fires over the line). */
  cannonCost: 360,
  /** Gold per second before the top-lane share and banks. */
  baseIncome: 10,
  /** Extra gold per second split by the top-lane center ratio. */
  centerIncome: 10,
  /** Land per second split by the bottom-lane center ratio. */
  centerLand: 10,
  /** How many banks sit above each capital. */
  bankCount: 3,
  /** Gold to unlock the first bank. */
  bankBaseCost: 120,
  /** Extra gold per bank already unlocked on that side. */
  bankCostStep: 120,
  /** Gold/sec granted per unlock, times current unlocked count. */
  bankIncomePer: 1,
  /** Match time (seconds) when each bank becomes purchasable. */
  bankUnlockAt: [120, 240, 360],

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

  // Interface

  /** Bank button width and height, in pixels, before UI scale. */
  bankButtonSize: 40,
  /** Gap between bank buttons, in pixels, before UI scale. */
  bankButtonGap: 8,
  /** Buy-button width, in pixels, before UI scale. */
  buyButtonW: 96,
  /** Buy-button height, in pixels, before UI scale. */
  buyButtonH: 22,
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

  // Troops

  /** Hit points of a troop, dragoon, or field cannon. */
  troopHP: 200,
  /** Shot damage of a melee troop before falloff. */
  troopRangedDamage: 10,
  /** Melee damage of a melee troop. */
  troopMeleeDamage: 10,
  /** Melee reach. A field cannon will not shoot or strike inside this. */
  troopRange: 200,
  /** Seconds between strikes for a troop or dragoon. */
  troopAttackCooldown: 1,
  /** Base walk speed, in pixels per second, before orders and upgrades. */
  troopSpeed: 20,
  /** Body radius of a troop or dragoon, in pixels. */
  troopRadius: 10,

  // Skirmishers

  /** Hit points of a skirmisher. */
  skirmisherHP: 100,
  /** Shot damage of a skirmisher before falloff. */
  skirmisherRangedDamage: 2,
  /** Melee damage of a skirmisher. */
  skirmisherMeleeDamage: 2,
  /** Farthest a skirmisher can shoot, in pixels. */
  skirmisherRange: 300,
  /** Seconds between skirmisher strikes. */
  skirmisherAttackCooldown: 1,
  /** Body radius of a skirmisher, in pixels. */
  skirmisherRadius: 10,

  // Dragoons

  /** Shot damage of a dragoon before falloff. */
  dragoonRangedDamage: 5,
  /** Melee damage of a dragoon. */
  dragoonMeleeDamage: 20,
  /** Extra multiplier on a dragoon's flanking hits, on top of the shared flank bonus. */
  dragoonFlankBonus: 1.5,
  /** Walk-speed multiplier for every dragoon. */
  dragoonOpenSpeed: 2,

  // Cannons

  /** Farthest a field cannon can shoot, in pixels. */
  cannonRange: 500,
  /** Shell damage of a field cannon before falloff. */
  cannonDamage: 90,
  /** Seconds between field-cannon shots. */
  cannonAttackCooldown: 4,
  /** Body radius of a field cannon, in pixels. */
  cannonRadius: 10,

  // Combat

  /** Open fire at this fraction of attack range unless a line-mate is already shooting. */
  openFireFactor: 0.5,
  /**
   * Extra pixels past a body-touch that still count as melee. Chargers halt
   * at the enemy edge and would never overlap without this slack.
   */
  meleeSlack: 6,
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
  /** How long a shot slows an advancing or charging troop. */
  shotSlowDuration: 0.6,
  /** Walk-speed multiplier while that shot slow is active. */
  shotSlowFactor: 0.4,
  /** Progress from each keep to that side's cover line. */
  quarterMark: 0.25,
  /** Extra armor while a troop's body overlaps its own side's fort line. */
  quarterArmor: 0.2,
  /** Shell speed, in pixels per second. */
  projectileSpeed: 220,
  /** How close a shell must be to count as a hit, in pixels. */
  projectileRadius: 4,
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
    /** Shell in flight. */
    projectile: "#f3d27a",
    /** Reform order outline. */
    reform: "#9ee07a",
    /** Halt order outline. */
    halt: "#e8b04a",
    /** Charge order outline. */
    charge: "#ff0000",
    /** Fallback order outline. */
    fallback: "#6ec8e0",
    /** Damage number for a shot. */
    splatShoot: "#ffe27a",
    /** Damage number for a melee hit. */
    splatMelee: "#ff5a4a",
    /** Outline behind a damage number. */
    splatStroke: "#3a1c10",
    /** Highlighted sublane while dragging. */
    laneHover: "#9ee8ff",
    /** Lane-center income divider. */
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
