import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createReadStream } from "node:fs";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { canonicalProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { DATA_DIR, DB_FILE, MEDIA_DIR } from "../config.js";
import { BackendDatabase } from "../db.js";

const compilationRoot = path.join(DATA_DIR, "production-compilations");
const sha256 = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest("hex");
const canonicalHash = (value: unknown) => sha256(canonicalProduction(value));
const continuityHash = (value: unknown) => sha256(JSON.stringify(value));
const gzip = (value: unknown) => gzipSync(Buffer.from(JSON.stringify(value), "utf8"));
const jsonFiles = (directory: string) => fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => name.endsWith(".json")).map(name => path.join(directory, name)) : [];
const summarizeBlockers = (items: Array<Record<string, any>>) => ({ total: items.length, samples: items.slice(0, 20).map(item => ({
    file: item.file || item.filePath, error: item.error || item.reason, storageKey: item.storageKey,
    paths: Array.isArray(item.paths) ? item.paths.slice(0, 3) : undefined,
    ...(item.indexedBytes !== undefined ? { indexedBytes: item.indexedBytes, actualBytes: item.actualBytes } : {}),
})) });

async function fileSha256(file: string) {
    const digest = crypto.createHash("sha256");
    for await (const chunk of createReadStream(file)) digest.update(chunk as Buffer);
    return digest.digest("hex");
}

function walkFiles(directory: string): string[] {
    if (!fs.existsSync(directory)) return [];
    const files: string[] = [];
    const stack = [directory];
    while (stack.length) {
        const current = stack.pop()!;
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const file = path.join(current, entry.name);
            if (entry.isDirectory()) stack.push(file);
            else if (entry.isFile()) files.push(file);
        }
    }
    return files;
}

async function inspect() {
    const db = new DatabaseSync(DB_FILE, { readOnly: true });
    try {
        const hasSha = (db.prepare("PRAGMA table_info(media_files)").all() as Array<{ name: string }>).some(column => column.name === "sha256");
        const indexed = db.prepare(`SELECT storage_key,file_path,file_size${hasSha ? ",sha256" : ""} FROM media_files`).all() as Array<{ storage_key: string; file_path: string; file_size: number; sha256?: string }>;
        const paths = new Set(indexed.map(row => path.resolve(row.file_path)));
        const files = walkFiles(MEDIA_DIR);
        const unindexed = files.filter(file => !paths.has(path.resolve(file)));
        const missing = indexed.filter(row => !fs.existsSync(row.file_path));
        const sizeMismatches = indexed.filter(row => fs.existsSync(row.file_path) && fs.statSync(row.file_path).size !== row.file_size);
        const jobs = jsonFiles(path.join(compilationRoot, "operations"));
        const reports = walkFiles(path.join(compilationRoot, "continuity")).filter(file => path.basename(file).startsWith("report-") && file.endsWith(".json"));
        const pool = walkFiles(path.join(compilationRoot, "inputs"));
        const prepared = fs.existsSync(compilationRoot) ? fs.readdirSync(compilationRoot, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^[a-f0-9-]{36}$/i.test(entry.name)).map(entry => entry.name) : [];
        const importPlan = planLegacyImports(paths);
        const legacyMediaPaths = importPlan.referencedMediaPaths;
        const missingLegacyMediaPaths = legacyMediaPaths.filter(file => !paths.has(path.resolve(file)) || !fs.existsSync(file));
        const missingLegacyBytes = missingLegacyMediaPaths.filter(file => fs.existsSync(file)).reduce((sum, file) => sum + fs.statSync(file).size, 0);
        const mediaByDigest = new Map<string, typeof indexed>();
        for (const row of indexed) if (typeof row.sha256 === "string" && row.sha256) {
            const candidates = mediaByDigest.get(row.sha256) || [];
            candidates.push(row);
            mediaByDigest.set(row.sha256, candidates);
        }
        const verifiedMediaDigests = new Map<string, string | null>();
        const compilationRootLower = path.resolve(compilationRoot).toLowerCase();
        const duplicateScan = { exactUniqueMatches: 0, ambiguousMatches: 0, noDigestMatch: 0, missingFiles: 0, outsideCompilationDirectory: 0, scannedBytes: 0, indexedCandidateIntegrityFailures: 0, examples: [] as Array<Record<string, unknown>> };
        for (const file of missingLegacyMediaPaths) {
            const resolved = path.resolve(file);
            if (!resolved.toLowerCase().startsWith(compilationRootLower + path.sep.toLowerCase())) {
                duplicateScan.outsideCompilationDirectory++;
                continue;
            }
            if (!fs.existsSync(file)) { duplicateScan.missingFiles++; continue; }
            duplicateScan.scannedBytes += fs.statSync(file).size;
            const digest = await fileSha256(file);
            const matchedKeys: string[] = [];
            for (const candidate of mediaByDigest.get(digest) || []) {
                const candidatePath = path.resolve(candidate.file_path);
                let verified = verifiedMediaDigests.get(candidatePath);
                if (verified === undefined) {
                    verified = fs.existsSync(candidate.file_path) && fs.statSync(candidate.file_path).size === candidate.file_size
                        ? await fileSha256(candidate.file_path) : null;
                    verifiedMediaDigests.set(candidatePath, verified);
                }
                if (verified === digest) matchedKeys.push(candidate.storage_key);
                else duplicateScan.indexedCandidateIntegrityFailures++;
            }
            const uniqueKeys = [...new Set(matchedKeys)];
            if (uniqueKeys.length === 1) duplicateScan.exactUniqueMatches++;
            else if (uniqueKeys.length > 1) {
                duplicateScan.ambiguousMatches++;
                if (duplicateScan.examples.length < 10) duplicateScan.examples.push({ file, status: "ambiguous", storageKeys: uniqueKeys.slice(0, 3) });
            } else {
                duplicateScan.noDigestMatch++;
                if (duplicateScan.examples.length < 10) duplicateScan.examples.push({ file, status: "no_digest_match" });
            }
        }
        const rows = jobs.map(file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } });
        return {
            mode: "read_only_inspect", database: DB_FILE, mediaDirectory: MEDIA_DIR, compilationDirectory: compilationRoot,
            media: { indexedRows: indexed.length, files: files.length, unindexedFiles: unindexed.length, unindexedBytes: unindexed.reduce((sum, file) => sum + fs.statSync(file).size, 0), missingIndexedFiles: missing.length,
                indexedSizeMismatches: sizeMismatches.length, indexedSizeMismatchSamples: sizeMismatches.slice(0, 20).map(row => ({ storageKey: row.storage_key, indexedBytes: row.file_size, actualBytes: fs.statSync(row.file_path).size })),
                sha256Indexed: indexed.filter(row => typeof row.sha256 === "string").length,
                sha256MissingRows: indexed.filter(row => typeof row.sha256 !== "string").length,
                legacyReferencedPaths: legacyMediaPaths.length, legacyReferencedPathsIndexed: legacyMediaPaths.length - missingLegacyMediaPaths.length,
                legacyReferencedPathsNeedRegistration: missingLegacyMediaPaths.length, legacyReferencedBytesNeedRegistration: missingLegacyBytes,
                legacyDuplicateContentScan: duplicateScan,
                referenceScan: "incomplete: runtime task, canvas history, assets, generation logs, production versions and receipts require reconciliation before any deletion" },
            compilation: { legacyJobs: jobs.length, continuityReports: reports.length, materialPoolFiles: pool.length, preparedDirectories: prepared.length,
                jobStates: rows.filter(Boolean).reduce((counts: Record<string, number>, row: any) => { counts[String(row.status || "unknown")] = (counts[String(row.status || "unknown")] || 0) + 1; return counts; }, {}),
                legacyJobBytes: jobs.reduce((sum, file) => sum + fs.statSync(file).size, 0), continuityReportBytes: reports.reduce((sum, file) => sum + fs.statSync(file).size, 0),
                materialPoolBytes: pool.reduce((sum, file) => sum + fs.statSync(file).size, 0),
                validJsonJobs: rows.filter(Boolean).length, invalidJsonJobs: rows.length - rows.filter(Boolean).length,
                importableJobs: importPlan.jobs.length, importableContinuityReports: importPlan.reports.length, migrationBlockers: summarizeBlockers(importPlan.errors) },
            deletionCandidates: { bytes: 0, status: "none: this command does not delete media or legacy compilation files" },
        };
    } finally { db.close(); }
}

function mediaPaths(value: unknown, key = "", output = new Set<string>()): Set<string> {
    if (Array.isArray(value)) { for (const item of value) mediaPaths(item, key, output); return output; }
    if (value && typeof value === "object") {
        for (const [childKey, child] of Object.entries(value)) {
            if (childKey === "references" && child && typeof child === "object" && !Array.isArray(child)) {
                for (const mediaPath of Object.values(child)) if (typeof mediaPath === "string" && path.isAbsolute(mediaPath)) output.add(path.resolve(mediaPath));
            } else mediaPaths(child, childKey, output);
        }
        return output;
    }
    if (["file", "approved_file"].includes(key) && typeof value === "string" && path.isAbsolute(value)) output.add(path.resolve(value));
    return output;
}

function missingMediaPathError(file: string, values: unknown, indexedPaths: Set<string>) {
    const missing = [...mediaPaths(values)].filter(value => !indexedPaths.has(value));
    return missing.length ? { file, error: `包含 ${missing.length} 条未登记到 media_files 的绝对媒体路径`, paths: missing.slice(0, 20) } : undefined;
}

function planLegacyImports(indexedPaths: Set<string> = new Set()) {
    const jobs: Array<{ owner: string; operationId: string; preparedId: string | null; status: string; expectedRevision: number; sourceHash: string | null; runtimeId: string | null; compilerHash: string | null; packet: any; job: any; file: string; mediaPaths: string[] }> = [];
    const errors: Array<{ file: string; error: string }> = [];
    const referencedMediaPaths = new Set<string>();
    for (const file of jsonFiles(path.join(compilationRoot, "operations"))) {
        try {
            const job = JSON.parse(fs.readFileSync(file, "utf8"));
            if (!job || typeof job.owner !== "string" || typeof job.operationId !== "string" || !Number.isInteger(job.expectedRevision)) throw new Error("作业缺少 owner/operationId/expectedRevision");
            let packet: any = null;
            if (job.preparedId) {
                if (typeof job.preparedId !== "string" || !/^[a-f0-9-]{36}$/i.test(job.preparedId)) throw new Error("作业 preparedId 无效");
                const packetFile = path.join(compilationRoot, job.preparedId, "packet.json");
                if (fs.existsSync(packetFile)) {
                    const saved = JSON.parse(fs.readFileSync(packetFile, "utf8"));
                    const { packetHash, ...content } = saved;
                    if (packetHash !== canonicalHash(content)) throw new Error("编译包摘要不匹配");
                    if (content.owner !== job.owner || content.id !== job.id || content.operationId !== `compilation:${job.preparedId}`) throw new Error("编译包 owner/id/operationId 不匹配");
                    packet = content;
                } else if (["queued", "running", "succeeded"].includes(job.status)) throw new Error("作业需要恢复或应用，但对应编译包缺失");
            }
            const jobMediaPaths = [...mediaPaths({ job, packet })];
            for (const mediaPath of jobMediaPaths) referencedMediaPaths.add(mediaPath);
            const unindexedPaths = jobMediaPaths.filter(value => !indexedPaths.has(value));
            if (unindexedPaths.length) {
                errors.push({ file, error: `编译作业引用 ${unindexedPaths.length} 条未登记媒体路径，保留待媒体核验`, paths: unindexedPaths.slice(0, 20) } as any);
                continue;
            }
            jobs.push({ owner: job.owner, operationId: job.operationId, preparedId: job.preparedId || null, status: String(job.status || "unknown"),
                expectedRevision: Number(job.expectedRevision), sourceHash: job.result?.sourceHash || job.director?.sourceHash || null,
                runtimeId: job.director?.engine?.runtimeId || null, compilerHash: job.director?.engine?.compilerHash || null,
                packet, job, file, mediaPaths: [...mediaPaths({ job, packet })] });
        } catch (error) { errors.push({ file, error: error instanceof Error ? error.message : String(error) }); }
    }
    const reports: Array<{ owner: { kind: string; id: string }; operationId: string; requestHash: string; report: any; result: any; file: string; mediaPaths: string[] }> = [];
    for (const file of walkFiles(path.join(compilationRoot, "continuity")).filter(file => path.basename(file).startsWith("report-") && file.endsWith(".json"))) {
        try {
            const report = JSON.parse(fs.readFileSync(file, "utf8"));
            const owner = report.owner;
            if (!owner || !["episode", "canvas", "scene"].includes(owner.kind) || typeof owner.id !== "string" || typeof report.operationId !== "string" || typeof report.sourceHash !== "string") throw new Error("连续性报告身份字段不完整");
            const directory = path.dirname(file);
            const operationFile = path.join(directory, `operation-${continuityHash(report.operationId)}.json`);
            if (!fs.existsSync(operationFile)) throw new Error("连续性 operation 回执缺失");
            const operation = JSON.parse(fs.readFileSync(operationFile, "utf8"));
            if (!operation.requestHash || !operation.result || operation.result.report?.operationId !== report.operationId) throw new Error("连续性 operation 与报告不匹配");
            const reportMediaPaths = [...mediaPaths({ report, result: operation.result })];
            for (const mediaPath of reportMediaPaths) referencedMediaPaths.add(mediaPath);
            const unindexedPaths = reportMediaPaths.filter(value => !indexedPaths.has(value));
            if (unindexedPaths.length) {
                errors.push({ file, error: `连续性回执引用 ${unindexedPaths.length} 条未登记媒体路径，保留待媒体核验`, paths: unindexedPaths.slice(0, 20) } as any);
                continue;
            }
            reports.push({ owner, operationId: report.operationId, requestHash: String(operation.requestHash), report, result: operation.result, file,
                mediaPaths: [...mediaPaths({ report, result: operation.result })] });
        } catch (error) { errors.push({ file, error: error instanceof Error ? error.message : String(error) }); }
    }
    return { jobs, reports, errors, referencedMediaPaths: [...referencedMediaPaths] };
}

async function apply() {
    const source = new DatabaseSync(DB_FILE, { readOnly: true });
    let indexedPaths: Set<string>;
    try { indexedPaths = new Set((source.prepare("SELECT file_path FROM media_files").all() as Array<{ file_path: string }>).map(row => path.resolve(row.file_path))); }
    finally { source.close(); }
    const plan = planLegacyImports(indexedPaths);
    const backend = new BackendDatabase(DB_FILE);
    try {
        const db = backend.db;
        const mediaRows = db.prepare("SELECT storage_key,file_path,file_size FROM media_files WHERE sha256 IS NULL OR sha256='' ORDER BY storage_key").all() as Array<{ storage_key: string; file_path: string; file_size: number }>;
        const digests: Array<{ storageKey: string; sha256: string }> = [];
        const invalidMediaPaths = new Set<string>();
        const mediaBlockers: Array<{ storageKey: string; filePath: string; reason: string; indexedBytes?: number; actualBytes?: number }> = [];
        for (const row of mediaRows) {
            if (!fs.existsSync(row.file_path)) {
                invalidMediaPaths.add(path.resolve(row.file_path));
                mediaBlockers.push({ storageKey: row.storage_key, filePath: row.file_path, reason: "missing_file", indexedBytes: row.file_size });
                continue;
            }
            const actualBytes = fs.statSync(row.file_path).size;
            if (actualBytes !== row.file_size) {
                invalidMediaPaths.add(path.resolve(row.file_path));
                mediaBlockers.push({ storageKey: row.storage_key, filePath: row.file_path, reason: "size_mismatch", indexedBytes: row.file_size, actualBytes });
                continue;
            }
            digests.push({ storageKey: row.storage_key, sha256: await fileSha256(row.file_path) });
        }
        const jobs = plan.jobs.filter(item => {
            const invalid = item.mediaPaths.filter(file => invalidMediaPaths.has(path.resolve(file)));
            if (invalid.length) plan.errors.push({ file: item.file, error: `编译作业引用 ${invalid.length} 个索引损坏的媒体文件，保留原记录`, paths: invalid.slice(0, 20) } as any);
            return !invalid.length;
        });
        const reports = plan.reports.filter(item => {
            const invalid = item.mediaPaths.filter(file => invalidMediaPaths.has(path.resolve(file)));
            if (invalid.length) plan.errors.push({ file: item.file, error: `连续性回执引用 ${invalid.length} 个索引损坏的媒体文件，保留原记录`, paths: invalid.slice(0, 20) } as any);
            return !invalid.length;
        });
        db.exec("BEGIN IMMEDIATE");
        try {
            const now = new Date().toISOString();
            for (const digest of digests) db.prepare("UPDATE media_files SET sha256=? WHERE storage_key=? AND (sha256 IS NULL OR sha256='')").run(digest.sha256, digest.storageKey);
            const persistent = (value: any, key = ""): any => {
                if (Array.isArray(value)) return value.map(item => persistent(item));
                if (!value || typeof value !== "object") {
                    if (["file", "approved_file"].includes(key) && typeof value === "string" && path.isAbsolute(value)) {
                        const row = db.prepare("SELECT storage_key FROM media_files WHERE file_path=?").get(value) as { storage_key: string } | undefined;
                        if (!row) throw new Error(`旧编译包引用未登记的媒体路径，需先完成媒体核验：${value}`);
                        return `storage-key://${row.storage_key}`;
                    }
                    return value;
                }
                const out: Record<string, unknown> = {};
                for (const [key, child] of Object.entries(value)) {
                    if (key === "references" && child && typeof child === "object" && !Array.isArray(child)) {
                        out[key] = Object.fromEntries(Object.entries(child as Record<string, unknown>).map(([identity, file]) => {
                            if (typeof file !== "string" || !path.isAbsolute(file)) return [identity, persistent(file)];
                            const row = db.prepare("SELECT storage_key FROM media_files WHERE file_path=?").get(file) as { storage_key: string } | undefined;
                            if (!row) throw new Error(`旧编译作业素材尚未登记到 MediaStore：${file}`);
                            return [identity, `storage-key://${row.storage_key}`];
                        }));
                    } else out[key] = persistent(child, key);
                }
                return out;
            };
            const compactAppliedJob = (job: any) => job?.application && job.director ? {
                ...job,
                references: {},
                director: { engine: job.director.engine, sourceHash: job.result?.sourceHash || job.director.sourceHash, source: {}, artifacts: [] },
            } : job;
            for (const item of jobs) {
                const fullJob = persistent(item.job), fullPacket = item.packet ? persistent(item.packet) : null;
                const storedJob = compactAppliedJob(fullJob);
                const storedPacket = item.job.application ? null : fullPacket;
                const prior = db.prepare("SELECT job_gzip,packet_gzip,packet_hash FROM production_compilation_jobs WHERE owner=? AND operation_id=?").get(item.owner, item.operationId) as { job_gzip: Uint8Array; packet_gzip?: Uint8Array | null; packet_hash?: string | null } | undefined;
                if (prior) {
                    const existing = JSON.parse(gunzipSync(Buffer.from(prior.job_gzip)).toString("utf8"));
                    if (item.job.application && prior.packet_gzip) {
                        const existingPacket = JSON.parse(gunzipSync(Buffer.from(prior.packet_gzip)).toString("utf8"));
                        if (!prior.packet_hash || canonicalHash(existingPacket) !== prior.packet_hash) throw new Error(`已应用编译包损坏，保留原记录：${item.operationId}`);
                    }
                    const existingJob = compactAppliedJob(existing);
                    if (canonicalHash(existingJob) !== canonicalHash(storedJob)
                        || prior.packet_hash && fullPacket && prior.packet_hash !== canonicalHash(fullPacket)) throw new Error(`编译作业冲突，保留原记录：${item.operationId}`);
                    if (item.job.application) db.prepare("UPDATE production_compilation_jobs SET packet_gzip=NULL,packet_hash=NULL,job_gzip=?,updated_at=? WHERE owner=? AND operation_id=?")
                        .run(gzip(storedJob), now, item.owner, item.operationId);
                    continue;
                }
                db.prepare(`INSERT INTO production_compilation_jobs(owner,operation_id,prepared_id,status,expected_revision,source_hash,engine_runtime_id,compiler_hash,packet_gzip,packet_hash,job_gzip,created_at,updated_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(item.owner,item.operationId,item.preparedId,item.status,item.expectedRevision,item.sourceHash,item.runtimeId,item.compilerHash,
                    storedPacket ? gzip(storedPacket) : null,storedPacket ? canonicalHash(storedPacket) : null,gzip(storedJob),item.job.createdAt || now,now);
            }
            for (const item of reports) {
                const storedReport = persistent(item.report), storedResult = persistent(item.result);
                const existing = db.prepare("SELECT request_hash FROM production_continuity_reports WHERE owner_kind=? AND owner_id=? AND operation_id=?").get(item.owner.kind,item.owner.id,item.operationId) as { request_hash: string } | undefined;
                if (existing) { if (existing.request_hash !== item.requestHash) throw new Error(`连续性 operation 冲突，保留原记录：${item.operationId}`); continue; }
                db.prepare(`INSERT INTO production_continuity_reports(owner_kind,owner_id,operation_id,request_hash,snapshot,source_hash,runtime_id,checked_at,report_gzip,result_gzip,created_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(item.owner.kind,item.owner.id,item.operationId,item.requestHash,item.report.snapshot === "published" ? "published" : "draft",item.report.sourceHash,
                    item.report.runtimeId || null,item.report.checkedAt || null,gzip(storedReport),gzip(storedResult),now);
            }
            for (const item of jobs) {
                const row = db.prepare("SELECT prepared_id,source_hash,packet_hash,job_gzip FROM production_compilation_jobs WHERE owner=? AND operation_id=?").get(item.owner,item.operationId) as any;
                const storedJob = compactAppliedJob(persistent(item.job)), storedPacket = item.job.application ? null : item.packet ? persistent(item.packet) : null;
                if (!row || row.prepared_id !== item.preparedId || row.source_hash !== item.sourceHash || storedPacket && row.packet_hash !== canonicalHash(storedPacket)
                    || item.job.application && row.packet_hash != null
                    || canonicalHash(JSON.parse(gunzipSync(Buffer.from(row.job_gzip)).toString("utf8"))) !== canonicalHash(storedJob)) throw new Error(`编译作业读回校验失败：${item.operationId}`);
            }
            for (const item of reports) {
                const storedReport = persistent(item.report);
                const row = db.prepare("SELECT request_hash,source_hash,report_gzip FROM production_continuity_reports WHERE owner_kind=? AND owner_id=? AND operation_id=?").get(item.owner.kind,item.owner.id,item.operationId) as any;
                if (!row || row.request_hash !== item.requestHash || row.source_hash !== item.report.sourceHash
                    || canonicalHash(JSON.parse(gunzipSync(Buffer.from(row.report_gzip)).toString("utf8"))) !== canonicalHash(storedReport)) throw new Error(`连续性回执读回校验失败：${item.operationId}`);
            }
            for (const digest of digests) {
                const row = db.prepare("SELECT sha256 FROM media_files WHERE storage_key=?").get(digest.storageKey) as { sha256?: string } | undefined;
                if (row?.sha256 !== digest.sha256) throw new Error(`媒体 SHA-256 回读不匹配：${digest.storageKey}`);
            }
            db.exec("COMMIT");
            return { mode: "apply", backfilledMediaDigests: digests.length, skippedMediaDigests: mediaBlockers.length, importedJobs: jobs.length, importedContinuityReports: reports.length,
                verifiedJobRows: jobs.length, verifiedReportRows: reports.length, migrationBlockers: summarizeBlockers([...plan.errors, ...mediaBlockers]),
                oldFilesRemoved: false, message: "可核验记录已导入；有未登记媒体路径的记录保留原位，所有旧文件均保留" };
        } catch (error) { db.exec("ROLLBACK"); throw error; }
    } finally { backend.close(); }
}

const mode = process.argv[2] || "inspect";
if (mode === "inspect") void inspect().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2)); process.exitCode = 1; });
else if (mode === "apply") void apply().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error), details: (error as any)?.details }, null, 2)); process.exitCode = 1; });
else throw new Error("用法: media-and-compilation-storage.ts [inspect|apply]");
