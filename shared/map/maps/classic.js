import { classicBoardFromConfig, classicLanesFromConfig } from "../definition.js";
import { CLASSIC_FEATURES } from "../classicFeatures.js";
import { GameMap } from "../GameMap.js";
import { CONFIG } from "../../config.js";

/** Current default map: classic two-lane board + terrain layout. */
export function createClassicMap() {
  return GameMap.fromDefinition({
    id: "default",
    label: "Default",
    board: classicBoardFromConfig(),
    lanes: classicLanesFromConfig(),
    forts: { distancePaces: CONFIG.fortDistancePaces },
    features: CLASSIC_FEATURES,
    config: {},
    rules: {},
  });
}
