import assert from "node:assert/strict";
import test from "node:test";
import "@/i18n";
import {
    boardData,
    isPromptOverModelLimit,
    modelPromptMaxChars,
    promptCharStats,
    referenceMissingLabel,
    referenceSourceLabel,
    segmentCardState,
    videoWaitLabel,
} from "./studio-detail-panel.js";

test("段状态只由本地真值派生，失败/排队/生成中/过期按 H3 段 status 细分", () => {
    assert.deepEqual(segmentCardState({ prompt: "" }), { tone: "idle", label: "待撰写提示词" });
    // 视频段 status=error/queued/loading 是画布 H3 段真实字段，不伪造等待原因或上游阶段。
    const failed = segmentCardState({ prompt: "p", videoStatus: "error", hasVideo: true });
    assert.equal(failed.tone, "failed");
    assert.equal(failed.label, "视频生成失败");
    assert.equal((failed as { detail?: string }).detail, "画布 H3 段 status=error；未记录具体原因，详见生成日志。");
    // 画布 H3 节点级 errorDetails 真值：失败态显示真实原因（对齐影策 segment-parts 失败原因）。
    const withError = segmentCardState({ prompt: "p", videoStatus: "error", hasVideo: true, errorDetails: "ComfyUI 已停止或当前不可达（ECONNREFUSED）" });
    assert.equal((withError as { detail?: string }).detail, "ComfyUI 已停止或当前不可达（ECONNREFUSED）");
    // 非文本噪声（[object Object] 等）由数据层过滤，这里只保证有值即展示。
    assert.equal((segmentCardState({ prompt: "p", videoStatus: "error", errorDetails: "fetch failed" }) as { detail?: string }).detail, "fetch failed");
    assert.deepEqual(Object.keys(failed).sort(), ["detail", "label", "tone"]);
    assert.equal(segmentCardState({ prompt: "p", videoStatus: "queued" }).label, "排队提交中");
    assert.equal(segmentCardState({ prompt: "p", videoStatus: "loading" }).tone, "busy");
    assert.equal(segmentCardState({ prompt: "p", videoStatus: "cancelled" }).label, "视频生成已取消");
    // inputOutdated 与 stale 回执是本地真实的「需重新生成」来源。
    assert.equal(segmentCardState({ prompt: "p", inputOutdated: true, hasVideo: true }).label, "视频需重新生成（输入已更改）");
    assert.equal(segmentCardState({ prompt: "p", artStatus: "stale", hasVideo: true }).label, "视频需重新生成");
    assert.equal(segmentCardState({ prompt: "p", hasVideo: true }).label, "视频已生成");
    assert.equal(segmentCardState({ prompt: "p" }).label, "待生成视频");
    // 无真值字段时状态对象不带 detail，不编造等待原因。
    assert.deepEqual(segmentCardState({ prompt: "p", videoStatus: "loading" }), { tone: "busy", label: "生成视频中" });
});

test("段状态接入后端 segment.state：提示词失败/等待/过期按影策优先级细分", () => {
    // 提示词失败是终态，先于「无提示词」与视频态；promptError 是后端真值，有才展示。
    assert.deepEqual(segmentCardState({ prompt: "", promptStatus: "failed", promptError: "文本模型不可用" }), {
        tone: "failed", label: "提示词撰写失败", detail: "文本模型不可用",
    });
    assert.deepEqual(segmentCardState({ prompt: "p", promptStatus: "failed" }), { tone: "failed", label: "提示词撰写失败" });
    // 撰写已排队但没提交：短标签取冒号/括号前，完整等待原因放进 detail。
    assert.deepEqual(segmentCardState({ prompt: "p", promptStatus: "queued", waitReason: "并发已满：同时生成数达上限" }), {
        tone: "blocked", label: "并发已满", detail: "并发已满：同时生成数达上限",
    });
    assert.deepEqual(segmentCardState({ prompt: "p", promptStatus: "running", waitReason: "账号配额耗尽（稍后重试）" }), {
        tone: "blocked", label: "账号配额耗尽", detail: "账号配额耗尽（稍后重试）",
    });
    // queued/running 无等待真值 → 撰写中；有上游阶段真值则展示阶段。
    assert.deepEqual(segmentCardState({ prompt: "p", promptStatus: "queued" }), { tone: "busy", label: "撰写提示词中" });
    assert.deepEqual(segmentCardState({ prompt: "p", promptStatus: "running", upstreamStage: "上游排队" }), {
        tone: "busy", label: "上游排队", detail: "上游进度：上游排队",
    });
    // 待撰写 / 提示词已过期（先于视频 ready 分支）。
    assert.deepEqual(segmentCardState({ prompt: "", promptStatus: "none" }), { tone: "idle", label: "待撰写提示词" });
    assert.deepEqual(segmentCardState({ prompt: "p", promptStatus: "stale", hasVideo: true }), { tone: "stale", label: "提示词已过期" });
    // 视频真在跑时 prompt stale 不能抢在前：否则徽标「提示词已过期」会与按钮/遮罩「生成中」并存，
    // 占位处还会透出叠加文案「提示生成中过期」。视频态优先，过期提示等任务结束后再出现。
    assert.deepEqual(segmentCardState({ prompt: "p", promptStatus: "stale", videoStatus: "loading" }), { tone: "busy", label: "生成视频中" });
    assert.equal(segmentCardState({ prompt: "p", promptStatus: "stale", videoStatus: "error" }).tone, "failed");
    // 视频等待原因真值也走 blocked，不冒充「排队提交中」。
    assert.deepEqual(segmentCardState({ prompt: "p", videoStatus: "queued", waitReason: "排队中：上游队列较长" }), {
        tone: "blocked", label: "排队中", detail: "排队中：上游队列较长",
    });
    // 生成中上游阶段真值：展示阶段，无真值保持本地文案（不回归）。
    assert.deepEqual(segmentCardState({ prompt: "p", videoStatus: "loading", upstreamStage: "正在合成" }), {
        tone: "busy", label: "正在合成", detail: "上游进度：正在合成",
    });
    assert.deepEqual(segmentCardState({ prompt: "p", videoStatus: "loading" }), { tone: "busy", label: "生成视频中" });
    // references 从 state 透传但只用于参考图区，不改变状态判定；无 state 时本地真值分支照旧。
    assert.equal(segmentCardState({ prompt: "p", hasVideo: true, references: [{ label: "参考图1", sent: false }] }).label, "视频已生成");
    assert.equal(segmentCardState({ prompt: "p", videoStatus: "error", errorDetails: "fetch failed", promptStatus: "stale" }).detail, "fetch failed");
});

test("未附图文案只取 state.references 真值，无 missingReason 不编原因", () => {
    assert.equal(videoWaitLabel("并发已满：同时生成数达上限"), "并发已满");
    assert.equal(videoWaitLabel("账号配额耗尽（稍后重试）"), "账号配额耗尽");
    assert.equal(videoWaitLabel("没有分隔符"), "没有分隔符");
    assert.equal(referenceMissingLabel({ sent: false, missingReason: "参考图生成失败" }), "未附图：参考图生成失败");
    assert.equal(referenceMissingLabel({ sent: false, missingReason: "模型按文生视频生成，不收参考图" }), "未附图：模型按文生视频生成，不收参考图");
    // missingReason 为 undefined 时只说未附图，不编造原因。
    assert.equal(referenceMissingLabel({ sent: false }), "未附图");
    assert.equal(referenceMissingLabel({ sent: false, missingReason: "" }), "未附图");
    // 已发送或后端 state 未落地（sent 为 undefined）时不出未附图文案，保持原 tooltip 行为。
    assert.equal(referenceMissingLabel({ sent: true, missingReason: "参考图生成失败" }), null);
    assert.equal(referenceMissingLabel({}), null);
});

test("draft segment.state 真值接进段卡片：状态细分与未附图原因都来自后端", () => {
    const production = {
        draft: {
            director: {
                source: {
                    shots: [{ id: "sh1", segment_id: "seg1", duration_frames: 24, title: "镜1" }],
                    segments: [{
                        id: "seg1", shot_ids: ["sh1"], mode: "auto",
                        state: {
                            promptStatus: "queued", promptError: "", waitReason: "并发已满：同时生成数达上限",
                            upstreamStage: "上游排队",
                            references: [
                                { label: "Picture 1", sent: false, missingReason: "参考图生成失败" },
                                { label: "Picture 2", sent: true },
                            ],
                        },
                    }],
                },
                artifacts: [{
                    kind: "h3", targetId: "seg1", prompt: "p", status: "ok", receipt: {},
                    references: [{ label: "Picture 1", storageKey: "image:a" }, { label: "Picture 2", storageKey: "image:b" }],
                }],
            },
        },
    } as any;
    // 卡片视频真值必须来自画布段的 video: 产物；测试补上真实产物，不拿 artifact 快照冒充成片。
    const readyClip = [{ id: "c1", targetId: "seg1", title: "镜1", storageKey: "video:real", duration: 1, status: "success", inputOutdated: false }] as any;
    const card = boardData(production, readyClip).cards[0];
    assert.equal(card.state.tone, "blocked");
    assert.equal(card.state.label, "并发已满");
    assert.equal(card.state.detail, "并发已满：同时生成数达上限");
    assert.equal(card.thumbnails[0].sent, false);
    assert.equal(card.thumbnails[0].missingReason, "参考图生成失败");
    assert.equal(referenceMissingLabel(card.thumbnails[0]), "未附图：参考图生成失败");
    assert.equal(card.thumbnails[1].sent, true);
    assert.equal(referenceMissingLabel(card.thumbnails[1]), null);

    // 后端尚未落 state 时：卡片按本地真值派生，参考图不带 sent/原因，不编造未附图。
    const noState = structuredClone(production);
    delete noState.draft.director.source.segments[0].state;
    const legacy = boardData(noState, readyClip).cards[0];
    assert.equal(legacy.state.label, "视频已生成");
    assert.equal(legacy.thumbnails[0].sent, undefined);
    assert.equal(referenceMissingLabel(legacy.thumbnails[0]), null);
});

test("参考图来源只取 artifact.references 真字段", () => {
    assert.equal(referenceSourceLabel({ assetId: "asset-1", nodeId: "node-1" }), "项目资产设定");
    assert.equal(referenceSourceLabel({ nodeId: "node-1" }), "画布设定节点");
    assert.equal(referenceSourceLabel({ storageKey: "image:abc" }), "制作稿编译参考");
    assert.equal(referenceSourceLabel({}), "未绑定设定");
});

test("promptMaxChars 兼容未落地的中间态：无真值一律 null，不硬拦截", () => {
    assert.equal(modelPromptMaxChars(undefined), null);
    assert.equal(modelPromptMaxChars(null), null);
    assert.equal(modelPromptMaxChars({}), null);
    assert.equal(modelPromptMaxChars({ promptMaxChars: undefined }), null);
    assert.equal(modelPromptMaxChars({ promptMaxChars: 0 }), null);
    assert.equal(modelPromptMaxChars({ promptMaxChars: -5 }), null);
    assert.equal(modelPromptMaxChars({ promptMaxChars: NaN }), null);
    assert.equal(modelPromptMaxChars({ promptMaxChars: Infinity }), null);
    assert.equal(modelPromptMaxChars({ promptMaxChars: "8000" }), null);
    // 真值为有限正数时取整，按模型能力硬校验。
    assert.equal(modelPromptMaxChars({ promptMaxChars: 8000 }), 8000);
    assert.equal(modelPromptMaxChars({ promptMaxChars: 8000.9 }), 8000);
});

test("硬上限按码点计数，等于上限放行、超过拦截；无真值永不拦截", () => {
    assert.equal(isPromptOverModelLimit("甲".repeat(8000), 8000), false);
    assert.equal(isPromptOverModelLimit("甲".repeat(8001), 8000), true);
    assert.equal(isPromptOverModelLimit("甲".repeat(100_000), null), false);
    // emoji 在 UTF-16 是 2 个 code unit，按影策/后端码点口径只算 1 个字符。
    assert.equal(isPromptOverModelLimit("🎬".repeat(8000), 8000), false);
    assert.equal(isPromptOverModelLimit("🎬".repeat(8001), 8000), true);
    // 原有软上限函数返回结构保持不变（兼容已有单测）。
    assert.deepEqual(promptCharStats("你好"), { sentChars: 2, overSoftLimit: false });
});

test("custom 门控：手写提示词标 custom 后 stale 不再显示过期，仅 LLM 撰写才过期", () => {
    // 后端 state 未落地或 custom 为假时，stale 照旧显示过期（不回归）。
    assert.deepEqual(segmentCardState({ prompt: "p", promptStatus: "stale", hasVideo: true }), { tone: "stale", label: "提示词已过期" });
    assert.deepEqual(segmentCardState({ prompt: "p", promptStatus: "stale", custom: false, hasVideo: true }), { tone: "stale", label: "提示词已过期" });
    // stale + custom=true：影策不显示过期，继续往下判（有视频 → 视频已生成）。
    assert.deepEqual(segmentCardState({ prompt: "p", promptStatus: "stale", custom: true, hasVideo: true }), { tone: "ready", label: "视频已生成" });
    // stale + custom=true 且无视频：落到「待生成视频」，不是过期。
    assert.deepEqual(segmentCardState({ prompt: "p", promptStatus: "stale", custom: true }), { tone: "idle", label: "待生成视频" });
    // custom=true 但 stale 不成立时不误伤：仍按正常分支走。
    assert.equal(segmentCardState({ prompt: "p", custom: true, hasVideo: true }).label, "视频已生成");
});

test("videoReprocessable 门控：视频失败区分『后处理失败』与『生成失败』", () => {
    // 默认（无真值）保持原文案，不回归。
    assert.equal(segmentCardState({ prompt: "p", videoStatus: "error", hasVideo: true }).label, "视频生成失败");
    // videoReprocessable=false 明确同默认。
    assert.equal(segmentCardState({ prompt: "p", videoStatus: "error", hasVideo: true, videoReprocessable: false }).label, "视频生成失败");
    // videoReprocessable=true → 后处理失败，失败兜底文案保持不回归。
    const reprocess = segmentCardState({ prompt: "p", videoStatus: "error", hasVideo: true, videoReprocessable: true });
    assert.equal(reprocess.tone, "failed");
    assert.equal(reprocess.label, "视频后处理失败");
    assert.equal((reprocess as { detail?: string }).detail, "画布 H3 段 status=error；未记录具体原因，详见生成日志。");
    // 有 errorDetails 真值时仍展示真实原因。
    assert.equal((segmentCardState({ prompt: "p", videoStatus: "error", hasVideo: true, videoReprocessable: true, errorDetails: "尾帧合成失败" }) as { detail?: string }).detail, "尾帧合成失败");
    // 提示词失败优先级仍高于视频失败（custom / reprocessable 不越级）。
    assert.equal(segmentCardState({ prompt: "p", promptStatus: "failed", videoStatus: "error", videoReprocessable: true, custom: true }).label, "提示词撰写失败");
});

test("boardData 透传 segment.state.custom / videoReprocessable 到卡片状态", () => {
    const base = {
        draft: {
            director: {
                source: {
                    shots: [{ id: "sh1", segment_id: "seg1", duration_frames: 24, title: "镜1" }],
                    segments: [{ id: "seg1", shot_ids: ["sh1"], mode: "auto" }],
                },
                artifacts: [{ kind: "h3", targetId: "seg1", prompt: "p", status: "ok", receipt: {} }],
            },
        },
    } as any;
    // 手写段 stale 的用例同样需要真实 video: 产物，否则「视频已生成」是无真值编造。
    const readyClip = [{ id: "c0", targetId: "seg1", title: "镜1", storageKey: "video:real", duration: 1, status: "success", inputOutdated: false }] as any;
    // custom=true + stale：手写提示词不被判过期，有视频产物 → 视频已生成。
    const customProd = structuredClone(base);
    customProd.draft.director.source.segments[0].state = { promptStatus: "stale", custom: true };
    assert.equal(boardData(customProd, readyClip).cards[0].state.label, "视频已生成");
    // videoReprocessable=true + H3 段 status=error → 视频后处理失败。
    const reprocessProd = structuredClone(base);
    reprocessProd.draft.director.source.segments[0].state = { videoReprocessable: true };
    const clipMedia = [{ id: "c1", targetId: "seg1", title: "镜1", storageKey: "", duration: 1, status: "error", inputOutdated: false }] as any;
    const reprocessCard = boardData(reprocessProd, clipMedia).cards[0];
    assert.equal(reprocessCard.state.label, "视频后处理失败");
    assert.equal(reprocessCard.state.detail, "画布 H3 段 status=error；未记录具体原因，详见生成日志。");
});

test("segment.state.videoStatus/request 接入影策 6 态：failed/blocked/busy/stale/ready/idle", () => {
    // failed：state 的视频失败原因直接展示，不编造。
    assert.deepEqual(segmentCardState({ prompt: "p", stateVideoStatus: "failed", videoError: "提交被拒：配额耗尽" }), {
        tone: "failed", label: "视频生成失败", detail: "提交被拒：配额耗尽",
    });
    // 无 videoError 真值时 detail 缺省（不写「详见日志」这类本地臆测）。
    assert.deepEqual(segmentCardState({ prompt: "p", stateVideoStatus: "failed" }), { tone: "failed", label: "视频生成失败" });
    // blocked：提示词等待 + 视频排队等待原因都取冒号/括号前短标签。
    assert.deepEqual(segmentCardState({ prompt: "p", promptStatus: "queued", waitReason: "并发已满：同时生成数达上限" }), {
        tone: "blocked", label: "并发已满", detail: "并发已满：同时生成数达上限",
    });
    assert.deepEqual(segmentCardState({ prompt: "p", stateVideoStatus: "queued", waitReason: "排队中：上游队列较长" }), {
        tone: "blocked", label: "排队中", detail: "排队中：上游队列较长",
    });
    // blocked：loading 中 request.firstFramePending 真值 → 等上一段（不误报「生成视频中」）。
    assert.deepEqual(segmentCardState({ prompt: "p", stateVideoStatus: "loading", request: { firstFramePending: true } }), {
        tone: "blocked", label: "等待上一段",
    });
    assert.deepEqual(segmentCardState({ prompt: "p", stateVideoStatus: "running", request: { firstFramePending: false } }), {
        tone: "busy", label: "生成视频中",
    });
    // busy：提示词撰写中 / 视频排队 / 生成中带上游阶段。
    assert.deepEqual(segmentCardState({ prompt: "p", promptStatus: "running" }), { tone: "busy", label: "撰写提示词中" });
    assert.deepEqual(segmentCardState({ prompt: "p", stateVideoStatus: "queued" }), { tone: "busy", label: "排队提交中" });
    assert.deepEqual(segmentCardState({ prompt: "p", stateVideoStatus: "loading", upstreamStage: "正在合成" }), {
        tone: "busy", label: "正在合成", detail: "上游进度：正在合成",
    });
    // stale：提示词过期 / 视频需重新生成 / 输入已改。
    assert.deepEqual(segmentCardState({ prompt: "p", promptStatus: "stale" }), { tone: "stale", label: "提示词已过期" });
    assert.deepEqual(segmentCardState({ prompt: "p", stateVideoStatus: "stale" }), { tone: "stale", label: "视频需重新生成" });
    assert.equal(segmentCardState({ prompt: "p", inputOutdated: true }).label, "视频需重新生成（输入已更改）");
    // ready / idle：state ready 是真值；无提示词且无 video 真值只说待撰写。
    assert.deepEqual(segmentCardState({ prompt: "p", stateVideoStatus: "ready" }), { tone: "ready", label: "视频已生成" });
    assert.deepEqual(segmentCardState({ prompt: "", promptStatus: "none" }), { tone: "idle", label: "待撰写提示词" });
    assert.deepEqual(segmentCardState({ prompt: "p" }), { tone: "idle", label: "待生成视频" });
});

test("videoWaitLabel 取冒号/括号前的短标签，兼容中英文标点", () => {
    assert.equal(videoWaitLabel("并发已满: 同时生成数达上限"), "并发已满");
    assert.equal(videoWaitLabel("账号配额耗尽(稍后重试)"), "账号配额耗尽");
    assert.equal(videoWaitLabel("排队中（上游队列较长）"), "排队中");
    assert.equal(videoWaitLabel("：冒号开头"), "：冒号开头");
    assert.equal(videoWaitLabel(""), "");
});

test("state.videoError 显示真值，画布 errorDetails 仍兼容，两者皆无则不带 detail", () => {
    const base = {
        draft: { director: {
            source: { shots: [{ id: "sh1", segment_id: "seg1", duration_frames: 24 }], segments: [{ id: "seg1", shot_ids: ["sh1"], mode: "auto" }] },
            artifacts: [{ kind: "h3", targetId: "seg1", prompt: "p", status: "ok", receipt: {} }],
        } },
    } as any;
    const withStateError = structuredClone(base);
    withStateError.draft.director.source.segments[0].state = { videoStatus: "failed", videoError: "H3 返回 429：并发超限" };
    const stateCard = boardData(withStateError).cards[0];
    assert.equal(stateCard.state.label, "视频生成失败");
    assert.equal(stateCard.state.detail, "H3 返回 429：并发超限");

    // 画布 H3 节点级 errorDetails 优先（更贴近产物的真实原因），state 原因不覆盖。
    const bothErrors = structuredClone(base);
    bothErrors.draft.director.source.segments[0].state = { videoStatus: "failed", videoError: "state 原因" };
    const clipMedia = [{ id: "c1", targetId: "seg1", title: "镜1", storageKey: "", duration: 1, status: "error", errorDetails: "ComfyUI 不可达（ECONNREFUSED）", inputOutdated: false }] as any;
    assert.equal(boardData(bothErrors, clipMedia).cards[0].state.detail, "ComfyUI 不可达（ECONNREFUSED）");

    // 只有画布 status=error 时继续走原有兜底文案，不回归。
    const clipOnly = structuredClone(base);
    assert.equal(boardData(clipOnly, clipMedia).cards[0].state.label, "视频生成失败");
    assert.equal(boardData(clipOnly, clipMedia).cards[0].state.detail, "ComfyUI 不可达（ECONNREFUSED）");
});

test("boardData 的 videoReprocessable 分流对 state.videoStatus 同样生效", () => {
    const base = {
        draft: { director: {
            source: { shots: [{ id: "sh1", segment_id: "seg1", duration_frames: 24 }], segments: [{ id: "seg1", shot_ids: ["sh1"], mode: "auto" }] },
            artifacts: [{ kind: "h3", targetId: "seg1", prompt: "p", status: "ok", receipt: {} }],
        } },
    } as any;
    const reprocess = structuredClone(base);
    reprocess.draft.director.source.segments[0].state = { videoStatus: "failed", videoError: "尾帧合成失败", videoReprocessable: true };
    assert.equal(boardData(reprocess).cards[0].state.label, "视频后处理失败");

    const generate = structuredClone(base);
    generate.draft.director.source.segments[0].state = { videoStatus: "failed", videoError: "尾帧合成失败", videoReprocessable: false };
    assert.equal(boardData(generate).cards[0].state.label, "视频生成失败");

    // 提示词失败仍先于视频失败。
    const promptFirst = structuredClone(base);
    promptFirst.draft.director.source.segments[0].state = {
        promptStatus: "failed", promptError: "文本模型不可用", videoStatus: "failed", videoError: "尾帧合成失败", videoReprocessable: true,
    };
    assert.deepEqual(boardData(promptFirst).cards[0].state, { tone: "failed", label: "提示词撰写失败", detail: "文本模型不可用" });

    // request.firstFramePending 通过 boardData 透传到卡片 blocked 态。
    const pending = structuredClone(base);
    pending.draft.director.source.segments[0].state = { videoStatus: "loading", request: { firstFramePending: true, operation: "generate", referencesSent: 2, referenceLimited: false } };
    assert.deepEqual(boardData(pending).cards[0].state, { tone: "blocked", label: "等待上一段" });
});
