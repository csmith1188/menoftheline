import { classicBoardFromConfig, classicLanesFromConfig } from "../definition.js";
import { GameMap } from "../GameMap.js";
import { CONFIG } from "../../config.js";

/** Empty terrain (side forts only). Same board/lanes/towns as classic. */
export function createEmptyMap() {
  return GameMap.fromDefinition({
    id: "empty",
    label: "Empty",
    board: classicBoardFromConfig(),
    lanes: classicLanesFromConfig(),
    forts: { distancePaces: CONFIG.fortDistancePaces },
    features: [],
    config: {},
    rules: {},
  });
}
