import { isSubjectPromptAssembly, type DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";

type Row = Record<string, any>;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(value => value && typeof value === "object" ? value as Row : {}) : [];

/** A destination Clip has an explicit opening frame only when its first Shot has a submitted storyboard/keyframe. */
export function hasExplicitOpeningStoryboard(director: DirectorProduction, segment: Row | undefined,
    shotInputs: Record<string, unknown> = director.shotInputs, shots: unknown = director.source.shots) {
    const firstShotId = String(segment && Array.isArray(segment.shot_ids) ? segment.shot_ids[0] || "" : "");
    if (!firstShotId) return false;
    const shot = rows(shots).find(item => String(item.id || "") === firstShotId);
    if (isSubjectPromptAssembly(director.source)) {
        return rows(shot?.keyframes).some(frame => frame.requiredForSubmission === true
            && (frame.anchor === "opening" || frame.anchor === "at_frame" && Number(frame.localFrame) === 0));
    }
    const input = shotInputs[firstShotId] as Row | undefined;
    return Boolean(input && input.keyframePolicy !== "none" && input.keyframeAssetId);
}

export function defaultDirectorBoundary(director: DirectorProduction, from: string, to: string,
    options: { destination?: Row; shotInputs?: Record<string, unknown>; shots?: unknown } = {}) {
    const destination = options.destination || rows(director.source.segments).find(segment => String(segment.id || "") === to);
    const explicitOpening = hasExplicitOpeningStoryboard(director, destination, options.shotInputs, options.shots);
    return {
        from, to,
        tailFrame: !explicitOpening,
        motionContext: false,
        reason: explicitOpening
            ? "目标 Clip 已有明确首帧分镜图，沿用该首帧。"
            : "默认引用前段尾帧承接下一 Clip 的动作与场景状态；Motion Context 保持关闭。",
    };
}
