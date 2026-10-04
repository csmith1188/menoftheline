import { CONFIG } from "../../shared/config.js";
import { assessBattlefield, nextPosture } from "./assess.js";
import { bindCommands } from "./commands.js";
import { attachEconomyFacts, decideEconomy } from "./economy.js";
import { decideIntents, nextCommit, rememberIntents } from "./tactics.js";

const TARGET_MODES = ["bastion", "attrition", "terror"];
const STRATEGY_MODES = ["auto", ...TARGET_MODES];
const DIFFICULTIES = ["simple", "hard"];

export function botProfile(difficulty) {
  const hard = difficulty === "hard";
  return {
    hard,
    thinkInterval: hard ? CONFIG.botThinkInterval.hard : CONFIG.botThinkInterval.simple,
    useFatigue: hard,
    useRole: hard,
    dynamicComposition: hard,
    alternates: hard,
    chargeScoring: hard,
    groupRetreat: hard,
    keepCommitLocal: hard,
    richUrgency: hard,
  };
}

/**
 * Built-in opponent. One assessment, one purchase, and at most one
 * command per unit, on a difficulty clock. Simple and Hard share this
 * path; the profile only changes which signals are read.
 */
export class BotController {
  constructor(sideId, options = {}) {
    this.sideId = sideId;
    this.difficulty = DIFFICULTIES.includes(options.difficulty)
      ? options.difficulty
      : "simple";
    this.strategy = {
      top: STRATEGY_MODES.includes(options.strategy && options.strategy.top)
        ? options.strategy.top
        : "auto",
      bottom: STRATEGY_MODES.includes(options.strategy && options.strategy.bottom)
        ? options.strategy.bottom
        : "auto",
    };
    this.locks = new Map();
    this.unitMemory = new Map();
    this.lanePosture = { top: "hold", bottom: "hold" };
    this.laneDesperate = { top: false, bottom: false };
    this.laneCommit = { top: null, bottom: null };
    this.buyLane = null;
    this.nextThinkAt = 0;
    this.commands = bindCommands(this);
  }

  setDifficulty(difficulty) {
    if (DIFFICULTIES.includes(difficulty)) this.difficulty = difficulty;
  }

  setLaneStrategy(lane, mode) {
    if (lane !== "top" && lane !== "bottom") return;
    if (!STRATEGY_MODES.includes(mode)) return;
    this.strategy[lane] = mode;
  }

  act(sim) {
    if (!sim || sim.winner) return;
    const profile = botProfile(this.difficulty);
    if (sim.elapsed + 1e-9 < this.nextThinkAt) return;
    this.nextThinkAt = sim.elapsed + profile.thinkInterval;
    this.commands.prune(sim);

    const snapshot = assessBattlefield(sim, this.sideId, profile);
    attachEconomyFacts(sim, snapshot);
    this.applyLaneState(snapshot, profile);
    decideEconomy(this, sim, snapshot, profile);

    const decisions = decideIntents(this, snapshot, profile);
    this.issue(sim, snapshot, decisions);
    this.scheduleCatchUp(sim, decisions);
    rememberIntents(this, sim, decisions);
  }

  /** Wake before a trailer can walk through a holding leader. */
  scheduleCatchUp(sim, decisions) {
    let catchIn = null;
    for (let i = 0; i < decisions.length; i += 1) {
      const wait = decisions[i].catchIn;
      if (wait == null) continue;
      if (catchIn == null || wait < catchIn) catchIn = wait;
    }
    if (catchIn == null) return;
    const at = sim.elapsed + catchIn;
    if (at < this.nextThinkAt) this.nextThinkAt = at;
  }

  applyLaneState(snapshot, profile) {
    const foeId = this.sideId === "player" ? "enemy" : "player";
    const lanes = ["top", "bottom"];
    for (let i = 0; i < lanes.length; i += 1) {
      const lane = lanes[i];
      const info = snapshot.lanes[lane];
      const threatIn = snapshot.keepDesperate || info.threat >= CONFIG.botKeepThreatDefend;
      const threatOut = !snapshot.keepDesperate && info.threat < CONFIG.botKeepThreatClear;
      if (this.laneDesperate[lane]) {
        if (threatOut) this.laneDesperate[lane] = false;
      } else if (threatIn) {
        this.laneDesperate[lane] = true;
      }
      info.desperate = this.laneDesperate[lane];
      if (info.desperate) this.lanePosture[lane] = "defend";
      else this.lanePosture[lane] = nextPosture(this.lanePosture[lane], info);
      info.posture = this.lanePosture[lane];
      this.laneCommit[lane] = nextCommit(this.laneCommit[lane], info, profile, foeId);
      info.commit = this.laneCommit[lane];
    }
  }

  issue(sim, snapshot, decisions) {
    const issued = new Set();
    const cmds = this.commands;
    const foes = snapshot.foe.troops;

    for (let i = 0; i < decisions.length; i += 1) {
      if (decisions[i].formation === "wait") issued.add(decisions[i].unit.id);
    }

    // Clear same-row stacks before Reform. Reform recruits the whole seek
    // chain and no longer sidesteps blockers, so a Reform issued first
    // freezes the body that still needed to switch.
    for (let i = 0; i < decisions.length; i += 1) {
      const decision = decisions[i];
      if (issued.has(decision.unit.id)) continue;
      if (!decision.formation || decision.formation.action !== "switch") continue;
      cmds.switchRow(sim, decision.unit, decision.formation.sublane);
      issued.add(decision.unit.id);
    }

    for (let i = 0; i < decisions.length; i += 1) {
      const decision = decisions[i];
      if (!decision.formation || decision.formation === "wait") continue;
      if (decision.formation.action !== "reform") continue;
      if (issued.has(decision.unit.id)) continue;
      cmds.desireOrder(sim, decision.unit, "reform");
      issued.add(decision.unit.id);
    }
    for (let i = 0; i < decisions.length; i += 1) {
      const decision = decisions[i];
      if (!decision.formation || decision.formation.action !== "halt") continue;
      if (issued.has(decision.unit.id)) continue;
      cmds.desireOrder(
        sim,
        decision.unit,
        "halt",
        !decision.formation.group,
        false,
      );
      issued.add(decision.unit.id);
    }
    for (let i = 0; i < decisions.length; i += 1) {
      if (decisions[i].unit.order === "reform") issued.add(decisions[i].unit.id);
    }

    const seen = new Set();
    for (let i = 0; i < decisions.length; i += 1) {
      const decision = decisions[i];
      if (decision.unit.type !== "troop") continue;
      if (seen.has(decision.unit.id) || issued.has(decision.unit.id)) {
        seen.add(decision.unit.id);
        continue;
      }
      const lane = snapshot.lanes[decision.unit.lane];
      const line = decision.unit.lineGroup(lane.friendlies);
      const members = [];
      for (let g = 0; g < line.length; g += 1) {
        seen.add(line[g].id);
        if (issued.has(line[g].id)) continue;
        for (let d = 0; d < decisions.length; d += 1) {
          if (decisions[d].unit === line[g]) members.push(decisions[d]);
        }
      }
      if (!members.length) continue;
      const intent = members[0].intent;
      let uniform = true;
      let meleeSplit = false;
      for (let m = 0; m < members.length; m += 1) {
        const member = members[m];
        if (member.intent !== intent || member.solo || member.formation) uniform = false;
        if (member.unit.isInMelee(foes)) meleeSplit = true;
      }
      if (uniform && !meleeSplit) {
        let speaker = members[0].unit;
        for (let m = 1; m < members.length; m += 1) {
          if (members[m].unit.progress > speaker.progress) speaker = members[m].unit;
        }
        this.issueMove(sim, speaker, intent, false);
        for (let m = 0; m < members.length; m += 1) issued.add(members[m].unit.id);
      } else {
        for (let m = 0; m < members.length; m += 1) {
          const member = members[m];
          issued.add(member.unit.id);
          if (member.formation === "wait") continue;
          if (member.unit.isInMelee(foes) && member.intent !== "fallback") continue;
          this.issueMove(sim, member.unit, member.intent, true);
        }
      }
    }

    for (let i = 0; i < decisions.length; i += 1) {
      const decision = decisions[i];
      if (issued.has(decision.unit.id)) continue;
      if (decision.formation === "wait") continue;
      if (decision.unit.isInMelee(foes) && decision.intent !== "fallback") continue;
      this.issueMove(sim, decision.unit, decision.intent, true);
    }
  }

  issueMove(sim, unit, intent, solo) {
    if (intent === "advance") this.commands.desireOrder(sim, unit, null, solo);
    else if (intent === "halt" || intent === "fallback" || intent === "charge") {
      this.commands.desireOrder(sim, unit, intent, solo);
    }
  }
}

export { DIFFICULTIES, STRATEGY_MODES, TARGET_MODES };
