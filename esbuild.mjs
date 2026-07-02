import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: "dist/extension.js",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: ["webview-ui/src/main.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  outfile: "dist/webview/main.js",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

async function run() {
  if (watch) {
    const c1 = await esbuild.context(extensionConfig);
    const c2 = await esbuild.context(webviewConfig);
    await Promise.all([c1.watch(), c2.watch()]);
    console.log("[esbuild] watching...");
  } else {
    await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
    console.log("[esbuild] build complete");
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
