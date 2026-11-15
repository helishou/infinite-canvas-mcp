/**
 * Clip 锁定计划：单段与「全部锁定 / 全部解锁」共用的纯函数。
 *
 * 锁定不只是 director.source.segments[].locked = true：还要把画布 H3 节点的噪声模式
 * 固定成 fixed（并记录 preLockNoiseSeedMode），否则锁定后重编译/生成仍会因随机种子变化。
 * 这里一次性算出源稿补丁、画布编辑与失败回滚编辑，调用方各自负责提交，避免两条路径语义分叉。
 */

export type ClipLockSource = {
    id: string;
    locked?: unknown;
    preLockNoiseSeedMode?: unknown;
};

export type ClipLockRuntime = {
    nodeId: string;
    segmentId: string;
    seed?: unknown;
    noiseSeed?: unknown;
    noiseSeedMode?: unknown;
};

export type ClipLockInput = {
    source: ClipLockSource;
    runtime?: ClipLockRuntime;
};

export type SourceLockPatch = { entity: "segment"; id: string; patch: Record<string, unknown> };
export type CanvasLockEdit = { nodeId: string; segmentId: string; patch: Record<string, unknown> };

export type ClipLockPlan = {
    /** 实际需要改变状态的 Clip id（已处于目标态的会被跳过）。 */
    ids: string[];
    patches: SourceLockPatch[];
    canvasEdits: CanvasLockEdit[];
    /** 源稿提交失败时，把画布噪声模式恢复到操作前状态。 */
    rollbackCanvasEdits: CanvasLockEdit[];
};

export function buildClipLockPlan(inputs: readonly ClipLockInput[], locked: boolean, random: () => number = Math.random): ClipLockPlan {
    const ids: string[] = [];
    const patches: SourceLockPatch[] = [];
    const canvasEdits: CanvasLockEdit[] = [];
    const rollbackCanvasEdits: CanvasLockEdit[] = [];
    for (const { source, runtime } of inputs) {
        const id = String(source.id ?? "").trim();
        if (!id) continue;
        const currentlyLocked = source.locked === true;
        if (currentlyLocked === locked) continue;
        const currentMode = runtime?.noiseSeedMode === "fixed" ? "fixed" : "random";
        const savedMode = source.preLockNoiseSeedMode;
        const restoreMode = savedMode === "fixed" || savedMode === "random" ? savedMode : currentMode;
        const seedValue = Number(runtime?.seed ?? runtime?.noiseSeed);
        const hasSeed = Number.isFinite(seedValue) && seedValue >= 0;
        const seed = hasSeed ? seedValue : Math.max(1, Math.floor(random() * Number.MAX_SAFE_INTEGER));
        ids.push(id);
        patches.push({
            entity: "segment",
            id,
            patch: locked ? { locked: true, preLockNoiseSeedMode: currentMode } : { locked: false, preLockNoiseSeedMode: null },
        });
        if (runtime) {
            const target = { nodeId: runtime.nodeId, segmentId: runtime.segmentId };
            canvasEdits.push({
                ...target,
                patch: locked ? { noiseSeedMode: "fixed", seed, noiseSeed: seed } : { noiseSeedMode: restoreMode },
            });
            // 锁定时回滚到原模式；解锁时回滚回 fixed（源稿没解锁，画面必须继续保持固定）。
            rollbackCanvasEdits.push({
                ...target,
                patch: locked ? { noiseSeedMode: currentMode } : { noiseSeedMode: "fixed" },
            });
        }
    }
    return { ids, patches, canvasEdits, rollbackCanvasEdits };
}
