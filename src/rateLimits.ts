export type WindowKind = "session" | "weekly" | "other";

export interface RateWindow {
  kind: WindowKind;
  label: string;
  usedPercent: number | undefined;
  resetsAt: number | undefined;
  windowDurationMins: number | undefined;
}

export interface RateLimitInfo {
  windows: RateWindow[];
  planType?: string;
  resetCreditsAvailable?: number;
}

function clampPercent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : undefined;
}

function parseResetAt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value >= 1e12 ? value / 1000 : value;
}

function parseWindow(value: unknown): RateWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const duration =
    typeof raw.windowDurationMins === "number" && Number.isFinite(raw.windowDurationMins)
      ? raw.windowDurationMins
      : undefined;

  let kind: WindowKind = "other";
  let label = duration ? `${duration}m` : "Quota";
  if (duration === 300) {
    kind = "session";
    label = "Session (5h)";
  } else if (duration === 10080) {
    kind = "weekly";
    label = "Weekly (7d)";
  }

  return {
    kind,
    label,
    usedPercent: clampPercent(raw.usedPercent),
    resetsAt: parseResetAt(raw.resetsAt),
    windowDurationMins: duration,
  };
}

function selectSnapshot(result: Record<string, unknown>): Record<string, unknown> | undefined {
  const buckets = result.rateLimitsByLimitId;
  if (buckets && typeof buckets === "object") {
    const byId = buckets as Record<string, unknown>;
    if (byId.codex && typeof byId.codex === "object") {
      return byId.codex as Record<string, unknown>;
    }
  }

  if (result.rateLimits && typeof result.rateLimits === "object") {
    return result.rateLimits as Record<string, unknown>;
  }

  if (buckets && typeof buckets === "object") {
    const candidates = Object.values(buckets).filter(
      (candidate) => candidate && typeof candidate === "object"
    );
    if (candidates.length === 1) return candidates[0] as Record<string, unknown>;
  }
  return undefined;
}

export function parseRateLimitResponse(value: unknown): RateLimitInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const result = value as Record<string, unknown>;
  const snapshot = selectSnapshot(result);
  if (!snapshot) return undefined;

  const windows = [parseWindow(snapshot.primary), parseWindow(snapshot.secondary)]
    .filter((window): window is RateWindow => window !== undefined)
    .sort(
      (a, b) =>
        (a.windowDurationMins ?? Number.POSITIVE_INFINITY) -
        (b.windowDurationMins ?? Number.POSITIVE_INFINITY)
    );
  if (windows.length === 0) return undefined;

  const credits = result.rateLimitResetCredits;
  const availableCount =
    credits &&
    typeof credits === "object" &&
    typeof (credits as Record<string, unknown>).availableCount === "number"
      ? ((credits as Record<string, unknown>).availableCount as number)
      : undefined;

  return {
    windows,
    planType: typeof snapshot.planType === "string" ? snapshot.planType : undefined,
    resetCreditsAvailable: availableCount,
  };
}

export function formatTimeRemaining(epochSeconds: number, now = Date.now()): string {
  const diff = Math.floor(epochSeconds - now / 1000);
  if (diff <= 0) return "soon";
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatBar(percent: number): string {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * 10);
  return "●".repeat(filled) + "○".repeat(10 - filled);
}
