const assert = require("assert");
const path = require("path");
const { readRateLimits } = require("../out/appServer.js");
const {
  formatBar,
  formatTimeRemaining,
  parseRateLimitResponse,
} = require("../out/rateLimits.js");

function fixture() {
  return {
    rateLimitsByLimitId: {
      codex: {
        planType: "plus",
        primary: {
          usedPercent: 18,
          windowDurationMins: 300,
          resetsAt: 1787521415,
        },
        secondary: {
          usedPercent: 39,
          windowDurationMins: 10080,
          resetsAt: 1787921415,
        },
      },
    },
    rateLimitResetCredits: { availableCount: 2 },
  };
}

async function main() {
  const parsed = parseRateLimitResponse(fixture());
  assert(parsed, "rate-limit response should parse");
  assert.equal(parsed.planType, "plus");
  assert.equal(parsed.windows.length, 2);
  assert.equal(parsed.windows[0].kind, "session");
  assert.equal(parsed.windows[0].label, "Session (5h)");
  assert.equal(parsed.windows[0].usedPercent, 18);
  assert.equal(parsed.windows[1].kind, "weekly");
  assert.equal(parsed.windows[1].label, "Weekly (7d)");
  assert.equal(parsed.windows[1].usedPercent, 39);
  assert.equal(parsed.resetCreditsAvailable, 2);

  const legacy = parseRateLimitResponse({
    rateLimits: {
      primary: { usedPercent: -10, windowDurationMins: 300, resetsAt: 1787521415000 },
      secondary: { usedPercent: 140, windowDurationMins: 10080 },
    },
  });
  assert.equal(legacy.windows[0].usedPercent, 0, "percentages clamp at zero");
  assert.equal(legacy.windows[1].usedPercent, 100, "percentages clamp at 100");
  assert.equal(legacy.windows[0].resetsAt, 1787521415, "millisecond timestamps normalize");

  assert.equal(parseRateLimitResponse(null), undefined);
  assert.equal(parseRateLimitResponse({ rateLimits: { primary: null, secondary: null } }), undefined);
  assert.equal(formatBar(40), "●●●●○○○○○○");
  assert.equal(formatTimeRemaining(10_000, 1_000_000), "2h 30m");

  const fakeCodex = path.join(__dirname, "fake-codex.js");
  const raw = await readRateLimits(fakeCodex, 5_000);
  const fromRpc = parseRateLimitResponse(raw);
  assert(fromRpc, "JSON-RPC app-server result should parse");
  assert.equal(fromRpc.windows[0].usedPercent, 18);
  assert.equal(fromRpc.windows[1].usedPercent, 39);

  console.log("selftest: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
