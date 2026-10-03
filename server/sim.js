import { CONFIG, truncateDamage, splatDamage } from "../shared/config.js";
import { UNIT_STATS, unitStats, massTaxOf, unitLandCost, isAlternateUnit } from "../shared/units.js";
import { Path, distance, touchesQuarterLine } from "../shared/path.js";

/** Per-lane grand strategy modes (cycle order). Kept for a future game mode. */
const TARGETING_MODES = ["bastion", "attrition", "terror"];
void TARGETING_MODES;

/** hp% − fatigue%; Attrition maximizes, Terror minimizes. Keep uses HP only. */
function targetVitality(unit) {
  if (unit && unit.capitalHP !== undefined) {
    const max = CONFIG.capitalHP;
    return max > 0 ? Math.max(0, unit.capitalHP) / max : 0;
  }
  const hpPct = unit.maxHp > 0 ? Math.max(0, unit.hp) / unit.maxHp : 0;
  const fatPct = unit.maxFatigue > 0 ? unit.fatigue / unit.maxFatigue : 0;
  return hpPct - fatPct;
}

/**
 * True when other is a legal ranged aim. Keeps are always valid while
 * standing (melee does not lock them). Units in melee are not.
 */
function isValidRangedTarget(other) {
  if (!other) return false;
  if (other.capitalHP !== undefined) return other.capitalHP > 0;
  if (other.hp <= 0) return false;
  if (other.isMeleeTargetLocked && other.isMeleeTargetLocked()) return false;
  return true;
}

/**
 * Distance used only when ranking targets. Keep counts as
 * keepTargetDistanceOffsetPaces closer; actual shotPaces is unchanged.
 */
function targetPriorityPaces(shooter, other) {
  const d = shooter.shotPaces(other);
  if (other && other.capitalHP !== undefined) {
    return Math.max(0, d - CONFIG.keepTargetDistanceOffsetPaces);
  }
  return d;
}

/**
 * True when candidate beats the current best under mode.
 * Bastion: closer. Attrition: healthier. Terror: weaker.
 * Distance breaks ties for Attrition/Terror.
 */
function isBetterTarget(mode, candD, candVit, bestD, bestVit) {
  if (mode === "attrition") {
    if (candVit !== bestVit) return candVit > bestVit;
    return candD < bestD;
  }
  if (mode === "terror") {
    if (candVit !== bestVit) return candVit < bestVit;
    return candD < bestD;
  }
  return candD < bestD;
}

/**
 * Skirmisher / Rifles shot priority (lower is better). Cavalry is tier 0
 * only when it is the closest valid target; otherwise it sits after guns.
 */
function skirmisherTargetTier(type, dist, closestDist) {
  if (type === "dragoon") return dist <= closestDist ? 0 : 4;
  if (type === "skirmisher") return 1;
  if (type === "officer") return 2;
  if (type === "cannon") return 3;
  if (type === "troop") return 5;
  return 6;
}

/**
 * Shot fired by a troop or cannon. Travels over intervening units and
 * only collides with its chosen target (or the target keep). A shell
 * already in flight still hits if that target later enters melee.
 */
class Projectile {
  constructor(x, y, target, damage, allies, kind, sourceType, sim, shot) {
    this.x = x;
    this.y = y;
    this.target = target;
    this.damage = damage;
    this.baseDamage = damage;
    this.allies = allies;
    this.kind = kind || "shoot";
    this.sourceType = sourceType || "troop";
    this.sim = sim;
    this.speed = shot && shot.speed != null ? shot.speed : UNIT_STATS.troop.projectileSpeed;
    this.size = shot && shot.size != null ? shot.size : UNIT_STATS.troop.projectileSize;
    this.color = shot && shot.color ? shot.color : UNIT_STATS.troop.projectileColor;
    this.splash = shot && shot.splash != null ? shot.splash : 0;
    this.attackerSum = shot && shot.attackerSum ? shot.attackerSum : 0;
    this.shotSign = shot && shot.shotSign ? shot.shotSign : 1;
    this.shootingPushback = shot && shot.shootingPushback != null
      ? shot.shootingPushback
      : 0;
    this.alive = true;
    this.bounce = null;
    this.anchor = null;
    /** Bodies already struck; gun shells may continue for up to 3. */
    this.penHits = 0;
    this.lastX = target && target.x != null ? target.x : x;
    this.lastY = target && target.y != null ? target.y : y;
    this.sideId = allies.length && allies[0].side ? allies[0].side.id : "player";
  }

  /** Full / half / quarter for the 1st / 2nd / 3rd body on a gun shell. */
  hitFactor() {
    if (!(this.splash > 0)) return 1;
    if (this.penHits <= 0) return 1;
    if (this.penHits === 1) return 0.5;
    return 0.25;
  }

  /** How many bodies this shell may still strike. */
  maxPenHits() {
    return this.splash > 0 ? 3 : 1;
  }

  /** World point the shell is flying toward. */
  dest() {
    if (this.bounce) return this.bounce;
    if (this.target && this.target.capital) return this.target.capital;
    return this.target;
  }

  /** Fly toward a point. True when the shell arrives. */
  flyTo(dest, dt) {
    if (!dest) return true;
    const d = distance(this, dest);
    const step = this.speed * dt;
    if (d <= step + this.size) {
      this.x = dest.x;
      this.y = dest.y;
      return true;
    }
    this.x += ((dest.x - this.x) / d) * step;
    this.y += ((dest.y - this.y) / d) * step;
    return false;
  }

  /**
   * Next enemy footprint within gunPenetratePaces of this one's edge,
   * further along the shot on the same row.
   */
  nextBehind(from) {
    if (!from || !from.lane || !from.side) return null;
    const sign = this.shotSign || 1;
    const slack = Path.stationSlack(from.lane, "gun");
    const foes = from.side.troops;
    let best = null;
    let bestAlong = Infinity;
    for (let i = 0; i < foes.length; i += 1) {
      const other = foes[i];
      if (other === from || other.hp <= 0 || other.lane !== from.lane) continue;
      if (other.sublane !== from.sublane) continue;
      const delta = other.station() - from.station();
      if (sign > 0 && delta <= 0) continue;
      if (sign < 0 && delta >= 0) continue;
      const along = Math.abs(delta);
      if (along > slack || along >= bestAlong) continue;
      bestAlong = along;
      best = other;
    }
    return best;
  }

  /**
   * After a hit (or a dead aim), keep flying to the next body on the
   * row when the gun may still penetrate. Otherwise the shell dies.
   */
  continueBehind(from) {
    if (this.penHits >= this.maxPenHits()) {
      this.alive = false;
      return;
    }
    if (!(this.splash > 0) || !from || !from.side) {
      this.alive = false;
      return;
    }
    const next = this.nextBehind(from);
    if (!next || !isValidRangedTarget(next)) {
      this.alive = false;
      return;
    }
    this.target = next;
    this.anchor = null;
    this.bounce = null;
  }

  /** Advance the shell; apply damage on impact. */
  update(dt) {
    if (this.bounce) {
      if (!this.flyTo(this.bounce, dt)) return;
      const from = this.anchor;
      this.bounce = null;
      this.anchor = null;
      this.continueBehind(from);
      return;
    }
    if (this.target && this.target.hp !== undefined && this.target.hp <= 0) {
      this.anchor = this.target;
      this.bounce = { x: this.lastX, y: this.lastY };
      this.target = null;
      return;
    }
    if (this.target) {
      const destNow = this.dest();
      if (destNow) {
        this.lastX = destNow.x;
        this.lastY = destNow.y;
      }
    }
    const dest = this.dest();
    if (!dest || !this.flyTo(dest, dt)) return;
    if (!this.target) {
      this.alive = false;
      return;
    }
    if (this.target.capitalHP !== undefined) {
      const hit = this.target.applyKeepDamage(this.damage, this.attackerSum);
      this.target.capitalHP -= hit;
      const keep = this.target.capital;
      this.sim.spawnSplat(keep.x, keep.y, hit, this.kind);
      this.alive = false;
      return;
    }
    const struck = this.target;
    const raw = this.baseDamage * this.hitFactor();
    struck.takeDamage(raw, this.kind, this.attackerSum, this.shootingPushback);
    this.penHits += 1;
    this.continueBehind(struck);
  }

}

/**
 * Floating damage number that rises and fades over a wounded troop or keep.
 * Color marks whether the hit was a shot or a melee swing.
 */
class HitSplat {
  constructor(x, y, amount, kind) {
    this.x = x + (Math.random() - 0.5) * 14;
    this.y = y - 12;
    this.amount = amount;
    this.kind = kind || "shoot";
    this.age = 0;
    this.alive = true;
  }

  /** Yellow for shots, red for melee, green for healing, blue for halt fatigue. */
  fillColor() {
    if (this.kind === "melee") return CONFIG.colors.splatMelee;
    if (this.kind === "heal") return CONFIG.colors.splatHeal;
    if (this.kind === "fatigue") return CONFIG.colors.splatFatigue;
    return CONFIG.colors.splatShoot;
  }

  /** Rise and expire. */
  update(dt) {
    this.age += dt;
    this.y -= CONFIG.splatRise * dt;
    if (this.age >= CONFIG.splatLife) {
      this.alive = false;
    }
  }

}

/**
 * One purchased unit. Walks a sublane, sidesteps blockers and side enemies,
 * and fires visible shots. Subclasses set stats and special rules.
 */
class Unit {
  constructor(id, side, lane, sublane) {
    this.id = id;
    this.side = side;
    this.lane = lane;
    this.sublane = sublane;
    this.type = "troop";
    this.variant = null;
    this.alternate = false;
    this.applyStats(UNIT_STATS.troop);
    this.progress = 0;
    this.cooldown = 0;
    this.flash = 0;
    this.strafing = false;
    this.order = null;
    this.priorOrder = null;
    this.broken = false;
    this.reformNeedsAlign = false;
    this.squared = false;
    this.pushbackCounter = 0;
    /** Queued paces: { fatigueOnBlock, easeIndex }. */
    this.pushbackQueue = [];
    this.pushbackNextEaseIndex = 0;
    /** Active eased pace: { from, to, elapsed, duration, fatigueOnBlock }. */
    this.pushbackMove = null;
    /**
     * Set when this unit walks or eases toward its keep this tick
     * (retreat, fallback, charge reverse, peel, switch ease-back).
     * Survives until the next update so mid-tick hits still see it.
     */
    this.movingBackward = false;
    this.switch = null;
    this.switchEscape = false;
    this.switchEaseDir = 0;
    this.playerSwitch = false;
    /** After Reform-from-switch finishes, step this many rows (−1 or +1). */
    this.pendingSwitchDir = null;
    this.wasInMelee = false;
    /** Seconds left sticky-locking melee for shoot rules after contact ends. */
    this.meleeLockTimer = 0;
    this.orderHeld = false;
    this.heldOrder = null;
    /** Prior tick order; used to detect ending a pass-through while stacked. */
    this.prevCollisionOrder = null;
    /** Prior tick melee lock; paired with prevCollisionOrder for peel detect. */
    this.prevInMelee = false;
    /** Ease after pass-through ends while overlapping a collidable. */
    this.peelingFromPassThrough = false;
    /** Committed peel direction (+1 forward / -1 back) until clear. */
    this.peelDir = 0;
    /**
     * When true, this unit keeps a solo-issued order and does not absorb
     * halt/reform/advance from adjacent line-mates.
     */
    this.ignoreLineOrders = false;
    /**
     * Prior tick: already Perfect Line with a Halt/Reform troop next door.
     * Order passing only fires on the transition into that alignment.
     */
    this.wasOrderPassParallel = false;
    /**
     * Set when Advance is issued while already In Line with a Halt/Reform
     * troop ahead on an adjacent row. Blocks order passing until that
     * In Line contact ends, so a slightly-behind unit can walk past.
     */
    this.suppressOrderPass = false;
    this.applyPath();
    const spawn = Path.pointAt(this.points, 0);
    this.x = spawn.x;
    this.y = spawn.y;
  }

  /** Copy this kind's combat numbers onto the instance. */
  applyStats(stats) {
    this.maxHp = stats.hp;
    this.hp = stats.hp;
    this.maxFatigue = stats.fatigue;
    this.fatigue = 0;
    this.rangedDamage = stats.rangedDamage;
    this.meleeDamage = stats.meleeDamage;
    this.range = stats.range;
    this.shootingPushback = stats.shootingPushback || 0;
    this.meleePushback = stats.meleePushback || 0;
    this.pushbackTakenFactor = stats.pushbackTakenFactor != null
      ? stats.pushbackTakenFactor
      : 1;
    this.engageRange = stats.engageRange;
    this.chargeSpeed = stats.chargeSpeed;
    this.chargeMultiplier = stats.chargeMultiplier;
    this.flankMultiplier = stats.flankMultiplier;
    this.rangedCooldown = stats.rangedCooldown;
    this.meleeCooldown = stats.meleeCooldown;
    this.projectileSize = stats.projectileSize;
    this.projectileSpeed = stats.projectileSpeed;
    this.projectileColor = stats.projectileColor;
    this.radius = stats.radius;
    this.speed = stats.speed;
    this.lineBonus = stats.lineBonus;
    this.fightsMelee = stats.fightsMelee;
    this.splash = stats.splash;
    this.restoreRange = stats.restoreRange || 0;
    this.restoreRate = stats.restoreRate || 0;
    this.restoreHealth = Boolean(stats.restoreHealth);
    this.officerDamageMultiplier = stats.officerDamageMultiplier || 1;
  }

  /**
   * Speed ladder for swipes: retreat, fallback, halt, advance, charge.
   * Reform sits beside advance for swipe stepping.
   */
  speedOrders() {
    return ["retreat", "fallback", "halt", null, "charge"];
  }

  speedIndex() {
    if (this.order === "retreat") return 0;
    if (this.order === "fallback") return 1;
    if (this.order === "halt") return 2;
    if (this.order === "charge") return 4;
    return 3;
  }

  /** Units that receive this order: the whole line, or only this troop.
   * Melee units never share group orders — each must be ordered alone.
   * They still count in lineGroup for line bonus and Line size. */
  orderGroup(allies, solo, enemies) {
    if (solo) return [this];
    if (enemies && this.isInMelee(enemies)) return [this];
    const group = this.lineGroup(allies);
    if (!enemies) return group;
    return group.filter((unit) => unit === this || !unit.isInMelee(enemies));
  }

  /**
   * Click cycle: advance, halt, reform. Charge and fallback are drag orders.
   * Subclasses replace this when they use a different set.
   */
  clickOrders() {
    return [null, "halt", "reform"];
  }

  /** Click toggles Halt and Advance. Reform is not on this cycle. */
  nextClickOrder() {
    const current = this.orderHeld ? this.heldOrder : this.order;
    if (current === "halt") return null;
    return "halt";
  }

  /**
   * Accept an order. In melee the only accepted order is Fall Back,
   * and that is Retreat immediately. Retreat is not stored for later.
   */
  commitOrder(next, enemies) {
    if (this.broken) return;
    const inMelee = Boolean(enemies && this.isInMelee(enemies));
    if (inMelee && next === "fallback") next = "retreat";
    if (inMelee && next !== "retreat") return;
    this.orderHeld = false;
    this.heldOrder = null;
    this.squared = false;
    this.order = next;
    this.reformNeedsAlign = next === "reform";
    if (next !== "reform") {
      this.priorOrder = null;
      this.pendingSwitchDir = null;
    }
    if (next === "retreat" || next === "fallback" || next === "charge" || next === "halt" || next === null) {
      this.switch = null;
      this.switchEscape = false;
      this.switchEaseDir = 0;
      this.playerSwitch = false;
    }
  }

  /** Apply an order to this troop's order group. */
  applyGroupOrder(allies, next, solo, enemies) {
    const forceSolo = Boolean(solo) || Boolean(enemies && this.isInMelee(enemies));
    const group = this.orderGroup(allies, forceSolo, enemies);
    const lock = forceSolo;
    for (let i = 0; i < group.length; i += 1) {
      group[i].commitOrder(next, enemies);
      group[i].ignoreLineOrders = lock;
      if (next === null) {
        group[i].refreshOrderPassSuppress(allies);
      } else {
        group[i].suppressOrderPass = false;
      }
    }
  }

  /** Start a held order once this unit is no longer in melee. */
  releaseHeldOrder(enemies) {
    if (!this.orderHeld || this.isInMelee(enemies)) return;
    const next = this.heldOrder;
    this.orderHeld = false;
    this.heldOrder = null;
    this.order = next;
    this.reformNeedsAlign = next === "reform";
    if (next !== "reform") this.priorOrder = null;
    if (next === null && this.side) {
      this.refreshOrderPassSuppress(this.side.troops);
    } else {
      this.suppressOrderPass = false;
    }
  }

  /**
   * Left-click while selected: enter reform, remembering the prior order.
   * Broken units ignore it. Melee units reform alone. Recruit uses the
   * reform seek chain, not the combat In-Line group.
   */
  issueReform(allies, enemies, solo) {
    if (this.broken) {
      return;
    }
    if (this.order === "reform") return;
    const forceSolo = Boolean(solo) || this.isInMelee(enemies);
    const group = forceSolo ? [this] : this.reformSeekGroup(allies);
    const lock = forceSolo;
    for (let i = 0; i < group.length; i += 1) {
      if (group[i].broken || group[i].order === "reform") continue;
      if (enemies && group[i] !== this && group[i].isInMelee(enemies)) continue;
      group[i].priorOrder = group[i].orderHeld ? group[i].heldOrder : group[i].order;
      group[i].commitOrder("reform", enemies);
      group[i].priorOrder = group[i].priorOrder;
      group[i].ignoreLineOrders = lock;
    }
  }

  /**
   * Left-click while reforming: restore the prior speed order when it is
   * still legal, otherwise advance.
   */
  issueRestore(allies, enemies, solo) {
    if (this.broken) {
      return;
    }
    let want = this.priorOrder;
    if (want === "reform") want = null;
    if (want === "charge" && this.lineInMelee(allies, enemies)) want = null;
    if (want !== "halt" && want !== "charge" && want !== "fallback"
      && want !== "retreat" && want !== null) {
      want = null;
    }
    this.applyGroupOrder(allies, want, solo, enemies);
  }

  /**
   * Left-click: halt, or reform if already halted, or resume a normal
   * advance if reforming. In melee the order is held unless it is reform.
   */
  issueOrder(allies, enemies, solo) {
    if (this.broken) return;
    const next = this.nextClickOrder();
    this.applyGroupOrder(allies, next, solo, enemies);
  }

  /**
   * Swipe forward: one step up the speed ladder
   * (retreat → fallback → halt → advance → charge).
   */
  issueSpeedUp(allies, enemies, solo) {
    if (this.broken) return;
    const ladder = this.speedOrders();
    const next = Math.min(ladder.length - 1, this.speedIndex() + 1);
    const order = ladder[next];
    if (order === this.order) return;
    this.applyGroupOrder(allies, order, solo, enemies);
  }

  /**
   * Swipe back: one step down the speed ladder
   * (charge → advance → halt → fallback → retreat).
   */
  issueSpeedDown(allies, enemies, solo) {
    if (this.broken) {
      return;
    }
    const ladder = this.speedOrders();
    const next = Math.max(0, this.speedIndex() - 1);
    const order = ladder[next];
    if (order === this.order) return;
    this.applyGroupOrder(allies, order, solo, enemies);
  }

  /**
   * Drag forward: charge (seek melee, no shooting until contact).
   * A charge given in melee waits until contact ends.
   */
  issueCharge(allies, enemies, solo) {
    if (this.broken || this.order === "charge") {
      return;
    }
    this.applyGroupOrder(allies, "charge", solo, enemies);
  }

  /**
   * Fall back at reform speed. In melee this is Retreat immediately:
   * retreat speed, and the order keeps moving through contact.
   * Melee attacks and leaving melee range do not cancel that Retreat.
   */
  issueFallback(allies, enemies, solo) {
    if (this.broken) return;
    if (enemies && this.isInMelee(enemies)) {
      if (this.order === "retreat") return;
      this.applyGroupOrder(allies, "retreat", solo, enemies);
      return;
    }
    if (this.order === "fallback") return;
    this.applyGroupOrder(allies, "fallback", solo, enemies);
  }

  /** Swipe toward the enemy: charge. */
  issueForward(allies, enemies, solo) {
    if (this.broken) return;
    this.issueCharge(allies, enemies, solo);
  }

  /** Swipe toward your keep: fall back. In melee this stays on that unit. */
  issueBack(allies, enemies, solo) {
    if (this.broken) return;
    this.issueFallback(allies, enemies, solo);
  }

  /** True when this body may not be given a sublane switch. */
  switchBlocked() {
    return this.broken || this.order === "retreat";
  }

  /**
   * Hidden switch: slide this unit one row. Melee, broken, and
   * retreating units ignore it.
   */
  issueSwitch(sublane) {
    const foes = this.enemyTroops();
    if (this.switchBlocked() || (foes && this.isInMelee(foes))) return;
    const count = Path.sublaneCount(this.lane);
    if (!Number.isInteger(sublane) || sublane < 0 || sublane >= count || sublane === this.sublane) {
      this.switch = null;
      return;
    }
    const dir = Math.sign(sublane - this.sublane);
    const next = this.sublane + dir;
    const allies = this.side ? this.side.troops : [];
    const mate = this.lineMateOnRow(next, allies);
    if (mate) {
      this.reformUnits(this.reformSeekGroup(allies));
      return;
    }
    this.switch = next;
    this.switchEscape = false;
    this.playerSwitch = true;
    this.squared = false;
    this.switchEaseDir = 0;
  }

  /**
   * Hidden switch for a line. Only allowed when the touched unit's next
   * row in the swipe direction has no overlapping matching unit. Swiping
   * into a same-line (or any In-Line matching) neighbor Reforms only. A
   * clear swipe on a staggered line Reforms then switches; a squared line
   * switches immediately.
   */
  issueLineSwitch(dir, allies) {
    if (this.switchBlocked() || (dir !== 1 && dir !== -1)) return;
    const foes = this.enemyTroops();
    if (foes && this.isInMelee(foes)) return;
    const seekers = this.reformSeekGroup(allies);
    const mate = this.lineMateOnRow(this.sublane + dir, allies);

    // Into an overlapping matching unit: Reform only, never queue a switch.
    if (mate) {
      if (seekers.length >= 2 && !this.lineIsSquare(seekers)) {
        for (let i = 0; i < seekers.length; i += 1) {
          seekers[i].pendingSwitchDir = null;
        }
        this.reformUnits(seekers);
      }
      return;
    }

    // Adjacent row clear: switch, squaring first when needed.
    if (seekers.length >= 2 && !this.lineIsSquare(seekers)) {
      for (let i = 0; i < seekers.length; i += 1) {
        seekers[i].pendingSwitchDir = dir;
      }
      this.reformUnits(seekers);
      return;
    }
    const group = this.lineGroup(allies);
    this.applyLineSwitch(dir, group.length >= 1 ? group : [this], foes);
  }

  /**
   * Commit a one-row shift for every eligible member. Aborts the whole
   * move when any eligible member would leave the lane.
   */
  applyLineSwitch(dir, group, foes) {
    if (dir !== 1 && dir !== -1 || !group || group.length < 1) return;
    const count = Path.sublaneCount(this.lane);
    const enemies = foes || this.enemyTroops();
    const movers = [];
    for (let i = 0; i < group.length; i += 1) {
      const member = group[i];
      if (member.switchBlocked()) continue;
      if (enemies && member.isInMelee(enemies)) continue;
      const next = member.sublane + dir;
      if (next < 0 || next >= count) return;
      movers.push(member);
    }
    for (let i = 0; i < movers.length; i += 1) {
      movers[i].switch = movers[i].sublane + dir;
      movers[i].switchEscape = false;
      movers[i].switchEaseDir = 0;
      movers[i].playerSwitch = true;
      movers[i].squared = false;
      movers[i].pendingSwitchDir = null;
    }
  }

  /** Square these units. Keeps pendingSwitchDir so a queued row shift can run after. */
  reformUnits(units) {
    for (let i = 0; i < units.length; i += 1) {
      const unit = units[i];
      if (!unit || unit.broken || unit.hp <= 0) continue;
      unit.priorOrder = unit.order;
      unit.order = "reform";
      unit.squared = false;
      unit.reformNeedsAlign = true;
      unit.switch = null;
      unit.switchEscape = false;
      unit.switchEaseDir = 0;
      unit.playerSwitch = false;
    }
  }

  /**
   * Put the reform-seek column on reform without cycling through halt.
   * Does not absorb orders later by walking into parallel.
   */
  startReform(allies, solo, enemies) {
    const forceSolo = Boolean(solo) || Boolean(enemies && this.isInMelee(enemies));
    const group = forceSolo ? [this] : this.reformSeekGroup(allies);
    const lock = forceSolo;
    for (let i = 0; i < group.length; i += 1) {
      if (group[i].broken) continue;
      if (enemies && group[i] !== this && group[i].isInMelee(enemies)) continue;
      group[i].priorOrder = group[i].order;
      group[i].order = "reform";
      group[i].squared = false;
      group[i].reformNeedsAlign = true;
      group[i].ignoreLineOrders = lock;
      group[i].switch = null;
      group[i].switchEscape = false;
      group[i].switchEaseDir = 0;
      group[i].playerSwitch = false;
    }
  }

  /** Rebuild the polyline after a sublane change so progress stays on-track. */
  applyPath() {
    this.points = Path.waypoints(this.side.id, this.lane, this.sublane);
    this.pathLength = Path.length(this.points);
  }

  /** Shared 0..1 coordinate from the player capital so opposite sides line up. */
  laneT() {
    return this.side.id === "player" ? this.progress : 1 - this.progress;
  }

  /** Shared lineup coordinate so every sublane of this lane lines up. */
  station() {
    return Path.stationAt(this.lane, this.x, this.y);
  }

  /** Parallel / line / block tolerance in this lane's station units. */
  stationSlack(kind) {
    const radius = this.lane === "bottom" ? Path.bottomRadius(this.sublane) : 0;
    return Path.stationSlack(this.lane, kind, radius);
  }

  /**
   * How far other sits along this troop's facing.
   * Negative is behind, zero is parallel, positive is ahead.
   */
  alongSigned(other) {
    const delta = other.station() - this.station();
    return this.side.id === "player" ? delta : -delta;
  }

  /** True when both troops share the same station (pixels or degrees). */
  isParallelTo(other) {
    return Math.abs(this.station() - other.station()) <= this.stationSlack("parallel");
  }

  /** True when two stations overlap enough to share a line. */
  withinLine(other) {
    return Math.abs(this.station() - other.station()) <= this.stationSlack("line");
  }

  /** Each type only lines with its own kind. */
  sameLineType(other) {
    return this.type === other.type;
  }

  /** True when the other unit sits in the next row over. */
  adjacentRow(other) {
    return Math.abs(this.sublane - other.sublane) === 1;
  }

  /**
   * True when a neighbor row is close enough along the centerline to
   * count as the same line. A gap of one or more empty sublanes splits
   * two groups into separate lines.
   */
  inLineWith(other) {
    if (this.broken || other.broken) return false;
    if (other.hp <= 0 || other.lane !== this.lane || !this.adjacentRow(other)) {
      return false;
    }
    if (!this.sameLineType(other)) {
      return false;
    }
    return this.withinLine(other);
  }

  /**
   * This troop plus allies chained through adjacent inLineWith. One
   * troop per sublane, at most as many as this lane has rows.
   */
  lineGroup(allies) {
    const cap = Path.sublaneCount(this.lane);
    const group = [this];
    const seen = {};
    const usedRow = {};
    seen[this.id] = true;
    usedRow[this.sublane] = true;
    let added = true;
    while (added && group.length < cap) {
      added = false;
      let best = null;
      let bestDist = Infinity;
      for (let i = 0; i < group.length; i += 1) {
        const member = group[i];
        for (let j = 0; j < allies.length; j += 1) {
          const ally = allies[j];
          if (seen[ally.id] || ally.hp <= 0 || usedRow[ally.sublane]) {
            continue;
          }
          if (!member.inLineWith(ally)) {
            continue;
          }
          const dist = Math.abs(ally.station() - this.station());
          if (dist < bestDist) {
            bestDist = dist;
            best = ally;
          }
        }
      }
      if (best) {
        seen[best.id] = true;
        usedRow[best.sublane] = true;
        group.push(best);
        added = true;
      }
    }
    return group;
  }

  /** Line members from rear to front, relative to this side's facing. */
  sortRearToFront(line) {
    const playerFacing = this.side.id === "player";
    return line.slice().sort((a, b) => (
      playerFacing ? a.station() - b.station() : b.station() - a.station()
    ));
  }

  /**
   * Closest ally behind this troop in an adjacent sublane. Used when a
   * lone unit reforms to get parallel with someone further back.
   */
  nextBehindOtherSublane(allies) {
    let best = null;
    let bestGap = Infinity;
    for (let i = 0; i < allies.length; i += 1) {
      const ally = allies[i];
      if (ally === this || ally.hp <= 0) {
        continue;
      }
      if (ally.lane !== this.lane || !this.adjacentRow(ally)) {
        continue;
      }
      if (!this.sameLineType(ally)) {
        continue;
      }
      const along = this.alongSigned(ally);
      if (along >= 0) {
        continue;
      }
      const gap = -along;
      if (gap < bestGap) {
        bestGap = gap;
        best = ally;
      }
    }
    return best;
  }

  /**
   * True when a same-type ally (or their line) sits ahead and this
   * troop can walk up to join: same row, next row, or a line that
   * already touches this row.
   */
  canJoinLineAhead(allies) {
    for (let i = 0; i < allies.length; i += 1) {
      const ally = allies[i];
      if (ally === this || ally.hp <= 0 || ally.lane !== this.lane) {
        continue;
      }
      if (!this.sameLineType(ally)) {
        continue;
      }
      if (this.alongSigned(ally) <= 0) {
        continue;
      }
      if (ally.sublane === this.sublane || this.adjacentRow(ally)) {
        return true;
      }
      const line = ally.lineGroup(allies);
      for (let k = 0; k < line.length; k += 1) {
        if (line[k].sublane === this.sublane || this.adjacentRow(line[k])) {
          return true;
        }
      }
    }
    return false;
  }

  /** Closest ally ahead in an adjacent sublane of the same lane. */
  nextAheadOtherSublane(allies) {
    let best = null;
    let bestGap = Infinity;
    for (let i = 0; i < allies.length; i += 1) {
      const ally = allies[i];
      if (ally === this || ally.hp <= 0) {
        continue;
      }
      if (ally.lane !== this.lane || !this.adjacentRow(ally)) {
        continue;
      }
      if (!this.sameLineType(ally)) {
        continue;
      }
      const along = this.alongSigned(ally);
      if (along <= 0) {
        continue;
      }
      if (along < bestGap) {
        bestGap = along;
        best = ally;
      }
    }
    return best;
  }

  /**
   * True when this rank already fills every row of the lane. `outsider`
   * is left out, so a skirmisher on a taken row is not what fills it and
   * is not a reason for the rank to change order.
   */
  rankIsFull(allies, outsider) {
    const cap = Path.sublaneCount(this.lane);
    const rows = {};
    const seen = {};
    const queue = [this];
    seen[this.id] = true;
    rows[this.sublane] = true;
    let head = 0;
    while (head < queue.length && Object.keys(rows).length < cap) {
      const member = queue[head];
      head += 1;
      for (let i = 0; i < allies.length; i += 1) {
        const other = allies[i];
        if (other === outsider || other === this || seen[other.id] || other.hp <= 0) {
          continue;
        }
        if (!member.inLineWith(other)) {
          continue;
        }
        if (rows[other.sublane]) {
          continue;
        }
        seen[other.id] = true;
        rows[other.sublane] = true;
        queue.push(other);
      }
    }
    return Object.keys(rows).length >= cap;
  }

  /** Another living unit of this type already standing on this row. */
  sameRowMate(allies) {
    for (let i = 0; i < allies.length; i += 1) {
      const other = allies[i];
      if (other === this || other.hp <= 0 || other.lane !== this.lane) {
        continue;
      }
      if (other.sublane !== this.sublane || !this.sameLineType(other)) {
        continue;
      }
      return other;
    }
    return null;
  }

  /**
   * Orders pass only between bodies that each stand alone on their row.
   * A second body on a row, even one that does not collide, is overlapping
   * and neither gives nor takes a line order.
   */
  canPassLineOrder(ally, allies) {
    return !this.sameRowMate(allies) && !ally.sameRowMate(allies);
  }

  /**
   * True when this unit can still enter ally's line. The check ignores
   * this unit, so a skirmisher passing through a full rank is not counted
   * as the member of its row. A full rank has no room left.
   */
  canTakeLineOrder(ally, allies) {
    const cap = Path.sublaneCount(this.lane);
    const rows = {};
    const seen = {};
    const queue = [ally];
    seen[ally.id] = true;
    rows[ally.sublane] = true;
    let head = 0;
    while (head < queue.length) {
      const member = queue[head];
      head += 1;
      for (let i = 0; i < allies.length; i += 1) {
        const other = allies[i];
        if (other === this || seen[other.id] || other.hp <= 0) {
          continue;
        }
        if (!member.inLineWith(other)) {
          continue;
        }
        if (rows[other.sublane]) {
          continue;
        }
        seen[other.id] = true;
        rows[other.sublane] = true;
        queue.push(other);
      }
    }
    if (rows[this.sublane]) {
      return false;
    }
    return queue.length < cap;
  }

  /**
   * Adjacent Halt/Reform troop ahead or level within the given station
   * window. Used by order passing (Perfect Line) and Advance suppress (In Line).
   */
  orderPassCandidate(allies, kind) {
    const slack = this.stationSlack(kind);
    for (let i = 0; i < allies.length; i += 1) {
      const ally = allies[i];
      if (ally === this || ally.hp <= 0 || ally.lane !== this.lane) {
        continue;
      }
      if (ally.type !== "troop" || !this.adjacentRow(ally)) {
        continue;
      }
      if (ally.order !== "halt" && ally.order !== "reform") {
        continue;
      }
      if (Math.abs(this.station() - ally.station()) > slack) {
        continue;
      }
      // Must be walking up to them (or already level), not copying from behind.
      if (this.alongSigned(ally) < -this.stationSlack("parallel")) {
        continue;
      }
      return ally;
    }
    return null;
  }

  /** Adjacent Halt/Reform troop this unit is already Perfect Line with. */
  orderPassNeighbor(allies) {
    return this.orderPassCandidate(allies, "parallel");
  }

  /**
   * Adjacent Halt/Reform troop this unit is already In Line with and not
   * past. Advance issued in this state suppresses order passing so the
   * unit can walk through Perfect Line and past the line.
   */
  orderPassInLineNeighbor(allies) {
    return this.orderPassCandidate(allies, "line");
  }

  /** Latch or clear suppress when this unit is put on Advance. */
  refreshOrderPassSuppress(allies) {
    this.suppressOrderPass = Boolean(this.orderPassInLineNeighbor(allies));
  }

  /**
   * Order passing for troops only. An Advancing troop that newly enters
   * Perfect Line with a Halted or Reforming troop on an adjacent row
   * takes that order on itself alone. Already-aligned units that are
   * given a new order do not immediately re-inherit. Advance issued while
   * already In Line behind a Halt/Reform mate suppresses passing until
   * that In Line contact ends, so the unit can walk past. Reform movement
   * does not absorb mid-manoeuvre.
   */
  tryJoinAhead(allies) {
    if (this.type !== "troop" || this.broken) {
      return;
    }
    if (this.suppressOrderPass && !this.orderPassInLineNeighbor(allies)) {
      this.suppressOrderPass = false;
    }
    const passer = this.orderPassNeighbor(allies);
    const nowParallel = Boolean(passer);
    const entered = nowParallel && !this.wasOrderPassParallel;
    this.wasOrderPassParallel = nowParallel;
    // Track alignment even while Halted/Reforming so a later Advance does
    // not look like a fresh walk-up into line.
    if (!entered || !passer) {
      return;
    }
    // Advance only. Reform movement must not absorb mid-manoeuvre.
    if (this.order != null) {
      return;
    }
    // Issued Advance while already In Line behind them — keep going past.
    if (this.suppressOrderPass) {
      return;
    }
    if (this.isInMelee(this.enemyTroops())) {
      return;
    }
    this.order = passer.order;
    this.reformNeedsAlign = passer.order === "reform";
    if (passer.order !== "reform") {
      this.priorOrder = null;
    }
  }

  /** Mid-walk reform absorb from behind stays off; Perfect Line uses tryJoinAhead. */
  takeReformFromBehind(_allies) {}

  /**
   * Enemy this troop is touching, or standing against at the body edge.
   * Used for charge contact and order-lock; walking into a body is still blocked.
   */
  /**
   * Melee reach on this row or the next one: footprints plus meleeSlack.
   * Wider than sameRowFootprint so units can lock melee outside bodies.
   */
  footprintReaches(other) {
    if (!other || other === this || other.hp <= 0 || other.lane !== this.lane) return false;
    if (Math.abs(this.sublane - other.sublane) > 1) return false;
    return Math.abs(this.station() - other.station()) <= this.stationSlack("melee");
  }

  /** Same-row hard footprint overlap (centers within the block gap). */
  sameRowFootprint(other) {
    if (!other || other === this || other.hp <= 0 || other.lane !== this.lane) return false;
    if (other.sublane !== this.sublane) return false;
    return Math.abs(this.station() - other.station()) <= this.stationSlack("block");
  }

  /**
   * Same-row centers strictly inside the footprint (deeper than edge).
   * Melee pairs must not sit here unless one is retreating.
   */
  sameRowDeepOverlap(other) {
    if (!other || other.hp <= 0 || other.lane !== this.lane) return false;
    if (other.sublane !== this.sublane) return false;
    const foot = this.stationSlack("block");
    return Math.abs(this.station() - other.station()) < foot;
  }

  /**
   * Enemy this troop is touching. Body radii plus meleeSlack, same as
   * the pre-1D charge contact: a neighbor row is not melee unless the
   * bodies actually meet.
   */
  collidingEnemy(enemies) {
    const reach = this.bodyRadius() + CONFIG.meleeSlack;
    for (let i = 0; i < enemies.length; i += 1) {
      const enemy = enemies[i];
      if (enemy.hp <= 0 || enemy.lane !== this.lane) continue;
      if (distance(this, enemy) <= reach + enemy.bodyRadius()) return enemy;
    }
    return null;
  }

  /**
   * Another living ally (not this) whose footprint reaches this enemy.
   * Used to detect pile-ons onto an enemy already in melee with someone else.
   */
  otherAllyReaching(enemy, allies) {
    if (!enemy || !enemy.fightsMelee) return null;
    for (let i = 0; i < allies.length; i += 1) {
      const ally = allies[i];
      if (ally === this || ally.hp <= 0 || !ally.fightsMelee) continue;
      if (enemy.footprintReaches(ally)) return ally;
    }
    return null;
  }

  /**
   * Same-row friendly already in melee whose footprint we share.
   * Pile-ons peel off; the engaged unit itself does not use this to move.
   */
  overlappingFriendlyInMelee(allies, enemies) {
    for (let i = 0; i < allies.length; i += 1) {
      const ally = allies[i];
      if (ally === this || ally.hp <= 0) continue;
      if (!this.sameRowFootprint(ally)) continue;
      if (ally.isInMelee(enemies)) return ally;
    }
    return null;
  }

  /**
   * Friendly already in melee, or enemy already fighting someone else,
   * whose same-row footprint we share — for units not yet locked in melee.
   * Our own edge-contact melee partner does not count.
   */
  meleeStackToPeel(allies, enemies) {
    const friend = this.overlappingFriendlyInMelee(allies, enemies);
    if (friend) return friend;
    for (let i = 0; i < enemies.length; i += 1) {
      const enemy = enemies[i];
      if (!this.sameRowFootprint(enemy)) continue;
      if (this.otherAllyReaching(enemy, allies)) return enemy;
    }
    return null;
  }

  /**
   * Same-row enemy we are stacked inside of (deeper than edge contact),
   * when neither side is retreating. Used only so a charger can ease
   * itself back to the contact edge — never to move the enemy.
   */
  deepEnemyOverlap(enemies) {
    if (this.passesThroughEnemies()) return null;
    for (let i = 0; i < enemies.length; i += 1) {
      const enemy = enemies[i];
      if (enemy.hp <= 0) continue;
      if (enemy.order === "retreat" || enemy.order === "fallback") continue;
      if (this.sameRowDeepOverlap(enemy)) return enemy;
    }
    return null;
  }

  /**
   * Body we should be peeling away from. Friendlies only — opposing units
   * never move each other, and once in melee a unit stays put (except flank
   * dress) so we do not snap against enemy footprints.
   */
  peelTarget(allies, enemies) {
    return this.overlappingFriendlyInMelee(allies, enemies)
      || this.collidingAlly(allies);
  }

  bodyRadius() {
    return this.radius;
  }

  maxHP() {
    return this.maxHp;
  }

  /**
   * True when this unit is locked in body contact with an enemy that
   * also fights in melee.
   */
  isInMelee(foes) {
    if (!this.fightsMelee || this.hp <= 0) return false;
    const foe = this.collidingEnemy(foes || this.enemyTroops());
    return Boolean(foe && foe.fightsMelee);
  }

  /**
   * HARD RULE — do not weaken: a unit that is in melee, was in melee
   * last tick, or is still inside the sticky melee lock must not fire
   * ranged shots. Melee swings use fire(..., "melee") and bypass this.
   */
  cannotFireRanged(foes) {
    if (this.meleeLockTimer > 0) return true;
    if (this.wasInMelee) return true;
    return this.isInMelee(foes);
  }

  /**
   * HARD RULE — do not weaken: melee-locked units are never valid
   * ranged targets. The Keep is the sole exception (see isValidRangedTarget).
   * Keeps may still fire into melee.
   * Covers current contact, prior tick, and sticky lock after gaps.
   */
  isMeleeTargetLocked() {
    if (this.meleeLockTimer > 0) return true;
    if (this.wasInMelee) return true;
    return this.isInMelee();
  }

  /** True if any member of this line is in melee. Orders are locked then. */
  lineInMelee(allies, enemies) {
    if (!this.fightsMelee) {
      return false;
    }
    const group = this.lineGroup(allies);
    for (let i = 0; i < group.length; i += 1) {
      if (group[i].fightsMelee && group[i].collidingEnemy(enemies)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Flank bonus: charging, footprints already overlap, and either the
   * next row or the same row from behind the target.
   */
  isFlanking(target) {
    if (this.order !== "charge") return false;
    if (!this.footprintReaches(target)) return false;
    if (target.sublane !== this.sublane) return true;
    return this.alongSigned(target) > 0;
  }

  /**
   * Closest living enemy this charger is flanking on an adjacent row
   * (by along-lane station gap). Same-row flanks do not dress. Null when
   * not charging into an adjacent-row flank.
   */
  closestFlankTarget(enemies) {
    if (this.order !== "charge") return null;
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < enemies.length; i += 1) {
      const enemy = enemies[i];
      if (enemy.hp <= 0 || !this.isFlanking(enemy)) continue;
      if (enemy.sublane === this.sublane) continue;
      const dist = Math.abs(this.station() - enemy.station());
      if (dist < bestDist) {
        bestDist = dist;
        best = enemy;
      }
    }
    return best;
  }

  /**
   * Charging flankers may still ease along the lane — only to dress into
   * Perfect Line with the closest adjacent-row unit they are flanking.
   * Same-row contact stays put (no walking deeper into the target).
   * Never walks through another charging / collidable friendly.
   * True if it moved.
   */
  seekFlankPerfectLine(dt, allies, enemies) {
    const target = this.closestFlankTarget(enemies);
    if (!target || target.sublane === this.sublane || this.isParallelTo(target)) {
      return false;
    }

    const along = this.alongSigned(target);
    const slack = this.stationSlack("parallel");
    const need = Math.abs(along) - slack;
    if (!(need > 0)) return false;

    const sign = along > 0 ? 1 : -1;
    // Do not dress through a collidable charger (or anyone else we block).
    for (let i = 0; i < allies.length; i += 1) {
      if (this.isBlockedToward(allies[i], sign)) {
        return false;
      }
    }

    const stationSpan = Path.lanePaces(this.lane) * Path.stationPerPace(this.lane);
    if (!(stationSpan > 0)) return false;

    const speed = this.marchSpeed(allies);
    if (!(speed > 0)) return false;
    const delta = Math.min(this.alongDelta(speed, dt), need / stationSpan);
    if (!(delta > 0)) return false;

    const nextProgress = Math.max(0, Math.min(1, this.progress + sign * delta));
    if (nextProgress === this.progress) return false;

    const allyClamped = this.clampProgressFromCollidableAlly(nextProgress, allies);
    if (allyClamped == null || allyClamped === this.progress) return false;

    const next = Path.pointAt(this.points, allyClamped);
    const nextStation = Path.stationAt(this.lane, next.x, next.y);
    // Stay in melee reach with the flanked unit.
    if (Math.abs(nextStation - target.station()) > this.stationSlack("melee")) {
      return false;
    }
    this.progress = allyClamped;
    this.syncPosition();
    return true;
  }

  /** True if a world point would overlap an enemy footprint on atSublane. */
  overlapsEnemyAt(x, y, enemies, atSublane = this.sublane) {
    const station = Path.stationAt(this.lane, x, y);
    const slack = this.stationSlack("block");
    for (let i = 0; i < enemies.length; i += 1) {
      const enemy = enemies[i];
      if (enemy.hp <= 0 || enemy.lane !== this.lane) continue;
      if (enemy.sublane !== atSublane) continue;
      // Retreating / falling back bodies are pass-through for movement.
      if (enemy.order === "retreat" || enemy.order === "fallback") continue;
      if (Math.abs(station - enemy.station()) <= slack) return true;
    }
    return false;
  }

  /**
   * True when this unit is withdrawing and must not be stopped by enemy
   * bodies (Fall Back and Retreat walk through opposing units).
   */
  passesThroughEnemies() {
    return this.order === "retreat" || this.order === "fallback";
  }

  /**
   * A formed (perfectly parallel) line holds if anyone in it has opened
   * fire. Troops still closing up are not held — they walk into square.
   * Charge, fallback, and reform use their own movement.
   */
  lineIsHolding(allies, enemies, enemySide) {
    if (this.order === "charge" || this.order === "fallback" || this.order === "retreat"
      || this.order === "reform") {
      return false;
    }
    const line = this.lineGroup(allies);
    for (let i = 0; i < line.length; i += 1) {
      const mate = line[i];
      if (mate === this || mate.isInMelee(enemies) || !this.isParallelTo(mate)) {
        continue;
      }
      if (mate.isOpeningFire(enemies, allies, enemySide)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Advancing in a squared line that has opened fire: full shoot range.
   * Opening fire itself still uses engage range (see openFireRange).
   */
  lineVolleyRange(allies, enemies, enemySide) {
    if (this.order != null) {
      return false;
    }
    if (this.lineIsHolding(allies, enemies, enemySide)) {
      return true;
    }
    if (!this.isOpeningFire(enemies, allies, enemySide)) {
      return false;
    }
    const line = this.lineGroup(allies);
    for (let i = 0; i < line.length; i += 1) {
      const mate = line[i];
      if (mate === this || mate.isInMelee(enemies) || !this.isParallelTo(mate)) {
        continue;
      }
      return true;
    }
    return false;
  }

  /**
   * Same-type neighbors on adjacent rows within In Line for Reform's
   * initial recruit. An empty row still splits them. Order passing does
   * not use this after the reform has started.
   */
  reformSeekGroup(allies) {
    return this.reformChain(allies, null);
  }

  /**
   * Same-type reforming neighbors on adjacent rows that are still In Line.
   * An empty row still splits them.
   */
  reformFormation(allies) {
    return this.reformChain(allies, "reform");
  }

  /**
   * Adjacent-row same-type chain within In Line. When onlyOrder is set,
   * only units on that order join (active reform formation). When null,
   * any living unit joins (initial reform seek).
   */
  reformChain(allies, onlyOrder) {
    const cap = Path.sublaneCount(this.lane);
    const group = [this];
    const seen = {};
    const usedRow = {};
    seen[this.id] = true;
    usedRow[this.sublane] = true;
    let added = true;
    while (added && group.length < cap) {
      added = false;
      for (let i = 0; i < group.length && group.length < cap; i += 1) {
        const member = group[i];
        for (let j = 0; j < allies.length; j += 1) {
          const ally = allies[j];
          if (seen[ally.id] || ally.hp <= 0 || usedRow[ally.sublane]) {
            continue;
          }
          if (ally.broken || ally.lane !== this.lane) {
            continue;
          }
          if (onlyOrder != null && ally.order !== onlyOrder) {
            continue;
          }
          if (!member.sameLineType(ally) || !member.adjacentRow(ally)) {
            continue;
          }
          if (!member.withinLine(ally)) {
            continue;
          }
          seen[ally.id] = true;
          usedRow[ally.sublane] = true;
          group.push(ally);
          added = true;
          if (group.length >= cap) {
            break;
          }
        }
      }
    }
    return group;
  }

  /**
   * While a reforming formation is staggered, the furthest-forward unit
   * holds. Everyone else walks until they match that unit's progress,
   * then holds. Perfect Line / station windows alone left the head ahead.
   */
  reformShouldStop(allies) {
    if (this.order !== "reform") {
      return false;
    }
    const formation = this.reformBody(allies);
    if (formation.length < 2) {
      return false;
    }
    if (this.reformFormationSquare(formation)) {
      return false;
    }
    const front = this.reformFrontOf(formation);
    if (this === front) {
      return true;
    }
    return this.progress >= front.progress;
  }

  /** True when every unit in the group is in perfect line with the front. */
  lineIsSquare(group) {
    if (!group || group.length < 2) return true;
    const front = this.sortRearToFront(group)[group.length - 1];
    for (let i = 0; i < group.length; i += 1) {
      if (!group[i].isParallelTo(front)) return false;
    }
    return true;
  }

  /**
   * True when every reformer has matched the front's progress. A lone
   * reformer only finishes if no adjacent same-type unit remains.
   */
  reformIsSquare(allies) {
    if (this.order !== "reform") return false;
    const formation = this.reformBody(allies);
    if (formation.length < 2) {
      return this.reformSeekGroup(allies).length < 2;
    }
    return this.reformFormationSquare(formation);
  }

  /** Living non-melee members of the active reform chain. */
  reformBody(allies) {
    const foes = this.enemyTroops();
    return this.reformFormation(allies).filter((unit) => !unit.isInMelee(foes));
  }

  /** Done when every member has walked up to the front's progress. */
  reformFormationSquare(formation) {
    if (!formation || formation.length < 2) return false;
    const front = this.reformFrontOf(formation);
    for (let i = 0; i < formation.length; i += 1) {
      if (formation[i].progress < front.progress) return false;
    }
    return true;
  }

  /** Furthest along its own path in this formation. */
  reformFrontOf(formation) {
    let front = formation[0];
    for (let i = 1; i < formation.length; i += 1) {
      if (formation[i].progress > front.progress) front = formation[i];
    }
    return front;
  }

  /** Halt the whole reforming body together, then run any queued row shift. */
  finishReform(allies) {
    const formation = this.reformBody(allies);
    const units = formation.length > 0 ? formation : [this];
    let pendingDir = null;
    for (let i = 0; i < units.length; i += 1) {
      const unit = units[i];
      if (unit.pendingSwitchDir === 1 || unit.pendingSwitchDir === -1) {
        pendingDir = unit.pendingSwitchDir;
      }
      unit.order = "halt";
      unit.squared = true;
      unit.reformNeedsAlign = false;
      unit.priorOrder = null;
      unit.reformHold = false;
      unit.pendingSwitchDir = null;
    }
    if (pendingDir) {
      this.applyLineSwitch(pendingDir, units, this.enemyTroops());
    }
  }

  /**
   * A squared reforming line holds while anyone in it is inside engage
   * range. A staggered line does not: the rear still walks up to square.
   */
  reformSquaredInRange(allies, enemies, enemySide) {
    if (this.order !== "reform") {
      return false;
    }
    const formation = this.reformFormation(allies).filter((unit) => !unit.isInMelee(enemies));
    if (formation.length < 2) {
      return false;
    }
    const front = this.sortRearToFront(formation)[formation.length - 1];
    for (let i = 0; i < formation.length; i += 1) {
      if (!formation[i].isParallelTo(front)) {
        return false;
      }
    }
    for (let i = 0; i < formation.length; i += 1) {
      const mate = formation[i];
      if (mate.nearestTarget(enemies, mate.openFireRange(), allies, enemySide)) {
        return true;
      }
    }
    return false;
  }

  /** Front-most member of a line, or a lone unit with someone behind. */
  isLineLeader(allies) {
    const line = this.lineGroup(allies);
    if (line.length >= 2) {
      const ordered = this.sortRearToFront(line);
      return ordered[ordered.length - 1] === this;
    }
    return Boolean(this.nextBehindOtherSublane(allies));
  }

  /**
   * Turn a pixel walk speed into progress along this lane's pace length.
   * Every row of a lane shares that length. A shorter drawn arc still
   * covers the same progress in fewer pixels.
   */
  alongDelta(speed, dt) {
    const span = Path.topSpanPx();
    const lanePaces = Path.lanePaces(this.lane);
    if (!(span > 0) || !(lanePaces > 0)) return 0;
    const paceSpeed = speed * (CONFIG.topLanePaces / span);
    return (paceSpeed * dt) / lanePaces;
  }

  /** Living troops on the other side. */
  enemyTroops() {
    const sim = this.side && this.side.sim;
    if (!sim) return [];
    return this.side === sim.player ? sim.enemy.troops : sim.player.troops;
  }

  /** True when a living enemy troop is within range. */
  nearEnemy(range) {
    const foes = this.enemyTroops();
    for (let i = 0; i < foes.length; i += 1) {
      const foe = foes[i];
      if (foe.hp <= 0) continue;
      if (distance(this, foe) <= range) return true;
    }
    return false;
  }

  /** Troops and skirmishers walk faster while charging or retreating. */
  chargeSpeedScale() {
    if (this.order !== "charge" && this.order !== "retreat") return 1;
    if (this.chargeSpeed === 1) return 1;
    return this.chargeSpeed;
  }

  /** Fatigue as a 0–100 percent of the unit's pool. */
  fatiguePct() {
    if (this.maxFatigue <= 0) return 0;
    return (this.fatigue / this.maxFatigue) * 100;
  }

  /** Remaining hit points as a 0–100 percent of max. */
  hpPct() {
    if (this.maxHp <= 0) return 0;
    return (Math.max(0, this.hp) / this.maxHp) * 100;
  }

  /** True while standing in this side's keep cannon range. */
  inCapitalRange() {
    return distance(this, this.side.capital) <= CONFIG.capitalCannonRange;
  }

  /** True when this body overlaps this side's keep circle. */
  overlapsOwnCapital() {
    const capital = this.side && this.side.capital;
    if (!capital) return false;
    const reach = CONFIG.capitalRadius + this.bodyRadius();
    return distance(this, capital) <= reach;
  }

  /**
   * A retreat that has reached this side's end of the lane (progress 0)
   * becomes fall back, same as a full fatigue bar on a broken unit.
   */
  endRetreatAtLaneEnd() {
    if (this.order === "retreat" && this.progress <= 0) {
      this.order = "fallback";
    }
  }

  /**
   * Raise or lower fatigue for this step. Charge and melee contact gain
   * at combat rate (even inside the keep). Broken units also gain while
   * retreating until fatigue is full or they reach their own end of the
   * lane, then switch to fallback. Otherwise halt recovers at idle rate,
   * and own capital recovers faster. Overlapping the keep also restores
   * health at that same recovery rate when no enemy stands behind either
   * of this side's forts. Halt fatigue recovery queues a blue + splat.
   * Keep health restore queues a green + splat. A broken unit rallies
   * once fatigue is at or below half its current hp.
   */
  tickFatigue(dt, enemies) {
    this.endRetreatAtLaneEnd();
    const inMelee = Boolean(this.collidingEnemy(enemies));
    const gaining = this.order === "retreat"
      || (!this.broken && (this.order === "charge" || inMelee));
    if (gaining) {
      this.fatigue = Math.min(
        this.maxFatigue,
        this.fatigue + CONFIG.fatigueCombatRate * dt,
      );
    } else if (this.inCapitalRange()) {
      const recovered = CONFIG.fatigueRecoverRate * dt;
      this.fatigue = Math.max(0, this.fatigue - recovered);
      if (this.hp > 0 && this.overlapsOwnCapital() && this.fortsClearOfEnemies()) {
        const sim = this.side && this.side.sim;
        if (sim) {
          const gained = sim.applyHeal(this, recovered);
          if (gained > 0) sim.registerRestore(this, "heal", gained);
        } else {
          this.hp = Math.min(this.maxHp, this.hp + recovered);
        }
      }
    } else if (this.order === "halt") {
      const before = this.fatigue;
      this.fatigue = Math.max(0, this.fatigue - CONFIG.fatigueIdleRate * dt);
      const eased = before - this.fatigue;
      if (eased > 0 && this.side && this.side.sim) {
        this.side.sim.registerRestore(this, "fatigue", eased);
      }
    }
    if (this.broken) {
      if (this.order === "retreat" && this.fatigue >= this.maxFatigue) {
        this.order = "fallback";
      }
      // Rally only after Retreat has ended (Fall Back / recovery). Do not
      // clear Retreat just because fatigue is still below half health.
      if (this.order !== "retreat" && this.fatigue <= this.hp * 0.5) {
        this.broken = false;
        this.order = null;
      }
    }
  }

  /** Force a rout: retreat until fatigue is full or the lane ends, then fall back until fatigue is half current hp. */
  breakUnit() {
    this.broken = true;
    this.order = this.fatigue >= this.maxFatigue ? "fallback" : "retreat";
    this.priorOrder = null;
    this.reformNeedsAlign = false;
    this.squared = false;
    this.switch = null;
    this.switchEscape = false;
    this.switchEaseDir = 0;
    this.playerSwitch = false;
    this.pendingSwitchDir = null;
    this.orderHeld = false;
    this.heldOrder = null;
  }

  /**
   * After a hit, roll to break when fatigue % exceeds hp %. Chance equals
   * the percent gap between them.
   */
  tryBreak() {
    if (this.broken || this.hp <= 0) return;
    const gap = this.fatiguePct() - this.hpPct();
    if (gap <= 0) return;
    if (Math.random() * 100 < gap) {
      this.breakUnit();
    }
  }

  /**
   * Reform: the front stands still, the rearmost walks at full speed,
   * and everyone else walks at half speed until the line is square.
   */
  marchSpeed(allies) {
    const base = this.speed * this.side.speedMultiplier;
    if (this.order === "halt") {
      return 0;
    }
    if (this.order === "fallback") {
      return base * CONFIG.reformSpeedFactor;
    }
    if (this.order === "charge" || this.order === "retreat") {
      return base * this.chargeSpeedScale();
    }
    if (this.order === "reform") {
      if (this.reformHold) {
        return 0;
      }
      if (this.reformIsRearmost(allies)) {
        return base;
      }
      return base * CONFIG.reformSpeedFactor;
    }
    return base;
  }

  /** True when this reforming unit is the furthest back in its formation. */
  reformIsRearmost(allies) {
    const formation = this.reformBody(allies);
    if (formation.length < 2) return true;
    let rear = formation[0];
    for (let i = 1; i < formation.length; i += 1) {
      if (formation[i].progress < rear.progress) rear = formation[i];
    }
    return rear === this;
  }

  /** Furthest-forward living reformer in this formation, or this unit. */
  reformFront(allies) {
    const formation = this.reformBody(allies);
    if (formation.length < 1) return this;
    return this.reformFrontOf(formation);
  }

  /** Firing range for this unit. */
  attackRange() {
    return this.range;
  }

  /** Weapon reach in paces, using the top lane as the ruler. */
  rangePaces() {
    return Path.pacesFromPx(this.attackRange());
  }

  /**
   * Halt shoots at full range. Advance and Fall Back use engageRange
   * (fraction of weapon range).
   */
  relevantRangePaces() {
    if (this.order === "halt") return this.rangePaces();
    const fraction = this.engageRange == null ? 0.5 : this.engageRange;
    return this.rangePaces() * fraction;
  }

  /** Distance along this lane from the named keep, in paces. */
  pacesFromKeep(sideId) {
    const total = Path.lanePaces(this.lane);
    const fromPlayer = this.laneT() * total;
    return sideId === "player" ? fromPlayer : total - fromPlayer;
  }

  /** Along-lane paces to a unit, or the path back through our keep for the other lane. */
  shotPaces(other) {
    if (other && other.capitalHP !== undefined) {
      return (1 - this.progress) * Path.lanePaces(this.lane);
    }
    if (other && other.lane === this.lane) {
      const per = Path.stationPerPace(this.lane);
      if (!(per > 0)) return Infinity;
      return Math.abs(this.station() - other.station()) / per;
    }
    const back = this.progress * Path.lanePaces(this.lane);
    const out = other && other.pacesFromKeep ? other.pacesFromKeep(this.side.id) : Infinity;
    return back + out;
  }

  /**
   * True when no living enemy stands between this side's keep and either
   * fort (top or bottom). Keep health restore only runs while this is clear;
   * keep fatigue restore still runs.
   */
  fortsClearOfEnemies() {
    const foes = this.enemyTroops();
    const limit = CONFIG.fortDistancePaces;
    const sideId = this.side.id;
    for (let i = 0; i < foes.length; i += 1) {
      const foe = foes[i];
      if (foe.hp <= 0) continue;
      if (foe.pacesFromKeep(sideId) <= limit) return false;
    }
    return true;
  }

  /** True when other is a legal shot at this pace range. */
  inShotRange(other, rangePaces) {
    if (!other) return false;
    if (other.capitalHP !== undefined) {
      if (other.capitalHP <= 0) return false;
      return this.shotPaces(other) <= rangePaces;
    }
    if (other.hp <= 0) return false;
    if (other.lane === this.lane) return this.shotPaces(other) <= rangePaces;
    const cross = this.shotPaces(other);
    return cross < CONFIG.crossLaneMaxPaces && cross <= rangePaces;
  }

  /** Range used to open fire on your own. Values are paces. */
  openFireRange() {
    return this.relevantRangePaces();
  }

  /** Range used to pick a shoot target, in paces. */
  shootRange() {
    return this.relevantRangePaces();
  }

  /**
   * True when this troop has a shot in its current range.
   * Chargers and reformers do not shoot. Melee blocks shooting.
   */
  isOpeningFire(enemies, allies, enemySide) {
    // HARD RULE: never open fire while melee-locked.
    if (this.cannotFireRanged(enemies)) return false;
    if (this.order === "charge" || this.order === "reform" || this.order === "retreat") {
      return false;
    }
    return Boolean(this.nearestTarget(enemies, this.openFireRange(), allies, enemySide));
  }

  /** True when this troop may fire at its current range. */
  mayShoot(allies, enemies, enemySide) {
    if (this.order === "reform" || this.order === "charge" || this.order === "retreat") {
      return false;
    }
    // HARD RULE: never shoot while melee-locked.
    if (this.cannotFireRanged(enemies)) return false;
    return Boolean(this.nearestTarget(enemies, this.shootRange(), allies, enemySide));
  }

  /** How often this unit may strike. Fall Back reloads at half rate, except skirmishers. */
  strikeDelay(kind) {
    let base = kind === "melee" ? this.meleeCooldown : this.rangedCooldown;
    if (kind !== "melee" && this.order === "fallback" && this.type !== "skirmisher") {
      base *= 2;
    }
    return base;
  }

  /** Snap onto the current sublane path. Used after a finished strafe. */
  syncPosition() {
    const pos = Path.pointAt(this.points, this.progress);
    this.x = pos.x;
    this.y = pos.y;
  }

  /**
   * Slide only across the path (never diagonally, never along the lane)
   * onto the current sublane. Returns true while still aligning.
   */
  strafe(dt, enemies, allies) {
    const dest = Path.pointAt(this.points, this.progress);
    const tan = Path.tangentAt(this.points, this.progress);
    const nx = -tan.y;
    const ny = tan.x;
    const across = (dest.x - this.x) * nx + (dest.y - this.y) * ny;
    const charge = this.chargeSpeedScale();
    const step = this.speed * this.side.speedMultiplier * charge * dt;
    const dir = across > 0 ? 1 : -1;
    const move = Math.min(Math.abs(across), step) * dir;
    const nxPos = this.x + nx * move;
    const nyPos = this.y + ny * move;
    if (this.overlapsEnemyAt(nxPos, nyPos, enemies)) {
      this.strafing = false;
      return false;
    }
    this.x = nxPos;
    this.y = nyPos;
    if (Math.abs(across) <= step) {
      this.strafing = false;
      return false;
    }
    return true;
  }

  /** Switch rows and start a perpendicular slide into the new path. */
  enterSublane(sublane, enemies) {
    if (sublane === this.sublane && !this.strafing) {
      return;
    }
    // Only ever step one row at a time — never teleport across rows.
    if (Math.abs(sublane - this.sublane) > 1) {
      return;
    }
    const dest = Path.pointAt(Path.waypoints(this.side.id, this.lane, sublane), this.progress);
    if (this.overlapsEnemyAt(dest.x, dest.y, enemies, sublane)) {
      return;
    }
    this.sublane = sublane;
    this.applyPath();
    this.strafing = true;
  }

  /** True when this row has no blockGap-collidable friend and the landing is empty. */
  canEnterSublane(sublane, allies, enemies) {
    const count = Path.sublaneCount(this.lane);
    if (sublane === this.sublane || sublane < 0 || sublane >= count) {
      return false;
    }
    if (this.sublaneHasCollidableInBlockGap(sublane, allies)) {
      return false;
    }
    const dest = Path.pointAt(Path.waypoints(this.side.id, this.lane, sublane), this.progress);
    return !this.overlapsEnemyAt(dest.x, dest.y, enemies, sublane);
  }

  /**
   * Step one sublane toward goal when that next row is free.
   * Returns true if the slide started.
   */
  stepTowardSublane(goal, allies, enemies) {
    const dir = Math.sign(goal - this.sublane);
    if (dir === 0) {
      return false;
    }
    const next = this.sublane + dir;
    if (!this.canEnterSublane(next, allies, enemies)) {
      return false;
    }
    this.enterSublane(next, enemies);
    return true;
  }

  /** Remember a row to slide into; waits if that stretch is blocked. */
  issueLaneChange(sublane) {
    this.issueSwitch(sublane);
  }

  /**
   * Step toward a hidden switch. Returns "stepping" while sliding or
   * easing along the row to clear a blocker, "waiting" if blocked with
   * no room to clear, or "none" when there is no pending row change.
   * Melee pauses it unless this is a non-adjacent escape.
   */
  followLaneOrder(dt, allies, enemies) {
    if (this.switch == null) {
      return "none";
    }
    if (this.switchBlocked()) {
      this.switch = null;
      this.switchEscape = false;
      this.playerSwitch = false;
      return "none";
    }
    // Melee pauses a row change. It does not cancel it. A non-adjacent
    // escape (switchEscape) may still finish.
    if (this.isInMelee(enemies) && !this.switchEscape) {
      return "none";
    }
    if (this.switch === this.sublane) {
      if (!this.strafing) {
        this.playerSwitch = false;
        this.switch = null;
        this.switchEscape = false;
      }
      return "none";
    }
    if (this.pursueSublaneChange(dt, allies, enemies, this.switch)) {
      return "stepping";
    }
    return "waiting";
  }

  /**
   * Walk forward (dir +1) or backward (dir -1) along the current sublane.
   * Stops short of friendly blockers and same-row enemies (edge contact
   * only — no deep overlap unless withdrawing). When seekContact is set,
   * may snap onto the contact edge of a same-row foe — but never through
   * a collidable ally already in that fight. Fall Back and Retreat walk
   * through enemy bodies so opposing withdrawers cannot jam each other.
   * True if it moved.
   */
  marchAlong(dt, allies, enemies, dir, seekContact = false) {
    const sign = dir < 0 ? -1 : 1;
    if (sign < 0) this.movingBackward = true;
    for (let i = 0; i < allies.length; i += 1) {
      if (this.isBlockedToward(allies[i], sign)) {
        return false;
      }
    }
    const speed = this.marchSpeed(allies);
    const delta = this.alongDelta(speed, dt);
    if (!(delta > 0)) return false;
    const nextProgress = Math.max(0, Math.min(1, this.progress + sign * delta));
    if (nextProgress === this.progress) return false;

    if (!this.passesThroughEnemies()) {
      // Collidable allies first so seekContact cannot jump through them.
      const allyClamped = this.clampProgressFromCollidableAlly(
        nextProgress,
        allies,
      );
      if (allyClamped == null) return false;
      if (allyClamped !== nextProgress) {
        if (allyClamped === this.progress) return false;
        this.progress = allyClamped;
        this.syncPosition();
        return true;
      }
      const clamped = this.clampProgressFromSameRowEnemy(
        allyClamped,
        enemies,
        seekContact,
        allies,
      );
      if (clamped == null) return false;
      if (clamped === this.progress) return false;
      this.progress = clamped;
      this.syncPosition();
      return true;
    }

    this.progress = nextProgress;
    this.syncPosition();
    this.endRetreatAtLaneEnd();
    return true;
  }

  /**
   * Nearest same-row living enemy in station space, or null.
   */
  nearestSameRowEnemy(enemies) {
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < enemies.length; i += 1) {
      const enemy = enemies[i];
      if (enemy.hp <= 0 || enemy.lane !== this.lane) continue;
      if (enemy.sublane !== this.sublane) continue;
      if (enemy.order === "retreat" || enemy.order === "fallback") continue;
      const dist = Math.abs(this.station() - enemy.station());
      if (dist < bestDist) {
        bestDist = dist;
        best = enemy;
      }
    }
    return best;
  }

  /**
   * True when applying progress would sit inside a collidable same-row
   * ally's footprint.
   */
  progressHitsCollidableAlly(progress, allies) {
    const pt = Path.pointAt(this.points, progress);
    const station = Path.stationAt(this.lane, pt.x, pt.y);
    const contact = this.stationSlack("block");
    for (let i = 0; i < allies.length; i += 1) {
      const ally = allies[i];
      if (ally === this || ally.hp <= 0 || ally.lane !== this.lane) continue;
      if (ally.sublane !== this.sublane || !this.blocksAlly(ally)) continue;
      if (Math.abs(station - ally.station()) <= contact) return true;
    }
    return false;
  }

  /**
   * Limit nextProgress so this unit does not step into a collidable
   * same-row ally. Already touching: no closer step. Outside: stop just
   * short of their footprint so chargers do not stack on a melee.
   * Returns null when blocked, or the progress to apply.
   */
  clampProgressFromCollidableAlly(nextProgress, allies) {
    const contact = this.stationSlack("block");
    const curStation = this.station();

    let limited = nextProgress;
    for (let i = 0; i < allies.length; i += 1) {
      const ally = allies[i];
      if (ally === this || ally.hp <= 0 || ally.lane !== this.lane) continue;
      if (ally.sublane !== this.sublane || !this.blocksAlly(ally)) continue;

      const allyStation = ally.station();
      const gap = Math.abs(curStation - allyStation);
      const limitedPt = Path.pointAt(this.points, limited);
      const limitedStation = Path.stationAt(
        this.lane,
        limitedPt.x,
        limitedPt.y,
      );
      const nextGap = Math.abs(limitedStation - allyStation);

      if (gap <= contact) {
        if (nextGap < gap) return null;
        continue;
      }
      if (nextGap <= contact) {
        const short = this.progressOutsideContactEdge(allyStation, limited);
        if (short == null || short === this.progress) return null;
        limited = short;
      }
    }
    return limited;
  }

  /**
   * Limit nextProgress so this unit does not step deep inside a same-row
   * enemy footprint. Already in the melee ring (or inside the footprint):
   * no along-lane step. Seeking contact may snap onto the outer melee
   * edge (outside the footprint). Returns null when blocked, or the
   * progress to apply.
   */
  clampProgressFromSameRowEnemy(nextProgress, enemies, seekContact, allies) {
    const foot = this.stationSlack("block");
    const melee = this.stationSlack("melee");
    const curStation = this.station();
    const friendlies = allies || [];

    let limited = nextProgress;
    for (let i = 0; i < enemies.length; i += 1) {
      const enemy = enemies[i];
      if (enemy.hp <= 0 || enemy.lane !== this.lane) continue;
      if (enemy.sublane !== this.sublane) continue;
      if (enemy.order === "retreat" || enemy.order === "fallback") continue;

      const enemyStation = enemy.station();
      const gap = Math.abs(curStation - enemyStation);
      const limitedPt = Path.pointAt(this.points, limited);
      const limitedStation = Path.stationAt(
        this.lane,
        limitedPt.x,
        limitedPt.y,
      );
      const nextGap = Math.abs(limitedStation - enemyStation);

      // Inside footprint or already in the melee ring: hold.
      if (gap <= melee) {
        return null;
      }

      // Step would enter melee reach (and possibly the footprint).
      if (nextGap <= melee) {
        if (!seekContact) {
          // Non-seek: refuse entering the footprint; allow the ring.
          if (nextGap <= foot) return null;
          continue;
        }
        // Snap to the outer melee edge (gap ≈ melee, outside footprint).
        const snapped = this.progressAtContactEdge(enemyStation, limited);
        if (snapped == null || snapped === this.progress) return null;
        if (this.progressHitsCollidableAlly(snapped, friendlies)) {
          return null;
        }
        limited = snapped;
      }
    }
    return limited;
  }

  /**
   * Progress toward towardHint that lands on the outer melee edge
   * (gap == melee reach). Stays outside the hard footprint.
   */
  progressAtContactEdge(targetStation, towardHint) {
    const melee = this.stationSlack("melee");
    const curGap = Math.abs(this.station() - targetStation);
    if (curGap <= melee) return this.progress;

    let lo = this.progress;
    let hi = towardHint;
    const outside = (t) => {
      const pt = Path.pointAt(this.points, t);
      return Math.abs(Path.stationAt(this.lane, pt.x, pt.y) - targetStation) > melee;
    };
    if (!outside(lo)) return this.progress;
    if (outside(hi)) return towardHint;

    for (let n = 0; n < 20; n += 1) {
      const mid = (lo + hi) / 2;
      if (outside(mid)) lo = mid;
      else hi = mid;
    }
    return hi;
  }

  /**
   * Progress toward towardHint that stays just outside the hard footprint
   * (gap > block). Used to stop short of a collidable ally.
   */
  progressOutsideContactEdge(targetStation, towardHint) {
    const contact = this.stationSlack("block");
    const curGap = Math.abs(this.station() - targetStation);
    if (curGap <= contact) return null;

    let lo = this.progress;
    let hi = towardHint;
    const outside = (t) => {
      const pt = Path.pointAt(this.points, t);
      return Math.abs(Path.stationAt(this.lane, pt.x, pt.y) - targetStation) > contact;
    };
    if (!outside(lo)) return null;
    if (outside(hi)) return towardHint;

    for (let n = 0; n < 20; n += 1) {
      const mid = (lo + hi) / 2;
      if (outside(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Step toward a preferred row, or the nearest free (or clearable)
   * neighbor, when a charger cannot keep walking forward.
   */
  tryChargeSidestep(dt, allies, enemies, prefer) {
    if (prefer !== undefined && this.pursueSublaneChange(dt, allies, enemies, prefer)) {
      return true;
    }
    return this.pursueSublaneChange(dt, allies, enemies);
  }

  /**
   * Enemy a charger should close on. Same-row first, then anyone in line,
   * then someone behind, then the nearest foe ahead.
   */
  chargePrey(enemies) {
    let best = null;
    let bestScore = Infinity;
    for (let i = 0; i < enemies.length; i += 1) {
      const enemy = enemies[i];
      if (enemy.hp <= 0 || enemy.lane !== this.lane) continue;
      const along = this.alongSigned(enemy);
      const rowGap = Math.abs(enemy.sublane - this.sublane);
      const stationGap = Math.abs(this.station() - enemy.station());
      let rank = 3;
      if (rowGap === 0) rank = 0;
      else if (this.withinLine(enemy)) rank = 1;
      else if (along < 0) rank = 2;
      const score = rank * 100000 + rowGap * 1000 + stationGap;
      if (score < bestScore) {
        bestScore = score;
        best = enemy;
      }
    }
    return best;
  }

  /**
   * In-line enemy more than one sublane away. Chargers keep stepping
   * toward this unit until they are adjacent or in its row.
   */
  chargeLinedFar(enemies) {
    let best = null;
    let bestScore = Infinity;
    for (let i = 0; i < enemies.length; i += 1) {
      const enemy = enemies[i];
      if (enemy.hp <= 0 || enemy.lane !== this.lane) continue;
      if (!this.withinLine(enemy)) continue;
      const rowGap = Math.abs(enemy.sublane - this.sublane);
      if (rowGap <= 1) continue;
      const score = Math.abs(this.station() - enemy.station()) * 1000 + rowGap;
      if (score < bestScore) {
        bestScore = score;
        best = enemy;
      }
    }
    return best;
  }

  /**
   * Chargers close for melee. They step across when in line with the
   * target. If that row is blocked they keep walking ahead until they
   * can cut in. Once past the enemy (no longer overlapping) they enter
   * its sublane, then reverse in that row to make contact.
   */
  seekChargeMelee(dt, allies, enemies) {
    const prey = this.chargeLinedFar(enemies) || this.chargePrey(enemies);
    if (!prey) return false;
    const along = this.alongSigned(prey);
    const slack = this.stationSlack("parallel");
    if (prey.sublane === this.sublane) {
      if (along < -slack) {
        this.marchAlong(dt, allies, enemies, -1);
      } else if (along > slack && !this.marchAlong(dt, allies, enemies, 1)) {
        this.tryChargeSidestep(dt, allies, enemies);
      }
      return true;
    }
    const past = along < -slack;
    if ((this.withinLine(prey) || past)
      && this.stepTowardSublane(prey.sublane, allies, enemies)) {
      this.strafe(dt, enemies, allies);
      return true;
    }
    if (!this.marchAlong(dt, allies, enemies, 1)) {
      this.tryChargeSidestep(dt, allies, enemies, prey.sublane);
    }
    return true;
  }

  /**
   * Friendly collision. Fall back and retreat ignore friendlies.
   * Charge ignores friendlies unless the other is also charging or
   * either body is in melee (see blocksAllyWithOrders).
   */
  collisionEnabled() {
    if (this.order === "fallback" || this.order === "retreat") return false;
    if (this.order === "charge") return false;
    return true;
  }

  /**
   * True when this unit and ally may not occupy the same stretch.
   */
  blocksAlly(ally) {
    return this.blocksAllyWithOrders(
      ally,
      this.order,
      ally.order,
      this.isInMelee(),
      typeof ally.isInMelee === "function" ? ally.isInMelee() : false,
    );
  }

  /**
   * blocksAlly using explicit orders and melee flags so we can detect
   * ending a pass-through while still overlapping.
   * Fall Back / Retreat always pass through. Charge ignores friendlies
   * unless that friendly is also Charging or either unit is in melee.
   */
  blocksAllyWithOrders(ally, myOrder, theirOrder, myInMelee = false, theirInMelee = false) {
    if (myOrder === "fallback" || myOrder === "retreat"
      || theirOrder === "fallback" || theirOrder === "retreat") {
      return false;
    }
    const myCharge = myOrder === "charge";
    const theirCharge = theirOrder === "charge";
    if (myCharge || theirCharge) {
      if (myCharge && theirCharge) return true;
      if (myInMelee || theirInMelee) return true;
      return false;
    }
    return true;
  }

  /**
   * True when this unit and ally share a row and sit inside the block gap,
   * under the same type/order rules as blocksAlly.
   */
  overlapsCollidingAlly(ally) {
    if (ally === this || ally.hp <= 0) {
      return false;
    }
    if (ally.lane !== this.lane || ally.sublane !== this.sublane) {
      return false;
    }
    if (!this.blocksAlly(ally)) {
      return false;
    }
    return Math.abs(ally.station() - this.station()) <= this.stationSlack("block");
  }

  /**
   * True when we now block a same-row ally inside the block gap, but would
   * not have under prevCollisionOrder / prevInMelee (left fall back /
   * retreat, ended a charge, ally entered melee under us, etc.).
   */
  gainedCollisionWhileOverlapping(allies) {
    const gap = this.stationSlack("block");
    const prev = this.prevCollisionOrder;
    const prevMelee = Boolean(this.prevInMelee);
    const myMelee = this.isInMelee();
    for (let i = 0; i < allies.length; i += 1) {
      const ally = allies[i];
      if (ally === this || ally.hp <= 0 || ally.lane !== this.lane) {
        continue;
      }
      if (ally.sublane !== this.sublane) {
        continue;
      }
      if (Math.abs(ally.station() - this.station()) > gap) {
        continue;
      }
      const theirMelee = typeof ally.isInMelee === "function"
        ? ally.isInMelee()
        : false;
      if (!this.blocksAllyWithOrders(
        ally,
        this.order,
        ally.order,
        myMelee,
        theirMelee,
      )) {
        continue;
      }
      if (this.blocksAllyWithOrders(
        ally,
        prev,
        ally.prevCollisionOrder,
        prevMelee,
        Boolean(ally.prevInMelee),
      )) {
        continue;
      }
      return true;
    }
    return false;
  }

  /** Closest same-row friendly we currently collide with, or null. */
  collidingAlly(allies) {
    let best = null;
    let bestDist = Infinity;
    let bestAlong = 0;
    for (let i = 0; i < allies.length; i += 1) {
      const ally = allies[i];
      if (!this.overlapsCollidingAlly(ally)) {
        continue;
      }
      const along = this.alongSigned(ally);
      const dist = Math.abs(ally.station() - this.station());
      // Closer station wins; on a tie prefer the one ahead so direction is stable.
      if (dist < bestDist || (dist === bestDist && along > bestAlong)) {
        bestDist = dist;
        bestAlong = along;
        best = ally;
      }
    }
    return best;
  }

  /**
   * Same-row friendly overlap while collision is already on. Does not
   * handle collision re-enable peel (that runs first in update). Halt
   * does not move here. A unit with someone behind may keep advancing;
   * the rear stops on isBlockedBy. Perfect overlap eases one body back.
   */
  resolveAllyCollision(dt, allies, enemies) {
    const other = this.collidingAlly(allies);
    if (!other) {
      return false;
    }

    // Halt: collide but do not move here. Shooting still runs; marchSpeed is 0.
    if (this.order === "halt") {
      return false;
    }
    const along = this.alongSigned(other);
    // Other is behind: do not freeze the front — let it march; the rear
    // will stop when blocked ahead.
    if (along < 0) {
      return false;
    }
    if (along === 0) {
      this.easeBack(dt, allies, enemies);
      return true;
    }
    return false;
  }

  /**
   * Snap this unit out of an enemy footprint to just outside the body
   * (into the meleeSlack ring). Moves only self. True if progress changed.
   */
  snapToEnemyContactEdge(enemy) {
    if (!enemy) return false;
    const foot = this.stationSlack("block");
    const eStat = enemy.station();
    const gapAt = (t) => {
      const pt = Path.pointAt(this.points, t);
      return Math.abs(Path.stationAt(this.lane, pt.x, pt.y) - eStat);
    };
    if (!(gapAt(this.progress) < foot)) return false;

    const eps = Math.min(0.002, Math.max(this.progress, 1 - this.progress, 0.001));
    const gapBack = this.progress > 0 ? gapAt(Math.max(0, this.progress - eps)) : -1;
    const gapFwd = this.progress < 1 ? gapAt(Math.min(1, this.progress + eps)) : -1;
    let hi = gapBack >= gapFwd ? 0 : 1;
    if (gapAt(hi) < foot) {
      hi = hi === 0 ? 1 : 0;
      if (gapAt(hi) < foot) return false;
    }
    let lo = this.progress;
    for (let n = 0; n < 20; n += 1) {
      const mid = (lo + hi) / 2;
      if (gapAt(mid) < foot) lo = mid;
      else hi = mid;
    }
    const next = Math.max(0, Math.min(1, hi));
    if (next === this.progress) return false;
    this.progress = next;
    this.syncPosition();
    return true;
  }

  /**
   * Peel in progress: ease away from a friendly peel target only.
   * True while still peeling.
   */
  peelAfterCollisionEnable(dt, allies, enemies) {
    if (!this.peelingFromPassThrough) {
      return false;
    }
    const other = this.peelTarget(allies, enemies);
    if (!other) {
      this.peelingFromPassThrough = false;
      this.peelDir = 0;
      return false;
    }

    if (this.peelDir === 0) {
      const along = this.alongSigned(other);
      // Away from the closer unit: ahead → back, behind → forward, tie → back.
      this.peelDir = along < 0 ? 1 : -1;
      // Lane start clamps progress at 0 — backward peel cannot clear a stack.
      if (this.peelDir < 0 && this.progress <= 0) {
        this.peelDir = 1;
      }
    }
    // Ignore friendlies and enemies while peeling off a friendly stack so we
    // can leave the pile. Melee lock against enemies is restored after.
    if (!this.easeAlong(dt, allies, enemies, this.peelDir, true, true)
      && this.peelDir < 0) {
      this.peelDir = 1;
      this.easeAlong(dt, allies, enemies, this.peelDir, true, true);
    }

    if (!this.peelTarget(allies, enemies)) {
      this.peelingFromPassThrough = false;
      this.peelDir = 0;
      return false;
    }
    return true;
  }

  /**
   * True when a friendly in this sublane is close in the travel direction.
   * dir is +1 ahead or -1 behind. Troops cannot pass through each other.
   */
  isBlockedToward(ally, dir) {
    if (ally === this || ally.hp <= 0) {
      return false;
    }
    if (ally.lane !== this.lane || ally.sublane !== this.sublane) {
      return false;
    }
    if (!this.blocksAlly(ally)) {
      return false;
    }
    const along = this.alongSigned(ally);
    const gap = this.stationSlack("block");
    if (dir > 0) {
      return along > 0 && along <= gap;
    }
    return along < 0 && -along <= gap;
  }

  /** Friendly close ahead in this sublane. */
  isBlockedBy(ally) {
    return this.isBlockedToward(ally, 1);
  }

  /** True when a collidable ally in this sublane sits inside the line window. */
  sublaneHasCollidableInLine(sublane, allies) {
    return Boolean(this.inLineCollidableInSublane(sublane, allies));
  }

  /** True when a collidable ally in this sublane sits inside the block gap. */
  sublaneHasCollidableInBlockGap(sublane, allies) {
    return Boolean(this.blockGapCollidableInSublane(sublane, allies));
  }

  /**
   * Collidable ally in sublane inside the line window that we are furthest
   * behind (largest positive along), or the closest in-line if none are ahead.
   */
  inLineCollidableInSublane(sublane, allies) {
    return this.nearestCollidableInSublane(sublane, allies, this.stationSlack("line"));
  }

  /** Closest collidable in sublane within the block gap of our station. */
  blockGapCollidableInSublane(sublane, allies) {
    return this.nearestCollidableInSublane(sublane, allies, this.stationSlack("block"));
  }

  /**
   * Among collidables in sublane within slack of our station, the one with
   * the largest along (furthest ahead / least behind).
   */
  nearestCollidableInSublane(sublane, allies, slack) {
    let best = null;
    let bestAlong = -Infinity;
    for (let i = 0; i < allies.length; i += 1) {
      const ally = allies[i];
      if (ally === this || ally.hp <= 0 || ally.lane !== this.lane) {
        continue;
      }
      if (ally.sublane !== sublane || !this.blocksAlly(ally)) {
        continue;
      }
      if (Math.abs(ally.station() - this.station()) > slack) {
        continue;
      }
      const along = this.alongSigned(ally);
      if (along > bestAlong) {
        bestAlong = along;
        best = ally;
      }
    }
    return best;
  }

  /**
   * Next collidable ahead in this sublane (along > 0), or null.
   * Used to score how open a row is beyond the immediate station.
   */
  nextCollidableAhead(sublane, allies) {
    let best = null;
    let bestAlong = Infinity;
    for (let i = 0; i < allies.length; i += 1) {
      const ally = allies[i];
      if (ally === this || ally.hp <= 0 || ally.lane !== this.lane) {
        continue;
      }
      if (ally.sublane !== sublane || !this.blocksAlly(ally)) {
        continue;
      }
      const along = this.alongSigned(ally);
      if (along <= 0) {
        continue;
      }
      if (along < bestAlong) {
        bestAlong = along;
        best = ally;
      }
    }
    return best ? { ally: best, along: bestAlong } : null;
  }

  /**
   * True if a friendly already occupies this row near our station (block
   * gap). Used for dense same-station checks such as parallel enemy slides.
   */
  sublaneOccupied(sublane, allies) {
    return this.sublaneHasCollidableInBlockGap(sublane, allies);
  }

  /**
   * Next body ahead in this sublane (ally we collide with, or living
   * enemy that is not withdrawing). Used to score open rows.
   */
  nextBodyAheadAlong(sublane, allies, enemies) {
    let bestAlong = Infinity;
    for (let i = 0; i < allies.length; i += 1) {
      const ally = allies[i];
      if (ally === this || ally.hp <= 0 || ally.lane !== this.lane) continue;
      if (ally.sublane !== sublane || !this.blocksAlly(ally)) continue;
      const along = this.alongSigned(ally);
      if (along > 0 && along < bestAlong) bestAlong = along;
    }
    if (enemies) {
      for (let i = 0; i < enemies.length; i += 1) {
        const enemy = enemies[i];
        if (enemy.hp <= 0 || enemy.lane !== this.lane) continue;
        if (enemy.sublane !== sublane) continue;
        if (enemy.order === "retreat" || enemy.order === "fallback") continue;
        const along = this.alongSigned(enemy);
        if (along > 0 && along < bestAlong) bestAlong = along;
      }
    }
    return bestAlong;
  }

  /**
   * True when an enemy footprint sits in this sublane inside the block
   * gap of our station (cannot land a row switch there).
   */
  sublaneHasEnemyInBlockGap(sublane, enemies) {
    if (!enemies) return false;
    const gap = this.stationSlack("block");
    const here = this.station();
    for (let i = 0; i < enemies.length; i += 1) {
      const enemy = enemies[i];
      if (enemy.hp <= 0 || enemy.lane !== this.lane) continue;
      if (enemy.sublane !== sublane) continue;
      if (enemy.order === "retreat" || enemy.order === "fallback") continue;
      if (Math.abs(enemy.station() - here) <= gap) return true;
    }
    return false;
  }

  /**
   * Best sublane to move around a line: any other row with no ally or
   * enemy in the block gap at our station, scored by how far ahead the
   * next body is (empty ahead wins). Closer rows win ties.
   */
  pickBestSwitchSublane(allies, enemies) {
    const count = Path.sublaneCount(this.lane);
    let best = null;
    let bestAlong = -Infinity;
    let bestDist = Infinity;
    for (let s = 0; s < count; s += 1) {
      if (s === this.sublane) continue;
      if (this.sublaneHasCollidableInBlockGap(s, allies)) continue;
      if (this.sublaneHasEnemyInBlockGap(s, enemies)) continue;
      const along = this.nextBodyAheadAlong(s, allies, enemies);
      const dist = Math.abs(s - this.sublane);
      if (along > bestAlong || (along === bestAlong && dist < bestDist)) {
        bestAlong = along;
        bestDist = dist;
        best = s;
      }
    }
    return best;
  }

  /**
   * When every row is stacked at our station, pick an adjacent whose
   * blockGap neighbor we are furthest behind so easing back can open it.
   */
  pickEaseAdjacent(allies) {
    const count = Path.sublaneCount(this.lane);
    const adj = [];
    if (this.sublane - 1 >= 0) adj.push(this.sublane - 1);
    if (this.sublane + 1 < count) adj.push(this.sublane + 1);
    let best = null;
    let bestAlong = -Infinity;
    for (let i = 0; i < adj.length; i += 1) {
      const blocker = this.blockGapCollidableInSublane(adj[i], allies);
      if (!blocker) {
        continue;
      }
      const along = this.alongSigned(blocker);
      if (along > bestAlong) {
        bestAlong = along;
        best = adj[i];
      }
    }
    return best;
  }

  /**
   * Ease along the path (dir +1 forward, -1 back). Stops short of
   * same-row enemy bodies unless ignoreEnemies. Unless ignoreFriendlies,
   * also stops for friendlies in that direction. Uses walk speed even
   * while halted. True if it moved.
   */
  easeAlong(dt, allies, enemies, dir, ignoreFriendlies, ignoreEnemies = false) {
    const sign = dir < 0 ? -1 : 1;
    if (sign < 0) this.movingBackward = true;
    if (!ignoreFriendlies) {
      for (let i = 0; i < allies.length; i += 1) {
        if (this.isBlockedToward(allies[i], sign)) {
          return false;
        }
      }
    }
    const speed = this.speed * this.side.speedMultiplier;
    const delta = this.alongDelta(speed, dt);
    const nextProgress = Math.max(0, Math.min(1, this.progress + sign * delta));
    if (nextProgress === this.progress) {
      return false;
    }
    if (!ignoreEnemies && !this.passesThroughEnemies()) {
      const allyClamped = ignoreFriendlies
        ? nextProgress
        : this.clampProgressFromCollidableAlly(nextProgress, allies);
      if (allyClamped == null || allyClamped === this.progress) return false;
      const clamped = this.clampProgressFromSameRowEnemy(
        allyClamped,
        enemies,
        false,
        ignoreFriendlies ? [] : allies,
      );
      if (clamped == null || clamped === this.progress) return false;
      this.progress = clamped;
      this.syncPosition();
      return true;
    }
    this.progress = nextProgress;
    this.syncPosition();
    return true;
  }

  /** Ease backward along the path. Stops short of friendlies behind and enemies. */
  easeBack(dt, allies, enemies) {
    return this.easeAlong(dt, allies, enemies, -1, false);
  }

  /** Ease forward along the path. Stops short of friendlies ahead and enemies. */
  easeForward(dt, allies, enemies) {
    return this.easeAlong(dt, allies, enemies, 1, false);
  }

  /**
   * Enter next (one adjacent step), or ease until next is clear of
   * blockGap collidables. If this unit is ahead of the blocker, ease
   * forward; otherwise ease back. Commits this.switch so we keep
   * pursuing the goal instead of thrashing. Never eases when next is
   * already clear.
   */
  /** Same-type friendly already in line on this row, if any. */
  lineMateOnRow(sublane, allies) {
    for (let i = 0; i < allies.length; i += 1) {
      const ally = allies[i];
      if (ally === this || ally.hp <= 0 || ally.broken) continue;
      if (ally.lane !== this.lane || ally.sublane !== sublane) continue;
      if (!this.sameLineType(ally) || !this.withinLine(ally)) continue;
      return ally;
    }
    return null;
  }

  /**
   * Other units in this player line-switch: same line, same shift
   * direction, still carrying a row goal.
   */
  lineSwitchPeers(allies) {
    if (!this.playerSwitch || this.switch == null) {
      return [this];
    }
    const myDir = Math.sign(this.switch - this.sublane);
    const seed = this.lineGroup(allies);
    const group = seed.length >= 2 ? seed : this.reformSeekGroup(allies);
    const peers = [];
    for (let i = 0; i < group.length; i += 1) {
      const unit = group[i];
      if (!unit.playerSwitch || unit.switch == null) continue;
      const dir = Math.sign(unit.switch - unit.sublane);
      if (myDir !== 0 && dir !== 0 && dir !== myDir) continue;
      peers.push(unit);
    }
    if (peers.indexOf(this) < 0) {
      peers.push(this);
    }
    return peers;
  }

  /**
   * When any peer cannot enter its next row because of a foreign blocker,
   * the whole line eases that peer's clear direction together. 0 if every
   * peer is free to step (or only blocked by fellow shifters).
   */
  lineSwitchSharedEaseDir(allies, enemies) {
    const peers = this.lineSwitchPeers(allies);
    if (peers.length < 2) {
      return 0;
    }
    for (let i = 0; i < peers.length; i += 1) {
      const unit = peers[i];
      if (unit.switch == null || unit.switch === unit.sublane) continue;
      const step = Math.sign(unit.switch - unit.sublane);
      if (step === 0) continue;
      const next = unit.sublane + step;
      const dest = Path.pointAt(Path.waypoints(unit.side.id, unit.lane, next), unit.progress);
      if (unit.overlapsEnemyAt(dest.x, dest.y, enemies, next)) {
        continue;
      }
      const blocker = unit.blockGapCollidableInSublane(next, allies);
      if (!blocker) continue;
      if (peers.indexOf(blocker) >= 0 && blocker.playerSwitch) continue;
      return unit.alongSigned(blocker) < 0 ? 1 : -1;
    }
    return 0;
  }

  tryEnterOrEaseAdjacent(dt, allies, enemies, next, commitGoal) {
    if (next === this.sublane) {
      return false;
    }
    if (commitGoal != null && this.switch !== commitGoal) {
      this.switch = commitGoal;
      this.switchEscape = Math.abs(commitGoal - this.sublane) > 1;
    }
    if (this.playerSwitch && commitGoal != null) {
      // One end clearing a foreign blocker: whole line eases with it until
      // that row opens, then everyone steps together.
      const sharedEase = this.lineSwitchSharedEaseDir(allies, enemies);
      if (sharedEase) {
        this.switchEaseDir = sharedEase;
        return this.easeAlong(dt, allies, enemies, sharedEase, true);
      }
    }
    if (this.playerSwitch && commitGoal != null && Math.abs(next - this.sublane) === 1) {
      const mate = this.lineMateOnRow(next, allies);
      const dir = Math.sign(commitGoal - this.sublane);
      // Whole line shifting together: the unit already on the next row is
      // also moving the same way — do not abort into Reform, and allow
      // entry even while they still occupy that row this tick.
      const mateAlsoShifting = mate && mate.playerSwitch
        && (mate.switch === mate.sublane + dir || mate.switch === commitGoal + dir);
      if (mate && !mateAlsoShifting) {
        this.playerSwitch = false;
        this.switch = null;
        this.switchEscape = false;
        this.switchEaseDir = 0;
        this.startReform(allies, this.ignoreLineOrders, enemies);
        return true;
      }
      if (mateAlsoShifting) {
        const dest = Path.pointAt(Path.waypoints(this.side.id, this.lane, next), this.progress);
        if (!this.overlapsEnemyAt(dest.x, dest.y, enemies, next)) {
          this.switchEaseDir = 0;
          this.enterSublane(next, enemies);
          this.strafe(dt, enemies, allies);
          return true;
        }
      }
    }
    if (this.canEnterSublane(next, allies, enemies)) {
      this.switchEaseDir = 0;
      this.enterSublane(next, enemies);
      this.strafe(dt, enemies, allies);
      return true;
    }
    const blocker = this.blockGapCollidableInSublane(next, allies);
    if (blocker) {
      // Ahead of the blocker → ease forward; else ease back.
      // A player switch keeps that direction and ignores same-row friendlies.
      if (commitGoal != null) {
        if (this.switchEaseDir === 0) {
          this.switchEaseDir = this.alongSigned(blocker) < 0 ? 1 : -1;
        }
        return this.easeAlong(dt, allies, enemies, this.switchEaseDir, true);
      }
      const dir = this.alongSigned(blocker) < 0 ? 1 : -1;
      return this.easeAlong(dt, allies, enemies, dir, false);
    }
    // Enemy occupies the landing at our station: ease back to find a gap
    // (same sticky commit as an ally blocker when we have a goal).
    if (commitGoal != null && this.sublaneHasEnemyInBlockGap(next, enemies)) {
      if (this.switchEaseDir === 0) {
        this.switchEaseDir = -1;
      }
      return this.easeAlong(dt, allies, enemies, this.switchEaseDir, true);
    }
    return false;
  }

  /**
   * True when a committed auto-switch goal is still a valid gap (no
   * ally or enemy in the block gap at our station on that row).
   */
  switchGoalStillValid(goal, allies, enemies) {
    if (goal == null || goal === this.sublane) {
      return false;
    }
    const count = Path.sublaneCount(this.lane);
    if (goal < 0 || goal >= count) {
      return false;
    }
    if (this.sublaneHasCollidableInBlockGap(goal, allies)) return false;
    if (this.sublaneHasEnemyInBlockGap(goal, enemies)) return false;
    return true;
  }

  /**
   * Step one sublane toward prefer / a committed switch, or pick the best
   * open row around a line (look-ahead). Stick to the committed goal so
   * units do not bounce between rows — keep it while easing/strafing even
   * if the landing is briefly occupied.
   */
  pursueSublaneChange(dt, allies, enemies, prefer) {
    let goal = prefer;
    if (goal === undefined || goal === null) {
      const committed = this.switch != null && this.switch !== this.sublane;
      const midManeuver = this.strafing || this.switchEaseDir !== 0;
      if (committed && (midManeuver
        || this.switchGoalStillValid(this.switch, allies, enemies))) {
        goal = this.switch;
      } else {
        goal = this.pickBestSwitchSublane(allies, enemies);
      }
    }

    if (goal != null && goal !== this.sublane) {
      const next = this.sublane + Math.sign(goal - this.sublane);
      return this.tryEnterOrEaseAdjacent(dt, allies, enemies, next, goal);
    }

    // Every row stacked at our station: ease back to open an adjacent gap.
    const easeTarget = this.pickEaseAdjacent(allies);
    if (easeTarget == null) {
      return false;
    }
    return this.tryEnterOrEaseAdjacent(dt, allies, enemies, easeTarget, easeTarget);
  }

  /**
   * Best living enemy inside maxRange paces (closest eligible = Bastion).
   * Same lane uses along-track paces. The other lane is in range only
   * when the path back through our keep is under 200 paces and inside
   * maxRange. Officers are skipped while another unit type is in that
   * same range (except skirmishers/rifles, which use a fixed type
   * priority). The Keep competes using targetPriorityPaces (50 paces
   * closer for ranking only) whenever it is within actual weapon range;
   * melee does not lock the Keep.
   */
  nearestTarget(enemies, maxRange, allies, enemySide) {
    const range = maxRange === undefined ? this.relevantRangePaces() : maxRange;
    if (this.type === "skirmisher") {
      return this.skirmisherNearestTarget(enemies, range, enemySide);
    }
    // Grand strategies disabled; always Bastion (closest eligible).
    const mode = "bastion";
    let best = null;
    let bestD = Infinity;
    let bestVit = 0;
    let bestOfficer = null;
    let bestOfficerD = Infinity;
    let bestOfficerVit = 0;
    let otherInRange = false;
    for (let i = 0; i < enemies.length; i += 1) {
      const other = enemies[i];
      if (!isValidRangedTarget(other)) continue;
      if (!this.inShotRange(other, range)) continue;
      const d = this.shotPaces(other);
      if (other.type !== "officer") otherInRange = true;
      const vit = targetVitality(other);
      if (other.type === "officer") {
        if (!bestOfficer || isBetterTarget(mode, d, vit, bestOfficerD, bestOfficerVit)) {
          bestOfficerD = d;
          bestOfficerVit = vit;
          bestOfficer = other;
        }
        continue;
      }
      if (!best || isBetterTarget(mode, d, vit, bestD, bestVit)) {
        bestD = d;
        bestVit = vit;
        best = other;
      }
    }
    if (!best && !otherInRange) {
      best = bestOfficer;
      bestD = bestOfficerD;
      bestVit = bestOfficerVit;
    }
    if (enemySide && this.inShotRange(enemySide, range)) {
      const keepD = targetPriorityPaces(this, enemySide);
      const keepVit = targetVitality(enemySide);
      if (!best || isBetterTarget(mode, keepD, keepVit, bestD, bestVit)) {
        return enemySide;
      }
    }
    return best;
  }

  /**
   * Skirmisher / Rifles: fixed type priority, closest within the best
   * tier (not closest-eligible Bastion). Keep wins only when its
   * priority distance is closer than every valid unit.
   */
  skirmisherNearestTarget(enemies, range, enemySide) {
    const candidates = [];
    let closestDist = Infinity;
    for (let i = 0; i < enemies.length; i += 1) {
      const other = enemies[i];
      if (!isValidRangedTarget(other)) continue;
      if (!this.inShotRange(other, range)) continue;
      const d = this.shotPaces(other);
      if (d < closestDist) closestDist = d;
      candidates.push({ other, d });
    }
    let best = null;
    let bestTier = Infinity;
    let bestD = Infinity;
    for (let i = 0; i < candidates.length; i += 1) {
      const { other, d } = candidates[i];
      const tier = skirmisherTargetTier(other.type, d, closestDist);
      if (tier < bestTier || (tier === bestTier && d < bestD)) {
        bestTier = tier;
        bestD = d;
        best = other;
      }
    }
    if (enemySide && this.inShotRange(enemySide, range)) {
      const keepD = targetPriorityPaces(this, enemySide);
      if (!best || keepD < closestDist) return enemySide;
    }
    return best;
  }

  /**
   * Enemy in another sublane who is perfectly parallel. Ahead or behind
   * in their own row can be passed.
   */
  nearestParallel(enemies) {
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < enemies.length; i += 1) {
      const other = enemies[i];
      if (other.hp <= 0 || other.lane !== this.lane) {
        continue;
      }
      if (other.sublane === this.sublane) {
        continue;
      }
      if (!this.isParallelTo(other)) {
        continue;
      }
      const d = distance(this, other);
      if (d < bestD) {
        bestD = d;
        best = other;
      }
    }
    return best;
  }

  /**
   * Apply raw (base × falloff), the attacker's percent sum, then defensive
   * multipliers (armor, cover) one after another. Optional pushAmount is
   * shooting/melee pushback from the attacker.
   */
  takeDamage(raw, kind, attackerSum, pushAmount) {
    const hit = truncateDamage(Math.max(
      0,
      raw * (1 + (attackerSum || 0)) * this.incomingMultiplier(kind),
    ));
    this.hp -= hit;
    this.flash = 0.12;
    this.side.sim.spawnSplat(this.x, this.y, hit, kind);
    const fatigueGain = kind === "melee" ? CONFIG.fatigueOnMelee : CONFIG.fatigueOnShot;
    this.fatigue = Math.min(this.maxFatigue, this.fatigue + fatigueGain);
    if (pushAmount > 0) {
      this.applyPushback(pushAmount, true);
    }
    this.tryBreak();
  }

  /**
   * True while this unit is withdrawing toward its keep: Retreat, Fall
   * Back, or any tick that marched/eased backward (charge reverse, peel
   * around a friendly, switch ease-back). Pushback is not applied then.
   */
  isWithdrawingBackward() {
    if (this.order === "retreat" || this.order === "fallback") return true;
    return Boolean(this.movingBackward);
  }

  /** Drop queued and in-flight pushback so absolute eases cannot pin a withdraw. */
  clearPushback() {
    this.pushbackCounter = 0;
    this.pushbackQueue.length = 0;
    this.pushbackMove = null;
    this.pushbackNextEaseIndex = 0;
  }

  /**
   * Add pushback points. When the counter crosses pushbackPerPace, enqueue
   * a pace. fatigueOnBlock is false for cannon self-recoil. Skipped while
   * the unit is moving backward.
   */
  applyPushback(amount, fatigueOnBlock) {
    if (!(amount > 0) || this.hp <= 0) return;
    if (this.isWithdrawingBackward()) return;
    const taken = amount * (this.pushbackTakenFactor != null ? this.pushbackTakenFactor : 1);
    if (!(taken > 0)) return;
    const perPace = CONFIG.pushbackPerPace > 0 ? CONFIG.pushbackPerPace : 1;
    this.pushbackCounter += taken;
    while (this.pushbackCounter >= perPace) {
      this.pushbackCounter -= perPace;
      this.pushbackQueue.push({
        fatigueOnBlock: Boolean(fatigueOnBlock),
        easeIndex: this.pushbackNextEaseIndex,
      });
      this.pushbackNextEaseIndex += 1;
    }
  }

  /** Progress change for one pace toward this side's keep. */
  pushbackPaceDelta() {
    const lanePaces = Path.lanePaces(this.lane);
    if (!(lanePaces > 0)) return 0;
    return 1 / lanePaces;
  }

  /** True when a same-row collidable ally sits behind within the block gap. */
  pushbackBlocked(allies) {
    if (!allies) return false;
    for (let i = 0; i < allies.length; i += 1) {
      if (this.isBlockedToward(allies[i], -1)) return true;
    }
    return false;
  }

  /**
   * True when a pushback step cannot finish: already blocked behind, or the
   * destination would enter / deepen into a collidable ally (same clamp as
   * march). Checking the destination matters — a unit sitting just outside
   * the block gap can owe a full pace that lands inside it.
   */
  pushbackStepBlocked(progress, allies) {
    if (this.pushbackBlocked(allies)) return true;
    if (progress == null || !allies) return false;
    const clamped = this.clampProgressFromCollidableAlly(progress, allies);
    return clamped == null || clamped !== progress;
  }

  /** Spend a blocked pushback pace: optional fatigue, then clear the ease. */
  consumeBlockedPushbackPace(fatigueOnBlock) {
    if (fatigueOnBlock) {
      this.fatigue = Math.min(
        this.maxFatigue,
        this.fatigue + CONFIG.fatiguePerPace,
      );
    }
    this.pushbackMove = null;
    this.resetPushbackEaseIfIdle();
  }

  /**
   * Ease queued pushback paces toward own keep. Stacked paces ease
   * fast-to-slow by easeIndex. Blocked paces still consume the queue;
   * fatigue applies unless this was cannon recoil. While withdrawing
   * backward, discard pending paces so they cannot overwrite march.
   */
  tickPushback(dt, allies) {
    if (this.isWithdrawingBackward()) {
      this.clearPushback();
      return;
    }
    if (this.pushbackMove) {
      const move = this.pushbackMove;
      move.elapsed += dt;
      const t = move.duration > 0 ? Math.min(1, move.elapsed / move.duration) : 1;
      // Ease-out: start fast, settle slow.
      const eased = 1 - (1 - t) * (1 - t);
      const next = move.from + (move.to - move.from) * eased;
      // Block on current contact or if this ease would enter an ally.
      if (this.pushbackStepBlocked(next, allies)
        || this.pushbackStepBlocked(move.to, allies)) {
        this.progress = move.from;
        this.syncPosition();
        this.consumeBlockedPushbackPace(move.fatigueOnBlock);
        return;
      }
      this.progress = Math.max(0, Math.min(1, next));
      this.syncPosition();
      if (t >= 1) {
        this.progress = Math.max(0, move.to);
        this.syncPosition();
        this.pushbackMove = null;
        this.resetPushbackEaseIfIdle();
      }
      return;
    }

    while (this.pushbackQueue.length > 0 && !this.pushbackMove) {
      const pace = this.pushbackQueue.shift();
      const delta = this.pushbackPaceDelta();
      const to = delta > 0 ? Math.max(0, this.progress - delta) : this.progress;
      // Already touching behind, or this pace would land inside a friendly.
      if (this.pushbackStepBlocked(to, allies)) {
        this.consumeBlockedPushbackPace(pace.fatigueOnBlock);
        continue;
      }
      if (!(delta > 0) || this.progress <= 0) {
        if (pace.fatigueOnBlock && this.progress <= 0) {
          this.fatigue = Math.min(
            this.maxFatigue,
            this.fatigue + CONFIG.fatiguePerPace,
          );
        }
        this.resetPushbackEaseIfIdle();
        continue;
      }
      const from = this.progress;
      const duration = CONFIG.pushbackEaseMin
        + CONFIG.pushbackEaseStep * (pace.easeIndex || 0);
      if (!(duration > 0.001)) {
        this.progress = to;
        this.syncPosition();
        this.resetPushbackEaseIfIdle();
        continue;
      }
      this.pushbackMove = {
        from,
        to,
        elapsed: 0,
        duration,
        fatigueOnBlock: pace.fatigueOnBlock,
      };
    }
  }

  resetPushbackEaseIfIdle() {
    if (!this.pushbackMove && this.pushbackQueue.length === 0) {
      this.pushbackNextEaseIndex = 0;
    }
  }

  /**
   * Product of defensive factors: armor ranks and fort cover. Each stacks
   * by multiplying, not by adding percents.
   */
  incomingMultiplier(kind) {
    let mult = 1;
    if (this.side) mult *= 1 - this.side.armorReduction();
    if (this.hasCover()) mult *= 1 - CONFIG.quarterArmor;
    return Math.max(0, mult);
  }

  /** True when this body overlaps this side's fort in this lane. */
  onQuarterLine() {
    return touchesQuarterLine(this);
  }

  /** Fort overlap grants the cover bonus. The keep does not. */
  hasCover() {
    return this.onQuarterLine();
  }

  /**
   * Shooting line bonus: +20% for each other troop in line that is not
   * in melee and can see a target. Broken units are already out of the line.
   */
  lineDamagePercent(allies) {
    if (!this.lineBonus || this.type !== "troop") return 0;
    const group = allies || [];
    const line = this.lineGroup(group);
    const foes = this.enemyTroops();
    let mates = 0;
    for (let i = 0; i < line.length; i += 1) {
      const mate = line[i];
      if (mate === this || mate.type !== "troop" || mate.isInMelee(foes)) continue;
      const enemySide = mate.side === this.side.sim.player ? this.side.sim.enemy : this.side.sim.player;
      if (mate.nearestTarget(foes, mate.shootRange(), group, enemySide)) mates += 1;
    }
    return mates * this.lineBonus;
  }

  /** Shot falloff from 1 at point blank down to minDamageFactor at max range. */
  falloffTo(target) {
    const range = Math.max(this.rangePaces(), 1);
    return Math.max(CONFIG.minDamageFactor, 1 - this.shotPaces(target) / range);
  }

  /**
   * True while a living Color Guard on this side restores this unit
   * (same lane, within officer restore paces). Negates missing-health
   * damage loss.
   */
  inColorGuardAura(allies) {
    const group = allies || (this.side ? this.side.troops : []);
    const per = Path.stationPerPace(this.lane);
    if (!(per > 0)) return false;
    for (let i = 0; i < group.length; i += 1) {
      const source = group[i];
      if (source === this || source.hp <= 0) continue;
      if (source.variant !== "colorGuard") continue;
      if (source.lane !== this.lane) continue;
      const gap = Math.abs(source.station() - this.station()) / per;
      if (gap <= CONFIG.officerRestorePaces) return true;
    }
    return false;
  }

  /**
   * Damage multiplier from remaining health. Missing health cuts damage
   * at half that fraction (50% health → 75% damage). Color Guard aura
   * holds the unit at full output.
   */
  healthDamageFactor(allies) {
    if (this.inColorGuardAura(allies)) return 1;
    const max = this.maxHp || 1;
    const hpPct = Math.max(0, Math.min(1, this.hp / max));
    const ratio = CONFIG.missingHealthDamageRatio;
    return 1 - (1 - hpPct) * ratio;
  }

  /**
   * Attacker percents added together: variance, charge, flank, line,
   * damage upgrade, missing-health loss, and the officer-damage bonus.
   * Troop line bonus does not apply when shooting skirmishers/rifles.
   * Defense is applied separately on impact as multipliers. Not yet truncated.
   */
  attackerPercents(target, kind, allies) {
    const strike = kind || "shoot";
    let sum = (Math.random() * 2 - 1) * CONFIG.damageVariance;
    if (strike === "melee" && this.order === "charge") sum += this.chargeMultiplier - 1;
    if (strike === "melee" && target.lane && this.isFlanking(target)) {
      sum += this.flankMultiplier - 1;
    }
    if (strike !== "melee" && target.type !== "skirmisher") {
      sum += this.lineDamagePercent(allies);
    }
    if (this.side) sum += this.side.damageScale() - 1;
    if (target.type === "officer") sum += (this.officerDamageMultiplier || 1) - 1;
    sum += this.healthDamageFactor(allies) - 1;
    return sum;
  }

  /**
   * Base × falloff, before percent modifiers. Melee has no falloff.
   * The attacker percent sum travels with the shot; defensive multipliers
   * are applied on impact.
   */
  attackDamage(target, kind, allies) {
    const strike = kind || "shoot";
    const falloff = strike === "melee" ? 1 : this.falloffTo(target);
    return {
      raw: this.baseAttackDamage(strike) * falloff,
      attackerSum: this.attackerPercents(target, strike, allies),
    };
  }

  /** Ranged or melee base from this unit's own stats. */
  baseAttackDamage(kind) {
    return kind === "melee" ? this.meleeDamage : this.rangedDamage;
  }

  /**
   * Strike a target. Melee lands instantly (splat + sound, no shell).
   * Ranged fire launches a projectile that travels to the aim.
   * Friendly overlap does not cancel the strike — Halt is expected to keep
   * shooting while colliding, and mayShoot already short-circuits march.
   */
  fire(target, allies, projectiles, kind) {
    const strike = kind || "shoot";
    // HARD RULES — do not weaken:
    // 1) Melee-locked units never shoot (melee swings use strike === "melee").
    // 2) Melee-locked units are never valid ranged targets (Keep excepted).
    if (strike !== "melee") {
      if (this.cannotFireRanged()) return;
      if (target && !isValidRangedTarget(target)) return;
    }
    const shot = this.attackDamage(target, strike, allies);
    if (strike === "melee") {
      this.fatigue = Math.min(this.maxFatigue, this.fatigue + CONFIG.fatigueOnMelee);
      this.side.sim.emitSound({ type: "melee", sideId: this.side.id });
      if (target && target.capitalHP !== undefined) {
        const hit = target.applyKeepDamage(shot.raw, shot.attackerSum);
        target.capitalHP -= hit;
        this.side.sim.spawnSplat(target.capital.x, target.capital.y, hit, "melee");
      } else if (target && target.takeDamage) {
        const push = this.order === "charge" ? this.meleePushback : 0;
        target.takeDamage(shot.raw, "melee", shot.attackerSum, push);
      }
      this.cooldown = this.strikeDelay(strike);
      this.flash = 0.12;
      return;
    }
    this.side.sim.emitSound({
      type: "shoot",
      lane: this.lane,
      sublane: this.sublane,
      unitType: this.type,
      sideId: this.side.id,
    });
    projectiles.push(new Projectile(
      this.x,
      this.y,
      target,
      shot.raw,
      allies,
      strike,
      this.type,
      this.side.sim,
      {
        speed: this.projectileSpeed,
        size: this.projectileSize,
        color: this.projectileColor,
        splash: this.splash,
        attackerSum: shot.attackerSum,
        shotSign: target.station && this.station ? Math.sign(target.station() - this.station()) || 1 : 1,
        shootingPushback: this.shootingPushback,
      },
    ));
    this.cooldown = this.strikeDelay(strike);
    this.flash = 0.12;
    if (this.type === "cannon") {
      this.applyPushback(this.shootingPushback, false);
    }
  }

  /**
   * One unit decision: finish a lane change first, then shoot or swing,
   * then start a slide toward a side enemy, or march (advance stops when
   * a friendly blocks ahead).
   */
  update(dt, allies, enemies, enemySide, projectiles) {
    if (this.cooldown > 0) {
      this.cooldown -= dt;
    }
    if (this.flash > 0) {
      this.flash -= dt;
    }

    this.movingBackward = false;
    this.tickFatigue(dt, enemies);
    this.releaseHeldOrder(enemies);

    try {
      this.updateActions(dt, allies, enemies, enemySide, projectiles);
    } finally {
      this.tickPushback(dt, allies);
    }
  }

  /**
   * Orders, shooting, melee, and marching for one step. Pushback eases in
   * update()'s finally so every early return still resolves paces.
   */
  updateActions(dt, allies, enemies, enemySide, projectiles) {
    const inMeleeNow = this.isInMelee(enemies);
    // Sticky melee lock so brief footprint gaps cannot open a shoot window.
    if (inMeleeNow) {
      this.meleeLockTimer = Math.max(this.meleeLockTimer, 0.35);
    } else if (this.meleeLockTimer > 0) {
      this.meleeLockTimer = Math.max(0, this.meleeLockTimer - dt);
    }
    // Fall Back that is still in the fight is Retreat. A retreat that has
    // already reached this side's end of the lane stays Fall Back.
    if (inMeleeNow && !this.broken && this.order === "fallback" && this.progress > 0) {
      this.order = "retreat";
    }
    // Leaving melee Halts, except Charge and Retreat. Retreat is not
    // cancelled by walking out of contact or by the fight that caused it.
    if (this.wasInMelee && !inMeleeNow && !this.broken
      && this.order !== "charge" && this.order !== "retreat") {
      this.order = "halt";
      this.reformNeedsAlign = false;
      this.priorOrder = null;
    }
    this.wasInMelee = inMeleeNow;

    // Drop peels that are no longer needed.
    if (this.peelingFromPassThrough && !this.peelTarget(allies, enemies)) {
      this.peelingFromPassThrough = false;
      this.peelDir = 0;
    }

    // Only the unit that ends pass-through peels — never shove a partner.
    // Charge / fall back / retreat ending while stacked, or a charger that
    // suddenly blocks because the overlapped unit entered melee.
    if (!this.peelingFromPassThrough && this.gainedCollisionWhileOverlapping(allies)) {
      const prev = this.prevCollisionOrder;
      const iEndedPassThrough = prev === "charge"
        || prev === "fallback"
        || prev === "retreat";
      if (iEndedPassThrough || this.order === "charge") {
        this.peelingFromPassThrough = true;
        this.peelDir = 0;
      }
    }
    // Fall back / retreat always pass through — no peel while withdrawing.
    if (this.order === "fallback" || this.order === "retreat") {
      this.peelingFromPassThrough = false;
      this.peelDir = 0;
    }
    this.prevCollisionOrder = this.order;
    this.prevInMelee = inMeleeNow;

    // Friendly / order-change peel in progress.
    if (this.peelAfterCollisionEnable(dt, allies, enemies)) {
      return;
    }

    if (this.broken) {
      if (this.strafing && this.strafe(dt, enemies, allies)) {
        return;
      }
      if (this.resolveAllyCollision(dt, allies, enemies)) {
        return;
      }
      this.marchAlong(dt, allies, enemies, -1);
      return;
    }

    this.tryJoinAhead(allies);

    // In melee a unit holds still, unless retreating or sliding a
    // non-adjacent escape. Retreat keeps its order and its movement;
    // melee swings and contact distance do not stop it.
    const meleeLock = inMeleeNow && !this.switchEscape && this.order !== "retreat";
    if (this.strafing && !meleeLock && this.strafe(dt, enemies, allies)) {
      return;
    }

    const laneMove = meleeLock ? "none" : this.followLaneOrder(dt, allies, enemies);
    if (laneMove === "stepping") {
      return;
    }

    // Ally stack resolve can ease units — never while melee-locked.
    if (!meleeLock && this.resolveAllyCollision(dt, allies, enemies)) {
      return;
    }

    const contact = this.collidingEnemy(enemies);
    const atKeep = this.progress >= 1;
    const charging = this.order === "charge";
    const fallingBack = this.order === "fallback";
    const retreating = this.order === "retreat";
    const halted = this.order === "halt";

    if (retreating) {
      this.marchAlong(dt, allies, enemies, -1);
      return;
    }

    if (fallingBack) {
      if (contact && this.fightsMelee) {
        if (this.cooldown <= 0) {
          this.fire(contact, allies, projectiles, "melee");
        }
      } else if (this.mayShoot(allies, enemies, enemySide)) {
        const aim = this.nearestTarget(enemies, this.shootRange(), allies, enemySide);
        if (aim && this.cooldown <= 0) {
          this.fire(aim, allies, projectiles, "shoot");
        }
      }
      this.marchAlong(dt, allies, enemies, -1);
      return;
    }

    if (contact && this.fightsMelee) {
      if (this.cooldown <= 0) {
        this.fire(contact, allies, projectiles, "melee");
      }
      return;
    }

    if (charging && this.fightsMelee && laneMove !== "waiting") {
      if (this.seekChargeMelee(dt, allies, enemies)) {
        return;
      }
      if (atKeep) {
        if (this.cooldown <= 0) {
          this.fire(enemySide, allies, projectiles, "melee");
        }
        return;
      }
    }

    if (this.order === "reform") {
      if (this.reformIsSquare(allies)) {
        this.finishReform(allies);
        return;
      }
      if (laneMove === "waiting" || this.reformHold) {
        return;
      }
      let reformBlocked = false;
      for (let i = 0; i < allies.length; i += 1) {
        if (this.isBlockedBy(allies[i])) {
          reformBlocked = true;
          break;
        }
      }
      if (reformBlocked) {
        this.pursueSublaneChange(dt, allies, enemies);
        return;
      }
      const reformSpeed = this.marchSpeed(allies);
      let reformProgress = Math.min(1, this.progress + this.alongDelta(reformSpeed, dt));
      // Do not walk past the holding front (that would make a new head).
      const front = this.reformFront(allies);
      if (front && front !== this && reformProgress > front.progress) {
        reformProgress = front.progress;
      }
      const clamped = this.clampProgressFromSameRowEnemy(reformProgress, enemies, false);
      if (clamped == null || clamped === this.progress) {
        return;
      }
      this.progress = clamped;
      this.syncPosition();
      return;
    }

    if (!charging && this.mayShoot(allies, enemies, enemySide)) {
      const aim = this.nearestTarget(enemies, this.shootRange(), allies, enemySide);
      if (aim && this.cooldown <= 0) {
        this.fire(aim, allies, projectiles, "shoot");
      }
      return;
    }

    if (laneMove === "waiting") {
      return;
    }

    if (halted) {
      return;
    }

    let blocked = false;
    for (let i = 0; i < allies.length; i += 1) {
      if (this.isBlockedBy(allies[i])) {
        blocked = true;
        break;
      }
    }
    if (blocked) {
      // Advance stops behind friendlies. Charge may still sidestep.
      if (charging) {
        this.pursueSublaneChange(dt, allies, enemies);
      }
      return;
    }

    const speed = this.marchSpeed(allies);
    const nextProgress = Math.min(1, this.progress + this.alongDelta(speed, dt));
    if (nextProgress === this.progress) return;
    const clamped = this.clampProgressFromSameRowEnemy(nextProgress, enemies, false);
    if (clamped == null || clamped === this.progress) {
      return;
    }
    this.progress = clamped;
    this.syncPosition();
    this.tryJoinAhead(allies);
  }

}

/** Melee infantry. Formed lines add damage. Charges faster near an enemy. */
class Troop extends Unit {
  constructor(id, side, lane, sublane) {
    super(id, side, lane, sublane);
    this.type = "troop";
    this.applyStats(UNIT_STATS.troop);
  }
}

/**
 * Light infantry. Full fire range, fixed type-priority targeting, and
 * troop line bonus does not apply against them.
 */
class Skirmisher extends Unit {
  constructor(id, side, lane, sublane) {
    super(id, side, lane, sublane);
    this.type = "skirmisher";
    this.applyStats(UNIT_STATS.skirmisher);
  }
}

/**
 * Mounted infantry. Weaker shots, harder melee, a wider flank bonus, and
 * twice the walk speed.
 */
class Dragoon extends Unit {
  constructor(id, side, lane, sublane) {
    super(id, side, lane, sublane);
    this.type = "dragoon";
    this.applyStats(UNIT_STATS.dragoon);
  }
}

/**
 * Field gun. A hit can continue to two more bodies on the same row.
 * Charging guns do not shoot; they still fight in melee.
 */
class Cannon extends Unit {
  constructor(id, side, lane, sublane) {
    super(id, side, lane, sublane);
    this.type = "cannon";
    this.applyStats(UNIT_STATS.cannon);
  }

  /** A charging or melee-locked gun does not shoot. */
  isOpeningFire(enemies, allies, enemySide) {
    if (this.order === "charge" || this.cannotFireRanged(enemies)) return false;
    return Boolean(this.nearestTarget(enemies, this.openFireRange(), allies, enemySide));
  }
}

/**
 * Command unit. Restores fatigue to living allies within restoreRange.
 * Restores twice as fast when this officer stands ahead of that ally.
 * Enemy fire ignores this unit except from skirmishers/rifles while any
 * other target remains in the firer's full shooting range.
 */
class Officer extends Unit {
  constructor(id, side, lane, sublane) {
    super(id, side, lane, sublane);
    this.type = "officer";
    this.applyStats(UNIT_STATS.officer);
  }

  /**
   * Restore is applied once per side in GameSim.applySupport so officer,
   * color guard, and keep effects stack without double-counting.
   */
  restoreNearby() {
  }

  /**
   * Health restore goes through GameSim.applyHeal; green + signs are
   * queued from applySupport / keep overlap via registerRestore.
   */
  restoreHealthTo(ally, amount) {
    if (!this.side || !this.side.sim) return;
    this.side.sim.applyHeal(ally, amount);
  }

  update(dt, allies, enemies, enemySide, projectiles) {
    super.update(dt, allies, enemies, enemySide, projectiles);
    this.restoreNearby(allies, dt);
  }
}

/** Troop alternate: tougher body; takes half pushback. */
class Grenadier extends Troop {
  constructor(id, side, lane, sublane) {
    super(id, side, lane, sublane);
    this.variant = "grenadier";
    this.alternate = true;
    this.applyStats(UNIT_STATS.grenadier);
  }
}

/** Skirmisher alternate: harder shot, slower reload; double damage to Officers. */
class Rifle extends Skirmisher {
  constructor(id, side, lane, sublane) {
    super(id, side, lane, sublane);
    this.variant = "rifle";
    this.alternate = true;
    this.applyStats(UNIT_STATS.rifle);
  }
}

/** Dragoon alternate: normal flank, stronger charge damage. */
class Lancer extends Dragoon {
  constructor(id, side, lane, sublane) {
    super(id, side, lane, sublane);
    this.variant = "lancer";
    this.alternate = true;
    this.applyStats(UNIT_STATS.lancer);
  }
}

/**
 * Cannon alternate: shorter range, cannister fire. On each shot, fires
 * one projectile at the closest in-range non-officer in every row
 * (lane + sublane), using the same shoot range as the current order.
 * No splash.
 */
class Howitzer extends Cannon {
  constructor(id, side, lane, sublane) {
    super(id, side, lane, sublane);
    this.variant = "howitzer";
    this.alternate = true;
    this.applyStats(UNIT_STATS.howitzer);
  }

  /**
   * Closest valid target in each row of this lane. An officer is valid
   * when that row has no other target. Units in melee are skipped.
   * The Keep competes only in the middle row (priority paces), so a
   * volley hits it at most once.
   */
  cannisterTargets(enemies, allies, maxRange, enemySide) {
    const best = {};
    const officer = {};
    for (let i = 0; i < enemies.length; i += 1) {
      const other = enemies[i];
      if (!isValidRangedTarget(other) || other.lane !== this.lane) continue;
      if (!this.inShotRange(other, maxRange)) continue;
      const d = this.shotPaces(other);
      const key = String(other.sublane);
      if (other.type === "officer") {
        const prev = officer[key];
        if (!prev || d < prev.d) officer[key] = { unit: other, d };
        continue;
      }
      const prev = best[key];
      if (!prev || d < prev.d) best[key] = { unit: other, d };
    }
    const middle = Math.floor(Path.sublaneCount(this.lane) / 2);
    const midKey = String(middle);
    if (enemySide && this.inShotRange(enemySide, maxRange)) {
      const keepD = targetPriorityPaces(this, enemySide);
      const rowPick = best[midKey] || officer[midKey];
      if (!rowPick || keepD < rowPick.d) {
        best[midKey] = { unit: enemySide, d: keepD };
        delete officer[midKey];
      }
    }
    const out = [];
    const rows = {};
    const keys = Object.keys(best).concat(Object.keys(officer));
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (rows[key]) continue;
      rows[key] = true;
      const pick = best[key] || officer[key];
      if (pick) out.push(pick.unit);
    }
    return out;
  }

  /** Cannister: one shell per in-range row; falls back to a single aim. */
  fire(target, allies, projectiles, kind) {
    const strike = kind || "shoot";
    if (strike === "melee") {
      super.fire(target, allies, projectiles, kind);
      return;
    }
    // HARD RULES — same as Unit.fire: no ranged fire while melee-locked,
    // and never aim at a melee-locked unit (Keep excepted).
    if (this.cannotFireRanged()) return;
    if (target && !isValidRangedTarget(target)) {
      // Still may cannister other rows; only block the fallback single aim.
      target = null;
    }
    const sim = this.side.sim;
    const enemies = this.enemyTroops();
    const enemySide = this.side === sim.player ? sim.enemy : sim.player;
    const range = this.shootRange(allies || this.side.troops, enemies, enemySide);
    let targets = this.cannisterTargets(enemies, allies, range, enemySide);
    if (!targets.length) {
      if (target && isValidRangedTarget(target)) {
        targets = [target];
      } else {
        return;
      }
    }
    // Final filter so a locked unit never slips through (Keep stays valid).
    targets = targets.filter((aim) => isValidRangedTarget(aim));
    if (!targets.length) return;
    this.side.sim.emitSound({
      type: "shoot",
      lane: this.lane,
      sublane: this.sublane,
      unitType: this.type,
      sideId: this.side.id,
    });
    for (let i = 0; i < targets.length; i += 1) {
      const aim = targets[i];
      const shot = this.attackDamage(aim, strike, allies);
      projectiles.push(new Projectile(
        this.x,
        this.y,
        aim,
        shot.raw,
        allies,
        strike,
        this.type,
        this.side.sim,
        {
          speed: this.projectileSpeed,
          size: this.projectileSize,
          color: this.projectileColor,
          splash: 0,
          attackerSum: shot.attackerSum,
          shotSign: aim.station ? (Math.sign(aim.station() - this.station()) || 1) : 1,
          shootingPushback: this.shootingPushback,
        },
      ));
    }
    this.cooldown = this.strikeDelay(strike);
    this.flash = 0.12;
    this.applyPushback(this.shootingPushback, false);
  }
}

/**
 * Officer alternate: same fatigue and health restore as an Officer.
 * Friends in its aura ignore missing-health damage loss. Ahead doubles
 * the restore rate.
 */
class ColorGuard extends Officer {
  constructor(id, side, lane, sublane) {
    super(id, side, lane, sublane);
    this.variant = "colorGuard";
    this.alternate = true;
    this.applyStats(UNIT_STATS.colorGuard);
  }
}

const UNIT_KINDS = {
  troop: Troop,
  skirmisher: Skirmisher,
  dragoon: Dragoon,
  cannon: Cannon,
  officer: Officer,
  grenadier: Grenadier,
  rifle: Rifle,
  lancer: Lancer,
  howitzer: Howitzer,
  colorGuard: ColorGuard,
};

function createUnit(id, side, lane, sublane, type) {
  const Ctor = UNIT_KINDS[type] || Troop;
  return new Ctor(id, side, lane, sublane);
}

/**
 * A bottom-lane point that grants income to whichever side last walked through it.
 */
class Checkpoint {
  constructor(index, x, y) {
    this.index = index;
    this.x = x;
    this.y = y;
    this.owner = null;
    this.producing = false;
  }

  /**
   * Order along the arc: defense, speed, damage, speed, defense.
   * Same kinds share remaining cost; a second town doubles land/sec into that research.
   */
  upgradeKind() {
    const last = CONFIG.checkpointCount - 1;
    const dist = Math.min(this.index, last - this.index);
    if (dist === 0) {
      return "armor";
    }
    if (dist === 1) {
      return "speed";
    }
    return "damage";
  }

  /** Drawn town size follows the UI scale. */
  radius() {
    return CONFIG.checkpointRadius * CONFIG.uiScale;
  }

  /** Last bottom-lane troop to pass this town, on any row, claims it. */
  tryCapture(troop) {
    if (troop.lane !== "bottom" || troop.hp <= 0) {
      return false;
    }
    const center = Path.bottomCenter();
    const radius = Math.hypot(troop.x - center.x, troop.y - center.y);
    const slack = Path.arcDegrees(CONFIG.captureRadius, radius);
    const gap = Math.abs(troop.station() - Path.bottomStationDeg(this.x, this.y));
    if (gap > slack) {
      return false;
    }
    if (this.owner === troop.side.id) {
      return false;
    }
    this.owner = troop.side.id;
    this.producing = false;
    return true;
  }

}

/**
 * One combatant: gold, income, speed upgrades, keep health, and living troops.
 */
class Side {
  constructor(id, capital, sim) {
    this.id = id;
    this.sim = sim;
    this.capital = capital;
    this.gold = CONFIG.startGold;
    this.income = CONFIG.baseIncome;
    this.land = 0;
    this.landIncome = 0;
    this.capitalHP = CONFIG.capitalHP;
    this.speedMultiplier = 1;
    this.upgrades = { speed: 0, armor: 0, damage: 0 };
    this.upgradeProgress = { speed: 0, armor: 0, damage: 0 };
    this.landInvestRate = 0;
    this.banks = 0;
    this.troops = [];
    this.shotCooldown = 0;
    /** Per-lane fire priority (grand strategies disabled; always bastion). */
    this.targeting = { top: "bastion", bottom: "bastion" };
  }

  /**
   * Grand strategies are disabled in the current game mode.
   * Kept for a future mode; always rejects so targeting stays Bastion.
   */
  setTargeting(lane, mode) {
    return false;
  }

  /** Land price of the next rank of this upgrade. */
  upgradeCost(kind) {
    return CONFIG.upgradeBaseCost + CONFIG.upgradeCostStep * this.upgrades[kind];
  }

  /** True when this upgrade is below the tier cap and can be paid for. */
  canBuyUpgrade(kind) {
    if (this.upgrades[kind] === undefined || this.upgrades[kind] >= CONFIG.upgradeMax) {
      return false;
    }
    return this.land >= this.upgradeCost(kind);
  }

  /**
   * Fraction of incoming damage removed by armor ranks (capped).
   * Unit combat only — Keep hits must use applyKeepDamage instead.
   */
  armorReduction() {
    return Math.min(CONFIG.armorCap, CONFIG.armorPerUpgrade * this.upgrades.armor);
  }

  /** Apply armor and optional fort cover as separate multipliers. */
  mitigate(amount, cover) {
    let mult = 1 - this.armorReduction();
    if (cover) mult *= 1 - CONFIG.quarterArmor;
    return Math.max(0, amount * mult);
  }

  /**
   * Outgoing damage multiplier from damage ranks.
   * Unit combat only — Keep gun fire must not use this.
   */
  damageScale() {
    return 1 + CONFIG.damageUpgradeAmount * this.upgrades.damage;
  }

  /** Keep HP ignores town Defense; units still use armorReduction(). */
  applyKeepDamage(raw, attackerSum) {
    return truncateDamage(Math.max(0, raw * (1 + (attackerSum || 0))));
  }

  /** Gold per second paid to keep this side's living units. */
  massTax() {
    return massTaxOf(this.troops);
  }

  /** Gold price of a unit or its alternate. */
  unitCost(type) {
    return unitStats(type).cost;
  }

  /** Land price of an alternate (0 for base units). */
  unitLandCost(type) {
    return unitLandCost(type);
  }

  /** True when this side may spawn this unit key (base or alternate). */
  canSpawnUnit(type) {
    return UNIT_KINDS[type] !== undefined;
  }

  /** True when gold (and land for alternates) covers the buy price. */
  canAffordUnit(type) {
    if (!this.canSpawnUnit(type)) return false;
    if (this.gold < this.unitCost(type)) return false;
    if (isAlternateUnit(type) && this.land < this.unitLandCost(type)) return false;
    return true;
  }

  /** Living troops assigned to one lane. Used by the bot and spawn picking. */
  countInLane(lane) {
    let n = 0;
    for (let i = 0; i < this.troops.length; i += 1) {
      if (this.troops[i].lane === lane && this.troops[i].hp > 0) {
        n += 1;
      }
    }
    return n;
  }

  /** Living units of one type in a lane. */
  countTypeInLane(lane, type) {
    let n = 0;
    for (let i = 0; i < this.troops.length; i += 1) {
      const troop = this.troops[i];
      if (troop.lane === lane && troop.hp > 0 && troop.type === type) {
        n += 1;
      }
    }
    return n;
  }

  /** Prefer an emptier row so new units do not spawn stacked. */
  pickSublane(lane) {
    const count = Path.sublaneCount(lane);
    let best = 0;
    let bestN = Infinity;
    for (let s = 0; s < count; s += 1) {
      let n = 0;
      for (let i = 0; i < this.troops.length; i += 1) {
        const troop = this.troops[i];
        if (troop.lane === lane && troop.sublane === s && troop.hp > 0) {
          n += 1;
        }
      }
      if (n < bestN) {
        bestN = n;
        best = s;
      }
    }
    return best;
  }

  /**
   * Recalculate gold/sec from the base, this side's share of the
   * top-lane center pool, and unlocked banks. Towns do not pay gold.
   */
  refreshIncome(share) {
    const portion = share === undefined ? 0.5 : share;
    this.income = Math.round(
      CONFIG.baseIncome
      + CONFIG.centerIncome * portion
      + this.bankIncome(),
    );
  }

  /** Gold/sec from banks: bankIncomePer times unlocked count. */
  bankIncome() {
    return CONFIG.bankIncomePer * this.banks;
  }

  /** Gold to unlock the next bank. */
  bankCost() {
    return CONFIG.bankBaseCost + CONFIG.bankCostStep * this.banks;
  }


  /** True when match time has reached this bank's unlock minute. */
  bankUnlockedByTime(index) {
    const at = CONFIG.bankUnlockAt[index];
    return at !== undefined && this.sim.elapsed >= at;
  }

  /** Spend gold to open the next bank, once its clock time has passed. */
  tryUnlockBank() {
    if (this.banks >= CONFIG.bankCount) {
      return false;
    }
    if (!this.bankUnlockedByTime(this.banks)) {
      return false;
    }
    const cost = this.bankCost();
    if (this.gold < cost) {
      return false;
    }
    this.gold -= cost;
    this.banks += 1;
    return true;
  }

  /** Land/sec is only the bottom-lane share of the 0–10 pool. */
  refreshLand(share) {
    const portion = share === undefined ? 0.5 : share;
    this.landIncome = Math.round(CONFIG.centerLand * portion);
  }

  /**
   * Spend gold (and land for alternates) to spawn a unit.
   * lane is "top" or "bottom". Returns the unit, or null if unaffordable.
   */
  tryBuy(lane, nextId, type) {
    if (!this.canAffordUnit(type)) {
      return null;
    }
    const cost = this.unitCost(type);
    const land = this.unitLandCost(type);
    this.gold -= cost;
    this.land -= land;
    const troop = createUnit(nextId, this, lane, this.pickSublane(lane), type);
    this.troops.push(troop);
    return troop;
  }

  /** Remaining land needed to finish the next rank of this upgrade kind. */
  upgradeRemaining(kind) {
    if (this.upgrades[kind] === undefined || this.upgrades[kind] >= CONFIG.upgradeMax) {
      return 0;
    }
    return Math.max(0, this.upgradeCost(kind) - (this.upgradeProgress[kind] || 0));
  }

  /** Toggle a town into or out of upgrade production. */
  tryToggleTownProduce(town) {
    if (!town || town.owner !== this.id) return false;
    const kind = town.upgradeKind();
    if (this.upgrades[kind] >= CONFIG.upgradeMax) {
      town.producing = false;
      return false;
    }
    town.producing = !town.producing;
    return true;
  }

  /**
   * Best enemy troop in cannon range (closest eligible = Bastion;
   * keeps have no lane of their own). May fire into melee.
   * Officers are ignored while any other enemy is in cannon range.
   */
  capitalTarget(enemies, allies) {
    // Grand strategies disabled; always Bastion (closest eligible).
    const mode = "bastion";
    let best = null;
    let bestD = Infinity;
    let bestVit = 0;
    let bestOfficer = null;
    let bestOfficerD = Infinity;
    let bestOfficerVit = 0;
    for (let i = 0; i < enemies.length; i += 1) {
      const other = enemies[i];
      if (other.hp <= 0) {
        continue;
      }
      const d = other.pacesFromKeep(this.id);
      if (d > Path.pacesFromPx(CONFIG.capitalCannonRange)) {
        continue;
      }
      const vit = targetVitality(other);
      if (other.type === "officer") {
        if (!bestOfficer || isBetterTarget(mode, d, vit, bestOfficerD, bestOfficerVit)) {
          bestOfficerD = d;
          bestOfficerVit = vit;
          bestOfficer = other;
        }
        continue;
      }
      if (!best || isBetterTarget(mode, d, vit, bestD, bestVit)) {
        bestD = d;
        bestVit = vit;
        best = other;
      }
    }
    return best || bestOfficer;
  }

  /**
   * Keep gun shell with falloff and variance. Fixed damage — no town research.
   * Uses cannon shooting pushback on units; the Keep itself never recoils
   * and never takes pushback (hits use applyKeepDamage, not takeDamage).
   */
  fireCapital(target, allies, projectiles) {
    const range = Math.max(Path.pacesFromPx(CONFIG.capitalCannonRange), 1);
    const along = target.pacesFromKeep ? target.pacesFromKeep(this.id) : range;
    const falloff = Math.max(CONFIG.minDamageFactor, 1 - along / range);
    const attackerSum = (Math.random() * 2 - 1) * CONFIG.damageVariance;
    const shell = UNIT_STATS.cannon;
    projectiles.push(new Projectile(
      this.capital.x,
      this.capital.y,
      target,
      CONFIG.capitalCannonDamage * falloff,
      allies,
      "shoot",
      "cannon",
      this.sim,
      {
        speed: shell.projectileSpeed,
        size: shell.projectileSize,
        color: shell.projectileColor,
        splash: shell.splash,
        attackerSum,
        shotSign: this.id === "player" ? 1 : -1,
        shootingPushback: shell.shootingPushback || 0,
      },
    ));
    this.sim.emitSound({ type: "shoot", lane: "top", sublane: 2, unitType: "cannon", sideId: this.id });
    this.shotCooldown = CONFIG.capitalCannonAttackCooldown;
  }

  /** Tick the keep gun: fire at the nearest in-range foe when ready. */
  updateGuns(dt, enemies, allies, projectiles) {
    if (this.shotCooldown > 0) {
      this.shotCooldown -= dt;
    }
    if (this.capitalHP <= 0 || this.shotCooldown > 0) {
      return;
    }
    const target = this.capitalTarget(enemies, allies);
    if (!target) {
      return;
    }
    this.fireCapital(target, allies, projectiles);
  }



}

/**
 * Authoritative match. Callers apply commands and bot actions between
 * beginStep (time and income) and finishStep (movement and combat).
 */
export class GameSim {
  constructor() {
    this.reset();
  }

  reset() {
    this.player = new Side("player", { ...CONFIG.playerCapital }, this);
    this.enemy = new Side("enemy", { ...CONFIG.enemyCapital }, this);
    this.checkpoints = [];
    this.projectiles = [];
    this.splats = [];
    this.sounds = [];
    this.nextTroopId = 1;
    this.winner = null;
    this.winReason = null;
    this.elapsed = 0;
    this.tick = 0;
    /** Eased lane shares. Income and the drawn line both use these. */
    this.shownTop = 0.5;
    this.shownBottom = 0.5;

    const center = Path.bottomCenter();
    const innerEdge = Path.bottomRadius(CONFIG.bottomSublaneCount - 1) - CONFIG.bottomSublaneWidth / 2;
    const townR = CONFIG.checkpointRadius * CONFIG.uiScale;
    const radius = innerEdge - townR + CONFIG.checkpointLaneOverlap;
    const count = CONFIG.checkpointCount;
    for (let i = 0; i < count; i += 1) {
      const t = (i + 1) / (count + 1);
      const theta = Math.PI * (1 - t);
      this.checkpoints.push(new Checkpoint(
        i,
        center.x + radius * Math.cos(theta),
        center.y + radius * Math.sin(theta),
      ));
    }
    this.refreshIncomes();
  }

  side(id) {
    return id === "player" ? this.player : this.enemy;
  }

  emitSound(event) {
    this.sounds.push(event);
  }

  /** Spend gold and assign the next troop id. Null when the buy is rejected. */
  grantTroop(side, lane, type) {
    const troop = side.tryBuy(lane, this.nextTroopId, type);
    if (!troop) return null;
    this.nextTroopId += 1;
    return troop;
  }

  /**
   * Human, bot, and future agent commands. Rejects buys the side cannot
   * afford and orders on troops it does not own. Issue methods still apply
   * the melee and row rules.
   */
  applyCommand(sideId, cmd) {
    if (this.winner || !cmd || typeof cmd !== "object") return false;
    const side = sideId === "player" ? this.player : sideId === "enemy" ? this.enemy : null;
    if (!side) return false;
    const foe = side === this.player ? this.enemy : this.player;
    if (cmd.type === "buy") {
      if (cmd.lane !== "top" && cmd.lane !== "bottom") return false;
      if (!side.canSpawnUnit(cmd.unit)) return false;
      return Boolean(this.grantTroop(side, cmd.lane, cmd.unit));
    }
    if (cmd.type === "bank") return side.tryUnlockBank();
    if (cmd.type === "targeting") {
      return side.setTargeting(cmd.lane, cmd.mode);
    }
    if (cmd.type === "townProduce" || cmd.type === "upgrade") {
      const id = Number(cmd.checkpointId);
      const town = this.checkpoints.find((c) => c.index === id);
      if (!town || town.owner !== side.id) return false;
      return side.tryToggleTownProduce(town);
    }
    if (cmd.type === "order") {
      const troopId = Number(cmd.troopId);
      const troop = side.troops.find((t) => t.id === troopId && t.hp > 0);
      if (!troop) return false;
      const solo = Boolean(cmd.solo) || troop.isInMelee(foe.troops);
      if (cmd.action === "reform") troop.issueReform(side.troops, foe.troops, solo);
      else if (cmd.action === "restore") troop.issueRestore(side.troops, foe.troops, solo);
      else if (cmd.action === "speedUp") troop.issueSpeedUp(side.troops, foe.troops, solo);
      else if (cmd.action === "speedDown") troop.issueSpeedDown(side.troops, foe.troops, solo);
      else if (cmd.action === "cycle") troop.issueOrder(side.troops, foe.troops, solo);
      else if (cmd.action === "charge") troop.issueCharge(side.troops, foe.troops, solo);
      else if (cmd.action === "fallback") troop.issueFallback(side.troops, foe.troops, solo);
      else if (cmd.action === "forward") troop.issueForward(side.troops, foe.troops, solo);
      else if (cmd.action === "back") troop.issueBack(side.troops, foe.troops, solo);
      else if (cmd.action === "shift") {
        const dir = Number(cmd.dir);
        if (dir !== 1 && dir !== -1) return false;
        troop.issueLineSwitch(dir, side.troops);
      }
      else if (cmd.action === "lane" || cmd.action === "switch") {
        if (cmd.sublane != null && cmd.sublane !== "") {
          const sublane = Number(cmd.sublane);
          if (!Number.isInteger(sublane)) return false;
          troop.issueSwitch(sublane);
        } else {
          const dir = Number(cmd.dir);
          if (dir !== 1 && dir !== -1) return false;
          if (cmd.solo) troop.issueSwitch(troop.sublane + dir);
          else troop.issueLineSwitch(dir, side.troops);
        }
      } else return false;
      return true;
    }
    return false;
  }

  /** Income for this step. False once the match already has a winner. */
  beginStep(dt) {
    this.sounds = [];
    if (this.winner) return false;
    this.tick += 1;
    this.elapsed += dt;
    this.tickIncome(dt);
    return true;
  }

  /** Movement, capture, guns, and the capital win check. */
  finishStep(dt) {
    if (this.winner) return;
    this.updateSide(this.player, this.enemy.troops, this.enemy, dt);
    this.updateSide(this.enemy, this.player.troops, this.player, dt);
    this.player.updateGuns(dt, this.enemy.troops, this.player.troops, this.projectiles);
    this.enemy.updateGuns(dt, this.player.troops, this.enemy.troops, this.projectiles);
    this.updateProjectiles(dt);
    this.checkWinner();
  }

  checkWinner() {
    if (this.winner) return;
    if (this.enemy.capitalHP <= 0) {
      this.winner = "player";
      this.winReason = "capital";
    } else if (this.player.capitalHP <= 0) {
      this.winner = "enemy";
      this.winReason = "capital";
    }
  }

  snapshot() {
    return {
      tick: this.tick,
      elapsed: this.elapsed,
      winner: this.winner,
      winReason: this.winReason,
      topCenter: this.shownTop,
      bottomCenter: this.shownBottom,
      sounds: this.sounds.map((sound) => ({ ...sound })),
      checkpoints: this.checkpoints.map((town) => ({
        index: town.index,
        x: town.x,
        y: town.y,
        owner: town.owner,
        producing: Boolean(town.producing),
      })),
      projectiles: this.projectiles.map((shot) => ({
        x: shot.x,
        y: shot.y,
        size: shot.size,
        color: shot.color,
      })),
      splats: this.splats.map((splat) => ({
        x: splat.x,
        y: splat.y,
        amount: splat.amount,
        kind: splat.kind,
        age: splat.age,
      })),
      sides: {
        player: this.snapshotSide(this.player),
        enemy: this.snapshotSide(this.enemy),
      },
    };
  }

  snapshotSide(side) {
    return {
      id: side.id,
      gold: side.gold,
      income: side.income,
      land: side.land,
      landIncome: side.landIncome,
      landInvestRate: side.landInvestRate,
      capitalHP: side.capitalHP,
      banks: side.banks,
      speedMultiplier: side.speedMultiplier,
      upgrades: { ...side.upgrades },
      upgradeProgress: { ...side.upgradeProgress },
      targeting: {
        top: side.targeting.top,
        bottom: side.targeting.bottom,
      },
      troops: side.troops.filter((troop) => troop.hp > 0).map((troop) => ({
        id: troop.id,
        lane: troop.lane,
        sublane: troop.sublane,
        type: troop.type,
        variant: troop.variant,
        alternate: Boolean(troop.alternate),
        hp: troop.hp,
        maxHp: troop.maxHp,
        fatigue: troop.fatigue,
        maxFatigue: troop.maxFatigue,
        broken: troop.broken,
        priorOrder: troop.priorOrder === undefined ? null : troop.priorOrder,
        radius: troop.radius,
        x: troop.x,
        y: troop.y,
        order: troop.order,
        squared: Boolean(troop.squared),
        flash: troop.flash,
        progress: troop.progress,
      })),
    };
  }


  /**
   * Glide the drawn lane shares toward the live push. A hit, break, or
   * death changes the target at once; the line and the payout catch up.
   */
  easeLaneCenters(dt) {
    const tau = CONFIG.laneCenterEase;
    const k = !(tau > 0) ? 1 : 1 - Math.exp(-dt / tau);
    const top = this.laneCenterT("top");
    const bottom = this.laneCenterT("bottom");
    this.shownTop += (top - this.shownTop) * k;
    this.shownBottom += (bottom - this.shownBottom) * k;
    if (Math.abs(top - this.shownTop) < 1e-4) this.shownTop = top;
    if (Math.abs(bottom - this.shownBottom) < 1e-4) this.shownBottom = bottom;
  }

  /**
   * Apply the eased lane-center splits to gold and land income, then
   * award both for this step.
   */
  refreshIncomes() {
    const top = this.shownTop;
    const bottom = this.shownBottom;
    this.player.refreshIncome(top);
    this.enemy.refreshIncome(1 - top);
    this.player.refreshLand(bottom);
    this.enemy.refreshLand(1 - bottom);
  }

  /**
   * Award passive gold and land, then drain mass tax and town upgrade investment.
   * Tax cannot push a treasury below zero.
   */
  tickIncome(dt) {
    this.easeLaneCenters(dt);
    this.refreshIncomes();
    this.player.gold = Math.max(0, this.player.gold + (this.player.income - this.player.massTax()) * dt);
    this.enemy.gold = Math.max(0, this.enemy.gold + (this.enemy.income - this.enemy.massTax()) * dt);
    this.player.land += this.player.landIncome * dt;
    this.enemy.land += this.enemy.landIncome * dt;
    this.tickTownProduction(this.player, dt);
    this.tickTownProduction(this.enemy, dt);
  }

  /**
   * Invest land into owned producing towns at townProduceRate each.
   * Same-kind towns share remaining cost and stack investment rate.
   * When land cannot cover every town, fund closest to the keep first.
   */
  tickTownProduction(side, dt) {
    side.landInvestRate = 0;
    const rate = CONFIG.townProduceRate;
    const towns = [];
    for (let i = 0; i < this.checkpoints.length; i += 1) {
      const town = this.checkpoints[i];
      if (town.owner !== side.id || !town.producing) continue;
      const kind = town.upgradeKind();
      if (side.upgrades[kind] >= CONFIG.upgradeMax) {
        town.producing = false;
        continue;
      }
      towns.push(town);
    }
    towns.sort((a, b) => distance(a, side.capital) - distance(b, side.capital));
    let invested = 0;
    for (let i = 0; i < towns.length; i += 1) {
      if (side.land <= 0) break;
      const town = towns[i];
      const kind = town.upgradeKind();
      if (side.upgrades[kind] >= CONFIG.upgradeMax) {
        town.producing = false;
        continue;
      }
      const spend = Math.min(rate * dt, side.land);
      if (spend <= 0) break;
      side.land -= spend;
      invested += spend;
      side.upgradeProgress[kind] = (side.upgradeProgress[kind] || 0) + spend;
      while (
        side.upgrades[kind] < CONFIG.upgradeMax
        && side.upgradeProgress[kind] >= side.upgradeCost(kind)
      ) {
        side.upgradeProgress[kind] -= side.upgradeCost(kind);
        side.upgrades[kind] += 1;
        side.speedMultiplier = 1 + CONFIG.speedUpgradeAmount * side.upgrades.speed;
      }
      if (side.upgrades[kind] >= CONFIG.upgradeMax) {
        side.upgradeProgress[kind] = 0;
        for (let t = 0; t < this.checkpoints.length; t += 1) {
          const other = this.checkpoints[t];
          if (other.owner === side.id && other.upgradeKind() === kind) {
            other.producing = false;
          }
        }
      }
    }
    side.landInvestRate = dt > 0 ? invested / dt : 0;
  }

  /** How many color-guard effects this keep grants at the unit's distance. */
  keepAuraMultiplier(unit) {
    const dist = unit.pacesFromKeep(unit.side.id);
    const bands = CONFIG.keepAuraPaces;
    if (dist <= bands[0]) return 3;
    if (dist <= bands[1]) return 2;
    if (dist <= bands[2]) return 1;
    return 0;
  }

  /**
   * Strongest officer, strongest color guard, and the keep band.
   * Officers and color guards each restore fatigue and health. They stack
   * with each other; a second of the same kind does not. Double rate when
   * the source is ahead of the unit. The keep band does not double.
   * Keep health restore only applies when no enemy stands behind either of
   * this side's forts; keep fatigue restore still runs.
   */
  applySupport(side, dt) {
    const troops = side.troops;
    const keepBase = CONFIG.keepRestoreBase || 4;
    for (let i = 0; i < troops.length; i += 1) {
      const unit = troops[i];
      if (unit.hp <= 0) continue;
      let bestOfficer = 0;
      let bestGuard = 0;
      for (let j = 0; j < troops.length; j += 1) {
        const source = troops[j];
        if (source === unit || source.hp <= 0 || source.type !== "officer") continue;
        if (source.lane !== unit.lane) continue;
        const per = Path.stationPerPace(unit.lane);
        if (!(per > 0)) continue;
        const gap = Math.abs(source.station() - unit.station()) / per;
        if (gap > CONFIG.officerRestorePaces) continue;
        const ahead = unit.alongSigned(source) > 0;
        const rate = (source.restoreRate || 1) * (ahead ? 2 : 1);
        if (source.variant === "colorGuard") {
          if (rate > bestGuard) bestGuard = rate;
        } else if (rate > bestOfficer) {
          bestOfficer = rate;
        }
      }
      const keepRate = keepBase * this.keepAuraMultiplier(unit);
      const fatigue = (bestOfficer + bestGuard + keepRate) * dt;
      if (fatigue > 0) unit.fatigue = Math.max(0, unit.fatigue - fatigue);
      const keepHeal = unit.fortsClearOfEnemies() ? keepRate : 0;
      if (bestOfficer > 0) {
        const gained = this.applyHeal(unit, bestOfficer * dt);
        if (gained > 0) this.registerRestore(unit, "heal", gained);
      }
      if (bestGuard > 0) {
        const gained = this.applyHeal(unit, bestGuard * dt);
        if (gained > 0) this.registerRestore(unit, "heal", gained);
      }
      if (keepHeal > 0) {
        const gained = this.applyHeal(unit, keepHeal * dt);
        if (gained > 0) this.registerRestore(unit, "heal", gained);
      }
    }
  }

  /** Move, fight, capture, and drop dead troops for one side. */
  updateSide(side, opponents, enemySide, dt) {
    for (let i = 0; i < side.troops.length; i += 1) {
      const troop = side.troops[i];
      troop.reformHold = troop.hp > 0 && troop.reformShouldStop(side.troops);
    }
    for (let i = 0; i < side.troops.length; i += 1) {
      const troop = side.troops[i];
      if (troop.hp <= 0) {
        continue;
      }
      troop.update(dt, side.troops, opponents, enemySide, this.projectiles);
      troop.reformHold = false;
    }
    this.applySupport(side, dt);
    for (let i = 0; i < side.troops.length; i += 1) {
      const troop = side.troops[i];
      if (troop.hp <= 0) continue;
      this.flushRestoreVisuals(troop);
      if (troop.lane === "bottom") {
        for (let c = 0; c < this.checkpoints.length; c += 1) {
          if (this.checkpoints[c].tryCapture(troop)) {
            this.refreshIncomes();
          }
        }
      }
    }
    side.troops = side.troops.filter((troop) => troop.hp > 0);
  }

  /**
   * Queue a restore + source for this tick. Blue = halt fatigue, green =
   * health. Splat rate depends on how many sources are active.
   */
  registerRestore(unit, kind, amount) {
    if (!unit || !(amount > 0)) return;
    if (!unit.restoreSources) unit.restoreSources = [];
    unit.restoreSources.push(kind);
    unit.restoreAmount = (unit.restoreAmount || 0) + amount;
  }

  /**
   * Spend the restore bank into alternating + splats.
   * 1 source → quarter the old rate (threshold 4).
   * 2 sources → half rate, alternating.
   * 3+ sources → full rate, alternating.
   */
  flushRestoreVisuals(unit) {
    const sources = unit.restoreSources;
    const amount = unit.restoreAmount || 0;
    unit.restoreSources = null;
    unit.restoreAmount = 0;
    if (!sources || !sources.length || !(amount > 0)) return;
    unit.restoreBank = (unit.restoreBank || 0) + amount;
    const n = sources.length;
    const threshold = n >= 3 ? 1 : n === 2 ? 2 : 4;
    while (unit.restoreBank >= threshold) {
      unit.restoreBank -= threshold;
      const kind = sources[(unit.restoreCycle || 0) % n];
      unit.restoreCycle = (unit.restoreCycle || 0) + 1;
      this.spawnSplat(unit.x, unit.y, threshold, kind === "fatigue" ? "fatigue" : "heal");
    }
  }

  /**
   * Restore health. Returns the amount actually gained. Callers register
   * green + sources; this does not spawn splats on its own.
   */
  applyHeal(unit, amount) {
    if (!unit || !(amount > 0) || unit.hp >= unit.maxHp) return 0;
    const before = unit.hp;
    unit.hp = Math.min(unit.maxHp, unit.hp + amount);
    return unit.hp - before;
  }

  /** Create a floating damage number at a world point. */
  spawnSplat(x, y, amount, kind) {
    this.splats.push(new HitSplat(x, y, splatDamage(amount), kind));
  }

  /** Rise and drop expired hit splats. */
  updateSplats(dt) {
    for (let i = 0; i < this.splats.length; i += 1) {
      this.splats[i].update(dt);
    }
    this.splats = this.splats.filter((splat) => splat.alive);
  }

  /** Fly shells; they pass over units and only hit their locked target. */
  updateProjectiles(dt) {
    for (let i = 0; i < this.projectiles.length; i += 1) {
      this.projectiles[i].update(dt);
    }
    this.projectiles = this.projectiles.filter((shot) => shot.alive);
  }

  /** Gold cost of living units in one lane. */
  laneArmyValue(side, lane) {
    let total = 0;
    for (let i = 0; i < side.troops.length; i += 1) {
      const troop = side.troops[i];
      if (troop.hp <= 0 || troop.lane !== lane) {
        continue;
      }
      total += side.unitCost(troop.variant || troop.type);
    }
    return total;
  }

  /**
   * One side's push in a lane: each living unit adds progress-from-its
   * keep times its remaining hit points. Broken units do not count.
   */
  laneValue(side, lane) {
    let total = 0;
    for (let i = 0; i < side.troops.length; i += 1) {
      const troop = side.troops[i];
      if (troop.hp <= 0 || troop.broken || troop.lane !== lane) {
        continue;
      }
      total += troop.progress * troop.hp;
    }
    return total;
  }

  /**
   * Share of a lane from the player keep. Player value over both
   * sides' values; 0.5 when nobody is on the lane.
   */
  laneCenterT(lane) {
    const playerVal = this.laneValue(this.player, lane);
    const enemyVal = this.laneValue(this.enemy, lane);
    const sum = playerVal + enemyVal;
    if (sum <= 0) {
      return 0.5;
    }
    return playerVal / sum;
  }

  topLaneCenterT() {
    return this.laneCenterT("top");
  }

  bottomLaneCenterT() {
    return this.laneCenterT("bottom");
  }
}
