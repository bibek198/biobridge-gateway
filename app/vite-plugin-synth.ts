import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, ViteDevServer } from "vite";

// Local API for the app's "Add a device" tab, served only by the dev server (`npm run dev`):
//   GET  /api/synth/models     models usable with the keys in the repo-root .env
//   POST /api/synth/jobs       start descriptor synthesis; returns { id }
//   GET  /api/synth/jobs/:id   progress and result
// The model calls run here, in Node, so API keys never reach the browser. A static build has no such API.

const MAX_BODY = 8 * 1024 * 1024;

/** The parts of src/synth/service.ts this plugin calls (loaded through Vite, so it can import app code). */
type SynthService = {
  availableModels(): Promise<{ id: string; label: string }[]>;
  startJob(req: unknown): string;
  getJob(id: string): unknown;
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("request too large"));
        req.destroy();
      } else parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Only this app may use the API: a page on another site could otherwise make the browser POST here and
 * spend the user's API credits. Cross-origin requests carry an Origin that will not match; requiring a JSON
 * content type also forces browsers to preflight them, which this middleware never approves.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return origin === undefined || origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`;
}

async function handle(server: ViteDevServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!sameOrigin(req)) return send(res, 403, { error: "cross-origin requests are not allowed" });
  const svc = (await server.ssrLoadModule("/src/synth/service.ts")) as unknown as SynthService;
  const url = req.url ?? "/";

  if (req.method === "GET" && url === "/models") return send(res, 200, { models: await svc.availableModels() });
  if (req.method === "POST" && url === "/jobs") {
    if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 415, { error: "expected application/json" });
    const id = svc.startJob(JSON.parse(await readBody(req)));
    return send(res, 202, { id });
  }
  const m = /^\/jobs\/([\w-]+)$/.exec(url);
  if (req.method === "GET" && m) {
    const job = svc.getJob(m[1]);
    return job ? send(res, 200, job) : send(res, 404, { error: "no such job" });
  }
  send(res, 404, { error: "not found" });
}

export function synthApi(): Plugin {
  return {
    name: "biobridge-synth-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api/synth", (req, res) => {
        handle(server, req, res).catch((err) => send(res, 400, { error: err instanceof Error ? err.message : String(err) }));
      });
    },
  };
}
