import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONFIG } from "../shared/config.js";
import {
  BUY_UNITS,
  CATEGORY_UNITS,
  UNIT_ALIASES,
  UNIT_CATEGORIES,
  UNIT_VARIETIES,
  UNITS,
  buyBaseOf,
  categoryOf,
  cycleVariantPick,
  isEliteVariety,
  isSpecialistVariety,
  mobilityClass,
  resolveUnitId,
  unitCategory,
  unitIdOf,
  unitLandCost,
  unitStats,
  unitVariety,
  variantOptions,
} from "../shared/units.js";

const EXPECTED = [
  ["regulars", "infantry", "standard", "foot"],
  ["militia", "infantry", "specialist", "foot"],
  ["grenadier", "infantry", "elite", "foot"],
  ["light", "skirmishers", "standard", "foot"],
  ["guerrilla", "skirmishers", "specialist", "foot"],
  ["rifle", "skirmishers", "elite", "foot"],
  ["dragoon", "cavalry", "standard", "mounted"],
  ["hussar", "cavalry", "specialist", "mounted"],
  ["lancer", "cavalry", "elite", "mounted"],
  ["fieldGun", "artillery", "standard", "limbered"],
  ["horseGun", "artillery", "specialist", "limbered"],
  ["howitzer", "artillery", "elite", "limbered"],
  ["major", "officer", "standard", "foot"],
  ["engineer", "officer", "specialist", "foot"],
  ["colorGuard", "officer", "elite", "foot"],
];

describe("unit taxonomy", () => {
  it("maps all 15 units to category, variety, and mobility", () => {
    assert.equal(Object.keys(UNITS).length, 15);
    assert.deepEqual(UNIT_CATEGORIES, [
      "infantry",
      "skirmishers",
      "cavalry",
      "artillery",
      "officer",
    ]);
    assert.deepEqual(UNIT_VARIETIES, ["standard", "specialist", "elite"]);
    for (const [id, category, variety, mobility] of EXPECTED) {
      assert.equal(unitCategory(id), category, id);
      assert.equal(unitVariety(id), variety, id);
      assert.equal(mobilityClass(id), mobility, id);
      assert.equal(UNITS[id].category, category);
      assert.equal(UNITS[id].variety, variety);
      assert.equal(UNITS[id].mobility, mobility);
    }
  });

  it("resolves legacy spawn aliases", () => {
    assert.equal(resolveUnitId("troop"), "regulars");
    assert.equal(resolveUnitId("skirmisher"), "light");
    assert.equal(resolveUnitId("cannon"), "fieldGun");
    assert.equal(resolveUnitId("officer"), "major");
    assert.equal(UNIT_ALIASES.troop, "regulars");
    assert.equal(unitStats("troop").cost, unitStats("regulars").cost);
  });

  it("cycles standard → elite → specialist", () => {
    assert.deepEqual(variantOptions("regulars"), [
      "regulars",
      "grenadier",
      "militia",
    ]);
    assert.equal(cycleVariantPick("regulars", "regulars", 1), "grenadier");
    assert.equal(cycleVariantPick("regulars", "grenadier", 1), "militia");
    assert.equal(cycleVariantPick("troop", "militia", 1), "regulars");
  });

  it("charges elite and specialist land ratios", () => {
    assert.equal(
      unitLandCost("grenadier"),
      Math.round(unitStats("grenadier").cost * CONFIG.unitLandCostRatio),
    );
    assert.equal(
      unitLandCost("militia"),
      Math.round(
        unitStats("militia").cost * CONFIG.specialistUnitLandCostRatio,
      ),
    );
    assert.equal(unitLandCost("regulars"), 0);
    assert.equal(isEliteVariety("grenadier"), true);
    assert.equal(isSpecialistVariety("militia"), true);
  });

  it("exposes category slots and buy catalog standards", () => {
    assert.deepEqual(CATEGORY_UNITS.infantry, {
      standard: "regulars",
      elite: "grenadier",
      specialist: "militia",
    });
    assert.equal(buyBaseOf("militia"), "regulars");
    assert.equal(buyBaseOf("troop"), "regulars");
    assert.deepEqual(
      BUY_UNITS.map((u) => u.type),
      ["regulars", "light", "dragoon", "fieldGun", "major"],
    );
  });

  it("reads category and unit id from living-unit shaped objects", () => {
    assert.equal(
      categoryOf({ category: "infantry", unit: "militia", type: "troop" }),
      "infantry",
    );
    assert.equal(unitIdOf({ unit: "militia", type: "troop" }), "militia");
    assert.equal(unitIdOf({ type: "troop", variant: null }), "regulars");
    assert.equal(unitIdOf({ type: "troop", variant: "militia" }), "militia");
  });
});
