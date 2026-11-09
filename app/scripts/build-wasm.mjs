// Compiles the firmware's DSP library (firmware/lib/bbdsp) to WebAssembly for the browser:
//   npm run build:wasm
// The output, src/dsp/bbdsp.wasm, is committed, so the app builds without a C toolchain; rerun this only
// after changing the C sources. Needs Zig (C compiler with a wasm32 target):
//   `zig` on PATH (e.g. `brew install zig`), or `pip install ziglang`, or ZIG="python3 -m ziglang".

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lib = resolve(app, "../firmware/lib/bbdsp");
const out = resolve(app, "src/dsp/bbdsp.wasm");

function findZig() {
  if (process.env.ZIG) return process.env.ZIG.split(" ");
  for (const candidate of [["zig"], ["python3", "-m", "ziglang"]]) {
    try {
      execFileSync(candidate[0], [...candidate.slice(1), "version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // try the next one
    }
  }
  throw new Error("Zig not found. Install it (`brew install zig` or `pip install ziglang`) or set ZIG.");
}

const zig = findZig();
const args = [
  ...zig.slice(1),
  "cc",
  "-target",
  "wasm32-freestanding",
  "-O2",
  "-std=c99",
  "-Wall",
  "-Werror",
  "-mbulk-memory", // struct zeroing lowers to memory.fill instead of a libc memset
  "-nostdlib",
  "-Wl,--no-entry",
  "-o",
  out,
  resolve(lib, "src/bbdsp.c"),
  resolve(lib, "wasm/bbdsp_wasm.c"),
];
execFileSync(zig[0], args, { stdio: "inherit" });
const version = execFileSync(zig[0], [...zig.slice(1), "version"]).toString().trim();
console.log(`wrote ${out} (${statSync(out).size} bytes) with zig ${version}`);
