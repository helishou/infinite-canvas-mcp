import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const agent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "canvas-agent");
const tsx = pathToFileURL(createRequire(path.join(agent, "package.json")).resolve("tsx")).href;
// Launch the workspace's installed runner directly so Windows never needs a shell for npm.cmd.
const child = spawn(process.execPath, ["--import", tsx, "src/index.ts"], {
    cwd: agent,
    stdio: "inherit",
    env: { ...process.env, PORT: "17371" },
});
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
