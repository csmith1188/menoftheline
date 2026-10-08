import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function stripEjs(src) {
  let s = src;
  s = s.replace(/<%- include\("pwa-head"\) %>\s*/g, "");
  s = s.replace(/\?v=<%= assetVersion %>/g, "");
  s = s.replace(
    /data-tooltips-default="<%= tooltipsDefault \? "1" : "0" %>"/g,
    'data-tooltips-default="1"',
  );
  s = s.replace(
    /data-bgm-volume-default="<%= Number\.isFinite\(bgmVolumeDefault\) \? bgmVolumeDefault : 50 %>"/g,
    'data-bgm-volume-default="50"',
  );
  s = s.replace(/<% if \(matchChatEnabled\) \{ %>\s*/g, "");
  s = s.replace(/<% \} %>\s*(?=\s*<div id="menu")/g, "");
  s = s.replace(
    /<script>window\.DEBUG_RANGES = <%- debugRanges \? "true" : "false" %>;<\/script>/,
    '<script src="/shell-config.js"></script><script>window.DEBUG_RANGES=false;</script>',
  );
  return s;
}

const outDir = path.join(root, "public", "app");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, "play.html"),
  stripEjs(fs.readFileSync(path.join(root, "views", "index.ejs"), "utf8")),
);
fs.writeFileSync(
  path.join(outDir, "play3d.html"),
  stripEjs(fs.readFileSync(path.join(root, "views", "play3d.ejs"), "utf8")),
);
console.log("wrote public/app/play.html and play3d.html");
