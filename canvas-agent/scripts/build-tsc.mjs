// canvas-agent tsc wrapper: bump V8 stack size so the compiler does not
// crash with STATUS_STACK_BUFFER_OVERRUN (exit 3221226505) on this large
// project under Node 22. Resolves the real tsc bin via node module resolution
// so it works regardless of npm workspace hoisting and non-ASCII paths.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tsc = require.resolve("typescript/bin/tsc", { paths: [process.cwd()] });
const result = spawnSync(process.execPath, ["--stack-size=8000", tsc, "-p", "tsconfig.json"], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
