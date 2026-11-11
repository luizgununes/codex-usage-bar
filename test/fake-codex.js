#!/usr/bin/env node

const readline = require("readline");

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n`);
  } else if (message.method === "account/rateLimits/read") {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          rateLimitsByLimitId: {
            codex: {
              planType: "plus",
              primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: 1787521415 },
              secondary: { usedPercent: 39, windowDurationMins: 10080, resetsAt: 1787921415 },
            },
          },
        },
      })}\n`
    );
  }
});
