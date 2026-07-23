import { build } from "esbuild";
import { rmSync, mkdirSync } from "node:fs";

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
    outfile: `dist/${name}/index.js`,
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
}

console.log("Bundled handlers:", handlers.map((h) => h.name).join(", "));
