/** Start the game with unit range and effect overlays drawn. */
process.env.DEBUG_RANGES = "1";
const { listen, PORT, THIS_URL } = await import("../app.js");
const { logger } = await import("../server/logger.js");
await listen(PORT);
logger.info({ event: "server_started", port: PORT, url: THIS_URL, debugRanges: true }, `Men Of The Line listening on ${THIS_URL}`);
logger.info({ event: "debug_ranges_enabled" }, "debug ranges overlays enabled");
