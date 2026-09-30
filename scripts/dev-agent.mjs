import { spawn } from "node:child_process";

// npm runs this script on Windows and Unix; do not use shell-specific `set PORT`.
const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev", "--workspace", "canvas-agent"], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, PORT: "17371" },
});
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
