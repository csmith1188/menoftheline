import { registerMap } from "./registry.js";
import { createClassicMap } from "./maps/classic.js";
import { createEmptyMap } from "./maps/empty.js";

export { normalizeMapDefinition, classicBoardFromConfig, classicLanesFromConfig } from "./definition.js";
export { GameMap } from "./GameMap.js";
export {
  registerMap,
  registerMapDefinition,
  getMap,
  mapIds,
  mapLobbyPresets,
} from "./registry.js";
export { computeResourceIncomes, lerpResource } from "./income.js";
export { CLASSIC_FEATURES } from "./classicFeatures.js";

// Built-in maps
registerMap(createClassicMap());
registerMap(createEmptyMap());
