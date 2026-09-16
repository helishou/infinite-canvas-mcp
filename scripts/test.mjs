import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// 同一入口发现每个 workspace 的全部 node:test 文件，避免手动清单漏测。
const require = createRequire(new URL("../backend/package.json", import.meta.url));
const tests = readdirSync("src", { recursive: true }).filter((file) => /\.test\.tsx?$/.test(file)).sort().map((file) => resolve("src", file));
if (!tests.length) throw new Error("没有发现测试文件");
const result = spawnSync(process.execPath, ["--import", pathToFileURL(require.resolve("tsx")).href, "--test", ...tests], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
