import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
await mkdir(resolve(root, "dist/main"), { recursive: true });
await mkdir(resolve(root, "dist/preload"), { recursive: true });

const shared = {
  bundle: true,
  platform: "node",
  target: "node24",
  sourcemap: true,
  external: ["electron"],
  logLevel: "info",
};

await Promise.all([
  build({
    ...shared,
    entryPoints: [resolve(root, "src/main/index.ts")],
    outfile: resolve(root, "dist/main/index.cjs"),
    format: "cjs",
  }),
  build({
    ...shared,
    entryPoints: [resolve(root, "src/preload/index.ts")],
    outfile: resolve(root, "dist/preload/index.cjs"),
    format: "cjs",
  }),
]);

