import crypto from "node:crypto";
import fs from "node:fs";
import { createReadStream } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { DATA_DIR, DB_FILE, MEDIA_DIR } from "../config.js";

type IndexedMedia = { file_path: string; file_size: number; sha256: string | null };
type Candidate = { source: string; canonical: string; bytes: number; sha256: string };
const temporaryName = /\.dedup-[a-f0-9-]+\.tmp$/i;
const mediaFileName = /\.(png|jpe?g|webp|gif|mp4|mov|webm|mkv|mp3|wav|m4a|flac)$/i;
const sourceDirectories = [MEDIA_DIR, path.join(DATA_DIR, "production-compilations")];

async function digest(file: string) {
    const hash = crypto.createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
    return hash.digest("hex");
}

function contained(root: string, file: string) {
    const relative = path.relative(root, file);
    return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function walk(directory: string): string[] {
    const found: string[] = [], stack = [directory];
    while (stack.length) {
        const current = stack.pop()!;
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const file = path.join(current, entry.name);
            if (entry.isSymbolicLink() || temporaryName.test(entry.name)) continue;
            if (entry.isDirectory()) stack.push(file);
            else if (entry.isFile()) found.push(file);
        }
    }
    return found;
}

export async function planMediaPathDeduplication(db: DatabaseSync) {
    const rows = db.prepare("SELECT file_path,file_size,sha256 FROM media_files ORDER BY storage_key").all() as IndexedMedia[];
    const indexedPaths = new Set(rows.map(row => path.resolve(row.file_path).toLowerCase()));
    const indexedBySize = new Map<number, IndexedMedia[]>();
    for (const row of rows) {
        if (!row.sha256 || !fs.existsSync(row.file_path)) continue;
        const actualSize = fs.statSync(row.file_path).size;
        if (actualSize !== Number(row.file_size)) continue;
        const entries = indexedBySize.get(actualSize) || [];
        entries.push(row);
        indexedBySize.set(actualSize, entries);
    }

    // Validate matching-size indexed files before trusting their stored digest.
    const verified = new Map<string, string | null>();

    const candidates: Candidate[] = [];
    let scannedFiles = 0, scannedBytes = 0, unmatchedFiles = 0;
    const files = sourceDirectories.flatMap(directory => fs.existsSync(directory) ? walk(directory) : []);
    let alreadyLinkedPaths = 0;
    for (const source of files) {
        if (!mediaFileName.test(source)) continue;
        if (indexedPaths.has(path.resolve(source).toLowerCase())) continue;
        const stat = fs.statSync(source);
        const sourceDigest = await digest(source);
        scannedFiles++;
        scannedBytes += stat.size;
        const targets = [];
        for (const row of indexedBySize.get(stat.size) || []) {
            const file = path.resolve(row.file_path);
            if (!contained(MEDIA_DIR, file)
                // Stable-name runtime files can be rewritten in place; content-addressed
                // input/output/library files are immutable and safe hard-link targets.
                || !["input", "output", "library"].includes(path.basename(path.dirname(file)))) continue;
            let actual = verified.get(file);
            if (actual === undefined) { actual = await digest(file); verified.set(file, actual); }
            if (actual === row.sha256 && actual === sourceDigest) targets.push(row);
        }
        const canonicalPaths = [...new Set(targets.map(row => path.resolve(row.file_path)))];
        if (!canonicalPaths.length) { unmatchedFiles++; continue; }
        const canonical = canonicalPaths[0];
        const targetStat = fs.statSync(canonical);
        if (Number(stat.ino) !== 0 && Number(stat.dev) === Number(targetStat.dev) && Number(stat.ino) === Number(targetStat.ino)) {
            alreadyLinkedPaths++;
            continue;
        }
        candidates.push({ source, canonical, bytes: stat.size, sha256: sourceDigest });
    }
    return {
        sourceDirectories,
        scannedFiles, scannedBytes,
        candidatePaths: candidates.length,
        alreadyLinkedPaths,
        estimatedReclaimedBytes: candidates.reduce((sum, item) => sum + item.bytes, 0),
        unmatchedFiles,
        candidates,
    };
}

export async function applyMediaPathDeduplication(candidates: Candidate[]) {
    let linkedPaths = 0, skippedChanged = 0, skippedAlreadyLinked = 0, savedBytes = 0;
    for (const item of candidates) {
        const temporary = path.join(path.dirname(item.source), `.dedup-${crypto.randomUUID()}.tmp`);
        try {
            const [sourceStat, targetStat] = await Promise.all([fs.promises.stat(item.source), fs.promises.stat(item.canonical)]);
            if (sourceStat.size !== item.bytes || targetStat.size !== item.bytes
                || await digest(item.source) !== item.sha256 || await digest(item.canonical) !== item.sha256) {
                skippedChanged++;
                continue;
            }
            if (sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino) {
                skippedAlreadyLinked++;
                continue;
            }
            fs.linkSync(item.canonical, temporary);
            if (await digest(temporary) !== item.sha256 || fs.statSync(temporary).size !== item.bytes) throw new Error("Hard-link verification failed");
            // Same-volume rename atomically replaces this path. The original name and
            // bytes remain available to every existing absolute-path reference.
            fs.renameSync(temporary, item.source);
            const after = fs.statSync(item.source), targetAfter = fs.statSync(item.canonical);
            if (after.dev !== targetAfter.dev || after.ino !== targetAfter.ino || after.size !== item.bytes) {
                throw new Error("Hard-link path verification failed after replacement");
            }
            linkedPaths++;
            savedBytes += item.bytes;
        } finally {
            try { fs.unlinkSync(temporary); } catch { /* no temporary link remains */ }
        }
    }
    return { linkedPaths, skippedChanged, skippedAlreadyLinked, savedBytes };
}

async function main() {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== "--apply") || args.length > 1) throw new Error("Usage: deduplicate-media-paths [--apply]");
    if (!fs.existsSync(DB_FILE)) throw new Error("Database does not exist");
    const apply = args.includes("--apply");
    const db = new DatabaseSync(DB_FILE, { readOnly: !apply });
    try {
        const plan = await planMediaPathDeduplication(db);
        const { candidates, ...summary } = plan;
        if (!apply) {
            console.log(JSON.stringify({ dryRun: true, ...summary, message: "Verified SHA-256 only; absolute media paths are preserved. --apply replaces byte-identical duplicate files with hard links to indexed immutable media." }, null, 2));
            return;
        }
        const beforeFreeBytes = fs.statfsSync(MEDIA_DIR).bfree * fs.statfsSync(MEDIA_DIR).bsize;
        const result = await applyMediaPathDeduplication(candidates);
        const afterFreeBytes = fs.statfsSync(MEDIA_DIR).bfree * fs.statfsSync(MEDIA_DIR).bsize;
        console.log(JSON.stringify({ ok: true, ...summary, ...result, beforeFreeBytes, afterFreeBytes, measuredFreedBytes: afterFreeBytes - beforeFreeBytes }, null, 2));
    } finally { db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
