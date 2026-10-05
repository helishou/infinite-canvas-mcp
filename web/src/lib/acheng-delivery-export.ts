import { Zip, ZipPassThrough } from "fflate";

import { backendMediaUrl, type EpisodeProduction, type ProductionReadiness } from "@/services/backend-api";

type RecordValue = Record<string, unknown>;
type CanvasNode = { id: string; title?: string; type?: string; metadata?: Record<string, unknown> };
type BinaryEntry = Omit<MediaEntry, "included" | "requested" | "missingReason">;
type ExportOptions = {
    owner: { kind: "canvas" | "episode" | "scene"; id: string };
    title: string;
    production: EpisodeProduction;
    readiness: ProductionReadiness;
    canvasNodes: CanvasNode[];
    includeGeneratedMedia?: boolean;
};
type MediaEntry = { key: string; path: string; kind: "reference" | "asset" | "keyframe" | "video"; targetId: string; sha256?: string; requested: boolean; included: boolean; missingReason?: string };

const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const safeName = (value: string) => String(value || "target").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 100) || "target";
const extensionOf = (storageKey: string) => /\.([a-z0-9]{1,8})$/i.exec(storageKey.split(/[?#]/, 1)[0])?.[1]?.toLowerCase() || "bin";

export async function exportAchengDeliveryBundle(options: ExportOptions) {
    const sourceRevision = options.production.revision;
    const publishedVersion = options.production.publishedVersion;
    const snapshot = options.production.draft;
    const director = snapshot.director;
    if (!director) throw new Error("尚未建立 Acheng 正式制作稿");
    const artifacts = director.artifacts;
    const binaries = new Map<string, BinaryEntry>();
    const artifactFiles = artifacts.map(artifact => {
        const kind = artifact.kind === "image" ? "image" : "h3";
        const base = `${kind}/${safeName(artifact.targetId)}`;
        const promptPath = `prompts/${base}.txt`;
        const uploadPath = `uploads/${base}.json`;
        const refs = artifact.references.map((ref, index) => {
            const key = `${ref.storageKey}\0${ref.sha256}`;
            let binary = binaries.get(key);
            if (!binary) {
                const path = `references/${String(binaries.size + 1).padStart(3, "0")}-${safeName(ref.label)}.${extensionOf(ref.storageKey)}`;
                binary = { key: ref.storageKey, path, kind: "reference", targetId: artifact.targetId, sha256: ref.sha256 };
                binaries.set(key, binary);
            }
            if (!binary) throw new Error(`无法分配参考媒体路径：${ref.label}`);
            return { slot: index + 1, label: ref.label, role: ref.role, nodeId: ref.nodeId, storageKey: ref.storageKey, sha256: ref.sha256, file: binary.path };
        });
        return {
            artifact,
            promptPath,
            uploadPath,
            refs,
            manifest: { id: artifact.id, kind: artifact.kind, targetId: artifact.targetId, status: artifact.status, promptSha256: artifact.sha256, sourceHash: artifact.sourceHash, receipt: artifact.receipt, promptFile: promptPath, uploadCard: uploadPath, references: refs },
        };
    });

    const d = director as EpisodeProduction["draft"]["director"];
    const actualMedia: BinaryEntry[] = [];
    for (const [assetId, asset] of Object.entries(d?.assets || {})) if (asset.storageKey) actualMedia.push({ key: asset.storageKey, path: `outputs/assets/${safeName(assetId)}.${extensionOf(asset.storageKey)}`, kind: "asset", targetId: assetId, sha256: asset.sha256 });
    for (const [shotId, frame] of Object.entries(snapshot.keyframes)) if (frame.storageKey) actualMedia.push({ key: frame.storageKey, path: `outputs/keyframes/${safeName(shotId)}.${extensionOf(frame.storageKey)}`, kind: "keyframe", targetId: shotId });
    for (const group of snapshot.clipGroups) {
        const node = options.canvasNodes.find(item => item.id === group.nodeId);
        const segments = Array.isArray(node?.metadata?.segments) ? node.metadata!.segments.map(record) : [];
        const segment = segments.find(item => String(item.id || "") === String(group.segmentId || ""));
        const storageKey = String(segment?.resultStorageKey || "");
        if (storageKey) actualMedia.push({ key: storageKey, path: `outputs/video/${safeName(group.id)}.${extensionOf(storageKey)}`, kind: "video", targetId: group.id });
    }
    const chosenOutputs = options.includeGeneratedMedia ? actualMedia : [];
    const outputByKey = new Map<string, BinaryEntry>();
    for (const item of chosenOutputs) if (!outputByKey.has(item.key)) outputByKey.set(item.key, item);
    const allBinaries = [...binaries.values(), ...outputByKey.values()];
    const mediaEntries: MediaEntry[] = actualMedia.filter(item => !options.includeGeneratedMedia).map(item => ({ ...item, requested: false, included: false }));
    const chunks: Uint8Array[] = [];
    let rejectArchive: (error: Error) => void = () => undefined;
    let resolveArchive: (blob: Blob) => void = () => undefined;
    const archiveDone = new Promise<Blob>((resolve, reject) => { resolveArchive = resolve; rejectArchive = reject; });
    const archive = new Zip((error, chunk, final) => {
        if (error) { rejectArchive(error); return; }
        if (chunk.length) chunks.push(chunk);
        if (final) resolveArchive(new Blob(chunks.map(chunk => Uint8Array.from(chunk).buffer), { type: "application/zip" }));
    });
    const addBytes = (path: string, data: Uint8Array) => {
        const file = new ZipPassThrough(path);
        archive.add(file);
        file.push(data, true);
    };
    const addJson = (path: string, value: unknown) => addBytes(path, new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`));

    try {
        const encoder = new TextEncoder();
        const completePrompts = artifacts.length > 0 && artifacts.every(item => item.status === "ready" && item.sourceHash === director.sourceHash && item.receipt.sourceHash === director.sourceHash && item.receipt.promptHash === item.sha256);
        const readyTargets = options.readiness.targets.filter(item => item.status === "ready" || item.status === "complete").length;
        const dependenciesCleared = !options.readiness.unresolved.length && options.readiness.targets.every(item => item.status === "ready" || item.status === "complete");
        const samePublishedSource = options.production.published?.director?.sourceHash === director.sourceHash;
        const manifest: RecordValue = {
            contract: "acheng-delivery-v1",
            owner: options.owner,
            title: options.title,
            sourceRevision,
            publishedVersion,
            stage: completePrompts && dependenciesCleared && samePublishedSource ? "prompt-ready" : "partial",
            fixedEngine: director.engine,
            sourceHash: director.sourceHash,
            unresolved: options.readiness.unresolved,
            targets: options.readiness.targets,
            artifacts: artifactFiles.map(item => item.manifest),
            media: mediaEntries,
            outputsIncluded: options.includeGeneratedMedia === true,
            readinessSummary: { ready: readyTargets, total: options.readiness.targets.length, nextAction: options.readiness.nextAction },
        };
        addJson("production.json", { owner: options.owner, revision: sourceRevision, publishedVersion, stage: options.production.published ? "draft-with-published-baseline" : "draft", data: snapshot, publishedSnapshot: options.production.published });
        for (const item of artifactFiles) {
            addBytes(item.promptPath, encoder.encode(item.artifact.prompt));
            addJson(item.uploadPath, { targetId: item.artifact.targetId, kind: item.artifact.kind, references: item.refs, receipt: item.artifact.receipt });
        }
        for (const binary of allBinaries) {
            const response = await fetch(backendMediaUrl(binary.key));
            if (!response.ok) {
                mediaEntries.push({ ...binary, requested: true, included: false, missingReason: `HTTP ${response.status}` });
                continue;
            }
            const file = new ZipPassThrough(binary.path);
            archive.add(file);
            if (response.body) {
                const reader = response.body.getReader();
                for (;;) {
                    const next = await reader.read();
                    if (next.done) break;
                    if (next.value?.length) file.push(next.value, false);
                }
                file.push(new Uint8Array(), true);
            } else file.push(new Uint8Array(await response.arrayBuffer()), true);
            mediaEntries.push({ ...binary, requested: true, included: true });
        }
        manifest.media = mediaEntries;
        const missingRequestedMedia = mediaEntries.some(item => item.requested && !item.included);
        if (missingRequestedMedia) manifest.stage = "partial";
        addBytes("README.txt", encoder.encode(`${options.title}\nAcheng revision ${sourceRevision} · published v${publishedVersion || "draft"}\nPackage status: ${String(manifest.stage)}\n${options.readiness.nextAction}\n${missingRequestedMedia ? "Some requested media files were unavailable; see manifest.json." : ""}\n`));
        addJson("manifest.json", manifest);
        archive.end();
        return await archiveDone;
    } catch (error) {
        archive.terminate();
        const failure = error instanceof Error ? error : new Error(String(error));
        throw failure;
    }
}
