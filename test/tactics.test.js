import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeBot, makeSim, quiet, spawn, stepBot } from "./helpers.js";

function silence(sim) {
  quiet(sim.player);
  quiet(sim.enemy);
}

describe("infantry formation", () => {
  it("steps a same-row stacker onto a free row", () => {
    const sim = makeSim();
    const bot = makeBot("simple");
    const a = spawn(sim, "player", "troop", "top", { progress: 0.3, sublane: 0 });
    const b = spawn(sim, "player", "troop", "top", { progress: 0.3, sublane: 0 });
    silence(sim);
    stepBot(bot, sim);
    const moved = a.switch != null ? a : b;
    const stayed = moved === a ? b : a;
    assert.notEqual(moved.switch, null);
    assert.equal(stayed.switch, null);
  });

  it("holds a leader until the trailer is close enough to reform", () => {
    const sim = makeSim();
    const bot = makeBot("simple");
    const front = spawn(sim, "player", "troop", "top", { progress: 0.4, sublane: 0 });
    const rear = spawn(sim, "player", "troop", "top", { progress: 0.32, sublane: 1 });
    silence(sim);
    stepBot(bot, sim);
    assert.equal(front.order, "halt");
    assert.equal(rear.order, null);

    const close = makeSim();
    const closeBot = makeBot("simple");
    const lead = spawn(close, "player", "troop", "top", { progress: 0.4, sublane: 0 });
    const tail = spawn(close, "player", "troop", "top", { progress: 0.395, sublane: 1 });
    silence(close);
    stepBot(closeBot, close);
    assert.equal(lead.order, "reform");
    assert.equal(tail.order, "reform");
  });

  it("squares a staggered pair without the trailer walking past", () => {
    const sim = makeSim();
    const bot = makeBot("simple");
    const front = spawn(sim, "player", "troop", "top", { progress: 0.3, sublane: 0 });
    const rear = spawn(sim, "player", "troop", "top", { progress: 0.25, sublane: 1 });
    silence(sim);
    const dt = 0.05;
    let worstLead = rear.progress - front.progress;
    for (let n = 0; n < 200; n += 1) {
      if (!sim.beginStep(dt)) break;
      bot.act(sim);
      sim.finishStep(dt);
      const lead = rear.progress - front.progress;
      if (lead > worstLead) worstLead = lead;
    }
    assert.ok(worstLead < 0.008, `trailer led by ${worstLead}`);
    assert.ok(Math.abs(front.progress - rear.progress) < 0.006);
  });

  it("does not advance or reform a halted line that should keep firing", () => {
    const sim = makeSim();
    const bot = makeBot("simple");
    const a = spawn(sim, "player", "troop", "top", {
      progress: 0.4, sublane: 1, order: "halt",
    });
    const b = spawn(sim, "player", "troop", "top", {
      progress: 0.4, sublane: 2, order: "halt",
    });
    spawn(sim, "enemy", "troop", "top", { progress: 0.45, sublane: 0 });
    silence(sim);
    stepBot(bot, sim);
    assert.equal(a.order, "halt");
    assert.equal(b.order, "halt");
  });

  it("does not reform a line that is already reforming", () => {
    const sim = makeSim();
    const bot = makeBot("simple");
    const a = spawn(sim, "player", "troop", "top", {
      progress: 0.4, sublane: 0, order: "reform",
    });
    spawn(sim, "player", "troop", "top", { progress: 0.32, sublane: 1, order: "reform" });
    silence(sim);
    let reforms = 0;
    const apply = sim.applyCommand.bind(sim);
    sim.applyCommand = (sideId, cmd) => {
      if (cmd.action === "reform") reforms += 1;
      return apply(sideId, cmd);
    };
    stepBot(bot, sim);
    assert.equal(reforms, 0);
    assert.equal(a.order, "reform");
  });

  it("clears a same-row stack before reforming so the trailer is not jammed", () => {
    const sim = makeSim();
    const bot = makeBot("simple");
    const front = spawn(sim, "player", "troop", "top", { progress: 0.4, sublane: 1 });
    const trailer = spawn(sim, "player", "troop", "top", { progress: 0.4, sublane: 2 });
    const stacker = spawn(sim, "player", "troop", "top", { progress: 0.4, sublane: 2 });
    const spp = (() => {
      const saved = front.progress;
      const before = front.station();
      front.progress = saved - 0.01;
      front.syncPosition();
      const after = front.station();
      front.progress = saved;
      front.syncPosition();
      return Math.abs(before - after) / 0.01;
    })();
    trailer.progress = front.progress - 6 / spp;
    trailer.syncPosition();
    stacker.progress = front.progress - 2 / spp;
    stacker.syncPosition();
    silence(sim);

    stepBot(bot, sim);
    assert.notEqual(front.order, "reform", "must not reform into the stack");
    assert.ok(
      trailer.switch != null
        || stacker.switch != null
        || stacker.sublane !== 2
        || trailer.sublane !== 2,
      "stack must start clearing before reform",
    );

    const dt = 0.05;
    let jam = 0;
    for (let n = 0; n < 300; n += 1) {
      if (!sim.beginStep(dt)) break;
      bot.act(sim);
      sim.finishStep(dt);
      for (const unit of [front, trailer, stacker]) {
        if (unit.order !== "reform") continue;
        for (const other of sim.player.troops) {
          if (unit !== other && unit.isBlockedBy(other)) jam += 1;
        }
      }
    }
    assert.equal(jam, 0, `reform jam frames: ${jam}`);
    assert.ok(trailer.isParallelTo(front) || stacker.isParallelTo(front));
  });

  it("steps off a non-troop blocker instead of reforming into it", () => {
    const sim = makeSim();
    const bot = makeBot("simple");
    const front = spawn(sim, "player", "troop", "top", { progress: 0.4, sublane: 1 });
    const trailer = spawn(sim, "player", "troop", "top", { progress: 0.4, sublane: 2 });
    const gun = spawn(sim, "player", "cannon", "top", {
      progress: 0.4, sublane: 2, order: "halt",
    });
    const spp = (() => {
      const saved = front.progress;
      const before = front.station();
      front.progress = saved - 0.01;
      front.syncPosition();
      const after = front.station();
      front.progress = saved;
      front.syncPosition();
      return Math.abs(before - after) / 0.01;
    })();
    trailer.progress = front.progress - 6 / spp;
    trailer.syncPosition();
    gun.progress = front.progress - 2 / spp;
    gun.syncPosition();
    silence(sim);

    stepBot(bot, sim);
    assert.notEqual(front.order, "reform");
    assert.ok(trailer.switch != null || trailer.sublane !== 2);
  });
});

describe("skirmishers", () => {
  it("screens friendly infantry and ignores distant troops", () => {
    const sim = makeSim();
    const bot = makeBot("simple");
    spawn(sim, "player", "troop", "top", { progress: 0.4, sublane: 2 });
    const screen = spawn(sim, "player", "skirmisher", "top", { progress: 0.5, sublane: 1 });
    spawn(sim, "enemy", "troop", "top", { progress: 0.05, sublane: 0 });
    spawn(sim, "enemy", "troop", "top", { progress: 0.05, sublane: 1 });
    silence(sim);
    stepBot(bot, sim);
    assert.notEqual(screen.order, "fallback");
    assert.equal(screen.order, "halt");
  });

  it("falls back from nearby infantry and resumes after they leave", () => {
    const sim = makeSim();
    const bot = makeBot("simple");
    spawn(sim, "player", "troop", "top", { progress: 0.4, sublane: 2 });
    const screen = spawn(sim, "player", "skirmisher", "top", { progress: 0.5, sublane: 0 });
    const foeA = spawn(sim, "enemy", "troop", "top", { progress: 0.46, sublane: 1 });
    const foeB = spawn(sim, "enemy", "troop", "top", { progress: 0.46, sublane: 2 });
    silence(sim);
    stepBot(bot, sim);
    assert.equal(screen.order, "fallback");

    foeA.progress = 0.05;
    foeB.progress = 0.05;
    foeA.syncPosition();
    foeB.syncPosition();
    stepBot(bot, sim);
    assert.equal(screen.order, "fallback");
    stepBot(bot, sim);
    assert.equal(screen.order, "halt");
  });
});

describe("cavalry", () => {
  it("catches infantry that is ahead beyond support range", () => {
    const sim = makeSim();
    const bot = makeBot("simple");
    spawn(sim, "player", "troop", "top", { progress: 0.7, sublane: 2 });
    const horse = spawn(sim, "player", "dragoon", "top", {
      progress: 0.2, sublane: 1, order: "halt",
    });
    silence(sim);
    stepBot(bot, sim);
    assert.equal(horse.order, null);
  });

  it("falls back when infantry is behind and out of support", () => {
    const sim = makeSim();
    const bot = makeBot("simple");
    spawn(sim, "player", "troop", "top", { progress: 0.15, sublane: 2 });
    const horse = spawn(sim, "player", "dragoon", "top", { progress: 0.7, sublane: 1 });
    silence(sim);
    stepBot(bot, sim);
    assert.equal(horse.order, "fallback");
  });

  it("does not charge a troop block with no friendly infantry", () => {
    const sim = makeSim();
    const bot = makeBot("hard");
    const horse = spawn(sim, "player", "dragoon", "top", { progress: 0.4, sublane: 1 });
    for (let i = 0; i < 3; i += 1) {
      spawn(sim, "enemy", "troop", "top", { progress: 0.42, sublane: i });
    }
    silence(sim);
    stepBot(bot, sim);
    assert.notEqual(horse.order, "charge");
    assert.equal(horse.order, "fallback");
  });

  it("charges an isolated cannon when infantry is close enough to support", () => {
    const sim = makeSim();
    const bot = makeBot("hard");
    spawn(sim, "player", "troop", "top", { progress: 0.4, sublane: 0 });
    const horse = spawn(sim, "player", "dragoon", "top", {
      progress: 0.42, sublane: 2, order: "halt",
    });
    spawn(sim, "enemy", "cannon", "top", { progress: 0.5, sublane: 4 });
    silence(sim);
    stepBot(bot, sim);
    assert.equal(horse.order, "charge");
  });
});

describe("cannons and officers", () => {
  it("halts inside weapon range and advances when the target is beyond it", () => {
    const sim = makeSim();
    const bot = makeBot("simple");
    const gun = spawn(sim, "player", "cannon", "top", { progress: 0.2, sublane: 2 });
    const foe = spawn(sim, "enemy", "troop", "top", { progress: 0.6, sublane: 2 });
    silence(sim);
    stepBot(bot, sim);
    assert.equal(gun.order, "halt");

    const simFar = makeSim();
    const botFar = makeBot("simple");
    const farGun = spawn(simFar, "player", "cannon", "top", {
      progress: 0.15, sublane: 2, order: "halt",
    });
    spawn(simFar, "enemy", "troop", "top", { progress: 0.25, sublane: 2 });
    silence(simFar);
    stepBot(botFar, simFar);
    assert.equal(farGun.order, null);
    void foe;
  });

  it("falls back from contact and from a post ahead of the infantry", () => {
    const sim = makeSim();
    const bot = makeBot("simple");
    const gun = spawn(sim, "player", "cannon", "top", { progress: 0.5, sublane: 2 });
    spawn(sim, "enemy", "troop", "top", { progress: 0.44, sublane: 0 });
    silence(sim);
    stepBot(bot, sim);
    assert.equal(gun.order, "fallback");

    const behind = makeSim();
    const botBehind = makeBot("simple");
    spawn(behind, "player", "troop", "top", { progress: 0.3, sublane: 1 });
    const lead = spawn(behind, "player", "cannon", "top", { progress: 0.55, sublane: 2 });
    spawn(behind, "enemy", "troop", "top", { progress: 0.1, sublane: 0 });
    silence(behind);
    stepBot(botBehind, behind);
    assert.equal(lead.order, "fallback");
  });

  it("keeps an officer on the line and away from cavalry", () => {
    const sim = makeSim();
    const bot = makeBot("simple");
    spawn(sim, "player", "troop", "top", { progress: 0.5, sublane: 1 });
    spawn(sim, "player", "troop", "top", { progress: 0.5, sublane: 2 });
    const officer = spawn(sim, "player", "officer", "top", { progress: 0.47, sublane: 0 });
    silence(sim);
    stepBot(bot, sim);
    assert.equal(officer.order, "halt");

    const threatened = makeSim();
    const botThreat = makeBot("simple");
    spawn(threatened, "player", "troop", "top", { progress: 0.5, sublane: 1 });
    const exposed = spawn(threatened, "player", "officer", "top", { progress: 0.5, sublane: 2 });
    spawn(threatened, "enemy", "dragoon", "top", { progress: 0.52, sublane: 0 });
    silence(threatened);
    stepBot(botThreat, threatened);
    assert.equal(exposed.order, "fallback");

    const leading = makeSim();
    const botLead = makeBot("simple");
    spawn(leading, "player", "troop", "top", { progress: 0.4, sublane: 1 });
    const leader = spawn(leading, "player", "officer", "top", { progress: 0.55, sublane: 2 });
    silence(leading);
    stepBot(botLead, leading);
    assert.equal(leader.order, "fallback");
    assert.notEqual(leader.order, null);
  });
});
