// Lists the Gemini models your key can use for descriptor synthesis:  npm run gemini:models
// Then run e.g.  SYNTH_LIVE=1 SYNTH_MODELS=gemini:<id> npm run eval:synth
// Reads GEMINI_API_KEY from the environment or the repo-root .env.

import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { listGeminiModels } from "../src/synth/providers.ts";

const dotenv = new URL("../../.env", import.meta.url);
if (existsSync(dotenv)) {
  for (const [k, v] of Object.entries(parseEnv(readFileSync(dotenv, "utf8")))) if (!process.env[k] && v) process.env[k] = v;
}
if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
  console.error("No GEMINI_API_KEY: add it to .env at the repo root (see .env.example).");
  process.exit(1);
}
for (const id of await listGeminiModels()) console.log(id);
