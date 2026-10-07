// Self-check: runs the real out/extension.js against a stubbed `vscode`, a fake
// api.anthropic.com, a temp HOME and a Linux platform. Run with `npm test`.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { EventEmitter } = require("events");

// Isolated HOME + Linux, so the real macOS keychain is never read (#11 path).
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cub-test-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
Object.defineProperty(process, "platform", { value: "linux" });

// Fake usage API: returns `apiBody`, records the Authorization header.
let apiBody = "{}";
let lastAuth;
require("https").request = (opts, cb) => {
  lastAuth = opts.headers.Authorization;
  const req = new EventEmitter();
  req.destroy = () => {};
  req.end = () => {
    const res = new EventEmitter();
    res.statusCode = 200;
    cb(res);
    res.emit("data", apiBody);
    res.emit("end");
  };
  return req;
};

// Minimal vscode API stub.
const config = { displayMode: "both" };
const items = [];
const commands = {};
const logs = [];
const vscodeStub = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1 },
  ThemeColor: class { constructor(id) { this.id = id; } },
  window: {
    createOutputChannel: () => ({ appendLine: (l) => logs.push(l), dispose() {} }),
    createStatusBarItem: () => {
      const item = { text: "", visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
      items.push(item);
      return item;
    },
    setStatusBarMessage: () => {},
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/tmp/demo-proj" } }],
    getConfiguration: () => ({
      get: (k, d) => (k in config ? config[k] : d),
      inspect: (k) => ({ globalValue: config[k] }),
      update: async (k, v) => { config[k] = v; },
    }),
  },
  commands: { registerCommand: (id, fn) => { commands[id] = fn; return { dispose() {} }; } },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === "vscode" ? vscodeStub : origLoad.call(this, request, ...rest);
};

// Claude Code transcripts for /tmp/demo-proj (#10, #12).
const transcripts = path.join(HOME, ".claude", "projects", "-tmp-demo-proj");
fs.mkdirSync(transcripts, { recursive: true });
const turn = (model, usage, extra = {}) => JSON.stringify({ type: "assistant", message: { model, usage }, ...extra });
const ctx80k = { input_tokens: 2, cache_creation_input_tokens: 13232, cache_read_input_tokens: 66545, output_tokens: 50 };
fs.writeFileSync(path.join(transcripts, "older.jsonl"), turn("claude-sonnet-4-5", ctx80k) + "\n");
fs.utimesSync(path.join(transcripts, "older.jsonl"), new Date(2020, 0, 1), new Date(2020, 0, 1));
const current = path.join(transcripts, "current.jsonl");
fs.writeFileSync(current, [
  '{"type":"user","message":{"role":"user","content":"hi"}}',
  turn("claude-opus-5-5", ctx80k),
  turn("claude-haiku-4-5-20251001", { input_tokens: 9 }, { isSidechain: true }), // subagent — ignored
  turn("<synthetic>", { input_tokens: 0 }), // API-error placeholder — ignored
].join("\n") + "\n");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const refresh = () => commands["claudeUsageBar.refresh"]();
const BAR = /[●○]{10}/;

async function main() {
  const state = {};
  const ctx = { subscriptions: [], globalState: { get: (k) => state[k], update: async (k, v) => { state[k] = v; } } };
  require("../out/extension.js").activate(ctx);
  const [usage, session] = items;
  const seg = (label) => usage.text.split("  ").find((p) => p.includes(label));

  // #15 / #16 — no credentials: say so, and never fall back to "Usage OK".
  assert.match(usage.text, /not signed in/, "#15: missing creds should say not signed in");
  for (let i = 0; i < 3; i++) commands["claudeUsageBar.switchDisplayMode"](); // redraws, back to "both"
  assert.match(usage.text, /not signed in/, "#16: redraw without data must not show Usage OK");

  // #11 — token comes from ~/.claude/.credentials.json off macOS.
  fs.writeFileSync(path.join(HOME, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok-linux" } }));
  const future = new Date(Date.now() + 3 * 3600e3).toISOString();
  apiBody = JSON.stringify({ five_hour: { utilization: 1.0, resets_at: future }, seven_day: { utilization: 29.0, resets_at: future } });
  refresh();
  assert.equal(lastAuth, "Bearer tok-linux", "#11: token from credentials file");

  // #13 — API 1.0 means 1%, not 100%; and 29.0 must not float-floor to 28%.
  assert.match(seg("S:"), / 1% /, `#13: expected 1%, got "${usage.text}"`);
  assert.doesNotMatch(usage.text, /100%/);
  assert.match(seg("W:"), / 29% /, `expected 29%, got "${usage.text}"`);

  // #16 — a response without a session window shows 0%, not "Usage OK".
  apiBody = JSON.stringify({ five_hour: null, seven_day: { utilization: 19.0 } });
  refresh();
  assert.match(seg("S:"), / 0%/, `#16: expected S: 0%, got "${usage.text}"`);
  assert.doesNotMatch(usage.text, /Usage OK/);

  // #9 — progress bar per limit.
  assert.match(seg("S:"), BAR); assert.match(seg("W:"), BAR); // default "both"
  config.progressBar = "session"; refresh();
  assert.match(seg("S:"), BAR); assert.doesNotMatch(seg("W:"), BAR);
  config.progressBar = "weekly"; refresh();
  assert.doesNotMatch(seg("S:"), BAR); assert.match(seg("W:"), BAR);
  delete config.progressBar; config.showProgressBar = false; refresh();
  assert.doesNotMatch(usage.text, BAR, "legacy showProgressBar=false still hides bars");
  config.progressBar = "weekly"; refresh();
  assert.match(seg("W:"), BAR, "explicit progressBar wins over legacy toggle");

  // diagnostics_channel intercept on a real HTTP round-trip: parses the body AND
  // leaves Node's own 'end' handler working (it threw when called without `this`).
  const http = require("http");
  const server = http.createServer((q, r) => r.end(JSON.stringify({ five_hour: { utilization: 42.0 } })));
  await new Promise((r) => server.listen(0, r));
  await new Promise((resolve, reject) => {
    const req = http.request({ port: server.address().port, path: "/api/oauth/usage", headers: { host: "api.anthropic.com" } }, (res) => res.on("data", () => {})); // like axios
    req.on("close", resolve);
    req.on("error", reject);
    req.end();
  });
  server.close();
  assert.match(seg("S:"), / 42%/, `intercept: expected 42%, got "${usage.text}"`);

  // #10 / #12 — model + context from the newest transcript, sidechain/synthetic skipped.
  assert.ok(session.visible);
  assert.equal(session.text, "$(hubot) Opus 5.5 · Ctx 80K");

  // ...and it follows the transcript live (fs.watch + 1s debounce).
  fs.appendFileSync(current, turn("claude-haiku-4-5-20251001", { input_tokens: 5, cache_read_input_tokens: 150000 }) + "\n");
  await sleep(2500);
  assert.equal(session.text, "$(hubot) Haiku 4.5 · Ctx 150K");

  config.showSessionInfo = false;
  fs.appendFileSync(current, turn("claude-opus-5-5", ctx80k) + "\n");
  await sleep(2500);
  assert.equal(session.visible, false, "showSessionInfo=false hides the item");

  ctx.subscriptions.forEach((d) => d.dispose());
  console.log("selftest: all checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err.message);
  console.error("--- extension log ---\n" + logs.join("\n"));
  process.exit(1);
});
