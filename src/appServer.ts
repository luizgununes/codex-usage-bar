import { ChildProcessWithoutNullStreams, spawn } from "child_process";

const DEFAULT_TIMEOUT_MS = 20_000;
let activeChild: ChildProcessWithoutNullStreams | undefined;

function classifiedError(message: string, reason: string): Error {
  return Object.assign(new Error(message), { reason });
}

export function readRateLimits(
  codexPath: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(codexPath, ["app-server"], {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reject(classifiedError(`Failed to start Codex: ${message}`, "not-found"));
      return;
    }
    activeChild = child;

    let settled = false;
    let buffer = "";
    const handlers = new Map<string, (message: Record<string, unknown>) => void>();
    const timeout = setTimeout(() => {
      finishError(classifiedError("Codex app-server did not respond in time.", "timeout"));
    }, timeoutMs);
    timeout.unref?.();

    const cleanup = () => {
      clearTimeout(timeout);
      handlers.clear();
      if (activeChild === child) activeChild = undefined;
      try {
        child.stdin.end();
      } catch {
        // Already closed.
      }
      try {
        child.kill("SIGTERM");
      } catch {
        // Already stopped.
      }
    };

    function finishError(error: Error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }

    function finishSuccess(result: unknown) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    const send = (payload: Record<string, unknown>) => {
      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        finishError(classifiedError(`Failed to write to Codex: ${message}`, "protocol"));
      }
    };

    const request = (
      id: number,
      method: string,
      params: unknown,
      handler: (message: Record<string, unknown>) => void
    ) => {
      handlers.set(String(id), handler);
      send({ jsonrpc: "2.0", id, method, params });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          const handler = handlers.get(String(message.id));
          if (handler) {
            handlers.delete(String(message.id));
            handler(message);
          }
        } catch {
          // Ignore non-protocol output.
        }
      }
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});

    child.on("error", (error: NodeJS.ErrnoException) => {
      const reason = error.code === "ENOENT" ? "not-found" : "not-executable";
      finishError(classifiedError(`Failed to start Codex: ${error.message}`, reason));
    });
    child.on("exit", (code, signal) => {
      finishError(
        classifiedError(
          `Codex app-server exited unexpectedly (${code ?? signal ?? "unknown"}).`,
          "exited"
        )
      );
    });

    request(
      1,
      "initialize",
      {
        clientInfo: {
          name: "codex-usage-bar-vscode",
          title: "Codex Usage Bar",
          version: "0.1.6",
        },
        capabilities: { experimentalApi: true },
      },
      (message) => {
        if (message.error) {
          finishError(classifiedError("Codex initialization failed.", "rpc"));
          return;
        }
        send({ jsonrpc: "2.0", method: "initialized" });
        request(2, "account/rateLimits/read", null, (response) => {
          if (response.error) {
            const error = response.error as Record<string, unknown>;
            const text = String(error.message ?? "");
            const reason = /login|logged|signed|auth|credential|unauthor/i.test(text)
              ? "not-authenticated"
              : "rpc";
            finishError(classifiedError("Codex rate-limit request failed.", reason));
            return;
          }
          finishSuccess(response.result);
        });
      }
    );
  });
}

export function disposeAppServer(): void {
  if (!activeChild) return;
  try {
    activeChild.kill("SIGKILL");
  } catch {
    // Already stopped.
  }
  activeChild = undefined;
}
