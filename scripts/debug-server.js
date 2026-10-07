/** Start the game with unit range and effect overlays drawn. */
process.env.DEBUG_RANGES = "1";
const { listen, PORT, THIS_URL } = await import("../app.js");
await listen(PORT);
console.log(`Men Of The Line listening on ${THIS_URL}`);
console.log("Debug ranges: forward weapon range, collision boxes, restore, fort, and keep bands");
