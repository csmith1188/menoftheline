import { isAlternateUnit, resolveUnitId } from "../shared/units.js";

/**
 * Guided overlay for training matches. Mounted over the top-lane region.
 * Auto-advances only when the active page's objective is met (no skipping).
 */

export const TUTORIAL_STEPS = [
  {
    id: "intro",
    title: "Men Of The Line",
    body: "You are a Colonel. Lead your regiment into battle by deploying and giving them orders. Hit Next to begin.",
  },
  {
    id: "buyTroops",
    title: "Buy two troops",
    body: "Swipe down on Troop twice to buy two units into the bottom lane. Troops are the backbone of your army.",
  },
  {
    id: "economy",
    title: "The Middle Line",
    body: "Each lane has a Middle Line. More units in your lane gives you more of that lane's resources (Gold or Land). Click Next.",
  },
  {
    id: "halt",
    title: "Halt",
    body: "Order a unit to Halt. They will shoot at full range and recover fatigue while halted.",
  },
  {
    id: "advance",
    title: "Advance",
    body: "Click a unit that is stopped (halted or reformed) to Advance. Units will stop to shoot anything within half their range. Advancing Troops that walk into Perfect Line with a Halted or Reforming Troop next door take that order alone.",
  },
  {
    id: "town",
    title: "Control a town",
    body: "Move into a town on the bottom arc to capture it. This will allow you to research upgrades.",
  },
  {
    id: "research",
    title: "Begin researching",
    body: "Tap a town you own to start producing an upgrade. When they are paid off, you get a permanent bonus.",
  },
  {
    id: "laneSwitch",
    title: "Lane switch",
    body: "Drag across a unit to switch its row. Lines move together.",
  },
  {
    id: "reform",
    title: "Reform a line",
    body: "Swipe a unit into a lane with a matching unit adjacent to it to join them together. Units in a line share orders.",
  },
  {
    id: "charge",
    title: "Charge",
    body: "Drag forward on a unit to Charge. Entering melee while charging does bonus damage.",
  },
  {
    id: "melee",
    title: "Attack in melee",
    body: "Move into an enemy with a charge to engage in melee. Melee is brutal and exhausting, and units can't take orders when fighting.",
  },
  {
    id: "fallback",
    title: "Fallback",
    body: "Drag back on a unit to Fallback. Units in melee will Retreat instead.",
  },
  {
    id: "alternate",
    title: "Buy an alternate",
    body: "Spend extra land to buy alternate units that are upgraded. Put one in the bottom lane now.",
  },
  {
    id: "keep",
    title: "Destroy the Keep",
    body: "Reduce the enemy Keep to zero to finish training.",
  },
];

/** How many state frames to wait for a queued order to land. */
const PENDING_MAX_FRAMES = 20;

function findTroop(board, troopId) {
  if (!board || !board.player || !board.player.troops) return null;
  return board.player.troops.find((t) => t.id === troopId) || null;
}

function troopOrder(troop) {
  if (!troop) return undefined;
  return troop.order;
}

/** Prefer the board's real line-size helper when input methods are bound. */
function lineSizeOf(board, troopId) {
  const troop = findTroop(board, troopId);
  if (!troop) return 0;
  if (typeof board.lineSizeOf === "function") {
    return board.lineSizeOf(troop);
  }
  if (board.inspectedLineIds && board.inspectedLineIds[troopId]) {
    return Object.keys(board.inspectedLineIds).length;
  }
  const allies = board.player.troops;
  let n = 0;
  for (let i = 0; i < allies.length; i += 1) {
    const a = allies[i];
    if (!a || a.hp <= 0) continue;
    if (a.lane !== troop.lane) continue;
    if (Math.abs((a.progress || 0) - (troop.progress || 0)) > 0.08) continue;
    if (Math.abs((a.sublane || 0) - (troop.sublane || 0)) > 1) continue;
    n += 1;
  }
  return Math.max(1, n);
}

function reformingCount(board) {
  if (!board || !board.player || !board.player.troops) return 0;
  let n = 0;
  for (let i = 0; i < board.player.troops.length; i += 1) {
    const t = board.player.troops[i];
    if (t && t.hp > 0 && t.order === "reform") n += 1;
  }
  return n;
}

export function createTutorial(root) {
  const el = root || document.getElementById("tutorial");
  if (!el) {
    return {
      setActive() {},
      noteCommand() {},
      noteState() {},
      destroy() {},
    };
  }

  const titleEl = el.querySelector(".tutorial-title");
  const bodyEl = el.querySelector(".tutorial-body");
  const stepEl = el.querySelector(".tutorial-step");
  const backBtn = el.querySelector(".tutorial-back");
  const nextBtn = el.querySelector(".tutorial-next");

  let active = false;
  let stepIndex = 0;
  let board = null;
  /** @type {Record<string, boolean>} */
  const done = Object.create(null);
  let troopBuys = 0;
  /**
   * Wait for the server to apply a queued order before scoring.
   * @type {{ troopId: number, before: unknown, action: string, frames: number } | null}
   */
  let pendingOrder = null;
  let seatKey = "a";

  function currentId() {
    return TUTORIAL_STEPS[stepIndex] && TUTORIAL_STEPS[stepIndex].id;
  }

  function mark(id) {
    // Only the active page can complete and advance — never skip ahead.
    if (!active || currentId() !== id || done[id]) return;
    done[id] = true;
    goTo(stepIndex + 1);
  }

  function goTo(index) {
    stepIndex = Math.max(0, Math.min(TUTORIAL_STEPS.length - 1, index));
    render();
  }

  function render() {
    if (!active) {
      el.classList.add("hidden");
      return;
    }
    el.classList.remove("hidden");
    const step = TUTORIAL_STEPS[stepIndex];
    if (titleEl) titleEl.textContent = step.title;
    if (bodyEl) bodyEl.textContent = step.body;
    if (stepEl) {
      stepEl.textContent = `${stepIndex + 1} / ${TUTORIAL_STEPS.length}`;
    }
    if (backBtn) backBtn.disabled = stepIndex <= 0;
    if (nextBtn) {
      nextBtn.disabled = stepIndex >= TUTORIAL_STEPS.length - 1;
      nextBtn.textContent = done[step.id] ? "Next ✓" : "Next";
    }
  }

  function onBack() {
    goTo(stepIndex - 1);
  }

  function onNext() {
    goTo(stepIndex + 1);
  }

  if (backBtn) backBtn.addEventListener("click", onBack);
  if (nextBtn) nextBtn.addEventListener("click", onNext);

  function watchOrder(cmd) {
    const troop = findTroop(board, cmd.troopId);
    pendingOrder = {
      troopId: cmd.troopId,
      before: troopOrder(troop),
      action: cmd.action,
      dir: cmd.dir,
      solo: Boolean(cmd.solo),
      frames: 0,
    };
  }

  /**
   * True when this command is a Reform gesture (including swipe-into-mate
   * on an already squared line, where the server may leave orders unchanged).
   */
  function isReformGesture(cmd) {
    if (!cmd) return false;
    if (cmd.action === "reform") return true;
    if (cmd.action !== "switch" && cmd.action !== "shift" && cmd.action !== "lane") {
      return false;
    }
    const troop = findTroop(board, cmd.troopId);
    if (!troop || !board) return false;
    const dir = Number(cmd.dir);
    if ((dir === 1 || dir === -1) && typeof board.switchSwipeLabel === "function") {
      return board.switchSwipeLabel(troop, dir, Boolean(cmd.solo)) === "Reform";
    }
    return false;
  }

  function scoreOrderResult(after, pending) {
    const size = lineSizeOf(board, pending.troopId);
    const action = pending.action;
    const multiReform = reformingCount(board) >= 2;
    const reformGesture = isReformGesture(pending);

    // Reform order applied, or Reform gesture on a line (even if already squared).
    if (
      ((after === "reform" || multiReform) && (size >= 2 || multiReform))
      || (reformGesture && size >= 2)
    ) {
      mark("reform");
    }
    if (
      after === null
      && pending.before !== null
      && pending.before !== undefined
    ) {
      mark("advance");
    }
    if (after === "charge") mark("charge");
    if (after === "fallback" || after === "retreat") mark("fallback");
    if (after === "halt") mark("halt");
    if (action === "lane" || action === "switch" || action === "shift") {
      mark("laneSwitch");
    }
  }

  function noteCommand(cmd) {
    if (!active || !cmd || typeof cmd !== "object") return;

    if (cmd.type === "buy") {
      if (resolveUnitId(cmd.unit) === "regulars") {
        troopBuys += 1;
        if (troopBuys >= 2) mark("buyTroops");
      }
      if (isAlternateUnit(cmd.unit)) mark("alternate");
      return;
    }

    if (cmd.type === "townProduce" || cmd.type === "upgrade") {
      mark("research");
      return;
    }

    if (cmd.type !== "order") return;

    const action = cmd.action;
    const size = lineSizeOf(board, cmd.troopId);

    // Reform gesture counts even when the line is already squared and the
    // server leaves orders unchanged.
    if (isReformGesture(cmd) && size >= 2) {
      mark("reform");
    }

    // Lane-switch gesture counts even when the line cannot move (e.g. as
    // many units as rows — shift would leave the lane).
    if (action === "lane" || action === "switch" || action === "shift") {
      mark("laneSwitch");
    }

    if (action === "reform") {
      watchOrder(cmd);
      return;
    }

    if (
      action === "restore"
      || action === "cycle"
      || action === "speedUp"
      || action === "speedDown"
      || action === "charge"
      || action === "fallback"
      || action === "forward"
      || action === "back"
      || action === "halt"
      || action === "lane"
      || action === "switch"
      || action === "shift"
    ) {
      // Switch often becomes Reform on the server — wait for the result.
      // Cycle/restore must wait too: state ticks arrive before the queue applies.
      watchOrder(cmd);
    }
  }

  function noteState(snap) {
    if (!active || !board) return;

    const towns = board.checkpoints || [];
    let ownTown = false;
    let producing = false;
    for (let i = 0; i < towns.length; i += 1) {
      const town = towns[i];
      if (town && town.owner === "player") {
        ownTown = true;
        if (town.producing) producing = true;
      }
    }
    if (ownTown) mark("town");
    if (producing) mark("research");

    if (board.winner === "player") mark("keep");
    if (board.enemy && board.enemy.keepHP <= 0) mark("keep");

    const mine = seatKey === "a" ? "player" : "enemy";
    const sounds = snap && snap.sounds;
    if (sounds) {
      for (let i = 0; i < sounds.length; i += 1) {
        const sound = sounds[i];
        if (sound && sound.type === "melee" && sound.sideId === mine) {
          mark("melee");
          break;
        }
      }
    }

    if (pendingOrder) {
      const troop = findTroop(board, pendingOrder.troopId);
      const after = troopOrder(troop);
      pendingOrder.frames += 1;
      if (after !== pendingOrder.before) {
        scoreOrderResult(after, pendingOrder);
        pendingOrder = null;
      } else if (pendingOrder.frames >= PENDING_MAX_FRAMES) {
        // Timed out with no change — reform-into-mate on a squared line, or switch.
        if (isReformGesture(pendingOrder) && lineSizeOf(board, pendingOrder.troopId) >= 2) {
          mark("reform");
        }
        if (
          pendingOrder.action === "lane"
          || pendingOrder.action === "switch"
          || pendingOrder.action === "shift"
        ) {
          mark("laneSwitch");
        }
        pendingOrder = null;
      }
    }

    if (snap && snap.sides) {
      const foe = seatFoeSide(snap);
      if (foe && foe.keepHP <= 0) mark("keep");
    }
  }

  function seatFoeSide(snap) {
    if (!snap || !snap.sides) return null;
    const mine = seatKey === "a" ? "player" : "enemy";
    const foe = mine === "player" ? "enemy" : "player";
    return snap.sides[foe] || null;
  }

  return {
    setActive(on, opts = {}) {
      active = Boolean(on);
      board = opts.board || board;
      if (opts.seat) seatKey = opts.seat;
      if (opts.reset) {
        stepIndex = 0;
        troopBuys = 0;
        pendingOrder = null;
        for (const key of Object.keys(done)) delete done[key];
      }
      render();
    },
    noteCommand,
    noteState,
    destroy() {
      if (backBtn) backBtn.removeEventListener("click", onBack);
      if (nextBtn) nextBtn.removeEventListener("click", onNext);
      el.classList.add("hidden");
      active = false;
    },
  };
}
