import { CONFIG } from "../shared/config.js";
import { Path, distance, touchesQuarterLine } from "../shared/path.js";

/**
 * Shot fired by a troop or cannon. Travels over intervening units and
 * only collides with its chosen target (or the target keep).
 */
class Projectile {
  constructor(x, y, target, damage, allies, kind, sourceType, sim) {
    this.x = x;
    this.y = y;
    this.target = target;
    this.damage = damage;
    this.allies = allies;
    this.kind = kind || "shoot";
    this.sourceType = sourceType || "melee";
    this.sim = sim;
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
    const step = CONFIG.projectileSpeed * dt;
    if (d <= step + CONFIG.projectileRadius) {
      if (this.target.capitalHP !== undefined) {
        const hit = this.target.mitigate(this.damage);
        this.target.capitalHP -= hit;
        const keep = this.target.capital;
        this.sim.spawnSplat(keep.x, keep.y, hit, this.kind);
      } else if (this.kind === "melee" || !this.target.isInMelee(this.allies)) {
        this.target.takeDamage(this.damage, this.kind);
        this.splashCannonLine();
      }
      this.alive = false;
      return;
    }
    this.x += ((dest.x - this.x) / d) * step;
    this.y += ((dest.y - this.y) / d) * step;
  }

  /**
   * Cannon shells also hit units one row over if they share the
   * target's line. Those neighbors take half the shell's damage.
   */
  splashCannonLine() {
    if (this.sourceType !== "cannon" || !this.target.side) {
      return;
    }
    const splash = Math.round(this.damage / 2);
    if (splash <= 0) {
      return;
    }
    const hit = this.target;
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

  /** Yellow for shots, red for melee. */
  fillColor() {
    return this.kind === "melee" ? CONFIG.colors.splatMelee : CONFIG.colors.splatShoot;
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
 * and fires visible shots (skirmishers reach farther with light hits;
 * dragoons flank harder; cannons reach farther).
 */
class Troop {
  constructor(id, side, lane, sublane, type) {
    this.id = id;
    this.side = side;
    this.lane = lane;
    this.sublane = sublane;
    this.type = type;
    this.hp = this.maxHP();
    this.progress = 0;
    this.cooldown = 0;
    this.flash = 0;
    this.strafing = false;
    this.order = null;
    this.reformNeedsAlign = false;
    this.shotSlow = 0;
    this.wantedSublane = null;
    this.applyPath();
    const spawn = Path.pointAt(this.points, 0);
    this.x = spawn.x;
    this.y = spawn.y;
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

  /**
   * Ally ahead on an adjacent row who is not yet in this line. A
   * reforming shooter walks up to them to claim the line-damage bonus.
   */
  reformTargetAhead(allies) {
    if (this.order !== "reform") {
      return null;
    }
    const ahead = this.nextAheadOtherSublane(allies);
    if (!ahead || this.withinLine(ahead)) {
      return null;
    }
    return ahead;
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
   * First ally behind the whole line (any sublane), not a line-mate.
   * The line slows together so this troop can catch up.
   */
  nextBehindLine(line, allies) {
    const rear = this.sortRearToFront(line)[0];
    const inLine = {};
    for (let i = 0; i < line.length; i += 1) {
      inLine[line[i].id] = true;
    }
    let best = null;
    let bestGap = Infinity;
    for (let i = 0; i < allies.length; i += 1) {
      const ally = allies[i];
      if (inLine[ally.id] || ally.hp <= 0 || ally.lane !== this.lane) {
        continue;
      }
      if (!this.sameLineType(ally)) {
        continue;
      }
      let nextToLine = false;
      for (let k = 0; k < line.length; k += 1) {
        if (line[k].adjacentRow(ally)) {
          nextToLine = true;
          break;
        }
      }
      if (!nextToLine) {
        continue;
      }
      const along = rear.alongSigned(ally);
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
   * An advancing troop that becomes perfectly parallel with another
   * absorbs that troop or line's order. Chargers keep going to flank.
   */
  tryJoinAhead(allies) {
    if (this.order === "charge" || this.order === "fallback") {
      return;
    }
    for (let i = 0; i < allies.length; i += 1) {
      const ally = allies[i];
      if (ally === this || ally.hp <= 0 || ally.lane !== this.lane) {
        continue;
      }
      if (!this.adjacentRow(ally)) {
        continue;
      }
      if (!this.sameLineType(ally)) {
        continue;
      }
      if (!ally.order) {
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
      const theirs = ally.lineGroup(allies);
      let alreadyIn = false;
      let rowTaken = false;
      for (let t = 0; t < theirs.length; t += 1) {
        if (theirs[t] === this) {
          alreadyIn = true;
        } else if (theirs[t].sublane === this.sublane) {
          rowTaken = true;
        }
      }
      if (rowTaken || (!alreadyIn && theirs.length >= Path.sublaneCount(this.lane))) {
        continue;
      }
      const group = this.lineGroup(allies);
      for (let g = 0; g < group.length; g += 1) {
        group[g].order = ally.order;
        group[g].reformNeedsAlign = ally.reformNeedsAlign;
      }
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
    if (this.type === "cannon") {
      return CONFIG.cannonRadius;
    }
    if (this.type === "skirmisher") {
      return CONFIG.skirmisherRadius;
    }
    return CONFIG.troopRadius;
  }

  maxHP() {
    return this.type === "skirmisher" ? CONFIG.skirmisherHP : CONFIG.troopHP;
  }

  /**
   * True when this melee troop is locked in body contact with an enemy
   * troop. Cannons are never in melee; overlapping a cannon is not melee.
   */
  isInMelee(foes) {
    if (this.type === "cannon") {
      return false;
    }
    const foe = this.collidingEnemy(foes);
    return Boolean(foe && foe.type !== "cannon");
  }

  /** True if any member of this line is in melee. Orders are locked then. */
  lineInMelee(allies, enemies) {
    if (this.type === "cannon") {
      return false;
    }
    const group = this.lineGroup(allies);
    for (let i = 0; i < group.length; i += 1) {
      if (group[i].type !== "cannon" && group[i].collidingEnemy(enemies)) {
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
   */
  lineIsHolding(allies, enemies, enemySide) {
    if (this.order === "charge" || this.order === "fallback") {
      return false;
    }
    if (this.order === "reform" && this.reformNeedsAlign) {
      return false;
    }
    const line = this.lineGroup(allies);
    for (let i = 0; i < line.length; i += 1) {
      const mate = line[i];
      if (mate === this || !this.isParallelTo(mate)) {
        continue;
      }
      if (mate.isOpeningFire(enemies, allies, enemySide)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Reforming troops already square with the rear wait so the rest can
   * catch up. The rearmost never waits. A finished line walks at half speed.
   */
  atFrontOfLine(allies) {
    if (this.order !== "reform" || !this.reformNeedsAlign) {
      return false;
    }
    const line = this.lineGroup(allies);
    if (line.length < 2) {
      return false;
    }
    const rear = this.sortRearToFront(line)[0];
    if (rear === this) {
      return false;
    }
    return this.isReformSquare(rear);
  }

  /** Station error still treated as a finished reform square. */
  reformSlack() {
    const px = 0.5;
    return this.lane === "bottom"
      ? Path.arcDegrees(px, Path.bottomMidRadius())
      : px;
  }

  /**
   * Reform keeps closing a stagger until the stations match. Combat
   * parallel is looser, so a halted line can still need this pass.
   */
  isReformSquare(other) {
    return Math.abs(this.station() - other.station()) <= this.reformSlack();
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

  /** True when another reforming neighbor already shares this station. */
  inPerfectLine(formation) {
    for (let i = 0; i < formation.length; i += 1) {
      if (formation[i] !== this && this.isReformSquare(formation[i])) {
        return true;
      }
    }
    return false;
  }

  /**
   * Forward-most station where at least two reforming neighbors are
   * already square. Null when the formation is still fully staggered.
   */
  frontPerfectStation(formation) {
    const facing = this.side.id === "player";
    let best = null;
    for (let i = 0; i < formation.length; i += 1) {
      let paired = false;
      for (let j = 0; j < formation.length; j += 1) {
        if (i !== j && formation[i].isReformSquare(formation[j])) {
          paired = true;
          break;
        }
      }
      if (!paired) {
        continue;
      }
      const station = formation[i].station();
      if (best === null || (facing ? station > best : station < best)) {
        best = station;
      }
    }
    return best;
  }

  /** True when this troop still has to walk up to station. */
  isBehindStation(station) {
    const delta = this.station() - station;
    if (Math.abs(delta) <= this.reformSlack()) {
      return false;
    }
    return this.side.id === "player" ? delta < 0 : delta > 0;
  }

  /**
   * A perfect reforming rank holds. Only troops behind it may walk
   * forward. Until any pair is square, the line may still close up.
   */
  reformMayAdvance(allies) {
    if (this.order !== "reform") {
      return true;
    }
    const formation = this.reformFormation(allies);
    if (formation.length < 2) {
      return true;
    }
    const front = this.frontPerfectStation(formation);
    if (front === null) {
      return true;
    }
    if (this.inPerfectLine(formation)) {
      return false;
    }
    return this.isBehindStation(front);
  }

  /** True when this reforming troop is behind a perfect rank. */
  behindPerfectReform(allies) {
    if (this.order !== "reform" || !this.reformMayAdvance(allies)) {
      return false;
    }
    const formation = this.reformFormation(allies);
    const front = this.frontPerfectStation(formation);
    return front !== null && this.isBehindStation(front);
  }

  /**
   * True when this unit's line is staggered, or a lone leader has an
   * adjacent ally behind who is not yet square.
   */
  needsLineAlign(allies) {
    const group = this.lineGroup(allies);
    if (group.length >= 2) {
      const rear = this.sortRearToFront(group)[0];
      for (let i = 0; i < group.length; i += 1) {
        if (!group[i].isReformSquare(rear)) {
          return true;
        }
      }
      return false;
    }
    const partner = this.nextBehindOtherSublane(allies);
    return Boolean(partner && !this.isReformSquare(partner));
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

  /** Put this line on reform without cycling through halt. */
  startReform(allies) {
    const group = this.lineGroup(allies);
    const needsAlign = this.needsLineAlign(allies);
    for (let i = 0; i < group.length; i += 1) {
      group[i].order = "reform";
      group[i].reformNeedsAlign = needsAlign;
    }
  }

  /**
   * Left-click: halt, or reform if already halted, or resume a normal
   * advance if reforming. Locked while the line is in melee.
   */
  issueOrder(allies, enemies) {
    if (this.lineInMelee(allies, enemies)) {
      return;
    }
    const next = this.order === "halt"
      ? "reform"
      : this.order === "reform"
        ? null
        : "halt";
    const group = this.lineGroup(allies);
    const needsAlign = next === "reform" && this.needsLineAlign(allies);
    for (let i = 0; i < group.length; i += 1) {
      group[i].order = next;
      group[i].reformNeedsAlign = needsAlign;
    }
  }

  /**
   * Drag forward: charge (seek melee, no shooting until contact).
   * Cannons push forward without firing. A second drag keeps charging.
   * Locked while in melee.
   */
  issueCharge(allies, enemies) {
    if (this.lineInMelee(allies, enemies) || this.order === "charge") {
      return;
    }
    const group = this.lineGroup(allies);
    for (let i = 0; i < group.length; i += 1) {
      group[i].order = "charge";
      group[i].reformNeedsAlign = false;
      group[i].wantedSublane = null;
    }
  }

  /**
   * Drag back: walk backward at reform speed. Allowed in melee so a
   * line can disengage. A second drag keeps falling back.
   */
  issueFallback(allies) {
    if (this.order === "fallback") {
      return;
    }
    const group = this.lineGroup(allies);
    for (let i = 0; i < group.length; i += 1) {
      group[i].order = "fallback";
      group[i].reformNeedsAlign = false;
      group[i].wantedSublane = null;
    }
  }

  /**
   * Once a reforming line is square, stop the catch-up speeds but keep
   * the reform order. The next click is what advances. Halt only ends
   * on another click.
   */
  clearOrderIfDone(allies) {
    if (this.order !== "reform" || !this.reformNeedsAlign) {
      return;
    }
    const line = this.lineGroup(allies);
    if (line.length >= 2) {
      const rear = this.sortRearToFront(line)[0];
      for (let i = 0; i < line.length; i += 1) {
        if (!line[i].isReformSquare(rear)) {
          return;
        }
      }
      for (let i = 0; i < line.length; i += 1) {
        line[i].reformNeedsAlign = false;
      }
      return;
    }
    const partner = this.nextBehindOtherSublane(allies);
    if (partner && this.isReformSquare(partner)) {
      this.reformNeedsAlign = false;
    }
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
    return CONFIG.shotSlowFactor;
  }

  /** Dragoons always walk faster than melee troops. */
  dragoonSpeedScale() {
    return this.type === "dragoon" ? CONFIG.dragoonOpenSpeed : 1;
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

  /** Troops and skirmishers walk faster while charging near an enemy. */
  chargeSpeedScale() {
    if (this.order !== "charge") return 1;
    if (this.type === "cannon" || this.type === "dragoon") return 1;
    if (!this.nearEnemy(CONFIG.chargeSpeedRange)) return 1;
    return CONFIG.chargeSpeedFactor;
  }

  /**
   * Reform speeds. A staggered line compounds (last full, each ahead at
   * half the next behind) until a rank is square. A perfect rank holds.
   * A lone troop uses half the next rear ally. Bottom-lane rings also
   * apply ringSpeedScale.
   */
  marchSpeed(allies) {
    const scale = this.ringSpeedScale() * this.shotSlowScale() * this.dragoonSpeedScale(allies);
    const base = CONFIG.troopSpeed * this.side.speedMultiplier * scale;
    this.clearOrderIfDone(allies);
    if (this.order === "halt") {
      return 0;
    }
    if (this.order === "fallback") {
      return base * CONFIG.reformSpeedFactor;
    }
    if (this.order === "charge") {
      return base * this.chargeSpeedScale();
    }
    if (this.order !== "reform") {
      return base;
    }
    if (!this.reformMayAdvance(allies)) {
      return 0;
    }
    const line = this.lineGroup(allies);
    if (line.length >= 2 && this.reformNeedsAlign) {
      const ordered = this.sortRearToFront(line);
      let speed = CONFIG.troopSpeed * ordered[0].side.speedMultiplier * scale;
      for (let i = 0; i < ordered.length; i += 1) {
        if (ordered[i] === this) {
          return speed;
        }
        speed *= CONFIG.reformSpeedFactor;
      }
      return speed;
    }
    if (line.length >= 2) {
      return base * CONFIG.reformSpeedFactor;
    }
    const trailer = this.nextBehindLine(line, allies);
    if (trailer) {
      return CONFIG.troopSpeed * trailer.side.speedMultiplier * CONFIG.reformSpeedFactor * scale;
    }
    if (this.nextAheadOtherSublane(allies)) {
      return base;
    }
    const partner = this.nextBehindOtherSublane(allies);
    const ref = partner ? partner.side.speedMultiplier : this.side.speedMultiplier;
    return CONFIG.troopSpeed * ref * CONFIG.reformSpeedFactor * scale;
  }

  /** Melee reach, or the longer cannon / skirmisher reach. */
  attackRange() {
    if (this.type === "cannon") {
      return CONFIG.cannonRange;
    }
    if (this.type === "skirmisher") {
      return CONFIG.skirmisherRange;
    }
    return CONFIG.troopRange;
  }

  /** True when other, or a keep's capital, is inside melee reach. */
  insideMeleeRange(other) {
    const pos = other && other.capital ? other.capital : other;
    return distance(this, pos) <= CONFIG.troopRange;
  }

  /** Distance at which this troop may open fire on its own. */
  openFireRange() {
    return this.attackRange() * CONFIG.openFireFactor;
  }

  /**
   * True when this troop has already committed to shooting: half-range,
   * melee contact, or standing on the enemy keep. Chargers only count
   * once they are in contact.
   */
  isOpeningFire(enemies, allies, enemySide) {
    if (this.type !== "cannon" && this.collidingEnemy(enemies)) {
      return true;
    }
    if (this.order === "charge") {
      return false;
    }
    return Boolean(this.nearestTarget(enemies, this.openFireRange(), allies, enemySide));
  }

  /**
   * True when this troop may shoot: it opened on its own, or it is in
   * line with someone who did and still has a full-range target.
   */
  mayShoot(allies, enemies, enemySide) {
    if (this.isOpeningFire(enemies, allies, enemySide)) {
      return true;
    }
    if (!this.nearestTarget(enemies, undefined, allies, enemySide)) {
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
  strikeDelay() {
    const base = this.type === "cannon"
      ? CONFIG.cannonAttackCooldown
      : this.type === "skirmisher"
        ? CONFIG.skirmisherAttackCooldown
        : CONFIG.troopAttackCooldown;
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
    const step = CONFIG.troopSpeed * this.side.speedMultiplier
      * this.shotSlowScale() * this.dragoonSpeedScale(allies || []) * charge * dt;
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

  /** True when this row is free of friends and the landing point is empty. */
  canEnterSublane(sublane, allies, enemies) {
    const count = Path.sublaneCount(this.lane);
    if (sublane === this.sublane || sublane < 0 || sublane >= count) {
      return false;
    }
    if (this.sublaneOccupied(sublane, allies)) {
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
  issueLaneChange(sublane, allies, enemies) {
    if (allies && enemies && this.lineInMelee(allies, enemies)) {
      return;
    }
    const count = Path.sublaneCount(this.lane);
    if (sublane < 0 || sublane >= count || sublane === this.sublane) {
      this.wantedSublane = null;
      return;
    }
    this.wantedSublane = sublane;
  }

  /**
   * Step toward wantedSublane. Returns "stepping", "waiting" if blocked,
   * or "none" when there is no pending row change.
   */
  followLaneOrder(dt, allies, enemies) {
    if (this.wantedSublane === null) {
      return "none";
    }
    if (this.lineInMelee(allies, enemies)) {
      this.wantedSublane = null;
      return "none";
    }
    if (this.wantedSublane === this.sublane) {
      if (!this.strafing) {
        this.wantedSublane = null;
      }
      return "none";
    }
    if (this.stepTowardSublane(this.wantedSublane, allies, enemies)) {
      this.strafe(dt, enemies, allies);
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
   * Step toward a preferred row, or the nearest free neighbor, when a
   * charger cannot keep walking forward.
   */
  tryChargeSidestep(dt, allies, enemies, prefer) {
    if (prefer !== undefined && this.stepTowardSublane(prefer, allies, enemies)) {
      this.strafe(dt, enemies, allies);
      return true;
    }
    const count = Path.sublaneCount(this.lane);
    let best = null;
    let bestDist = Infinity;
    for (let s = 0; s < count; s += 1) {
      if (!this.canEnterSublane(s, allies, enemies)) {
        continue;
      }
      const d = Math.abs(s - this.sublane);
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    if (best === null) {
      return false;
    }
    this.stepTowardSublane(best, allies, enemies);
    this.strafe(dt, enemies, allies);
    return true;
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
   * Friendly cannons are not solid to troops. Skirmishers pass through
   * all teammates. Troops still block troops, and cannons still block
   * other cannons.
   */
  blocksAlly(ally) {
    if (this.type === "skirmisher" || ally.type === "skirmisher") {
      return false;
    }
    if (ally.type === "cannon" && this.type !== "cannon") {
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

  /**
   * True if a friendly already occupies this row near our station, or is
   * currently sliding into that same stretch of the sublane.
   */
  sublaneOccupied(sublane, allies) {
    for (let i = 0; i < allies.length; i += 1) {
      const ally = allies[i];
      if (ally === this || ally.hp <= 0 || ally.lane !== this.lane) {
        continue;
      }
      if (ally.sublane !== sublane) {
        continue;
      }
      if (!this.blocksAlly(ally)) {
        continue;
      }
      if (Math.abs(ally.station() - this.station()) < this.stationSlack("block")) {
        return true;
      }
    }
    return false;
  }

  /** Nearest open row, or null when every sublane is stacked. */
  openSublane(allies) {
    const count = Path.sublaneCount(this.lane);
    let best = null;
    let bestDist = Infinity;
    for (let s = 0; s < count; s += 1) {
      if (s === this.sublane || this.sublaneOccupied(s, allies)) {
        continue;
      }
      const d = Math.abs(s - this.sublane);
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    return best;
  }

  /**
   * Closest living enemy inside a world-space circle. Lane and sublane
   * do not matter, but units locked in melee cannot be shot. Cannons
   * also skip anyone inside melee range. The enemy keep is a valid
   * target when no unit is closer.
   */
  nearestTarget(enemies, maxRange, allies, enemySide) {
    let best = null;
    let bestD = Infinity;
    const range = maxRange === undefined ? this.attackRange() : maxRange;
    for (let i = 0; i < enemies.length; i += 1) {
      const other = enemies[i];
      if (other.hp <= 0) {
        continue;
      }
      if (allies && other.isInMelee(allies)) {
        continue;
      }
      const d = distance(this, other);
      if (this.type === "cannon" && this.insideMeleeRange(other)) {
        continue;
      }
      if (d <= range && d < bestD) {
        bestD = d;
        best = other;
      }
    }
    if (!best && enemySide && enemySide.capitalHP > 0) {
      const d = distance(this, enemySide.capital);
      if (d <= range && !(this.type === "cannon" && this.insideMeleeRange(enemySide))) {
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
    const hit = this.side.mitigate(amount, this.onQuarterLine());
    this.hp -= hit;
    this.flash = 0.12;
    this.side.sim.spawnSplat(this.x, this.y, hit, kind);
    if (kind !== "melee" && (this.order === null || this.order === "charge")) {
      this.shotSlow = CONFIG.shotSlowDuration;
    }
  }

  /** True when this body overlaps this side's fort line. */
  onQuarterLine() {
    return touchesQuarterLine(this);
  }

  /**
   * Melee troops deal more while formed: +20% per other troop in line.
   */
  lineDamageScale(allies) {
    if (this.type !== "melee") {
      return 1;
    }
    const mates = this.lineGroup(allies || []).length - 1;
    return 1 + Math.max(0, mates) * CONFIG.lineDamageBonus;
  }

  /**
   * Outgoing damage: ranged uses falloff; melee uses its own base.
   * Charge, flanking, and formed-line bonuses still multiply after that.
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
      damage *= CONFIG.doubleDamageMultiplier;
    }
    if (target.lane && this.isFlanking(target)) {
      damage *= CONFIG.doubleDamageMultiplier;
      if (this.type === "dragoon") {
        damage *= CONFIG.dragoonFlankBonus;
      }
    }
    damage *= this.lineDamageScale(allies);
    damage *= this.side.damageScale();
    const roll = 1 + (Math.random() * 2 - 1) * CONFIG.damageVariance;
    damage *= roll;
    return Math.round(damage);
  }

  /** Ranged or melee base by unit type. Cannons only have a ranged shell. */
  baseAttackDamage(kind) {
    if (this.type === "cannon") {
      return CONFIG.cannonDamage;
    }
    if (this.type === "dragoon") {
      return kind === "melee" ? CONFIG.dragoonMeleeDamage : CONFIG.dragoonRangedDamage;
    }
    if (this.type === "skirmisher") {
      return kind === "melee" ? CONFIG.skirmisherMeleeDamage : CONFIG.skirmisherRangedDamage;
    }
    return kind === "melee" ? CONFIG.troopMeleeDamage : CONFIG.troopRangedDamage;
  }

  /** Fire a shell that ignores bodies between this unit and its target. */
  fire(target, allies, projectiles, kind) {
    const strike = kind || "shoot";
    if (this.type === "cannon" && this.insideMeleeRange(target)) {
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
    ));
    this.cooldown = this.strikeDelay();
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

    this.clearOrderIfDone(allies);
    this.tryJoinAhead(allies);

    // A sidestep must finish on the new row before the unit is allowed to halt and fight.
    if (this.strafing && this.strafe(dt, enemies, allies)) {
      return;
    }

    const laneMove = this.followLaneOrder(dt, allies, enemies);
    if (laneMove === "stepping") {
      return;
    }

    const contact = this.collidingEnemy(enemies);
    const target = this.nearestTarget(enemies, undefined, allies, enemySide);
    const atKeep = this.progress >= 1;
    const charging = this.order === "charge";
    const fallingBack = this.order === "fallback";

    if (fallingBack) {
      if (contact && this.type !== "cannon") {
        if (this.cooldown <= 0) {
          this.fire(contact, allies, projectiles, "melee");
        }
      } else if (target && this.mayShoot(allies, enemies, enemySide)) {
        if (this.cooldown <= 0) {
          this.fire(target, allies, projectiles, "shoot");
        }
      }
      this.marchAlong(dt, allies, enemies, -1);
      return;
    }

    if (contact && this.type !== "cannon") {
      if (this.cooldown <= 0) {
        this.fire(contact, allies, projectiles, "melee");
      }
      return;
    }

    if (charging && this.type !== "cannon" && laneMove !== "waiting") {
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

    const catchAhead = Boolean(this.reformTargetAhead(allies));
    const inLine = this.lineGroup(allies).length >= 2;
    const forming = this.order === "reform" && this.reformNeedsAlign;
    const closingLine = forming && inLine;

    if (!charging && target && this.mayShoot(allies, enemies, enemySide)) {
      if (this.cooldown <= 0) {
        this.fire(target, allies, projectiles, "shoot");
      }
      // A perfect rank stops after the shot. Troops still behind that
      // rank keep walking, and so does a line that has not squared yet.
      if (!closingLine && !this.behindPerfectReform(allies)) {
        return;
      }
    }

    if (laneMove === "waiting") {
      return;
    }

    if (!this.reformMayAdvance(allies)) {
      return;
    }

    if (forming && !catchAhead) {
      if (this.atFrontOfLine(allies) && !this.behindPerfectReform(allies)) {
        return;
      }
    } else if (!catchAhead) {
      const sideEnemy = this.nearestParallel(enemies);
      if (sideEnemy) {
        if (sideEnemy.sublane !== this.sublane
            && !this.sublaneOccupied(sideEnemy.sublane, allies)) {
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
        const open = this.openSublane(allies);
        if (open !== null) {
          this.enterSublane(open, enemies);
          this.strafe(dt, enemies, allies);
        }
        return;
      }

      if (this.lineIsHolding(allies, enemies, enemySide) || this.atFrontOfLine(allies)) {
        return;
      }
    } else {
      for (let i = 0; i < allies.length; i += 1) {
        if (this.isBlockedBy(allies[i])) {
          return;
        }
      }
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

/**
 * A bottom-lane point that grants income to whichever side last walked through it.
 */
class Checkpoint {
  constructor(index, x, y) {
    this.index = index;
    this.x = x;
    this.y = y;
    this.owner = null;
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

  /** Apply armor (plus cover on this side's fort line), then round. */
  mitigate(amount, cover) {
    let reduction = this.armorReduction();
    if (cover) {
      reduction = Math.min(CONFIG.armorCap, reduction + CONFIG.quarterArmor);
    }
    return Math.round(amount * (1 - reduction));
  }

  /** Outgoing damage multiplier from damage ranks. */
  damageScale() {
    return 1 + CONFIG.damageUpgradeAmount * this.upgrades.damage;
  }

  /** Gold price of a melee troop, skirmisher, dragoon, or cannon. */
  unitCost(type) {
    if (type === "cannon") {
      return CONFIG.cannonCost;
    }
    if (type === "dragoon") {
      return CONFIG.dragoonCost;
    }
    if (type === "skirmisher") {
      return CONFIG.skirmisherCost;
    }
    return CONFIG.troopCost;
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
   * Spend gold to spawn a melee troop, skirmisher, dragoon, or cannon.
   * lane is "top" or "bottom". Returns the unit, or null if unaffordable.
   */
  tryBuy(lane, nextId, type) {
    const cost = this.unitCost(type);
    if (this.gold < cost) {
      return null;
    }
    this.gold -= cost;
    const troop = new Troop(nextId, this, lane, this.pickSublane(lane), type);
    this.troops.push(troop);
    return troop;
  }

  /** Spend land on speed, armor, or damage. Caps at five ranks. */
  tryBuyUpgrade(kind) {
    if (!this.canBuyUpgrade(kind)) {
      return false;
    }
    const cost = this.upgradeCost(kind);
    this.land -= cost;
    this.upgrades[kind] += 1;
    this.speedMultiplier = 1 + CONFIG.speedUpgradeAmount * this.upgrades.speed;
    return true;
  }

  /**
   * Closest enemy troop in cannon range. Units locked in melee are skipped.
   */
  capitalTarget(enemies, allies) {
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < enemies.length; i += 1) {
      const other = enemies[i];
      if (other.hp <= 0) {
        continue;
      }
      if (other.isInMelee(allies)) {
        continue;
      }
      const d = distance(this.capital, other);
      if (d <= CONFIG.capitalCannonRange && d < bestD) {
        bestD = d;
        best = other;
      }
    }
    return best;
  }

  /** Cannon-style shell at double cannon damage, with falloff and variance. */
  fireCapital(target, allies, projectiles) {
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
    projectiles.push(new Projectile(
      this.capital.x,
      this.capital.y,
      target,
      Math.round(damage),
      allies,
      "shoot",
      "cannon",
      this.sim,
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
      if (!["melee", "skirmisher", "dragoon", "cannon"].includes(cmd.unit)) return false;
      return Boolean(this.grantTroop(side, cmd.lane, cmd.unit));
    }
    if (cmd.type === "bank") return side.tryUnlockBank();
    if (cmd.type === "upgrade") {
      const id = Number(cmd.checkpointId);
      const town = this.checkpoints.find((c) => c.index === id);
      if (!town || town.owner !== side.id) return false;
      return side.tryBuyUpgrade(town.upgradeKind());
    }
    if (cmd.type === "order") {
      const troopId = Number(cmd.troopId);
      const troop = side.troops.find((t) => t.id === troopId && t.hp > 0);
      if (!troop) return false;
      if (cmd.action === "cycle") troop.issueOrder(side.troops, foe.troops);
      else if (cmd.action === "charge") troop.issueCharge(side.troops, foe.troops);
      else if (cmd.action === "fallback") troop.issueFallback(side.troops);
      else if (cmd.action === "lane") {
        const sublane = Number(cmd.sublane);
        if (!Number.isInteger(sublane)) return false;
        troop.issueLaneChange(sublane, side.troops, foe.troops);
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
      })),
      projectiles: this.projectiles.map((shot) => ({ x: shot.x, y: shot.y })),
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
      capitalHP: side.capitalHP,
      banks: side.banks,
      speedMultiplier: side.speedMultiplier,
      upgrades: { ...side.upgrades },
      troops: side.troops.filter((troop) => troop.hp > 0).map((troop) => ({
        id: troop.id,
        lane: troop.lane,
        sublane: troop.sublane,
        type: troop.type,
        hp: troop.hp,
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

  /** Award passive gold and land from current income. */
  tickIncome(dt) {
    this.refreshIncomes();
    this.player.gold += this.player.income * dt;
    this.enemy.gold += this.enemy.income * dt;
    this.player.land += this.player.landIncome * dt;
    this.enemy.land += this.enemy.landIncome * dt;
  }

  /** Move, fight, capture, and drop dead troops for one side. */
  updateSide(side, opponents, enemySide, dt) {
    for (let i = 0; i < side.troops.length; i += 1) {
      const troop = side.troops[i];
      if (troop.hp <= 0) {
        continue;
      }
      troop.update(dt, side.troops, opponents, enemySide, this.projectiles);
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
    this.splats.push(new HitSplat(x, y, amount, kind));
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
   * keep times its remaining hit points.
   */
  laneValue(side, lane) {
    let total = 0;
    for (let i = 0; i < side.troops.length; i += 1) {
      const troop = side.troops[i];
      if (troop.hp <= 0 || troop.lane !== lane) {
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
