import { app, BrowserWindow, ipcMain, protocol, shell, net } from "electron";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SERVER = process.env.MOTL_SERVER_URL || "http://127.0.0.1:3000";

function clientRoot() {
  if (process.env.MOTL_CLIENT_DIR) return path.resolve(process.env.MOTL_CLIENT_DIR);
  const packaged = path.join(process.resourcesPath, "client");
  if (fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, "..", "..", "dist", "client");
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".webmanifest": "application/manifest+json",
};

function startStaticServer(root) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url || "/", "http://127.0.0.1");
        let rel = decodeURIComponent(u.pathname);
        if (rel === "/") rel = "/index.html";
        const filePath = path.normalize(path.join(root, rel));
        if (!filePath.startsWith(root)) {
          res.writeHead(403);
          res.end("forbidden");
          return;
        }
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
        fs.createReadStream(filePath).pipe(res);
      } catch (err) {
        res.writeHead(500);
        res.end(String(err && err.message));
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
    server.on("error", reject);
  });
}

let mainWindow = null;
let staticServer = null;
let serverUrl = DEFAULT_SERVER;

function createWindow(localOrigin) {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow.webContents.executeJavaScript(
      `window.MOTL_SHELL=true;window.MOTL_SERVER_URL=${JSON.stringify(serverUrl)};`,
    ).catch(() => {});
  });

  mainWindow.loadURL(`${localOrigin}/app/games.html`);
}

function handleDeepLink(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "motl:") return;
    const token = u.searchParams.get("token");
    if (token && mainWindow) {
      mainWindow.webContents.send("motl:authToken", token);
      mainWindow.webContents.executeJavaScript(
        `try{localStorage.setItem('motl.sessionToken',${JSON.stringify(token)});location.href='/app/games.html';}catch(e){}`,
      ).catch(() => {});
    }
  } catch {
    // ignore
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_ev, argv) => {
    const link = argv.find((a) => String(a).startsWith("motl://"));
    if (link) handleDeepLink(link);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    if (process.defaultApp) {
      if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient("motl", process.execPath, [path.resolve(process.argv[1])]);
      }
    } else {
      app.setAsDefaultProtocolClient("motl");
    }

    ipcMain.handle("motl:openExternal", async (_ev, url) => {
      const text = String(url || "");
      if (!/^https?:\/\//i.test(text)) return false;
      await shell.openExternal(text);
      return true;
    });
    ipcMain.handle("motl:getServerUrl", async () => serverUrl);

    const root = clientRoot();
    if (!fs.existsSync(root)) {
      console.error(`Client export missing at ${root}. Run npm run client:export first.`);
      app.quit();
      return;
    }

    // Patch boot.json + synchronous shell-config.js for this run.
    try {
      const bootPath = path.join(root, "boot.json");
      const boot = fs.existsSync(bootPath)
        ? JSON.parse(fs.readFileSync(bootPath, "utf8"))
        : {};
      boot.serverUrl = serverUrl;
      fs.writeFileSync(bootPath, `${JSON.stringify(boot, null, 2)}\n`);
      fs.writeFileSync(
        path.join(root, "shell-config.js"),
        `window.MOTL_SHELL=true;window.MOTL_SERVER_URL=${JSON.stringify(serverUrl)};window.MOTL_BOOT=${JSON.stringify(boot)};\n`,
      );
    } catch {
      // ignore
    }

    staticServer = await startStaticServer(root);
    const localOrigin = `http://127.0.0.1:${staticServer.port}`;
    createWindow(localOrigin);

    const deep = process.argv.find((a) => String(a).startsWith("motl://"));
    if (deep) handleDeepLink(deep);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(localOrigin);
    });
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  app.on("window-all-closed", () => {
    if (staticServer && staticServer.server) staticServer.server.close();
    if (process.platform !== "darwin") app.quit();
  });
}

// silence unused imports in some Electron versions
void protocol;
void net;
void pathToFileURL;
