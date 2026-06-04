import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const productName = "FDE 访谈助手";
const executableName = "FDEInterviewAssistant";
const bundleId = "com.fde.interview-assistant";
const version = "0.1.1";
const arch = process.arch === "arm64" ? "arm64" : "x64";
const distDir = path.join(rootDir, "dist");
const buildDir = path.join(os.tmpdir(), `fde-interview-assistant-package-${process.pid}`);
const macDir = path.join(buildDir, "mac");
const appPath = path.join(macDir, `${productName}.app`);
const resourcesDir = path.join(appPath, "Contents", "Resources");
const packagedSourceDir = path.join(resourcesDir, "app");
const executablePath = path.join(appPath, "Contents", "MacOS", executableName);
const dmgRoot = path.join(buildDir, "dmg-root");
const dmgPath = path.join(distDir, `FDE-Interview-Assistant-${version}-mac-${arch}.dmg`);
const zipPath = path.join(distDir, `FDE-Interview-Assistant-${version}-mac-${arch}.zip`);
const sherpaSourceRoot = "/Users/aerfa/.npm-global/lib/node_modules/@getpaseo/cli/node_modules";

let activeSigningIdentity = "-";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function resolveElectronApp() {
  const candidates = [
    process.env.ELECTRON_APP_PATH,
    path.join(rootDir, "desktop", "node_modules", "electron", "dist", "Electron.app"),
    "/Users/aerfa/Desktop/FDE-OS/node_modules/electron/dist/Electron.app",
    "/Users/aerfa/Desktop/FDE-OS/node_modules/.pnpm/electron@42.1.0/node_modules/electron/dist/Electron.app",
  ].filter(Boolean);
  const match = candidates.find((candidate) => fs.existsSync(candidate));
  if (!match) {
    throw new Error("Electron runtime not found. Set ELECTRON_APP_PATH or install Electron locally.");
  }
  return match;
}

function findDeveloperIdIdentity() {
  const result = capture("security", ["find-identity", "-v", "-p", "codesigning"]);
  if (result.status !== 0) return "";
  const line = result.stdout.split(/\r?\n/).find((entry) => entry.includes('"Developer ID Application:'));
  const match = line?.match(/"([^"]+)"/);
  return match?.[1] ?? "";
}

function resolveSigningIdentity() {
  const configured = String(process.env.FDE_INTERVIEW_MAC_SIGN_IDENTITY ?? "").trim();
  const requireDeveloperId = process.env.FDE_INTERVIEW_REQUIRE_DEVELOPER_ID === "1";
  if (configured && configured !== "-") return configured;
  if (configured === "-" && !requireDeveloperId) return "-";

  const detected = findDeveloperIdIdentity();
  if (detected) return detected;
  if (requireDeveloperId) {
    throw new Error("Developer ID signing was required, but no Developer ID Application certificate was found.");
  }
  return "-";
}

function copyDir(source, target) {
  if (!fs.existsSync(source)) {
    throw new Error(`Missing source directory: ${source}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, {
    recursive: true,
    verbatimSymlinks: true,
    filter(sourcePath) {
      const basename = path.basename(sourcePath);
      if (basename === ".DS_Store") return false;
      if (basename === "__pycache__") return false;
      if (basename.endsWith(".pyc")) return false;
      if (basename === ".pytest_cache") return false;
      if (basename === "node_modules" && sourcePath.includes(`${path.sep}desktop${path.sep}`)) return false;
      return true;
    },
  });
}

function copyFile(relativePath) {
  const source = path.join(rootDir, relativePath);
  const target = path.join(packagedSourceDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function copyProjectDir(relativePath) {
  copyDir(path.join(rootDir, relativePath), path.join(packagedSourceDir, relativePath));
}

function copyExternalDir(source, targetRelativePath) {
  copyDir(source, path.join(packagedSourceDir, targetRelativePath));
}

function writePackagedPackageJson() {
  const runtimePackage = {
    name: "fde-interview-assistant",
    version,
    private: true,
    main: "electron/main.js",
  };
  fs.writeFileSync(path.join(packagedSourceDir, "package.json"), `${JSON.stringify(runtimePackage, null, 2)}\n`, "utf8");
}

function pythonRuntimeRoot() {
  const sourcePython = fs.realpathSync(path.join(rootDir, "gateway", ".venv", "bin", "python"));
  return path.dirname(path.dirname(sourcePython));
}

function pythonSitePackagesRoot() {
  return path.join(rootDir, "gateway", ".venv", "lib", "python3.12", "site-packages");
}

function copyPythonRuntime() {
  copyDir(pythonRuntimeRoot(), path.join(packagedSourceDir, "python-runtime"));
}

function copyPythonSitePackages() {
  copyDir(pythonSitePackagesRoot(), path.join(packagedSourceDir, "python-site-packages"));
}

function copyGatewayRuntime() {
  copyDir(path.join(rootDir, "gateway", "app"), path.join(packagedSourceDir, "gateway", "app"));
  copyFile("gateway/pyproject.toml");
  copyFile("gateway/uv.lock");
}

function plistSetOrAdd(plistPath, key, type, value) {
  const setResult = capture("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plistPath]);
  if (setResult.status === 0) return;
  run("/usr/libexec/PlistBuddy", ["-c", `Add :${key} ${type} ${value}`, plistPath]);
}

function updatePlist() {
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  plistSetOrAdd(plistPath, "CFBundleExecutable", "string", executableName);
  plistSetOrAdd(plistPath, "CFBundleName", "string", productName);
  plistSetOrAdd(plistPath, "CFBundleDisplayName", "string", productName);
  plistSetOrAdd(plistPath, "CFBundleIdentifier", "string", bundleId);
  plistSetOrAdd(plistPath, "CFBundleShortVersionString", "string", version);
  plistSetOrAdd(plistPath, "CFBundleVersion", "string", version);
  plistSetOrAdd(plistPath, "NSMicrophoneUsageDescription", "string", "FDE 访谈助手需要使用麦克风录制访谈音频，用于本地转写、需求分析和事后复核。");
}

function scrubDisallowedXattrs(targetPath) {
  const stack = [targetPath];
  const names = ["com.apple.FinderInfo", "com.apple.ResourceFork"];
  while (stack.length) {
    const current = stack.pop();
    for (const name of names) {
      spawnSync("xattr", ["-d", name, current], { stdio: "ignore" });
    }
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const child of fs.readdirSync(current)) {
      stack.push(path.join(current, child));
    }
  }
}

function writeReadme() {
  const text = `FDE 访谈助手 ${version}

安装方式：
1. 打开 DMG。
2. 将 FDE 访谈助手.app 拖到 Applications，或直接运行 ZIP 解压后的 app。
3. 如果 macOS 提示未验证开发者，请在 Finder 中右键 FDE 访谈助手.app，然后选择打开。

本地能力：
- 启动后自动拉起本机 FastAPI Gateway 和访谈工作台，不需要手动启动浏览器服务。
- 原始录音、转写、需求分析、PRD 和导出文件写入 macOS Application Support 目录。
- ASR 使用随包附带的 sherpa-onnx 本地模型，不调用外部转写服务。
- Python 3.12 runtime 和 Gateway 依赖随包附带，拷贝到另一台 Apple Silicon Mac 后不依赖打包机器的 .venv 路径。
- 大模型增强分析读取 macOS Keychain 中的 fde-interview-ark-api-key，不会把 key 写入应用包。

当前限制：
- 这是自用先行版，仍是本地 ad-hoc 签名；正式分发前需要 Developer ID notarization。
- 签名状态：${activeSigningIdentity === "-" ? "本地 ad-hoc 签名，未 notarize。" : `Developer ID 签名：${activeSigningIdentity}。`}
`;
  fs.writeFileSync(path.join(distDir, "INSTALL.txt"), text, "utf8");
  fs.copyFileSync(path.join(distDir, "INSTALL.txt"), path.join(dmgRoot, "INSTALL.txt"));
}

function verifyRequiredInputs() {
  const required = [
    "electron/main.js",
    "desktop/dist/index.html",
    "gateway/app/main.py",
    "gateway/.venv/bin/python",
    "models/asr/sherpa-onnx-streaming-paraformer-bilingual-zh-en/encoder.onnx",
  ];
  for (const relativePath of required) {
    if (!fs.existsSync(path.join(rootDir, relativePath))) {
      throw new Error(`Missing required package input: ${relativePath}`);
    }
  }
  const templatesRoot = path.join(rootDir, "templates");
  if (!fs.existsSync(templatesRoot) || !fs.readdirSync(templatesRoot).some((name) => name.endsWith(".yaml"))) {
    throw new Error("Missing local templates: templates/*.yaml");
  }
  if (!fs.existsSync(path.join(pythonRuntimeRoot(), "bin", "python3.12"))) {
    throw new Error(`Missing Python runtime: ${pythonRuntimeRoot()}`);
  }
  if (!fs.existsSync(path.join(pythonSitePackagesRoot(), "fastapi"))) {
    throw new Error(`Missing Python site-packages: ${pythonSitePackagesRoot()}`);
  }
  for (const moduleName of ["sherpa-onnx-node", "sherpa-onnx-darwin-arm64"]) {
    const modulePath = path.join(sherpaSourceRoot, moduleName);
    if (!fs.existsSync(modulePath)) {
      throw new Error(`Missing sherpa node module: ${modulePath}`);
    }
  }
}

function main() {
  const electronApp = resolveElectronApp();
  activeSigningIdentity = resolveSigningIdentity();

  run("npm", ["run", "build"], { cwd: path.join(rootDir, "desktop") });
  verifyRequiredInputs();

  fs.rmSync(distDir, { recursive: true, force: true });
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(macDir, { recursive: true });
  fs.cpSync(electronApp, appPath, { recursive: true, verbatimSymlinks: true });

  fs.renameSync(path.join(appPath, "Contents", "MacOS", "Electron"), executablePath);
  fs.rmSync(packagedSourceDir, { recursive: true, force: true });
  fs.mkdirSync(packagedSourceDir, { recursive: true });

  copyProjectDir("electron");
  copyProjectDir("desktop/dist");
  copyGatewayRuntime();
  copyPythonRuntime();
  copyPythonSitePackages();
  copyProjectDir("templates");
  copyProjectDir("data");
  copyDir(
    path.join(rootDir, "models", "asr", "sherpa-onnx-streaming-paraformer-bilingual-zh-en"),
    path.join(packagedSourceDir, "models", "asr", "sherpa-onnx-streaming-paraformer-bilingual-zh-en"),
  );
  copyExternalDir(path.join(sherpaSourceRoot, "sherpa-onnx-node"), path.join("node_modules", "sherpa-onnx-node"));
  copyExternalDir(path.join(sherpaSourceRoot, "sherpa-onnx-darwin-arm64"), path.join("node_modules", "sherpa-onnx-darwin-arm64"));
  copyFile("README.md");
  copyFile("CHANGELOG.md");
  copyProjectDir("docs");
  writePackagedPackageJson();
  updatePlist();

  scrubDisallowedXattrs(appPath);
  run("/usr/bin/codesign", ["--force", "--deep", "--sign", activeSigningIdentity, appPath]);
  scrubDisallowedXattrs(appPath);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);

  fs.mkdirSync(dmgRoot, { recursive: true });
  fs.cpSync(appPath, path.join(dmgRoot, `${productName}.app`), { recursive: true, verbatimSymlinks: true });
  try {
    fs.symlinkSync("/Applications", path.join(dmgRoot, "Applications"));
  } catch {
    // The app can still be installed by dragging it manually.
  }
  writeReadme();
  scrubDisallowedXattrs(dmgRoot);

  run("hdiutil", ["create", "-volname", productName, "-srcfolder", dmgRoot, "-ov", "-format", "UDZO", dmgPath]);
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath]);

  console.log(`Signing identity: ${activeSigningIdentity === "-" ? "ad-hoc local signing" : activeSigningIdentity}`);
  console.log(`Packaged app: ${appPath}`);
  console.log(`DMG: ${dmgPath}`);
  console.log(`ZIP: ${zipPath}`);
}

main();
