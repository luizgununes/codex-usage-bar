const { readRateLimits } = require("../out/appServer.js");
const { parseRateLimitResponse } = require("../out/rateLimits.js");

const codexPath = process.env.CODEX_BIN || "codex";

async function main() {
  const raw = await readRateLimits(codexPath);
  const parsed = parseRateLimitResponse(raw);
  if (!parsed) throw new Error("Codex returned no usable rate-limit windows.");

  console.log("SMOKE: Codex app-server handshake and rate-limit read succeeded");
  if (parsed.planType) console.log(`  plan: ${parsed.planType}`);
  for (const window of parsed.windows) {
    console.log(`  ${window.label}: ${window.usedPercent ?? "?"}% used`);
  }
}

main().catch((error) => {
  console.error(`SMOKE FAILED: ${error.message}`);
  process.exit(1);
});
