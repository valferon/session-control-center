// Bundle src/test/*.test.ts with esbuild and run them under `node --test`.
// The data layer under test (jsonlParser, computeStatus) has no vscode
// dependency, so tests run in plain node — no VS Code test host needed.
import * as esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testSrcDir = path.join(root, "src", "test");
// Deliberately OUTSIDE dist/: .vscodeignore re-includes dist/** with a
// negation, and vsce negations always win — anything under dist/ ships.
const outDir = path.join(root, "dist-test");

const entryPoints = fs
  .readdirSync(testSrcDir)
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => path.join(testSrcDir, f));

if (entryPoints.length === 0) {
  console.error("no *.test.ts files under src/test");
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });

await esbuild.build({
  entryPoints,
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outdir: outDir,
  external: ["vscode"],
  sourcemap: true,
  logLevel: "warning",
});

const bundled = fs
  .readdirSync(outDir)
  .filter((f) => f.endsWith(".test.js"))
  .map((f) => path.join(outDir, f));

const result = spawnSync(process.execPath, ["--test", "--enable-source-maps", ...bundled], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
