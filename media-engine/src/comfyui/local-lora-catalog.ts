import path from "node:path";
import { readdir } from "node:fs/promises";
import { resolveComfyRoot } from "./local-root.js";

// Match ComfyUI folder_paths.supported_pt_extensions; previews and partial downloads are not models.
const modelExtensions = new Set([".ckpt", ".pt", ".pt2", ".bin", ".pth", ".safetensors", ".pkl", ".sft"]);

/** Read the configured installation, never guess another ComfyUI directory or cache a filename list. */
export async function listLocalLoras(configuredRoot: string): Promise<string[]> {
    if (!configuredRoot.trim()) return [];
    const directory = path.join(resolveComfyRoot(configuredRoot), "models", "loras");
    const files: string[] = [];
    const scan = async (relative: string): Promise<void> => {
        let entries;
        try { entries = await readdir(path.join(directory, relative), { withFileTypes: true }); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
        }
        for (const entry of entries) {
            const name = path.join(relative, entry.name);
            if (entry.isDirectory()) await scan(name);
            else if (entry.isFile() && modelExtensions.has(path.extname(entry.name).toLowerCase())) files.push(name);
        }
    };
    await scan("");
    return files;
}
