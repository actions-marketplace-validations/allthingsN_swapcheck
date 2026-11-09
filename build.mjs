import { build } from "esbuild";
import { readFileSync, mkdirSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
mkdirSync("dist", { recursive: true });
const shared = {
  bundle: true, platform: "node", format: "esm", target: "node22", legalComments: "none",
  define: { __SWAPCHECK_VERSION__: JSON.stringify(pkg.version) },
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
};
await build({ ...shared, entryPoints: ["src/cli/main.ts"], outfile: "dist/cli.mjs", banner: { js: `#!/usr/bin/env node\n${shared.banner.js}` } });
await build({ ...shared, entryPoints: ["src/index.ts"], outfile: "dist/index.mjs" });
await build({ ...shared, entryPoints: ["src/action/main.ts"], outfile: "action-dist/index.mjs" });
console.log(`built swapcheck ${pkg.version}`);
