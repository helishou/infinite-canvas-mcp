import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
export type CodexLaunch = { command: string; args: string[]; version: string; source: "package" | "path" };

/** Codex is optional for the HTTP/MCP server; resolve it only when needed. */
export function findCodexLaunch(pathValue = process.env.PATH || "", resolvePackage: (name: string) => string = require.resolve): CodexLaunch | undefined {
    let packageFile: string | undefined;
    try { packageFile = resolvePackage("@openai/codex/package.json"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error; }
    if (packageFile) {
        const script = path.join(path.dirname(packageFile), "bin", "codex.js");
        if (!existsSync(script)) throw new Error("Codex package is incomplete: bin/codex.js is missing. Reinstall @openai/codex.");
        const metadata = JSON.parse(readFileSync(packageFile, "utf8")) as { version?: string };
        return { command: process.execPath, args: [script], version: metadata.version || "", source: "package" };
    }
    for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
        // npm global installations expose a .cmd shim on Windows and a bin symlink on Unix.
        for (const packageDirectory of [path.join(directory, "node_modules", "@openai", "codex"), path.resolve(directory, "..", "lib", "node_modules", "@openai", "codex")]) {
            const script = path.join(packageDirectory, "bin", "codex.js");
            if (!existsSync(script)) continue;
            const metadataFile = path.join(packageDirectory, "package.json");
            const version = existsSync(metadataFile) ? String(JSON.parse(readFileSync(metadataFile, "utf8")).version || "") : "";
            return { command: process.execPath, args: [script], version, source: "path" };
        }
        const executable = path.join(directory, process.platform === "win32" ? "codex.exe" : "codex");
        if (existsSync(executable)) return { command: executable, args: [], version: "", source: "path" };
    }
    return undefined;
}

export function requireCodexLaunch(): CodexLaunch {
    const launch = findCodexLaunch();
    if (!launch) throw new Error("Codex CLI is not installed. Canvas, MCP and ComfyUI remain available. To use Codex chat, install it with: npm install -g @openai/codex@0.160.0");
    return launch;
}
