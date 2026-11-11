import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { disposeAppServer, readRateLimits } from "./appServer";
import {
  formatBar,
  formatTimeRemaining,
  parseRateLimitResponse,
  RateLimitInfo,
  RateWindow,
} from "./rateLimits";

const USAGE_PAGE = "https://chatgpt.com/codex/settings/usage";
const CONFIG_SECTION = "codexUsageBar";

let statusItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let countdownTimer: ReturnType<typeof setInterval> | undefined;
let contextRef: vscode.ExtensionContext;
let activeDisplayMode = "session";
let activeAlignment = "left";
let activeLeftPosition = "normal";
let cachedInfo: RateLimitInfo | undefined;
let refreshInFlight = false;

function log(message: string): void {
  outputChannel.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

function platformDirectories(): string[] {
  const platforms: Record<string, string> = {
    win32: "win32",
    darwin: "darwin",
    linux: "linux",
  };
  const architectures: Record<string, string> = {
    x64: "x86_64",
    arm64: "aarch64",
    arm: "arm",
  };
  const platform = platforms[process.platform] ?? process.platform;
  const arch = architectures[process.arch] ?? process.arch;
  const current = `${platform}-${arch}`;
  if (process.platform === "darwin") return [`macos-${arch}`, current];
  if (process.platform === "win32") return [`windows-${arch}`, current];
  return [current];
}

function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveCodexPath(): string {
  const configured = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<string>("codexPath", "codex")
    .trim();
  if (configured && configured !== "codex") return configured;

  const officialExtension = vscode.extensions.getExtension("openai.chatgpt");
  if (officialExtension?.extensionPath) {
    const binRoot = path.join(officialExtension.extensionPath, "bin");
    const executableName = process.platform === "win32" ? "codex.exe" : "codex";
    const candidates = platformDirectories().map((directory) =>
      path.join(binRoot, directory, executableName)
    );
    try {
      for (const entry of fs.readdirSync(binRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.push(path.join(binRoot, entry.name, executableName));
      }
    } catch {
      // Fall back to the known platform paths and then PATH.
    }
    const bundled = candidates.find(isExecutable);
    if (bundled) return bundled;
  }
  return configured || "codex";
}

function friendlyError(error: unknown): string {
  const reason = (error as { reason?: string } | undefined)?.reason;
  if (reason === "not-found") {
    return "Codex executable not found. Install/sign in to Codex or configure codexUsageBar.codexPath.";
  }
  if (reason === "not-authenticated") {
    return "Codex is not signed in. Run `codex login`, then refresh.";
  }
  if (reason === "timeout") return "Codex app-server did not respond in time.";
  return error instanceof Error ? error.message : "Codex usage is unavailable.";
}

function startRefreshTimer(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  const configured = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<number>("refreshIntervalSeconds", 60);
  const intervalMs = Math.max(15, configured) * 1000;
  refreshTimer = setInterval(() => void refreshUsage(), intervalMs);
}

async function refreshUsage(): Promise<void> {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    log("Refreshing rate limits through the local Codex app-server...");
    const raw = await readRateLimits(resolveCodexPath());
    const parsed = parseRateLimitResponse(raw);
    if (!parsed) throw new Error("Codex returned no usable rate-limit windows.");
    cachedInfo = parsed;
    await contextRef.globalState.update("rateLimitInfo", parsed);
    updateDisplay();
    log(`Rate limits updated (${parsed.windows.length} window(s)).`);
  } catch (error) {
    const message = friendlyError(error);
    log(`Refresh failed: ${message}`);
    if (cachedInfo) {
      statusItem.tooltip = `${buildTooltip(cachedInfo)}\n\nLast refresh failed: ${message}`;
    } else {
      statusItem.text = "$(warning) Codex: unavailable";
      statusItem.tooltip = `Codex Usage Bar\n${"─".repeat(22)}\n${message}\n\nClick to retry.`;
      statusItem.backgroundColor = undefined;
      statusItem.show();
    }
  } finally {
    refreshInFlight = false;
  }
}

function displayPercent(window: RateWindow): number | undefined {
  if (window.usedPercent === undefined) return undefined;
  const mode = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<string>("percentageMode", "used");
  return mode === "remaining" ? 100 - window.usedPercent : window.usedPercent;
}

function showsBar(kind: "session" | "weekly"): boolean {
  const mode = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<string>("progressBar", "both");
  return mode === "both" || mode === kind;
}

function formatLimitText(label: string, window: RateWindow): string {
  const percentage = displayPercent(window);
  const value = percentage === undefined ? "?%" : `${Math.round(percentage)}%`;
  const bar = percentage !== undefined && showsBar(window.kind as "session" | "weekly")
    ? `${formatBar(percentage)} `
    : "";
  const reset = window.resetsAt ? ` · ${formatTimeRemaining(window.resetsAt)}` : "";
  return `${label} ${bar}${value}${reset}`;
}

function providerPrefix(): string {
  const showLabel = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<boolean>("showProviderLabel", false);
  return showLabel ? "$(pulse) Codex " : "$(pulse) ";
}

function configuredAlignment(): string {
  return vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<string>("alignment", "left");
}

function configuredLeftPosition(): string {
  return vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<string>("leftPosition", "normal");
}

function createStatusItem(): void {
  const previousText = statusItem?.text;
  const previousTooltip = statusItem?.tooltip;
  const previousBackground = statusItem?.backgroundColor;
  statusItem?.dispose();
  activeAlignment = configuredAlignment();
  activeLeftPosition = configuredLeftPosition();
  const alignment =
    activeAlignment === "left"
      ? vscode.StatusBarAlignment.Left
      : vscode.StatusBarAlignment.Right;
  // Status-bar entries are ordered by descending priority. Far-left placement
  // is opt-in so a published extension does not override every user's layout.
  const priority =
    activeAlignment === "left"
      ? activeLeftPosition === "farLeft"
        ? 1_000_000
        : 0
      : 48;
  statusItem = vscode.window.createStatusBarItem(alignment, priority);
  statusItem.name = "Codex Usage Bar";
  statusItem.command = "codexUsageBar.refreshRateLimit";
  contextRef.subscriptions.push(statusItem);
  if (previousText) {
    statusItem.text = previousText;
    statusItem.tooltip = previousTooltip;
    statusItem.backgroundColor = previousBackground;
    statusItem.show();
  }
}

function buildTooltip(info: RateLimitInfo): string {
  const percentageMode = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<string>("percentageMode", "used");
  const lines = ["Codex Rate Limit", "─".repeat(22)];
  if (info.planType) lines.push(`Plan: ${info.planType}`);

  for (const window of info.windows) {
    const used = window.usedPercent === undefined ? "?" : `${Math.round(window.usedPercent)}%`;
    const remaining =
      window.usedPercent === undefined ? "?" : `${Math.round(100 - window.usedPercent)}%`;
    const reset = window.resetsAt ? formatTimeRemaining(window.resetsAt) : "?";
    lines.push(
      `${window.label}: ${percentageMode === "remaining" ? remaining : used} · resets ${reset}`
    );
  }
  if (info.resetCreditsAvailable && info.resetCreditsAvailable > 0) {
    lines.push(`Reset credits: ${info.resetCreditsAvailable}`);
  }
  lines.push("", "Reads metadata from the official local Codex app-server.", "Click to refresh.");
  return lines.join("\n");
}

function updateDisplay(): void {
  if (!cachedInfo) return;
  const session = cachedInfo.windows.find((window) => window.kind === "session");
  const weekly = cachedInfo.windows.find((window) => window.kind === "weekly");
  const showSession = activeDisplayMode === "session" || activeDisplayMode === "both";
  const showWeekly = activeDisplayMode === "weekly" || activeDisplayMode === "both";

  const parts: string[] = [];
  if (showSession && session) parts.push(formatLimitText("S:", session));
  if (showWeekly && weekly) parts.push(formatLimitText("W:", weekly));
  if (parts.length === 0) {
    const fallback = cachedInfo.windows[0];
    parts.push(formatLimitText("Q:", fallback));
  }

  statusItem.text = `${providerPrefix()}${parts.join("  ")}`;
  const used = [session?.usedPercent, weekly?.usedPercent].filter(
    (value): value is number => value !== undefined
  );
  const maxUsed = used.length ? Math.max(...used) : 0;
  if (maxUsed >= 90) {
    statusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  } else if (maxUsed >= 70) {
    statusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  } else {
    statusItem.backgroundColor = undefined;
  }
  statusItem.tooltip = buildTooltip(cachedInfo);
  statusItem.show();
}

export function activate(context: vscode.ExtensionContext): void {
  contextRef = context;
  outputChannel = vscode.window.createOutputChannel("Codex Usage Bar");
  context.subscriptions.push(outputChannel);
  log("Extension activating (v0.1.6 — shared pulse icon)");

  activeDisplayMode = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<string>("displayMode", "session");
  cachedInfo = context.globalState.get<RateLimitInfo>("rateLimitInfo");

  createStatusItem();
  if (cachedInfo) {
    updateDisplay();
  } else {
    statusItem.text = `${providerPrefix()}Waiting...`;
    statusItem.tooltip = "Codex Usage Bar\nFetching 5-hour and weekly limits...";
    statusItem.show();
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("codexUsageBar.refreshRateLimit", () => refreshUsage()),
    vscode.commands.registerCommand("codexUsageBar.switchDisplayMode", async () => {
      activeDisplayMode =
        activeDisplayMode === "session"
          ? "weekly"
          : activeDisplayMode === "weekly"
            ? "both"
            : "session";
      await vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .update("displayMode", activeDisplayMode, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(`Codex Usage Bar: showing ${activeDisplayMode}`, 3000);
      updateDisplay();
    }),
    vscode.commands.registerCommand("codexUsageBar.openUsagePage", () =>
      vscode.env.openExternal(vscode.Uri.parse(USAGE_PAGE))
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(CONFIG_SECTION)) return;
      if (
        configuredAlignment() !== activeAlignment ||
        configuredLeftPosition() !== activeLeftPosition
      ) {
        createStatusItem();
      }
      activeDisplayMode = vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<string>("displayMode", activeDisplayMode);
      startRefreshTimer();
      updateDisplay();
    })
  );

  startRefreshTimer();
  countdownTimer = setInterval(updateDisplay, 30_000);
  void refreshUsage();

  context.subscriptions.push({
    dispose: () => {
      if (refreshTimer) clearInterval(refreshTimer);
      if (countdownTimer) clearInterval(countdownTimer);
      disposeAppServer();
    },
  });
}

export function deactivate(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  if (countdownTimer) clearInterval(countdownTimer);
  disposeAppServer();
}
