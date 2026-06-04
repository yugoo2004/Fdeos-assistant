const { app, BrowserWindow, dialog, shell, session } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const PRODUCT_NAME = "FDE 访谈助手";
const DEFAULT_GATEWAY_PORT = 8765;
const DEFAULT_DESKTOP_PORT = 5173;
const DEFAULT_KEYCHAIN_SERVICE = "fde-interview-ark-api-key";

let gatewayProcess = null;
let staticServer = null;
let mainWindow = null;
let startupLogPath = "";

app.setName(PRODUCT_NAME);
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

function resolveAppRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "app");
  }
  return path.resolve(__dirname, "..");
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function appendStartupLog(message) {
  if (!startupLogPath) return;
  try {
    fs.mkdirSync(path.dirname(startupLogPath), { recursive: true });
    fs.appendFileSync(startupLogPath, `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {
    // Startup logging should never block app launch.
  }
}

function readEnvFile(filePath) {
  if (!fileExists(filePath)) return {};
  const env = {};
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

function writeDefaultRuntimeEnv(userDataDir) {
  const envPath = path.join(userDataDir, "runtime.env");
  if (fileExists(envPath)) return envPath;
  const content = [
    "# FDE Interview Assistant local runtime config.",
    "# API keys are read from macOS Keychain, not from this file.",
    "FDE_LLM_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3",
    "FDE_LLM_MODEL=kimi-k2.6",
    `FDE_LLM_KEYCHAIN_SERVICE=${DEFAULT_KEYCHAIN_SERVICE}`,
    `FDE_LLM_KEYCHAIN_ACCOUNT=${os.userInfo().username}`,
    "FDE_LLM_ALLOW_LOCAL_SYNTHESIS=1",
    "FDE_LLM_TIMEOUT_SECONDS=180",
    "",
  ].join("\n");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(envPath, content, "utf8");
  return envPath;
}

function readKeychainPassword(service, account) {
  if (!service) return "";
  const args = ["find-generic-password", "-s", service];
  if (account) args.push("-a", account);
  args.push("-w");
  const result = spawnSync("/usr/bin/security", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function validatePython(candidate) {
  if (!candidate || !fileExists(candidate)) return false;
  const result = spawnSync(candidate, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  appendStartupLog(`Python probe ${candidate}: status=${result.status} output=${output}`);
  return result.status === 0;
}

function findPython(appRoot, gatewayDir) {
  const candidates = [
    path.join(appRoot, "python-runtime", "bin", "python3.12"),
    path.join(gatewayDir, ".venv", "bin", "python"),
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    "/usr/bin/python3",
  ];
  for (const candidate of candidates) {
    if (validatePython(candidate)) return candidate;
  }
  throw new Error(`No usable Python runtime found. Tried: ${candidates.join(", ")}`);
}

function copyDirIfMissing(source, target) {
  if (fileExists(target) || !fileExists(source)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, {
    recursive: true,
    filter(sourcePath) {
      const basename = path.basename(sourcePath);
      return basename !== ".DS_Store" && basename !== "__pycache__" && !basename.endsWith(".pyc");
    },
  });
}

function prepareDataDir(appRoot, userDataDir) {
  const dataDir = path.join(userDataDir, "data");
  copyDirIfMissing(path.join(appRoot, "data"), dataDir);
  fs.mkdirSync(path.join(dataDir, "sessions"), { recursive: true });
  return dataDir;
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  };
  return types[ext] || "application/octet-stream";
}

function injectRuntimeConfig(html, apiBase) {
  const script = `<script>window.__FDE_INTERVIEW_API_BASE__=${JSON.stringify(apiBase)};</script>`;
  if (html.includes("</head>")) return html.replace("</head>", `${script}</head>`);
  return `${script}${html}`;
}

function createStaticServer(distDir, apiBase) {
  return http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    const pathname = decodeURIComponent(requestUrl.pathname);
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    let filePath = path.resolve(distDir, relative);
    if (!filePath.startsWith(path.resolve(distDir))) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }
    if (!fileExists(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(distDir, "index.html");
    }
    try {
      const isIndex = path.basename(filePath) === "index.html";
      const data = fs.readFileSync(filePath, isIndex ? "utf8" : undefined);
      response.writeHead(200, { "Content-Type": getContentType(filePath) });
      response.end(isIndex ? injectRuntimeConfig(data, apiBase) : data);
    } catch (error) {
      response.writeHead(500);
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function findFreePort(startPort) {
  return new Promise((resolve, reject) => {
    const tryPort = (port, remaining) => {
      const tester = net.createServer();
      tester.once("error", () => {
        tester.close();
        if (remaining <= 0) {
          reject(new Error(`No free localhost port found near ${startPort}`));
          return;
        }
        tryPort(port + 1, remaining - 1);
      });
      tester.listen(port, "127.0.0.1", () => {
        tester.close(() => resolve(port));
      });
    };
    tryPort(startPort, 50);
  });
}

async function waitForHealth(apiBase) {
  const healthUrl = `${apiBase}/health`;
  let lastError = null;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return;
      lastError = new Error(`Gateway health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw lastError || new Error("Gateway did not become ready.");
}

function mergeRuntimeEnv(appRoot, userDataDir, desktopOrigin) {
  const userEnvPath = writeDefaultRuntimeEnv(userDataDir);
  const packagedEnv = readEnvFile(path.join(appRoot, "config", "runtime.env"));
  const userEnv = readEnvFile(userEnvPath);
  const merged = {
    ...packagedEnv,
    ...userEnv,
    ...process.env,
  };
  merged.PATH = `/opt/homebrew/bin:/usr/local/bin:${merged.PATH || ""}`;
  merged.FDE_CORS_ORIGINS = desktopOrigin;
  merged.FDE_DEMO_SESSION_ID = merged.FDE_DEMO_SESSION_ID ?? "";
  if (!merged.FDE_LLM_API_KEY) {
    const service = merged.FDE_LLM_KEYCHAIN_SERVICE || DEFAULT_KEYCHAIN_SERVICE;
    const account = merged.FDE_LLM_KEYCHAIN_ACCOUNT || os.userInfo().username;
    const keychainValue = readKeychainPassword(service, account);
    if (keychainValue) merged.FDE_LLM_API_KEY = keychainValue;
  }
  return merged;
}

function startGateway({ appRoot, userDataDir, gatewayPort, desktopOrigin }) {
  const gatewayDir = path.join(appRoot, "gateway");
  const modelDir = path.join(appRoot, "models", "asr", "sherpa-onnx-streaming-paraformer-bilingual-zh-en");
  const sherpaNodeModule = path.join(appRoot, "node_modules", "sherpa-onnx-node", "sherpa-onnx.js");
  const env = mergeRuntimeEnv(appRoot, userDataDir, desktopOrigin);
  env.FDE_GATEWAY_PORT = String(gatewayPort);
  env.FDE_INTERVIEW_ROOT_DIR = appRoot;
  env.FDE_INTERVIEW_DATA_DIR = prepareDataDir(appRoot, userDataDir);
  env.FDE_INTERVIEW_TEMPLATES_DIR = path.join(appRoot, "templates");
  env.SHERPA_ONNX_MODEL_DIR = env.SHERPA_ONNX_MODEL_DIR || modelDir;
  env.SHERPA_ONNX_NODE_MODULE = env.SHERPA_ONNX_NODE_MODULE || sherpaNodeModule;
  env.PYTHONPATH = [
    path.join(appRoot, "python-site-packages"),
    gatewayDir,
    path.join(gatewayDir, ".venv", "lib", "python3.12", "site-packages"),
    env.PYTHONPATH || "",
  ].filter(Boolean).join(path.delimiter);
  env.PYTHONUNBUFFERED = "1";
  env.PYTHONDONTWRITEBYTECODE = "1";

  const python = findPython(appRoot, gatewayDir);
  appendStartupLog(`Starting Gateway with python=${python}`);
  const child = spawn(python, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(gatewayPort)], {
    cwd: gatewayDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    appendStartupLog(`[gateway stdout] ${text.trimEnd()}`);
    process.stdout.write(`[gateway] ${chunk}`);
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    appendStartupLog(`[gateway stderr] ${text.trimEnd()}`);
    process.stderr.write(`[gateway] ${chunk}`);
  });
  child.on("exit", (code, signal) => {
    appendStartupLog(`Gateway exited code=${code} signal=${signal || ""}`);
    if (code !== 0 && !app.isQuitting) {
      console.error(`Gateway exited with code=${code} signal=${signal || ""}`);
    }
  });
  return child;
}

function stopGateway() {
  if (!gatewayProcess || gatewayProcess.killed) return;
  gatewayProcess.kill("SIGTERM");
  gatewayProcess = null;
}

function createMainWindow(url) {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1180,
    minHeight: 780,
    title: PRODUCT_NAME,
    backgroundColor: "#f7f8fb",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (targetUrl.startsWith("http://127.0.0.1:") || targetUrl.startsWith("http://localhost:")) {
      return { action: "allow" };
    }
    shell.openExternal(targetUrl);
    return { action: "deny" };
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.loadURL(url);
}

async function start() {
  const appRoot = resolveAppRoot();
  const userDataDir = app.getPath("userData");
  startupLogPath = path.join(userDataDir, "startup.log");
  appendStartupLog(`App starting packaged=${app.isPackaged} appRoot=${appRoot}`);
  const distDir = path.join(appRoot, "desktop", "dist");
  if (!fileExists(distDir)) {
    throw new Error(`Desktop build not found: ${distDir}`);
  }

  const gatewayPort = await findFreePort(DEFAULT_GATEWAY_PORT);
  const desktopPort = await findFreePort(DEFAULT_DESKTOP_PORT);
  const apiBase = `http://127.0.0.1:${gatewayPort}/api`;
  const desktopOrigin = `http://127.0.0.1:${desktopPort}`;

  staticServer = createStaticServer(distDir, apiBase);
  await listen(staticServer, desktopPort);
  gatewayProcess = startGateway({ appRoot, userDataDir, gatewayPort, desktopOrigin });
  await waitForHealth(apiBase);
  createMainWindow(`${desktopOrigin}/`);
}

app.whenReady().then(() => {
  start().catch((error) => {
    const message = error instanceof Error ? `${error.stack || error.message}` : String(error);
    appendStartupLog(`Startup failed: ${message}`);
    console.error(error);
    dialog.showErrorBox(
      "FDE 访谈助手启动失败",
      `${message}\n\n日志文件：${startupLogPath || "未写入"}`,
    );
    app.quit();
  });
});

app.on("before-quit", () => {
  app.isQuitting = true;
  stopGateway();
  if (staticServer) staticServer.close();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && mainWindow === null) {
    start().catch((error) => {
      const message = error instanceof Error ? `${error.stack || error.message}` : String(error);
      appendStartupLog(`Startup failed: ${message}`);
      console.error(error);
    });
  }
});
