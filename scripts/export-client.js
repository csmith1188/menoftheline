/**
 * Copy shared frontend into dist/client for Electron/Capacitor shells.
 * Does not duplicate source under platforms/ — platforms point at dist/client.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { CLIENT_VERSION, PROTOCOL_VERSION } from "../shared/protocol.js";
import { resolveAssetVersion } from "../server/assetVersion.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist", "client");

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// Regenerate static play HTML from EJS templates.
await import("./generate-play-html.js");

rmrf(out);
fs.mkdirSync(out, { recursive: true });

copyDir(path.join(root, "public"), out);
copyDir(path.join(root, "shared"), path.join(out, "shared"));

const threeSrc = path.join(root, "node_modules", "three");
if (fs.existsSync(threeSrc)) {
  copyDir(threeSrc, path.join(out, "vendor", "three"));
}

const sioCandidates = [
  path.join(root, "node_modules", "socket.io", "client-dist", "socket.io.min.js"),
  path.join(root, "node_modules", "socket.io", "client-dist", "socket.io.js"),
  path.join(root, "node_modules", "socket.io-client", "dist", "socket.io.min.js"),
  path.join(root, "node_modules", "socket.io-client", "dist", "socket.io.js"),
];
const sio = sioCandidates.find((p) => fs.existsSync(p));
if (sio) {
  copyFile(sio, path.join(out, "vendor", "socket.io", "socket.io.js"));
}

const assetVersion = resolveAssetVersion({ root });
const boot = {
  protocolVersion: PROTOCOL_VERSION,
  clientVersion: CLIENT_VERSION,
  assetVersion,
  serverUrl: process.env.MOTL_SERVER_URL || "",
};
fs.writeFileSync(path.join(out, "boot.json"), `${JSON.stringify(boot, null, 2)}\n`);

const serverLiteral = JSON.stringify(boot.serverUrl || "");
fs.writeFileSync(
  path.join(out, "shell-config.js"),
  `window.MOTL_SHELL=true;window.MOTL_SERVER_URL=${serverLiteral};window.MOTL_BOOT=${JSON.stringify(boot)};\n`,
);

// Shell index → games menu
fs.writeFileSync(
  path.join(out, "index.html"),
  `<!DOCTYPE html><html><head><meta charset="utf-8"><script src="/shell-config.js"></script><meta http-equiv="refresh" content="0;url=/app/games.html"><title>Men Of The Line</title></head><body><a href="/app/games.html">Games</a></body></html>\n`,
);

const shellScript = '<script src="/shell-config.js"></script>';

// Point packaged play pages at local vendor socket.io when present.
for (const name of ["play.html", "play3d.html"]) {
  const file = path.join(out, "app", name);
  if (!fs.existsSync(file)) continue;
  let html = fs.readFileSync(file, "utf8");
  if (sio) {
    html = html.replace(
      'src="/socket.io/socket.io.js"',
      'src="/vendor/socket.io/socket.io.js"',
    );
  }
  html = html.replace(
    "<script>window.MOTL_SHELL=true;window.DEBUG_RANGES=false;</script>",
    `${shellScript}<script>window.DEBUG_RANGES=false;</script>`,
  );
  fs.writeFileSync(file, html);
}

for (const name of ["games.html", "lobby-create.html"]) {
  const file = path.join(out, "app", name);
  if (!fs.existsSync(file)) continue;
  let html = fs.readFileSync(file, "utf8");
  html = html.replace(
    /<script>\s*window\.MOTL_SHELL\s*=\s*true;\s*<\/script>/,
    shellScript,
  );
  fs.writeFileSync(file, html);
}

console.log(`Exported client → ${out}`);
console.log(`protocol=${PROTOCOL_VERSION} client=${CLIENT_VERSION}`);
