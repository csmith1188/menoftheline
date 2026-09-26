import { CONFIG, truncateDamage, splatDamage } from "../shared/config.js";
import { UNIT_STATS, unitStats, massTaxOf, unitLandCost, isAlternateUnit } from "../shared/units.js";
import { Path, distance, touchesQuarterLine } from "../shared/path.js";

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
    this.allies = allies;
    this.kind = kind || "shoot";
    this.sourceType = sourceType || "troop";
    this.sim = sim;
    this.speed = shot && shot.speed != null ? shot.speed : UNIT_STATS.troop.projectileSpeed;
    this.size = shot && shot.size != null ? shot.size : UNIT_STATS.troop.projectileSize;
    this.color = shot && shot.color ? shot.color : UNIT_STATS.troop.projectileColor;
    this.splash = shot && shot.splash != null ? shot.splash : 0;
    this.splashWholeLine = Boolean(shot && shot.splashWholeLine);
    this.alive = true;
    this.sideId = allies.length && allies[0].side ? allies[0].side.id : "player";
  }

  /** World point the shell is flying toward. */
  dest() {
    if (this.target.capital) {
      return this.target.capital;
    }
    return this.target;
  }

  /** Advance the shell; apply damage on impact. */
  update(dt) {
    if (this.target.hp !== undefined && this.target.hp <= 0) {
      this.alive = false;
      return;
    }
    const dest = this.dest();
    const d = distance(this, dest);
    const step = this.speed * dt;
    if (d <= step + this.size) {
      if (this.target.capitalHP !== undefined) {
        const hit = truncateDamage(this.target.mitigate(this.damage));
        this.target.capitalHP -= hit;
        const keep = this.target.capital;
        this.sim.spawnSplat(keep.x, keep.y, hit, this.kind);
      } else {
        this.target.takeDamage(this.damage, this.kind);
        this.splashCannonLine();
        this.slowSkirmisherLine();
      }
      this.alive = false;
      return;
    }
    this.x += ((dest.x - this.x) / d) * step;
    this.y += ((dest.y - this.y) / d) * step;
  }

  /**
   * Cannon shells also hit other units on the target's line. Field guns
   * splash half damage onto adjacent rows. Howitzers fire separate
   * cannister shells instead and do not splash.
   */
  splashCannonLine() {
    if (!(this.splash > 0) || !this.target.side) {
      return;
    }
    const splash = this.damage * this.splash;
    if (splash <= 0) {
      return;
    }
    const hit = this.target;
    if (this.splashWholeLine) {
      const line = hit.lineGroup(hit.side.troops);
      for (let i = 0; i < line.length; i += 1) {
        const other = line[i];
        if (other === hit || other.hp <= 0) {
          continue;
        }
        if (other.isInMelee(this.allies)) {
          continue;
        }
        other.takeDamage(splash, this.kind);
      }
      return;
    }
    const foes = hit.side.troops;
    for (let i = 0; i < foes.length; i += 1) {
      const other = foes[i];
      if (other === hit || other.hp <= 0 || other.lane !== hit.lane) {
        continue;
      }
      if (!hit.adjacentRow(other) || !hit.withinLine(other)) {
        continue;
      }
      if (other.isInMelee(this.allies)) {
        continue;
      }
      other.takeDamage(splash, this.kind);
    }
  }

  /**
   * A skirmisher shot slows every living unit in the target's line,
   * not only the body that was hit. Halt and reform still ignore the
   * slow while that order lasts.
   */
  slowSkirmisherLine() {
    if (this.sourceType !== "skirmisher" || this.kind === "melee" || !this.target.side) {
      return;
    }
    const hit = this.target;
    const line = hit.lineGroup(hit.side.troops);
    for (let i = 0; i < line.length; i += 1) {
      const other = line[i];
      if (other === hit || other.hp <= 0) {
        continue;
      }
      if (other.order === null || other.order === "charge") {
        other.shotSlow = other.shotSlowSpeed;
      }
    }
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

  /** Yellow for shots, red for melee, green for healing. */
  fillColor() {
    if (this.kind === "melee") return CONFIG.colors.splatMelee;
    if (this.kind === "heal") return CONFIG.colors.splatHeal;
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
    this.auraAttack = 1;
    this.auraSpeed = 1;
    this.applyStats(UNIT_STATS.troop);
    this.progress = 0;
    this.cooldown = 0;
    this.flash = 0;
    this.strafing = false;
    this.order = null;
    this.priorOrder = null;
    this.broken = false;
    this.reformNeedsAlign = false;
    this.shotSlow = 0;
    this.switch = null;
    this.switchEscape = false;
    this.orderHeld = false;
    this.heldOrder = null;
    this.fallbackLeavesMelee = false;
    /** Prior tick order; used to detect ending a pass-through while stacked. */
    this.prevCollisionOrder = null;
    /** Ease after pass-through ends while overlapping a collidable. */
    this.peelingFromPassThrough = false;
    /** Committed peel direction (+1 forward / -1 back) until clear. */
    this.peelDir = 0;
    /**
     * When true, this unit keeps a solo-issued order and does not absorb
     * halt/reform/advance from adjacent line-mates.
     */
    this.ignoreLineOrders = false;
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
    this.meleeReach = stats.meleeReach;
    this.shotSlowSpeed = stats.shotSlowSpeed;
    this.slowFactor = stats.slowFactor;
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
    this.splashWholeLine = Boolean(stats.splashWholeLine);
    this.restoreRange = stats.restoreRange || 0;
    this.restoreRate = stats.restoreRate || 0;
    this.restoreHealth = Boolean(stats.restoreHealth);
    this.officerDamageMultiplier = stats.officerDamageMultiplier || 1;
    this.buffRange = stats.buffRange || 0;
    this.attackBuff = stats.attackBuff || 0;
    this.speedBuff = stats.speedBuff || 0;
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

  /** Units that receive this order: the whole line, or only this troop. */
  orderGroup(allies, solo) {
    if (solo) return [this];
    return this.lineGroup(allies);
  }

  /**
   * Click cycle: advance, halt, reform. Charge and fallback are drag orders.
   * Subclasses replace this when they use a different set.
   */
  clickOrders() {
    return [null, "halt", "reform"];
  }

  /** Next order from a click. A held melee order counts, so the cycle can keep moving. */
  nextClickOrder() {
    const current = this.orderHeld ? this.heldOrder : this.order;
    if (current === "halt") return "reform";
    if (current === "reform") return null;
    return "halt";
  }

  /**
   * Accept an order. Reform and fallback start immediately. Any other
   * order given in melee is held until this unit is out of contact.
   */
  commitOrder(next, enemies) {
    if (this.broken) return;
    const immediate = next === "reform" || next === "fallback";
    if (!immediate && enemies && this.isInMelee(enemies)) {
      this.heldOrder = next;
      this.orderHeld = true;
      return;
    }
    this.orderHeld = false;
    this.heldOrder = null;
    this.order = next;
    this.reformNeedsAlign = next === "reform";
    if (next !== "reform") this.priorOrder = null;
    if (next === "retreat") {
      this.switch = null;
      this.switchEscape = false;
    }
    this.fallbackLeavesMelee = next === "fallback" && Boolean(enemies && this.isInMelee(enemies));
  }

  /** Apply an order to this troop's order group. */
  applyGroupOrder(allies, next, solo, enemies) {
    const group = this.orderGroup(allies, solo);
    const lock = Boolean(solo);
    for (let i = 0; i < group.length; i += 1) {
      group[i].commitOrder(next, enemies);
      group[i].ignoreLineOrders = lock;
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
  }

  /**
   * Left-click while selected: enter reform, remembering the prior order.
   * Locked while the line is in melee or broken.
   */
  issueReform(allies, enemies, solo) {
    if (this.broken) {
      return;
    }
    if (this.order === "reform") return;
    const group = this.orderGroup(allies, solo);
    const lock = Boolean(solo);
    for (let i = 0; i < group.length; i += 1) {
      if (group[i].broken || group[i].order === "reform") continue;
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
   * Fall back at reform speed. Starts even in melee. A fallback that
   * then leaves melee becomes a retreat, without breaking the unit.
   */
  issueFallback(allies, enemies, solo) {
    if (this.broken || this.order === "fallback") {
      return;
    }
    this.applyGroupOrder(allies, "fallback", solo, enemies);
  }

  /**
   * Swipe forward: charge, or resume a normal advance when halted.
   */
  issueForward(allies, enemies, solo) {
    if (this.broken) return;
    const current = this.orderHeld ? this.heldOrder : this.order;
    if (current === "halt") {
      this.applyGroupOrder(allies, null, solo, enemies);
      return;
    }
    this.issueCharge(allies, enemies, solo);
  }

  /**
   * Swipe back: fall back, or advance when charging outside melee.
   * A charging unit that is in melee falls back instead.
   */
  issueBack(allies, enemies, solo) {
    if (this.broken) return;
    const group = this.orderGroup(allies, solo);
    const lock = Boolean(solo);
    for (let i = 0; i < group.length; i += 1) {
      const member = group[i];
      if (member.broken) continue;
      const current = member.orderHeld ? member.heldOrder : member.order;
      const inMelee = member.isInMelee(enemies);
      if (current === "charge" && inMelee) {
        member.commitOrder("fallback", enemies);
      } else if (current === "charge") {
        member.commitOrder(null, enemies);
      } else {
        member.commitOrder("fallback", enemies);
      }
      member.ignoreLineOrders = lock;
    }
  }

  /** True when this body may not be given a sublane switch. */
  switchBlocked() {
    return this.broken || this.order === "retreat";
  }

  /**
   * Hidden switch: slide this unit to an exact sublane. Allowed in melee.
   * Broken and retreating units ignore it.
   */
  issueSwitch(sublane) {
    if (this.switchBlocked()) return;
    const count = Path.sublaneCount(this.lane);
    if (!Number.isInteger(sublane) || sublane < 0 || sublane >= count || sublane === this.sublane) {
      this.switch = null;
      return;
    }
    this.switch = sublane;
    this.switchEscape = Math.abs(sublane - this.sublane) > 1;
  }

  /**
   * Hidden switch for a line: each member steps one sublane in dir.
   * The line stays put when any member who can switch would leave the lane.
   */
  issueLineSwitch(dir, allies) {
    if (this.switchBlocked() || (dir !== 1 && dir !== -1)) return;
    const group = this.lineGroup(allies);
    const count = Path.sublaneCount(this.lane);
    const movers = [];
    for (let i = 0; i < group.length; i += 1) {
      const member = group[i];
      if (member.switchBlocked()) continue;
      const next = member.sublane + dir;
      if (next < 0 || next >= count) return;
      movers.push(member);
    }
    for (let i = 0; i < movers.length; i += 1) {
      movers[i].switch = movers[i].sublane + dir;
      movers[i].switchEscape = false;
    }
  }

  /** Put this line on reform without cycling through halt. */
  startReform(allies, solo) {
    const group = this.orderGroup(allies, solo);
    const lock = Boolean(solo);
    for (let i = 0; i < group.length; i += 1) {
      if (group[i].broken) continue;
      group[i].priorOrder = group[i].order;
      group[i].order = "reform";
      group[i].reformNeedsAlign = true;
      group[i].ignoreLineOrders = lock;
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
   * An advancing troop that becomes perfectly parallel with another
   * absorbs that troop or line's order, if that line still has an open
   * row. Chargers do not pass charge to anyone they line up with, and
   * they do not absorb others' orders. A retreat stays with the unit
   * that was given it. A full line neither takes an outsider's order
   * nor hands its own order on.
   */
  tryJoinAhead(allies) {
    if (this.ignoreLineOrders) {
      return;
    }
    if (this.broken || this.order === "charge" || this.order === "fallback"
      || this.order === "retreat" || this.isInMelee(this.enemyTroops())) {
      return;
    }
    const foes = this.enemyTroops();
    for (let i = 0; i < allies.length; i += 1) {
      const ally = allies[i];
      if (ally === this || ally.hp <= 0 || ally.lane !== this.lane || ally.isInMelee(foes)) {
        continue;
      }
      if (!this.adjacentRow(ally)) {
        continue;
      }
      if (!this.sameLineType(ally)) {
        continue;
      }
      // Charge never spreads by lining up.
      if (!ally.order || ally.order === "fallback" || ally.order === "retreat"
        || ally.order === "charge") {
        continue;
      }
      if (this.order === ally.order) {
        continue;
      }
      if (!this.isParallelTo(ally)) {
        continue;
      }
      if (this.alongSigned(ally) < -this.stationSlack("parallel")) {
        continue;
      }
      if (!this.canPassLineOrder(ally, allies)) {
        continue;
      }
      if (this.rankIsFull(allies, ally) || ally.rankIsFull(allies, this)) {
        continue;
      }
      if (!this.canTakeLineOrder(ally, allies)) {
        continue;
      }
      const group = this.lineGroup(allies);
      for (let g = 0; g < group.length; g += 1) {
        const member = group[g];
        if (member.broken || member.isInMelee(foes) || member.ignoreLineOrders) continue;
        if (member !== this && member.rankIsFull(allies, ally)) {
          continue;
        }
        member.order = ally.order;
        member.reformNeedsAlign = ally.reformNeedsAlign;
      }
      return;
    }
  }

  /**
   * A unit that reaches a reforming line from behind takes that order,
   * unless that line is already full. Charge and fallback are left alone.
   * Perfectly beside an open line is handled by tryJoinAhead.
   */
  takeReformFromBehind(allies) {
    if (this.ignoreLineOrders) {
      return;
    }
    if (this.broken || this.order === "charge" || this.order === "fallback"
      || this.order === "retreat" || this.order === "reform") {
      return;
    }
    const beside = this.stationSlack("parallel");
    for (let i = 0; i < allies.length; i += 1) {
      const ally = allies[i];
      if (ally === this || ally.hp <= 0 || ally.order !== "reform") {
        continue;
      }
      if (ally.lane !== this.lane || !this.sameLineType(ally) || !this.adjacentRow(ally)) {
        continue;
      }
      const along = this.alongSigned(ally);
      if (along <= beside || !this.withinLine(ally)) {
        continue;
      }
      if (!this.canPassLineOrder(ally, allies)) {
        continue;
      }
      if (this.rankIsFull(allies, ally) || ally.rankIsFull(allies, this) || !this.canTakeLineOrder(ally, allies)) {
        continue;
      }
      this.order = "reform";
      this.reformNeedsAlign = true;
      return;
    }
  }

  /**
   * Enemy this troop is touching, or standing against at the body edge.
   * Used for charge contact and order-lock; walking into a body is still blocked.
   */
  collidingEnemy(enemies) {
    const reach = this.bodyRadius() + CONFIG.meleeSlack;
    for (let i = 0; i < enemies.length; i += 1) {
      const enemy = enemies[i];
      if (enemy.hp <= 0 || enemy.lane !== this.lane) {
        continue;
      }
      if (distance(this, enemy) <= reach + enemy.bodyRadius()) {
        return enemy;
      }
    }
    return null;
  }

  bodyRadius() {
    return this.radius;
  }

  maxHP() {
    return this.maxHp;
  }

  /**
   * True when this unit is locked in body contact with an enemy that
   * also fights in melee. Cannons are never in melee.
   */
  isInMelee(foes) {
    if (!this.fightsMelee) {
      return false;
    }
    const foe = this.collidingEnemy(foes);
    return Boolean(foe && foe.fightsMelee);
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
   * Flanking: a charging unit on another sublane, inside the wider flank window.
   */
  isFlanking(target) {
    if (this.order !== "charge") {
      return false;
    }
    if (!target.lane || target.lane !== this.lane || target.sublane === this.sublane) {
      return false;
    }
    const radius = this.lane === "bottom" ? Path.bottomRadius(this.sublane) : 0;
    return Math.abs(this.station() - target.station()) <= Path.stationSlack(this.lane, "flank", radius);
  }

  /** True if a world point would sit inside an enemy body. */
  overlapsEnemyAt(x, y, enemies) {
    const here = { x, y };
    const reach = this.bodyRadius();
    for (let i = 0; i < enemies.length; i += 1) {
      const enemy = enemies[i];
      if (enemy.hp <= 0 || enemy.lane !== this.lane) {
        continue;
      }
      if (distance(here, enemy) < reach + enemy.bodyRadius()) {
        return true;
      }
    }
    return false;
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
   * Same-type reforming neighbors on adjacent rows, even when a stagger
   * is wider than the combat line window. An empty row still splits them.
   */
  reformFormation(allies) {
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
          if (ally.lane !== this.lane || ally.order !== "reform") {
            continue;
          }
          if (!member.sameLineType(ally) || !member.adjacentRow(ally)) {
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
   * While a reforming formation is staggered, units already at the
   * front station wait. Rear units walk up. A perfect line does not wait.
   */
  reformShouldStop(allies) {
    if (this.order !== "reform") {
      return false;
    }
    const foes = this.enemyTroops();
    const formation = this.reformFormation(allies).filter((unit) => !unit.isInMelee(foes));
    if (formation.length < 2) {
      return false;
    }
    const front = this.sortRearToFront(formation)[formation.length - 1];
    for (let i = 0; i < formation.length; i += 1) {
      if (!formation[i].isParallelTo(front)) {
        return this.isParallelTo(front);
      }
    }
    return false;
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
   * Inner and middle bottom rings are shorter. Scale walk speed so they
   * keep the same angle as a troop on the outer half-circle.
   */
  ringSpeedScale() {
    if (this.lane !== "bottom") {
      return 1;
    }
    const outer = Path.bottomRadius(0);
    if (outer <= 0) {
      return 1;
    }
    return Path.bottomRadius(this.sublane) / outer;
  }

  /**
   * Advancing and charging troops walk at half speed after a shot.
   * Halt and reform are unchanged.
   */
  shotSlowScale() {
    if (this.shotSlow <= 0) {
      return 1;
    }
    if (this.order !== null && this.order !== "charge") {
      return 1;
    }
    return this.slowFactor;
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
   * Raise or lower fatigue for this step. Charge and melee contact gain
   * at combat rate (even inside the keep). Broken units also gain while
   * retreating until fatigue is full, then switch to fallback. Otherwise
   * halt recovers at idle rate, and own capital recovers faster.
   * Overlapping the keep also restores health at that same recovery rate.
   * A broken unit rallies once fatigue is at or below half its current hp.
   */
  tickFatigue(dt, enemies) {
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
      if (this.hp > 0 && this.overlapsOwnCapital()) {
        this.hp = Math.min(this.maxHp, this.hp + recovered);
      }
    } else if (this.order === "halt") {
      this.fatigue = Math.max(0, this.fatigue - CONFIG.fatigueIdleRate * dt);
    }
    if (this.broken) {
      if (this.order === "retreat" && this.fatigue >= this.maxFatigue) {
        this.order = "fallback";
      }
      if (this.fatigue <= this.hp * 0.5) {
        this.broken = false;
        this.order = null;
      }
    }
  }

  /** Force a rout: retreat until fatigue is full, then fall back until fatigue is half current hp. */
  breakUnit() {
    this.broken = true;
    this.order = this.fatigue >= this.maxFatigue ? "fallback" : "retreat";
    this.priorOrder = null;
    this.reformNeedsAlign = false;
    this.switch = null;
    this.switchEscape = false;
    this.orderHeld = false;
    this.heldOrder = null;
    this.fallbackLeavesMelee = false;
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
   * Reform walks at half speed. The forward edge of a staggered reform
   * stands still until the rear is in line. Bottom rings also apply
   * ringSpeedScale.
   */
  marchSpeed(allies) {
    const scale = this.ringSpeedScale() * this.shotSlowScale();
    const base = this.speed * this.side.speedMultiplier * this.auraSpeed * scale;
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
      return base * CONFIG.reformSpeedFactor;
    }
    return base;
  }

  /** Firing range for this unit. */
  attackRange() {
    return this.range;
  }

  /** Range used to open fire on your own. Halt uses full range. */
  openFireRange() {
    if (this.order === "halt") return this.attackRange();
    return this.attackRange() * this.engageRange;
  }

  /**
   * Range used to pick a shoot target. Halt and advancing lined volleys
   * use full attack range; solo advance still opens at engage range.
   */
  shootRange(allies, enemies, enemySide) {
    if (this.order === "halt" || this.lineVolleyRange(allies, enemies, enemySide)) {
      return this.attackRange();
    }
    return this.openFireRange();
  }

  /**
   * True when this troop has already committed to shooting: engagement
   * range, full range while halted, melee contact, or the enemy keep.
   * Chargers only count once they are in contact.
   */
  isOpeningFire(enemies, allies, enemySide) {
    if (this.fightsMelee && this.collidingEnemy(enemies)) {
      return true;
    }
    if (this.order === "charge" || this.order === "reform") {
      return false;
    }
    return Boolean(this.nearestTarget(enemies, this.openFireRange(), allies, enemySide));
  }

  /**
   * True when this troop may shoot: it opened on its own, or it is in
   * line with someone who did and still has a target inside shoot range.
   * Reforming units do not shoot.
   */
  mayShoot(allies, enemies, enemySide) {
    if (this.order === "reform") {
      return false;
    }
    if (this.isOpeningFire(enemies, allies, enemySide)) {
      return true;
    }
    if (!this.nearestTarget(enemies, this.shootRange(allies, enemies, enemySide), allies, enemySide)) {
      return false;
    }
    const line = this.lineGroup(allies);
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] !== this && line[i].isOpeningFire(enemies, allies, enemySide)) {
        return true;
      }
    }
    return false;
  }

  /** How often this unit may strike, including speed-upgrade scaling. */
  strikeDelay(kind) {
    const base = kind === "melee" ? this.meleeCooldown : this.rangedCooldown;
    return base / (1 + CONFIG.speedAttackFactor * this.side.upgrades.speed);
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
    const step = this.speed * this.side.speedMultiplier
      * this.shotSlowScale() * charge * dt;
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
    const dest = Path.pointAt(Path.waypoints(this.side.id, this.lane, sublane), this.progress);
    if (this.overlapsEnemyAt(dest.x, dest.y, enemies)) {
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
    return !this.overlapsEnemyAt(dest.x, dest.y, enemies);
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
   * easing back to clear a blocker ahead in the next row, "waiting" if
   * blocked with no room to clear, or "none" when there is no pending
   * row change. Melee does not cancel it.
   */
  followLaneOrder(dt, allies, enemies) {
    if (this.switch == null) {
      return "none";
    }
    if (this.switchBlocked()) {
      this.switch = null;
      this.switchEscape = false;
      return "none";
    }
    if (this.isInMelee(enemies) && !this.switchEscape) {
      return "none";
    }
    if (this.switch === this.sublane) {
      if (!this.strafing) {
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
   * Stops short of enemy bodies and friendly blockers. True if it moved.
   */
  marchAlong(dt, allies, enemies, dir) {
    const sign = dir < 0 ? -1 : 1;
    for (let i = 0; i < allies.length; i += 1) {
      if (this.isBlockedToward(allies[i], sign)) {
        return false;
      }
    }
    const speed = this.marchSpeed(allies);
    const delta = (speed * dt) / this.pathLength;
    const nextProgress = Math.max(0, Math.min(1, this.progress + sign * delta));
    const next = Path.pointAt(this.points, nextProgress);
    if (this.overlapsEnemyAt(next.x, next.y, enemies)) {
      return false;
    }
    if (nextProgress === this.progress) {
      return false;
    }
    this.progress = nextProgress;
    this.syncPosition();
    return true;
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
      if (enemy.hp <= 0 || enemy.lane !== this.lane) {
        continue;
      }
      const along = this.alongSigned(enemy);
      const rowGap = Math.abs(enemy.sublane - this.sublane);
      const stationGap = Math.abs(this.station() - enemy.station());
      let rank = 3;
      if (rowGap === 0) {
        rank = 0;
      } else if (this.withinLine(enemy)) {
        rank = 1;
      } else if (along < 0) {
        rank = 2;
      }
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
      if (enemy.hp <= 0 || enemy.lane !== this.lane) {
        continue;
      }
      if (!this.withinLine(enemy)) {
        continue;
      }
      const rowGap = Math.abs(enemy.sublane - this.sublane);
      if (rowGap <= 1) {
        continue;
      }
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
    if (!prey) {
      return false;
    }
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
   * Friendly collision rules. Fall back / retreat disable collision.
   * Charging cavalry ride through friendlies. Advancing skirmishers and
   * officers pass through non-skirmish-like friendlies.
   */
  collisionEnabled() {
    return this.order !== "fallback" && this.order !== "retreat";
  }

  /** Skirmishers and officers share the same pass-through rules. */
  isSkirmishLike() {
    return this.type === "skirmisher" || this.type === "officer";
  }

  /** Dragoons and lancer variants. */
  isCavalry() {
    return this.type === "dragoon" || this.variant === "lancer";
  }

  /**
   * True when this unit and ally may not occupy the same stretch.
   * Fall back / retreat either side: no block. Charging cavalry either
   * side: no block. Skirmish-like on advance pass through anyone who is
   * not skirmish-like.
   */
  blocksAlly(ally) {
    return this.blocksAllyWithOrders(ally, this.order, ally.order);
  }

  /**
   * blocksAlly using explicit orders so we can detect ending a
   * pass-through (e.g. cavalry charge → halt while still overlapping).
   */
  blocksAllyWithOrders(ally, myOrder, theirOrder) {
    if (myOrder === "fallback" || myOrder === "retreat"
      || theirOrder === "fallback" || theirOrder === "retreat") {
      return false;
    }
    if ((this.isCavalry() && myOrder === "charge")
      || (ally.isCavalry() && theirOrder === "charge")) {
      return false;
    }
    if (this.isSkirmishLike() && myOrder === null && !ally.isSkirmishLike()) {
      return false;
    }
    if (ally.isSkirmishLike() && theirOrder === null && !this.isSkirmishLike()) {
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
    return Math.abs(ally.station() - this.station()) < this.stationSlack("block");
  }

  /**
   * True when we now block a same-row ally inside the block gap, but would
   * not have under prevCollisionOrder (left fall back / retreat, ended a
   * cavalry charge, left skirmish-like advance, etc.).
   */
  gainedCollisionWhileOverlapping(allies) {
    const gap = this.stationSlack("block");
    const prev = this.prevCollisionOrder;
    for (let i = 0; i < allies.length; i += 1) {
      const ally = allies[i];
      if (ally === this || ally.hp <= 0 || ally.lane !== this.lane) {
        continue;
      }
      if (ally.sublane !== this.sublane) {
        continue;
      }
      if (Math.abs(ally.station() - this.station()) >= gap) {
        continue;
      }
      if (!this.blocksAllyWithOrders(ally, this.order, ally.order)) {
        continue;
      }
      if (this.blocksAllyWithOrders(ally, prev, ally.order)) {
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
   * does not move here. True while holding a stack so advance does not
   * shove anyone.
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
    if (along < 0) {
      return true;
    }
    if (along === 0) {
      this.easeBack(dt, allies, enemies);
      return true;
    }
    return false;
  }

  /**
   * After ending a pass-through while stacked: ease toward the closest
   * overlapping collidable by station (forward if they are ahead, back
   * if they are behind). Once a direction is chosen, keep easing that
   * way until clear of every collidable — avoids thrashing when
   * sandwiched. True while still peeling so the unit must not act on
   * its order yet.
   */
  peelAfterCollisionEnable(dt, allies, enemies) {
    if (!this.peelingFromPassThrough) {
      return false;
    }
    const other = this.collidingAlly(allies);
    if (!other) {
      this.peelingFromPassThrough = false;
      this.peelDir = 0;
      return false;
    }
    if (this.peelDir === 0) {
      const along = this.alongSigned(other);
      // Toward the closer unit: ahead → forward, behind → back, tie → back.
      this.peelDir = along > 0 ? 1 : -1;
    }
    this.easeAlong(dt, allies, enemies, this.peelDir, true);
    if (!this.collidingAlly(allies)) {
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
      return along > 0 && along < gap;
    }
    return along < 0 && -along < gap;
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
      if (Math.abs(ally.station() - this.station()) >= slack) {
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
   * Best sublane to move around a line: any other row with no blockGap
   * collidable at our station, scored by how far ahead the next blocker
   * is (empty ahead wins). Closer rows win ties. Null if every row is
   * stacked on us.
   */
  pickBestSwitchSublane(allies) {
    const count = Path.sublaneCount(this.lane);
    let best = null;
    let bestAlong = -Infinity;
    let bestDist = Infinity;
    for (let s = 0; s < count; s += 1) {
      if (s === this.sublane) {
        continue;
      }
      if (this.sublaneHasCollidableInBlockGap(s, allies)) {
        continue;
      }
      const ahead = this.nextCollidableAhead(s, allies);
      const along = ahead ? ahead.along : Infinity;
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
   * Ease along the path (dir +1 forward, -1 back). Stops short of enemy
   * bodies. Unless ignoreFriendlies, also stops for friendlies in that
   * direction. Uses walk speed even while halted. True if it moved.
   */
  easeAlong(dt, allies, enemies, dir, ignoreFriendlies) {
    const sign = dir < 0 ? -1 : 1;
    if (!ignoreFriendlies) {
      for (let i = 0; i < allies.length; i += 1) {
        if (this.isBlockedToward(allies[i], sign)) {
          return false;
        }
      }
    }
    const scale = this.ringSpeedScale() * this.shotSlowScale();
    const speed = this.speed * this.side.speedMultiplier * this.auraSpeed * scale;
    const delta = (speed * dt) / this.pathLength;
    const nextProgress = Math.max(0, Math.min(1, this.progress + sign * delta));
    if (nextProgress === this.progress) {
      return false;
    }
    const next = Path.pointAt(this.points, nextProgress);
    if (this.overlapsEnemyAt(next.x, next.y, enemies)) {
      return false;
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
  tryEnterOrEaseAdjacent(dt, allies, enemies, next, commitGoal) {
    if (next === this.sublane) {
      return false;
    }
    if (commitGoal != null && this.switch !== commitGoal) {
      this.switch = commitGoal;
      this.switchEscape = Math.abs(commitGoal - this.sublane) > 1;
    }
    if (this.canEnterSublane(next, allies, enemies)) {
      this.enterSublane(next, enemies);
      this.strafe(dt, enemies, allies);
      return true;
    }
    const blocker = this.blockGapCollidableInSublane(next, allies);
    if (blocker) {
      // Ahead of the blocker → ease forward; else ease back.
      const dir = this.alongSigned(blocker) < 0 ? 1 : -1;
      return this.easeAlong(dt, allies, enemies, dir, false);
    }
    return false;
  }

  /**
   * True when a committed auto-switch goal is still a valid gap (no
   * blockGap collidable at our station on that row).
   */
  switchGoalStillValid(goal, allies) {
    if (goal == null || goal === this.sublane) {
      return false;
    }
    const count = Path.sublaneCount(this.lane);
    if (goal < 0 || goal >= count) {
      return false;
    }
    return !this.sublaneHasCollidableInBlockGap(goal, allies);
  }

  /**
   * Step one sublane toward prefer / a committed switch, or pick the best
   * open row around a line (look-ahead). Stick to the committed goal so
   * units do not bounce between rows.
   */
  pursueSublaneChange(dt, allies, enemies, prefer) {
    let goal = prefer;
    if (goal === undefined || goal === null) {
      if (this.switch != null && this.switch !== this.sublane
        && this.switchGoalStillValid(this.switch, allies)) {
        goal = this.switch;
      } else {
        goal = this.pickBestSwitchSublane(allies);
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
   * Closest living enemy inside a world-space circle. Lane and sublane
   * do not matter. Units locked in melee are not targeted until they
   * leave it. Except skirmishers/rifles, units will not fire at officers
   * while any other target (enemy unit or keep) is in full shooting
   * range. The enemy keep is a valid target when no unit is closer.
   */
  nearestTarget(enemies, maxRange, allies, enemySide) {
    const range = maxRange === undefined ? this.attackRange() : maxRange;
    const fullRange = this.attackRange();
    // Rifles keep type "skirmisher", so they may snipe officers too.
    const shyOfOfficers = this.type !== "skirmisher";
    let best = null;
    let bestD = Infinity;
    let bestOfficer = null;
    let bestOfficerD = Infinity;
    let otherInFullRange = false;
    for (let i = 0; i < enemies.length; i += 1) {
      const other = enemies[i];
      if (other.hp <= 0) {
        continue;
      }
      if (allies && other.isInMelee(allies)) {
        continue;
      }
      const d = distance(this, other);
      if (shyOfOfficers && other.type !== "officer" && d <= fullRange) {
        otherInFullRange = true;
      }
      if (d > range) {
        continue;
      }
      if (other.type === "officer" && shyOfOfficers) {
        if (d < bestOfficerD) {
          bestOfficerD = d;
          bestOfficer = other;
        }
        continue;
      }
      if (d < bestD) {
        bestD = d;
        best = other;
      }
    }
    if (
      shyOfOfficers &&
      !otherInFullRange &&
      enemySide &&
      enemySide.capitalHP > 0 &&
      distance(this, enemySide.capital) <= fullRange
    ) {
      otherInFullRange = true;
    }
    if (!best && !(shyOfOfficers && otherInFullRange)) {
      best = bestOfficer;
    }
    if (!best && enemySide && enemySide.capitalHP > 0) {
      const d = distance(this, enemySide.capital);
      if (d <= range) {
        return enemySide;
      }
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

  /** Apply incoming damage and spawn a hit splat over this troop. */
  takeDamage(amount, kind) {
    const hit = truncateDamage(this.side.mitigate(amount, this.onQuarterLine()));
    this.hp -= hit;
    this.flash = 0.12;
    this.side.sim.spawnSplat(this.x, this.y, hit, kind);
    if (kind !== "melee") {
      this.fatigue = Math.min(this.maxFatigue, this.fatigue + CONFIG.fatigueOnShot);
      if (this.order === null || this.order === "charge") {
        this.shotSlow = this.shotSlowSpeed;
      }
    }
    this.tryBreak();
  }

  /** True when this body overlaps this side's fort line. */
  onQuarterLine() {
    return touchesQuarterLine(this);
  }

  /**
   * Melee troops deal more while formed: +20% per other troop in line.
   */
  lineDamageScale(allies) {
    if (!this.lineBonus) {
      return 1;
    }
    const mates = this.lineGroup(allies || []).length - 1;
    return 1 + Math.max(0, mates) * this.lineBonus;
  }

  /**
   * Outgoing damage: ranged uses falloff; melee uses its own base.
   * Charge, flanking, and formed-line bonuses still multiply after that.
   * Returns the full float; armor + truncateDamage apply on the hit.
   */
  attackDamage(target, kind, allies) {
    const strike = kind || "shoot";
    let damage = this.baseAttackDamage(strike);
    if (strike !== "melee") {
      const dest = target.capital ? target.capital : target;
      const range = this.attackRange();
      const d = distance(this, dest);
      const falloff = Math.max(CONFIG.minDamageFactor, 1 - d / Math.max(range, 1));
      damage *= falloff;
    }
    if (this.order === "charge") {
      damage *= this.chargeMultiplier;
    }
    if (target.lane && this.isFlanking(target) && target.variant !== "grenadier") {
      damage *= this.flankMultiplier;
    }
    if (target.type === "officer") {
      damage *= this.officerDamageMultiplier;
    }
    damage *= this.lineDamageScale(allies);
    damage *= this.side.damageScale();
    damage *= this.auraAttack;
    const roll = 1 + (Math.random() * 2 - 1) * CONFIG.damageVariance;
    damage *= roll;
    return damage;
  }

  /** Ranged or melee base from this unit's own stats. */
  baseAttackDamage(kind) {
    return kind === "melee" ? this.meleeDamage : this.rangedDamage;
  }

  /** Fire a shell that ignores bodies between this unit and its target. */
  fire(target, allies, projectiles, kind) {
    const strike = kind || "shoot";
    if (allies && this.collidingAlly(allies)) {
      return;
    }
    if (strike !== "melee" && allies && target.isInMelee && target.isInMelee(allies)) {
      return;
    }
    if (strike === "melee") {
      this.side.sim.emitSound({ type: "melee" });
    } else {
      this.side.sim.emitSound({
        type: "shoot",
        lane: this.lane,
        sublane: this.sublane,
        unitType: this.type,
        sideId: this.side.id,
      });
    }
    projectiles.push(new Projectile(
      this.x,
      this.y,
      target,
      this.attackDamage(target, strike, allies),
      allies,
      strike,
      this.type,
      this.side.sim,
      {
        speed: this.projectileSpeed,
        size: this.projectileSize,
        color: this.projectileColor,
        splash: this.splash,
        splashWholeLine: this.splashWholeLine,
      },
    ));
    this.cooldown = this.strikeDelay(strike);
    this.flash = 0.12;
  }

  /**
   * One unit decision: finish a lane change first, then shoot or swing,
   * then start a slide toward a side enemy or around a blocker, or march.
   */
  update(dt, allies, enemies, enemySide, projectiles) {
    if (this.cooldown > 0) {
      this.cooldown -= dt;
    }
    if (this.flash > 0) {
      this.flash -= dt;
    }
    if (this.shotSlow > 0) {
      this.shotSlow -= dt;
    }

    this.tickFatigue(dt, enemies);
    this.releaseHeldOrder(enemies);

    // Ended pass-through (fall back/retreat, cavalry charge, skirmish
    // advance, …) while stacked: peel before acting on the new order.
    if (!this.peelingFromPassThrough && this.gainedCollisionWhileOverlapping(allies)) {
      this.peelingFromPassThrough = true;
      this.peelDir = 0;
    }
    // Back in a full pass-through: no need to peel.
    if (this.order === "fallback" || this.order === "retreat"
      || (this.isCavalry() && this.order === "charge")) {
      this.peelingFromPassThrough = false;
      this.peelDir = 0;
    }
    this.prevCollisionOrder = this.order;

    // Gained collision while stacked: ease back until clear before any order.
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

    this.takeReformFromBehind(allies);
    this.tryJoinAhead(allies);

    // In melee a unit holds still, unless it is sliding to a non-adjacent row.
    const meleeLock = this.isInMelee(enemies) && !this.switchEscape;
    if (this.strafing && !meleeLock && this.strafe(dt, enemies, allies)) {
      return;
    }

    const laneMove = meleeLock ? "none" : this.followLaneOrder(dt, allies, enemies);
    if (laneMove === "stepping") {
      return;
    }

    // Stacked on a colliding friendly: peel or hold — no fire or melee.
    if (this.resolveAllyCollision(dt, allies, enemies)) {
      return;
    }

    const contact = this.collidingEnemy(enemies);
    const target = this.nearestTarget(
      enemies,
      this.shootRange(allies, enemies, enemySide),
      allies,
      enemySide,
    );
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
      const wasMelee = this.isInMelee(enemies);
      if (contact && this.fightsMelee) {
        if (this.cooldown <= 0) {
          this.fire(contact, allies, projectiles, "melee");
        }
      } else if (target && this.mayShoot(allies, enemies, enemySide)) {
        if (this.cooldown <= 0) {
          this.fire(target, allies, projectiles, "shoot");
        }
      }
      this.marchAlong(dt, allies, enemies, -1);
      if (wasMelee && !this.isInMelee(enemies)) {
        this.order = "retreat";
        this.broken = false;
        this.fallbackLeavesMelee = false;
        this.orderHeld = false;
        this.heldOrder = null;
      }
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
      if (laneMove === "waiting" || this.reformHold
        || this.reformSquaredInRange(allies, enemies, enemySide)) {
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
      const reformProgress = Math.min(1, this.progress + (reformSpeed * dt) / this.pathLength);
      const reformNext = Path.pointAt(this.points, reformProgress);
      if (this.overlapsEnemyAt(reformNext.x, reformNext.y, enemies)) {
        return;
      }
      this.progress = reformProgress;
      this.syncPosition();
      this.tryJoinAhead(allies);
      return;
    }

    if (!charging && target && this.mayShoot(allies, enemies, enemySide)) {
      if (this.cooldown <= 0) {
        this.fire(target, allies, projectiles, "shoot");
      }
      return;
    }

    if (laneMove === "waiting") {
      return;
    }

    if (halted) {
      return;
    }

    const sideEnemy = this.nearestParallel(enemies);
    if (sideEnemy) {
      if (sideEnemy.sublane !== this.sublane
        && !this.sublaneHasCollidableInLine(sideEnemy.sublane, allies)) {
        this.enterSublane(sideEnemy.sublane, enemies);
      }
      this.strafe(dt, enemies, allies);
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
      this.pursueSublaneChange(dt, allies, enemies);
      return;
    }

    if (this.lineIsHolding(allies, enemies, enemySide)) {
      return;
    }

    const speed = this.marchSpeed(allies);
    const nextProgress = Math.min(1, this.progress + (speed * dt) / this.pathLength);
    const next = Path.pointAt(this.points, nextProgress);
    if (this.overlapsEnemyAt(next.x, next.y, enemies)) {
      return;
    }
    this.progress = nextProgress;
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
 * Light infantry. Long range, light hits. While advancing they walk
 * through non-skirmish-like friendlies. Same click orders as a troop.
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
 * twice the walk speed. Charge speed uses their own chargeSpeed (usually 1).
 * Their own order picks fallback, charge, or reform from nearby troops.
 */
class Dragoon extends Unit {
  constructor(id, side, lane, sublane) {
    super(id, side, lane, sublane);
    this.type = "dragoon";
    this.applyStats(UNIT_STATS.dragoon);
  }

  /**
   * Alternate orders: no troop ahead stays on advance; no troop nearby
   * falls back; an enemy nearby charges; a troop behind reforms.
   */
  supportOrder(allies, foes) {
    const range = CONFIG.dragoonSupportRange;
    if (this.kindAhead(allies, "troop")) return null;
    if (!this.kindNear(allies, "troop", range)) return "fallback";
    if (this.enemyNear(foes, range)) return "charge";
    if (this.kindBehind(allies, "troop", range)) return "reform";
    return null;
  }

  kindAhead(allies, type) {
    for (let i = 0; i < allies.length; i += 1) {
      const ally = allies[i];
      if (ally.hp <= 0 || ally === this || ally.type !== type) continue;
      if (ally.lane !== this.lane) continue;
      if (this.alongSigned(ally) > 0) return true;
    }
    return false;
  }

  kindNear(allies, type, range) {
    for (let i = 0; i < allies.length; i += 1) {
      const ally = allies[i];
      if (ally.hp <= 0 || ally === this || ally.type !== type) continue;
      if (distance(this, ally) <= range) return true;
    }
    return false;
  }

  kindBehind(allies, type, range) {
    for (let i = 0; i < allies.length; i += 1) {
      const ally = allies[i];
      if (ally.hp <= 0 || ally === this || ally.type !== type) continue;
      if (this.alongSigned(ally) >= 0) continue;
      if (distance(this, ally) <= range) return true;
    }
    return false;
  }

  enemyNear(foes, range) {
    for (let i = 0; i < foes.length; i += 1) {
      const foe = foes[i];
      if (foe.hp <= 0) continue;
      if (distance(this, foe) <= range) return true;
    }
    return false;
  }
}

/**
 * Field gun. Fires over the line and splashes the next row.
 * Charge is a push: no firing and no melee.
 */
class Cannon extends Unit {
  constructor(id, side, lane, sublane) {
    super(id, side, lane, sublane);
    this.type = "cannon";
    this.applyStats(UNIT_STATS.cannon);
  }

  /** A charging cannon keeps marching. It does not count as opening fire. */
  isOpeningFire(enemies, allies, enemySide) {
    if (this.order === "charge") return false;
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
   * Lower fatigue on nearby teammates. Ahead of an ally doubles the rate.
   * A color guard also restores that much health.
   * Does not restore this officer.
   */
  restoreNearby(allies, dt) {
    if (!(this.restoreRange > 0) || !(this.restoreRate > 0) || this.hp <= 0) {
      return;
    }
    for (let i = 0; i < allies.length; i += 1) {
      const ally = allies[i];
      if (ally === this || ally.hp <= 0) continue;
      if (distance(this, ally) > this.restoreRange) continue;
      const rate = ally.alongSigned(this) > 0
        ? this.restoreRate * 2
        : this.restoreRate;
      const step = rate * dt;
      ally.fatigue = Math.max(0, ally.fatigue - step);
      if (this.restoreHealth) this.restoreHealthTo(ally, step);
    }
  }

  /**
   * The same restore step is also health. A + splat appears once a
   * whole point has landed.
   */
  restoreHealthTo(ally, amount) {
    if (!(amount > 0) || ally.hp >= ally.maxHp) return;
    const before = ally.hp;
    ally.hp = Math.min(ally.maxHp, ally.hp + amount);
    const gained = ally.hp - before;
    if (!(gained > 0) || !this.side || !this.side.sim) return;
    ally.healBank = (ally.healBank || 0) + gained;
    if (ally.healBank < 1) return;
    const shown = Math.floor(ally.healBank);
    ally.healBank -= shown;
    this.side.sim.spawnSplat(ally.x, ally.y, shown, "heal");
  }

  update(dt, allies, enemies, enemySide, projectiles) {
    super.update(dt, allies, enemies, enemySide, projectiles);
    this.restoreNearby(allies, dt);
  }
}

/** Troop alternate: tougher body; ignores bonus flanking damage. */
class Grenadier extends Troop {
  constructor(id, side, lane, sublane) {
    super(id, side, lane, sublane);
    this.variant = "grenadier";
    this.alternate = true;
    this.applyStats(UNIT_STATS.grenadier);
  }
}

/** Skirmisher alternate: longer reach, harder shot, slower reload. */
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
   * Closest living non-officer in each row inside maxRange. Units locked
   * in melee are skipped. A row is a lane + sublane pair.
   */
  cannisterTargets(enemies, allies, maxRange) {
    const best = {};
    for (let i = 0; i < enemies.length; i += 1) {
      const other = enemies[i];
      if (other.hp <= 0 || other.type === "officer") {
        continue;
      }
      if (allies && other.isInMelee(allies)) {
        continue;
      }
      const d = distance(this, other);
      if (d > maxRange) {
        continue;
      }
      const key = `${other.lane}:${other.sublane}`;
      const prev = best[key];
      if (!prev || d < prev.d) {
        best[key] = { unit: other, d };
      }
    }
    const out = [];
    const keys = Object.keys(best);
    for (let i = 0; i < keys.length; i += 1) {
      out.push(best[keys[i]].unit);
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
    if (allies && this.collidingAlly(allies)) {
      return;
    }
    const sim = this.side.sim;
    const enemies = this.enemyTroops();
    const enemySide = this.side === sim.player ? sim.enemy : sim.player;
    const range = this.shootRange(allies || this.side.troops, enemies, enemySide);
    let targets = this.cannisterTargets(enemies, allies, range);
    if (!targets.length) {
      if (
        target
        && (!(target.isInMelee) || !allies || !target.isInMelee(allies))
      ) {
        targets = [target];
      } else {
        return;
      }
    }
    this.side.sim.emitSound({
      type: "shoot",
      lane: this.lane,
      sublane: this.sublane,
      unitType: this.type,
      sideId: this.side.id,
    });
    for (let i = 0; i < targets.length; i += 1) {
      const aim = targets[i];
      projectiles.push(new Projectile(
        this.x,
        this.y,
        aim,
        this.attackDamage(aim, strike, allies),
        allies,
        strike,
        this.type,
        this.side.sim,
        {
          speed: this.projectileSpeed,
          size: this.projectileSize,
          color: this.projectileColor,
          splash: 0,
          splashWholeLine: false,
        },
      ));
    }
    this.cooldown = this.strikeDelay(strike);
    this.flash = 0.12;
  }
}

/**
 * Officer alternate: fatigue restore also heals the same amount,
 * plus attack and speed to nearby allies within buffRange.
 * Units behind this color are restored twice as fast.
 */
class ColorGuard extends Officer {
  constructor(id, side, lane, sublane) {
    super(id, side, lane, sublane);
    this.variant = "colorGuard";
    this.alternate = true;
    this.applyStats(UNIT_STATS.colorGuard);
  }

  /** Raise nearby allies' attack and walk auras (does not buff self). */
  buffNearby(allies) {
    if (!(this.buffRange > 0) || this.hp <= 0) return;
    const attack = 1 + this.attackBuff;
    const speed = 1 + this.speedBuff;
    for (let i = 0; i < allies.length; i += 1) {
      const ally = allies[i];
      if (ally === this || ally.hp <= 0) continue;
      if (distance(this, ally) > this.buffRange) continue;
      if (attack > ally.auraAttack) ally.auraAttack = attack;
      if (speed > ally.auraSpeed) ally.auraSpeed = speed;
    }
  }

  update(dt, allies, enemies, enemySide, projectiles) {
    super.update(dt, allies, enemies, enemySide, projectiles);
    this.buffNearby(allies);
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
   * Closest and farthest towns are speed, the next pair are armor,
   * and the middle town is damage.
   */
  upgradeKind() {
    const last = CONFIG.checkpointCount - 1;
    const dist = Math.min(this.index, last - this.index);
    if (dist === 0) {
      return "speed";
    }
    if (dist === 1) {
      return "armor";
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

  /** Incoming damage multiplier after armor ranks. */
  armorReduction() {
    return Math.min(CONFIG.armorCap, CONFIG.armorPerUpgrade * this.upgrades.armor);
  }

  /** Apply armor (plus cover on this side's fort line). Caller truncates. */
  mitigate(amount, cover) {
    let reduction = this.armorReduction();
    if (cover) {
      reduction = Math.min(CONFIG.armorCap, reduction + CONFIG.quarterArmor);
    }
    return amount * (1 - reduction);
  }

  /** Outgoing damage multiplier from damage ranks. */
  damageScale() {
    return 1 + CONFIG.damageUpgradeAmount * this.upgrades.damage;
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

  /**
   * Each unlock adds +1gp/s times the number of unlocked banks.
   * One bank is +1, two is +1+2, three is +1+2+3.
   */
  bankIncome() {
    const n = this.banks;
    return CONFIG.bankIncomePer * (n * (n + 1)) / 2;
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
   * Closest enemy troop in cannon range. Units locked in melee are skipped.
   * Officers are ignored while any other enemy is in full cannon range.
   */
  capitalTarget(enemies, allies) {
    let best = null;
    let bestD = Infinity;
    let bestOfficer = null;
    let bestOfficerD = Infinity;
    for (let i = 0; i < enemies.length; i += 1) {
      const other = enemies[i];
      if (other.hp <= 0) {
        continue;
      }
      if (other.isInMelee(allies)) {
        continue;
      }
      const d = distance(this.capital, other);
      if (d > CONFIG.capitalCannonRange) {
        continue;
      }
      if (other.type === "officer") {
        if (d < bestOfficerD) {
          bestOfficerD = d;
          bestOfficer = other;
        }
        continue;
      }
      if (d < bestD) {
        bestD = d;
        best = other;
      }
    }
    return best || bestOfficer;
  }

  /** Cannon-style shell at double cannon damage, with falloff and variance. */
  fireCapital(target, allies, projectiles) {
    if (allies && target.isInMelee && target.isInMelee(allies)) {
      return;
    }
    const dest = target.capital ? target.capital : target;
    const d = distance(this.capital, dest);
    let damage = CONFIG.capitalCannonDamage;
    const falloff = Math.max(
      CONFIG.minDamageFactor,
      1 - d / Math.max(CONFIG.capitalCannonRange, 1),
    );
    damage *= falloff;
    damage *= this.damageScale();
    damage *= 1 + (Math.random() * 2 - 1) * CONFIG.damageVariance;
    const shell = UNIT_STATS.cannon;
    projectiles.push(new Projectile(
      this.capital.x,
      this.capital.y,
      target,
      damage,
      allies,
      "shoot",
      "cannon",
      this.sim,
      {
        speed: shell.projectileSpeed,
        size: shell.projectileSize,
        color: shell.projectileColor,
        splash: shell.splash,
      },
    ));
    this.sim.emitSound({ type: "shoot", lane: "top", sublane: 2, unitType: "cannon", sideId: this.id });
    this.shotCooldown = CONFIG.capitalCannonAttackCooldown
      / (1 + CONFIG.speedAttackFactor * this.upgrades.speed);
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
      const solo = Boolean(cmd.solo);
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
          troop.issueLineSwitch(dir, side.troops);
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
      topCenter: this.topLaneCenterT(),
      bottomCenter: this.bottomLaneCenterT(),
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
        shotSlow: troop.shotSlow,
        priorOrder: troop.priorOrder === undefined ? null : troop.priorOrder,
        radius: troop.radius,
        x: troop.x,
        y: troop.y,
        order: troop.order,
        flash: troop.flash,
        progress: troop.progress,
      })),
    };
  }


  /**
   * Apply the live lane-center splits to gold and land income, then
   * award both for this step.
   */
  refreshIncomes() {
    const top = this.topLaneCenterT();
    const bottom = this.bottomLaneCenterT();
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

  /** Move, fight, capture, and drop dead troops for one side. */
  updateSide(side, opponents, enemySide, dt) {
    for (let i = 0; i < side.troops.length; i += 1) {
      const troop = side.troops[i];
      troop.auraAttack = 1;
      troop.auraSpeed = 1;
      troop.reformHold = troop.hp > 0 && troop.reformShouldStop(side.troops);
    }
    for (let i = 0; i < side.troops.length; i += 1) {
      const troop = side.troops[i];
      if (troop.hp <= 0) {
        continue;
      }
      troop.update(dt, side.troops, opponents, enemySide, this.projectiles);
      troop.reformHold = false;
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
      total += side.unitCost(troop.type);
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
