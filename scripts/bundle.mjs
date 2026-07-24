import { build } from "esbuild";
import { rmSync, mkdirSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// jsdom resolves its synchronous-XHR worker at module load with
// `require.resolve("./xhr-sync-worker.js")`. esbuild can't bundle that runtime
// resolve, so the file must sit next to the bundled handler or the Lambda throws
// at init and 500s every request. We never do synchronous XHR (Readability parses
// a static DOM), so the worker is never spawned — the file only needs to exist.
const jsdomSyncWorker = require.resolve("jsdom/lib/jsdom/living/xhr/xhr-sync-worker.js");

// Bundle each Lambda handler into dist/<name>/index.js so CDK can zip a small,
// self-contained artifact per function.
const handlers = [
  { name: "api", entry: "src/handlers/api.ts" },
  { name: "poller", entry: "src/handlers/poller.ts" },
  { name: "synthCallback", entry: "src/handlers/synthCallback.ts" },
];

rmSync("dist", { recursive: true, force: true });

for (const { name, entry } of handlers) {
  mkdirSync(`dist/${name}`, { recursive: true });
  await build({
    entryPoints: [entry],
    // Emit .mjs: the bundle is ESM (import/export, import.meta.url), and Lambda's
    // Node runtime loads a plain index.js as CommonJS — which throws
    // "Cannot use import statement outside a module" at init and 500s every
    // request. The .mjs extension makes Lambda treat it as an ES module.
    outfile: `dist/${name}/index.mjs`,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    sourcemap: true,
    // Provide a require() shim so CJS deps work under ESM output.
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
    // The AWS SDK v3 is available in the Lambda Node 20 runtime; keep it external
    // to shrink the bundle. Everything else is bundled.
    external: ["@aws-sdk/*"],
    logLevel: "info",
  });
  // Place jsdom's sync-XHR worker beside the bundle so its init-time
  // require.resolve("./xhr-sync-worker.js") succeeds (see note above).
  copyFileSync(jsdomSyncWorker, `dist/${name}/xhr-sync-worker.js`);
}

console.log("Bundled handlers:", handlers.map((h) => h.name).join(", "));
