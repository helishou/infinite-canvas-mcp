import { appendScenePalettePrompt, sceneNodesByIds } from "../canvas/scene-generation-context.js";
import crypto from 'node:crypto';
import fs from 'node:fs';
import { canonicalProduction, productionImageModel, type EpisodeProductionData } from '@basketikun/canvas-agent/drama/production-contract';
import { compileReferenceSubmission, assertReferenceCompilation, productionImageInput } from '@basketikun/canvas-agent/reference-contract';
import { resolveH3Runtime, h3StoryboardIssues } from '@basketikun/canvas-agent/plugins/minimax-h3/runtime-params';
import { resolveCanvasImageReferencesByIds } from '../canvas/image-references.js';
import type { CanvasGenerationCommand } from '@basketikun/canvas-agent/generation-contract';
import type { CanvasProject } from '../db.js';

export const inputHash = (value: unknown) => crypto.createHash('sha256').update(canonicalProduction(value ?? null)).digest('hex');
const rows = (value: any): any[] => Array.isArray(value) ? value : [];
export type CanvasExecutionTarget = {
    id: string; nodeId: string; sourceNodeId: string; segmentId?: string;
    command: CanvasGenerationCommand; inputHash: string;
    dependencies: Array<{ targetId: string; nodeId: string; bindingId?: string; taskId?: string; storageKey?: string; sha256?: string }>;
};
export type CanvasExecutionSnapshot = {
    schemaVersion: 1; inputBasis: 'canvas' | 'published'; canvasId: string; canvasRevision: number; sourceHash: string;
    project: CanvasProject; defaults: Record<string, unknown>; targets: CanvasExecutionTarget[];
    blockedTargets: Array<{ targetId: string; code: string; message: string }>; warnings: Array<{ targetId: string; code: string; message: string }>;
    planHash: string;
};

/** Content, ordered references and effective parameters only; output/status never invalidates input. */
export function effectiveTargetInput(project: CanvasProject, nodeId: string, segmentId?: string, defaults: Record<string, unknown> = {}) {
    const node = rows(project.nodes).find(node => node.id === nodeId);
    if (!node) throw new Error(`目标节点不存在：${nodeId}`);
    const metadata = node.metadata || {};
    if (segmentId) {
        const segment = rows(metadata.segments).find(segment => segment.id === segmentId);
        if (!segment) throw new Error(`Clip 不存在：${segmentId}`);
        const runtime = resolveH3Runtime(segment, {}, metadata, defaults);
        const references = rows(segment.referenceBindings).filter(ref => ref.enabled !== false);
        const params = { ...runtime.params };
        if (params.noiseSeedMode === 'random') { delete params.seed; delete params.noiseSeed; }
        return { prompt: String(segment.prompt || ''), params, references,
            storyboardShots: segment.storyboardShots || [], characterGroups: segment.h3CharacterGroups || {} };
    }
    const formal = productionImageInput(node);
    const source = rows(project.nodes).find(node => node.id === (formal?.sourceNodeId || nodeId)) || node;
    const incoming = rows(project.connections).filter(edge => edge.toNodeId === source.id)
        .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
    const referenceNodes = incoming.filter(edge => ![nodeId, source.id].includes(edge.fromNodeId)).map(edge => edge.fromNodeId).filter(id => {
        const ref = rows(project.nodes).find(node => node.id === id);
        return !ref || ["image", "character", "scene"].includes(ref.type) || ref.type === "config" && ref.metadata?.generationMode === "image";
    });
    const baselineReferences = productionImageInput(source)?.references || formal?.references || [];
    const references = referenceNodes.flatMap(id => resolveCanvasImageReferencesByIds(project, source.id, [id]).map(ref => {
        const baseline = baselineReferences.find(baseline => baseline.nodeId === id && baseline.storageKey === ref.storageKey);
        return { ...ref, sourceNodeId: id, ...(baseline ? { role: baseline.role, assetId: baseline.assetId, assetVersion: baseline.assetVersion } : {}) };
    }));
    const targetPromptEdited = metadata.productionImageProjection?.fieldHashes?.prompt && inputHash(metadata.prompt) !== metadata.productionImageProjection.fieldHashes.prompt;
    const prompt = String(targetPromptEdited ? metadata.prompt : source.metadata?.prompt ?? source.metadata?.content ?? metadata.prompt ?? '');
    return { prompt, compiledPrompt: appendScenePalettePrompt(prompt, sceneNodesByIds({ nodes: project.nodes }, referenceNodes)),
        model: String(source.metadata?.model || metadata.model || (defaults.canvasImageModels as Record<string, string> | undefined)?.[nodeId] || ''),
        params: { ...(source.metadata?.comfyParams || {}), ...Object.fromEntries(['size', 'quality', 'count', 'width', 'height', 'resolution', 'aspectRatio'].filter(key => source.metadata?.[key] !== undefined).map(key => [key, source.metadata[key]])) },
        references, referenceNodes, sourceNodeId: source.id };
}

/** Freeze saved content without requiring a ready compilation or approved media. */
export function captureCanvasInputs(project: CanvasProject, data: EpisodeProductionData, targetIds: string[], defaults: Record<string, unknown>,
    media: (key: string) => { filePath?: string } | null | undefined): CanvasExecutionSnapshot {
    defaults = { ...defaults, canvasImageModels: Object.fromEntries(Object.entries(data.director?.assets || {}).filter(([, asset]) => asset.nodeId).map(([id, asset]) => [asset.nodeId!, productionImageModel(data.settings, data.director?.source || {}, id)])) };
    const frozen = structuredClone(project);
    (frozen as any).canvasReferenceDigests = {};
    const nodeByTarget = new Map<string, string>();
    for (const [id, asset] of Object.entries(data.director?.assets || {})) if (asset.nodeId) nodeByTarget.set(`asset:${id}`, asset.nodeId);
    for (const [shotId, input] of Object.entries(data.director?.shotInputs || {})) {
        const asset = input.keyframeAssetId && data.director?.assets[input.keyframeAssetId];
        if (asset && asset.nodeId) nodeByTarget.set(`frame:${shotId}`, asset.nodeId);
    }
    for (const group of data.clipGroups) if (group.nodeId) nodeByTarget.set(`segment:${group.id}`, group.nodeId);
    const canonicalImages = new Map<string, string>(), aliases: Array<{ targetId: string; canonicalId: string }> = [];
    targetIds = targetIds.filter(id => {
        const nodeId = nodeByTarget.get(id);
        if (!nodeId || id.startsWith("segment:")) return true;
        const canonicalId = canonicalImages.get(nodeId);
        if (canonicalId) { aliases.push({ targetId: id, canonicalId }); return false; }
        canonicalImages.set(nodeId, id); return true;
    });
    const selectedByNode = new Map(targetIds.filter(id => !id.startsWith('segment:')).map(id => [nodeByTarget.get(id), id]));
    const targets: CanvasExecutionTarget[] = [], blockedTargets: CanvasExecutionSnapshot['blockedTargets'] = [], warnings: CanvasExecutionSnapshot['warnings'] = [];
    for (const alias of aliases) warnings.push({ targetId: alias.targetId, code: "SHARED_TARGET_NODE", message: `与 ${alias.canonicalId} 共用图片节点，仅提交一次` });
    for (const id of targetIds) {
        try {
            const nodeId = nodeByTarget.get(id);
            if (!nodeId) throw new Error(`生产目标未绑定画布：${id}`);
            const group = id.startsWith('segment:') ? data.clipGroups.find(group => `segment:${group.id}` === id) : undefined;
            const node = rows(frozen.nodes).find(node => node.id === nodeId);
            if (!node) throw new Error(`目标节点不存在：${nodeId}`);
            const segmentId = group?.segmentId || undefined;
            if (group && !segmentId) throw new Error(`生产目标未绑定 Clip：${id}`);
            const effective = effectiveTargetInput(frozen, nodeId, segmentId, defaults);
            if (!effective.prompt.trim()) throw new Error('提示词为空');
            const dependencies: CanvasExecutionTarget['dependencies'] = [];
            let command: CanvasGenerationCommand;
            let compiledKeys: string[] | undefined;
            if (segmentId) {
                const segment = rows(node.metadata?.segments).find(segment => segment.id === segmentId);
                const runtime = resolveH3Runtime(segment, {}, node.metadata || {}, defaults);
                const issues = [...runtime.parameterIssues, ...h3StoryboardIssues(segment)];
                if (issues.length) throw new Error(issues.join('；'));
                for (const ref of rows(segment.referenceBindings).filter(ref => ref.enabled !== false)) {
                    if (!ref.storageKey && selectedByNode.has(ref.sourceNodeId)) dependencies.push({ targetId: selectedByNode.get(ref.sourceNodeId)!, nodeId: ref.sourceNodeId, bindingId: ref.id });
                }
                if (!dependencies.length) { const compiled = compileReferenceSubmission(frozen, { ...segment, taskMode: runtime.params.taskMode }); assertReferenceCompilation(compiled); compiledKeys = compiled.references.map(ref => String(ref.storageKey || "")).filter(Boolean); }
                command = { mode: 'video', operation: 'h3-run', projectId: project.id, nodeId, segmentId, skipCompleted: false, forceRegenerate: true, params: runtime.params };
            } else {
                const image = effective as ReturnType<typeof effectiveTargetInput> & { references: Array<Record<string, any>>; referenceNodes: string[]; sourceNodeId: string; model: string };
                for (const refNodeId of image.referenceNodes) if (!image.references.some(ref => ref.id === refNodeId || ref.sourceNodeId === refNodeId)) {
                    const targetId = selectedByNode.get(refNodeId);
                    if (!targetId) throw new Error(`参考图没有可用媒体：${refNodeId}`);
                    dependencies.push({ targetId, nodeId: refNodeId });
                }
                const model = image.model || data.settings.imageModels?.[id.slice(id.indexOf(':') + 1)] || data.settings.imageModel;
                if (!model) throw new Error('请选择图片模型');
                command = { mode: 'image', projectId: project.id, nodeId, sourceNodeId: image.sourceNodeId, model,
                    prompt: image.compiledPrompt || image.prompt,
                    ...(image.params.size !== undefined ? { size: String(image.params.size) } : {}),
                    ...(image.params.quality !== undefined ? { quality: String(image.params.quality) } : {}),
                    ...(image.params.count !== undefined ? { count: Number(image.params.count) } : {}),
                    ...(image.params.width !== undefined ? { width: Number(image.params.width) } : {}),
                    ...(image.params.height !== undefined ? { height: Number(image.params.height) } : {}),
                    references: structuredClone(image.references), params: { ...image.params, writeBackToTarget: true }, inputBasis: 'canvas' };
            }
            const keys = segmentId ? compiledKeys || rows((effective as any).references).map(ref => ref.storageKey || rows(frozen.referenceCatalog).find(asset => asset.id === ref.assetId)?.storageKey).filter(Boolean) : rows(command.references).map(ref => ref.storageKey).filter(Boolean);
            for (const key of keys) {
                const info = media(String(key));
                if (!info?.filePath || !fs.existsSync(info.filePath)) throw new Error(`参考文件不存在：${key}`);
                const sha256 = crypto.createHash('sha256').update(fs.readFileSync(info.filePath)).digest('hex');
                (frozen as any).canvasReferenceDigests[key] = sha256;
                if (segmentId) {
                    const asset = rows(frozen.referenceCatalog).find(asset => asset.storageKey === key);
                    if (asset) asset.sha256 = sha256;
                } else for (const ref of command.references || []) if (ref.storageKey === key) ref.sha256 = sha256;
            }
            if (node.metadata?.sharedAssetOrigin && !segmentId) throw new Error('共享引用请打开源资产画布编辑');
            const segment = segmentId && rows(node.metadata?.segments).find(segment => segment.id === segmentId);
            if (segment && segment.productionClipProjection?.fieldHashes && Object.entries(segment.productionClipProjection.fieldHashes).some(([key, hash]) => hash !== inputHash(segment[key]))) warnings.push({ targetId: id, code: 'MANUAL_INPUT', message: '使用当前已保存内容，导演稿保留为基线' });
            const sourceIds = segmentId ? rows((effective as any).references).map(ref => ref.sourceNodeId) : rows(command.references).map(ref => ref.sourceNodeId);
            for (const sourceId of sourceIds) if (Object.values(data.director?.assets || {}).some(asset => asset.nodeId === sourceId && asset.status !== 'approved')) warnings.push({ targetId: id, code: 'REFERENCE_UNREVIEWED', message: '参考素材尚未审核，按当前选择生成' });
            targets.push({ id, nodeId, sourceNodeId: command.sourceNodeId || nodeId, ...(segmentId ? { segmentId } : {}), command, inputHash: inputHash(effective), dependencies });
        } catch (error) { blockedTargets.push({ targetId: id, code: 'CANVAS_INPUT_INVALID', message: (error as Error).message }); }
    }
    // Cycles and failed selected prerequisites affect only their dependent branch.
    const byId = new Map(targets.map(target => [target.id, target]));
    const invalid = new Set(blockedTargets.map(target => target.targetId));
    const visit = (id: string, stack: Set<string>): boolean => {
        if (invalid.has(id)) return false;
        if (stack.has(id)) { invalid.add(id); return false; }
        const target = byId.get(id); if (!target) return false;
        return target.dependencies.every(dep => visit(dep.targetId, new Set([...stack, id])));
    };
    for (const target of targets) if (!visit(target.id, new Set())) { invalid.add(target.id); blockedTargets.push({ targetId: target.id, code: 'DEPENDENCY_BLOCKED', message: '本批次前置目标不可执行或存在依赖循环' }); }
    const scopeNodes = new Set<string>();
    for (const target of targets.filter(target => !invalid.has(target.id))) {
        scopeNodes.add(target.nodeId); scopeNodes.add(target.sourceNodeId);
        for (const ref of target.command.references || []) if (ref.sourceNodeId) scopeNodes.add(String(ref.sourceNodeId));
        for (const dependency of target.dependencies) scopeNodes.add(dependency.nodeId);
        const node = rows(frozen.nodes).find(node => node.id === target.nodeId);
        for (const segment of rows(node?.metadata?.segments)) for (const ref of rows(segment.referenceBindings)) {
            if (ref.sourceNodeId) scopeNodes.add(ref.sourceNodeId);
            const asset = rows(frozen.referenceCatalog).find(asset => asset.id === ref.assetId);
            if (asset?.sourceNodeId) scopeNodes.add(asset.sourceNodeId);
        }
    }
    frozen.nodes = rows(frozen.nodes).filter(node => scopeNodes.has(node.id)).map(node => {
        const copy = structuredClone(node);
        if (copy.metadata) {
            delete copy.metadata.generatedImageHistory; delete copy.metadata.materials;
            for (const segment of rows(copy.metadata.segments)) delete segment.results;
        }
        return copy;
    });
    frozen.connections = rows(frozen.connections).filter(edge => scopeNodes.has(edge.fromNodeId) && scopeNodes.has(edge.toNodeId));
    const snapshot = { schemaVersion: 1 as const, inputBasis: 'canvas' as const, canvasId: project.id, canvasRevision: Number(project.revision || 0), sourceHash: data.director?.sourceHash || '',
        project: frozen, defaults: structuredClone(defaults), targets: targets.filter(target => !invalid.has(target.id)), blockedTargets, warnings };
    return { ...snapshot, planHash: inputHash({ canvasRevision: snapshot.canvasRevision, defaults, targets: snapshot.targets, blockedTargets }) };
}
