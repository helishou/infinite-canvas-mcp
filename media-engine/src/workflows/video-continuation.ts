/**
 * 视频续写（像素/音频引导）的非侵入实现：纯图变换，无副作用。
 *
 * 「无限流」这类工作流的原生续段靠 easy forLoopStart 的循环携带值
 * （initial_value1=上段尾22帧画面、initial_value2=上段累计视频、initial_value3=上段尾20帧音频），
 * 并用「循环索引 > 0」判定续段。原流里这三个初值悬空、也没有外部上一段视频加载器，
 * 因此无法直接续写外部成片。本模块在每次执行的 API 图副本上动态追加节点：
 * 加载上一段成片 → 截尾帧/尾音频 → 接进循环初值，并把续段/多段判定与重叠帧规划
 * 强制为「续段」，让本次运行的首段也消费外部种子。存储的原工作流图从不被修改。
 *
 * 段号强制为 1..1：本次运行只生成一段，提示词按原样作为第 1 段提取（量化子=段号-1=0），
 * 续写物理来自种子与判定旗标，与段号无关，避免向提示词塞占位分隔符。
 */

type ApiNode = { class_type?: string; inputs?: Record<string, unknown> };
type Link = [string, number];

/** 本次执行实际追加/改写的可观察事实，供生成日志向用户证明续写已进入执行（而非仅声明了开关）。 */
export type VideoContinuationSummary = {
    prevVideoFile: string;
    addedNodes: number;
    loopId: string;
    startSegmentNode: string;
    endSegmentNode: string;
    continuationRewires: number;
    overlapRewires: number;
};

function nodeOf(value: unknown): ApiNode | null {
    return value && typeof value === "object" && !Array.isArray(value) ? value as ApiNode : null;
}

function linkOf(value: unknown): Link | null {
    return Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "number" ? [value[0], value[1]] : null;
}

function sameLink(value: unknown, target: Link | null): boolean {
    const link = linkOf(value);
    return Boolean(link && target && link[0] === target[0] && link[1] === target[1]);
}

function inputsOf(node: ApiNode): Record<string, unknown> {
    return node.inputs && typeof node.inputs === "object" ? node.inputs : {};
}

/** 工作流不支持续写时抛出清晰错误，由调用方让任务失败，绝不静默产出无续写的视频。 */
export function applyVideoContinuation(
    workflow: Record<string, unknown>,
    prevVideoFile: string,
): { workflow: Record<string, unknown>; summary: VideoContinuationSummary } {
    if (!prevVideoFile || !prevVideoFile.trim()) throw new Error("视频续写缺少上一段成片文件名");
    const result: Record<string, unknown> = JSON.parse(JSON.stringify(workflow));
    const entries = Object.entries(result).filter(([, value]) => nodeOf(value)?.class_type) as Array<[string, ApiNode]>;

    const loops = entries.filter(([, node]) => node.class_type === "easy forLoopStart" || node.class_type === "forLoopStart");
    if (loops.length !== 1) throw new Error("视频续写需要工作流恰好有一个 easy forLoopStart 循环入口（当前工作流不支持续写）");
    const [loopId, loopNode] = loops[0];
    const indexLink: Link = [loopId, 1];

    // 起始段号 = 「当前段号 = 循环索引 + 起始段号」加法器的 b 输入源。
    const adder = entries.find(([, node]) => node.class_type === "MathExpression|pysssss" && sameLink(inputsOf(node).a, indexLink));
    const startLink = adder ? linkOf(inputsOf(adder[1]).b) : null;
    const startNode = startLink ? nodeOf(result[startLink[0]]) : null;
    if (!startLink || startNode?.class_type !== "PrimitiveInt") throw new Error("视频续写找不到起始段号节点（当前工作流不支持续写）");
    // 结束段号 = 以起始段号为 b 输入的段数计算式的 a 输入源。
    const totalMath = entries.find(([, node]) => node.class_type === "ComfyMathExpression" && sameLink(inputsOf(node)["values.b"], startLink));
    const endLink = totalMath ? linkOf(inputsOf(totalMath[1])["values.a"]) : null;
    const endNode = endLink ? nodeOf(result[endLink[0]]) : null;
    if (!endLink || endNode?.class_type !== "PrimitiveInt") throw new Error("视频续写找不到结束段号节点（当前工作流不支持续写）");

    const totalLink = linkOf(inputsOf(loopNode).total);
    // 续段判定（循环索引 > 0）与多段判定（计划段数 > 1）都是单输入 ComfyMathExpression，靠输入源区分。
    const continuationMaths = entries.filter(([id, node]) => id !== loopId && node.class_type === "ComfyMathExpression" && sameLink(inputsOf(node)["values.a"], indexLink));
    const multiMaths = entries.filter(([, node]) => node.class_type === "ComfyMathExpression" && totalLink && sameLink(inputsOf(node)["values.a"], totalLink));
    if (continuationMaths.length !== 1 || multiMaths.length !== 1) throw new Error("视频续写无法唯一定位续段/多段判定节点（当前工作流不支持续写）");
    const continuationBoolLink: Link = [continuationMaths[0][0], 2];
    const multiBoolLink: Link = [multiMaths[0][0], 2];

    const added = ["vc_load", "vc_tail_img", "vc_audio_start", "vc_audio_end", "vc_audio_img", "vc_tail_audio", "vc_prev_video", "vc_resume_flag", "vc_overlap_flag"];
    for (const id of added) if (result[id]) throw new Error(`视频续写节点 ID 冲突：${id}`);

    // 上一段成片加载器：输出 IMAGE(0) / frame_count(1) / audio(2)。
    result.vc_load = { class_type: "VHS_LoadVideo", inputs: { video: prevVideoFile, force_rate: 24, custom_width: 0, custom_height: 0, frame_load_cap: 0, skip_first_frames: 0, select_every_nth: 1, format: "AnimateDiff" } };
    // 尾22帧画面：负 batch_index 从尾部取，与原流循环回传节点同构。
    result.vc_tail_img = { class_type: "ImageFromBatch", inputs: { image: ["vc_load", 0], batch_index: -22, length: 22 } };
    // 尾20帧音频：对齐尾22帧衔接区首部 [L-22, L-2)，预留后2帧防爆音隔离带，与原流 1311 截尾同构。
    result.vc_audio_start = { class_type: "ComfyMathExpression", inputs: { "values.a": ["vc_load", 1], expression: "max(0, a - 22)" } };
    result.vc_audio_end = { class_type: "ComfyMathExpression", inputs: { "values.a": ["vc_load", 1], expression: "max(0, a - 2)" } };
    result.vc_audio_img = { class_type: "ImageFromBatch", inputs: { image: ["vc_load", 0], batch_index: 0, length: ["vc_audio_end", 1] } };
    result.vc_tail_audio = { class_type: "MiniMaxH3MotionContextTrim", inputs: { images: ["vc_audio_img", 0], audio: ["vc_load", 2], trim_frames: ["vc_audio_start", 1], fps: 24, match_tail: true } };
    // 上段累计视频种子：供续段拼接分支消费，避免空 VIDEO 崩任务。
    result.vc_prev_video = { class_type: "CreateVideo", inputs: { images: ["vc_load", 0], audio: ["vc_load", 2], fps: 24, bit_depth: 8, color_space: "sRGB", chroma_subsampling: "420", codec: "none" } };
    result.vc_resume_flag = { class_type: "PrimitiveBoolean", inputs: { value: true } };
    result.vc_overlap_flag = { class_type: "PrimitiveInt", inputs: { value: 1 } };

    // 循环初值接上外部种子。
    inputsOf(loopNode).initial_value1 = ["vc_tail_img", 0];
    inputsOf(loopNode).initial_value2 = ["vc_prev_video", 0];
    inputsOf(loopNode).initial_value3 = ["vc_tail_audio", 1];
    // 本次只运行一段，按第 1 段提取原始提示词。
    inputsOf(startNode).value = 1;
    inputsOf(endNode).value = 1;

    // 续段/多段判定恒真（本次每段都是续段）；帧规划的 b>0 重叠项恒为 1（首段也生成 +22 重叠帧）。
    let continuationRewires = 0;
    let overlapRewires = 0;
    for (const [, node] of entries) {
        const inputs = inputsOf(node);
        for (const [name, value] of Object.entries(inputs)) {
            if (sameLink(value, continuationBoolLink) || sameLink(value, multiBoolLink)) {
                inputs[name] = ["vc_resume_flag", 0];
                continuationRewires++;
            } else if (node.class_type === "ComfyMathExpression" && name === "values.b" && sameLink(value, indexLink)) {
                inputs[name] = ["vc_overlap_flag", 0];
                overlapRewires++;
            }
        }
    }
    return {
        workflow: result,
        summary: {
            prevVideoFile,
            addedNodes: added.length,
            loopId,
            startSegmentNode: startLink[0],
            endSegmentNode: endLink[0],
            continuationRewires,
            overlapRewires,
        },
    };
}