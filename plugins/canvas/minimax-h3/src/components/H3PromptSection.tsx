import { getReact, useEffect, useMemo, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext, CanvasTextEditorHandle } from "@infinite-canvas/plugin-sdk";
import { Select } from "antd";
import type { H3Ref, H3Segment } from "../types";
import { H3Icon } from "./H3Icon";
import { refsForSegment } from "../services/h3-data";
import { segmentsFor } from "../hooks/useH3Segments";
import { persistPromptCandidate, promptJobs, setPromptJob } from "../services/h3-prompt-jobs";
import baseReference from "../storyboard-assets/references/base-en.txt?raw";
import refReference from "../storyboard-assets/references/ref-en.txt?raw";

type Props = {
  ctx: CanvasNodeContext;
  selected?: H3Segment;
  imageRefs: H3Ref[];
  videoRefs: H3Ref[];
  audioRefs: H3Ref[];
  patchSelected: (patch: Partial<H3Segment>) => void;
  onOpenStoryboard: () => void;
};

// 南风 H3 官方提示词骨架（nanfeng_prompt_nodes[_v10] web/h3_multiref.js insertPromptBlock 逐字核对）
const H3_OFFICIAL_BLOCK = [
  "subject_definitions:",
  "",
  "summary:",
  "",
  "retention_analysis:",
  "",
  "detailed_description:",
  "",
  "overall_soundscape:",
  "",
  "non_diegetic_music:",
  "N/A",
].join("\n");

const H3_SECTION_BLOCKS: Record<string, string> = {
  模板: H3_OFFICIAL_BLOCK,
  定义: "subject_definitions:\n",
  摘要: "summary:\n",
  保留: "retention_analysis:\n",
  分镜: "detailed_description:\n",
  声景: "overall_soundscape:\n",
  配乐: "non_diegetic_music:\nN/A",
};

const H3_VIDEO_BLOCK = [
  "integrated_multimodal_description:",
  "",
  "overall_soundscape:",
  "",
  "non_diegetic_music:",
  "N/A",
].join("\n");

const H3_PROMPT_MODE_CONFIG = {
  ref2va: {
    tools: H3_SECTION_BLOCKS,
    title: "Ref2VA 六段结构",
    fields: "subject_definitions → summary → retention_analysis → detailed_description → overall_soundscape → non_diegetic_music",
    refs: "可引用图片、视频和音频；图片使用 <Subject N> / <Picture N>，视频使用 <Video N>，音频使用 <Audio N>。",
  },
  t2v: {
    tools: { 模板: H3_VIDEO_BLOCK, 综合描述: "integrated_multimodal_description:\n", 声景: "overall_soundscape:\n", 配乐: "non_diegetic_music:\nN/A" },
    title: "T2V 三段结构",
    fields: "integrated_multimodal_description → overall_soundscape → non_diegetic_music",
    refs: "文生视频不使用参考素材，也不插入图片、视频或音频引用标签。",
  },
  i2v: {
    tools: { 模板: H3_VIDEO_BLOCK, 综合描述: "integrated_multimodal_description:\n", 声景: "overall_soundscape:\n", 配乐: "non_diegetic_music:\nN/A" },
    title: "I2V 三段结构",
    fields: "integrated_multimodal_description → overall_soundscape → non_diegetic_music",
    refs: "仅允许引用 1 张首帧图片，使用 <Subject 1> / <Picture 1>。",
  },
  fl2v: {
    tools: { 模板: H3_VIDEO_BLOCK, 综合描述: "integrated_multimodal_description:\n", 声景: "overall_soundscape:\n", 配乐: "non_diegetic_music:\nN/A" },
    title: "FL2V 三段结构",
    fields: "integrated_multimodal_description → overall_soundscape → non_diegetic_music",
    refs: "允许引用 2 张图片：<Picture 1> 为首帧，<Picture 2> 为尾帧。",
  },
} as const;

type MentionItem = { ref: H3Ref; ordinal: number };

export function H3PromptSection({
  ctx,
  selected,
  imageRefs,
  videoRefs,
  audioRefs,
  patchSelected,
  onOpenStoryboard,
}: Props) {
  const editorRef = useRef<CanvasTextEditorHandle | null>(null);
  const textTarget = useMemo(() => ({ nodeId: ctx.node.id, segmentId: selected?.id, field: "prompt" as const }), [ctx.node.id, selected?.id]);
  const textDocument = useMemo(() => ctx.textDocument(textTarget), [ctx.projectId, ctx.node.id, selected?.id]);
  const textStatus = getReact().useSyncExternalStore(textDocument.subscribe, textDocument.getSnapshot);
  const suggestions = useMemo(() => ctx.textSuggestions(textTarget), [ctx.projectId, ctx.node.id, selected?.id]);
  const suggestionState = getReact().useSyncExternalStore(suggestions.subscribe, suggestions.getSnapshot);
  const prompt = textStatus.ready ? textStatus.text : String(selected?.prompt || "");
  const TextEditor = ctx.TextEditor;
  const mode = String(selected?.mode || selected?.taskMode || "ref2va");
  const promptMode = mode in H3_PROMPT_MODE_CONFIG ? mode as keyof typeof H3_PROMPT_MODE_CONFIG : "ref2va";
  const modeConfig = H3_PROMPT_MODE_CONFIG[promptMode];
  const toolBlocks = modeConfig.tools as Record<string, string>;
  const [helpOpen, setHelpOpen] = useState(false);
  const enhancement = selected ? promptJobs(ctx)[selected.id] : undefined;
  const enhancing = enhancement?.status === "running";
  useEffect(() => {
    if (!selected || enhancement?.status !== "suggestion") return;
    const saved = suggestionState.items.find((item) => item.id === enhancement.requestId);
    if (saved && saved.status !== "pending") setPromptJob(ctx, selected.id, { ...enhancement, status: "done", error: undefined });
  }, [selected?.id, enhancement, suggestionState.items]);
  // 翻译态：缓存最近一次翻译结果（按 prompt 内容做 key），切换时优先复用，prompt 变化自动失效
  type Translation = { segmentId: string; prompt: string; text: string };
  const [translation, setTranslation] = useState<Translation | null>(null);
  const [translating, setTranslating] = useState(false);
  const [isTranslated, setIsTranslated] = useState(false);
  const [translateError, setTranslateError] = useState<string | null>(null);
  // 用来在异步翻译返回时校验 prompt 是否已被用户改掉，避免显示错配的中文
  const promptRef = useRef({ prompt, segmentId: selected?.id });
  promptRef.current = { prompt, segmentId: selected?.id };
  const models = ctx.ai.listModels("text");
  const promptModel = String(
    ctx.node.metadata?.minimaxLlmModel ||
      ctx.node.metadata?.llmModel ||
      ctx.ai.defaultModel("text") ||
      models[0]?.value ||
      "",
  );

  // 按 type 分组的序号（与 H3 工作台的 refsForSegment 语义一致：图片/视频/音频各自从 1 起）
  const mentionItems = useMemo<MentionItem[]>(
    () => [
      ...imageRefs.map((ref, index) => ({ ref, ordinal: index + 1 })),
      ...videoRefs.map((ref, index) => ({ ref, ordinal: index + 1 })),
      ...audioRefs.map((ref, index) => ({ ref, ordinal: index + 1 })),
    ],
    [imageRefs, videoRefs, audioRefs],
  );
  useEffect(() => { setIsTranslated(false); }, [selected?.id, prompt]);

  const enhancePrompt = async () => {
    if (!textStatus.ready || textStatus.blocked || !prompt.trim() || enhancing) return;
    const targetSegmentId = selected?.id;
    const promptAtCall = prompt;
    if (!targetSegmentId || promptJobs(ctx)[targetSegmentId]?.status === "running") return;
    const requestId = crypto.randomUUID();
    const job = { requestId, base: promptAtCall, documentId: textDocument.getDocumentId() };
    setPromptJob(ctx, targetSegmentId, { ...job, status: "running" });
    try {
      const model = String(
        ctx.node.metadata?.minimaxLlmModel ||
          ctx.node.metadata?.llmModel ||
          ctx.ai.defaultModel("text") ||
          "",
      );
      const normalizedMode = mode === "t2v" ? "t2va" : mode === "i2v" ? "i2va" : mode === "fl2v" ? "fl2va" : "ref2va";
      const target = segmentsFor(ctx.getNode(ctx.node.id)?.metadata || ctx.node.metadata || {}).find((segment) => segment.id === targetSegmentId) || selected;
      const references = target ? refsForSegment(target) : [];
      const ordinals = { image: 0, video: 0, audio: 0 };
      const manifest = references.map((ref) => {
        const ordinal = ++ordinals[ref.type];
        return `${ref.type === "image" ? "Picture" : ref.type === "video" ? "Video" : "Audio"} ${ordinal}: ${ref.name || "unnamed reference"}`;
      }).join("\n") || "None";
      // ---- 分镜图参考过渡：多张参考图按顺序排列成连续姿势帧，把段尾设计成过渡到下一张分镜姿势 ----
      const storyboardMode = ctx.node.metadata?.promptEnhanceStoryboard === true;
      let transitionPlan = "";
      let transitionInstruction = "";
      if (storyboardMode && imageRefs.length >= 2) {
        const lastOrd = imageRefs.length;
        transitionPlan = await analyzeStoryboardTransitions(ctx, imageRefs, model);
        transitionInstruction = [
          `这些参考图片是一组连续分镜姿势帧（图1为起始姿势，图${lastOrd}为目标姿势），不是互相独立的风格素材。`,
          `本段提示词必须：从图1的姿势出发，依次经过每一对相邻图（图k→图k+1）的连续动作，最终收尾于图${lastOrd}的姿势；相邻图之间不得瞬移、重置或硬切。`,
          `末句必须明确落到图${lastOrd}的目标姿势（例如图1站立、图2蹲下，则末句写“此人缓缓蹲下成蹲姿”）。`,
          `按下面的「过渡计划」落实每段肢体、重心、朝向的具体变化。`,
        ].join("\n");
      }
      const structure = normalizedMode === "ref2va"
        ? "Use exactly the six sections in this order: subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music. Use <Subject N>, <Picture N>, <Video N>, and <Audio N> consistently."
        : "Use exactly the three sections in this order: integrated_multimodal_description, overall_soundscape, non_diegetic_music.";
      const alignment = normalizedMode === "i2va"
        ? "Start with the official I2VA instruction aligning Picture 1 to 0.00 seconds."
        : normalizedMode === "fl2va"
          ? "Start with the official FL2VA instruction aligning Picture 1 to 0.00 seconds and Picture 2 to the final timestamp."
          : normalizedMode === "t2va"
            ? "Do not introduce reference labels or image-alignment instructions."
            : "Treat references as Ref2VA assets; do not force them to be the first frame unless the user explicitly requests it.";
      const officialReference = normalizedMode === "ref2va" ? refReference : baseReference;
      const systemParts = [
        "You are the official MiniMax H3 video prompt writer.",
        "Follow the embedded official H3 prompt-writing reference exactly; it is the format authority.",
        officialReference,
        `The selected mode is ${normalizedMode.toUpperCase()} and the selected clip duration is ${Number(selected?.duration || 5).toFixed(2)} seconds.`,
        structure,
        alignment,
        "Rewrite the user intent into one production-ready prompt. Preserve characters, actions, dialogue, visible text, reference numbering, and hard constraints; never invent facts.",
        "Make every requested visual detail explicit: composition, subject appearance, pose, gaze, action phases, camera type/amplitude/speed, lighting, materials, continuity, environment, and sound.",
        "Use the exact official field names, section order, reference tags, timestamp conventions, dialogue tags, and language rules. Preserve every {{ref:...}} and {{subject:...}} marker byte-for-byte; do not renumber or replace semantic markers.",
        "Keep exact user dialogue and visible text unchanged. Do not repeat dialogue in overall_soundscape or non_diegetic_music.",
        "Return only the final prompt, without Markdown fences, explanations, or prefaces.",
      ];
      if (transitionInstruction) systemParts.push(`Storyboard image reference transition instruction:\n${transitionInstruction}`);
      const system = systemParts.join("\n\n");
      const userPromptParts = [
        promptAtCall.trim(),
        String(ctx.node.metadata?.globalPrompt || "").trim(),
        `Reference manifest (fixed numbering; do not reorder):\n${manifest}`,
      ];
      if (transitionPlan) userPromptParts.push(`Transition plan (fixed image order; do not reorder):\n${transitionPlan}`);
      const userPrompt = userPromptParts.filter(Boolean).join("\n\n");
      const result = await ctx.ai.generateText(userPrompt, {
        model,
        system,
        references: references.map((ref) => ({ url: ref.url, name: ref.name })),
      });
      // 模型未返回内容时（如 Ollama 空响应），requestImageQuestion 现在返回空串，
      // 这里不能把 prompt 覆写成占位符/空串——保留用户原文，并给出明确失败提示。
      const enhanced = result.text.trim();
      if (enhanced) {
        setPromptJob(ctx, targetSegmentId, { ...job, text: enhanced, status: "suggestion" });
        // 先保存候选，再尝试条件采用；切 Clip 不改变此闭包捕获的目标。
        await persistPromptCandidate(suggestions, job, enhanced);
        setPromptJob(ctx, targetSegmentId, { ...job, status: "done" });
      } else {
        setPromptJob(ctx, targetSegmentId, { ...job, status: "error", error: "模型未返回内容，增强被跳过（请检查文本模型配置或重试）" });
      }
    } catch (error) {
      const candidate = promptJobs(ctx)[targetSegmentId];
      setPromptJob(ctx, targetSegmentId, { ...job, text: candidate?.text, status: candidate?.text ? "suggestion" : "error", error: error instanceof Error ? error.message : String(error) });
    }
  };

  // 翻译 system prompt：只翻自然语言，保留南风官方结构标记、引用标签和数值
  const TRANSLATION_SYSTEM_PROMPT = [
    "You are a translator for H3 video prompts. Translate the following to Simplified Chinese.",
    "Rules:",
    "- Keep section headers ending with ':' (e.g., subject_definitions:, summary:) exactly as in the original; they are official structure markers.",
    "- Keep reference tags like <Subject 1>, <Picture 1>, <Video 1>, <Audio 1> exactly as in the original.",
    "- Keep timestamps, numerical values, and proper nouns unchanged.",
    "- Translate all other natural language to natural Simplified Chinese.",
    "- Preserve line breaks, indentation, and overall structure.",
    "- Return only the translated prompt. No explanations, no Markdown fences, no preamble.",
  ].join("\n");

  const handleTranslateToggle = async () => {
    if (isTranslated) {
      setIsTranslated(false);
      return;
    }
    if (!prompt.trim()) return;
    // 缓存命中：直接切到中文态
    if (translation && translation.segmentId === selected?.id && translation.prompt === prompt) {
      setIsTranslated(true);
      return;
    }
    const promptAtCall = prompt;
    const segmentIdAtCall = selected?.id || "";
    setTranslating(true);
    setTranslateError(null);
    try {
      const model = String(
        ctx.node.metadata?.minimaxLlmModel ||
          ctx.node.metadata?.llmModel ||
          ctx.ai.defaultModel("text") ||
          "",
      );
      const result = await ctx.ai.generateText(promptAtCall.trim(), {
        model,
        system: TRANSLATION_SYSTEM_PROMPT,
      });
      const text = result.text.trim();
      if (text) {
        setTranslation({ segmentId: segmentIdAtCall, prompt: promptAtCall, text });
        // 异步期间 prompt 可能已被用户改掉，只在没变时才切到中文态
        if (promptRef.current.prompt === promptAtCall && promptRef.current.segmentId === segmentIdAtCall) setIsTranslated(true);
      } else {
        setTranslateError("翻译模型未返回内容，请检查文本模型配置或重试");
      }
    } catch (error) {
      setTranslateError(error instanceof Error ? error.message : String(error));
    } finally {
      setTranslating(false);
    }
  };

  const insertAtCursor = (text: string) => editorRef.current?.insert(text, { prefixNewline: true });

  // 南风 mention 插入文案:图片 <Subject N>…<Picture N>,视频 <Video N>,音频 <Audio N>（与 nativeMention/多参绑定一致）
  const mentionText = (item: MentionItem) =>
    item.ref.bindingId
      ? item.ref.type === "image"
        ? `{{subject:${item.ref.bindingId}}} is the visual content referenced from {{ref:${item.ref.bindingId}}}`
        : `{{ref:${item.ref.bindingId}}}`
      : item.ref.type === "image"
      ? `<Subject ${item.ordinal}> is the visual content referenced from <Picture ${item.ordinal}>`
      : item.ref.type === "video"
        ? `<Video ${item.ordinal}>`
        : `<Audio ${item.ordinal}>`;

  const editorReferences = useMemo(() => promptMode === "t2v" ? [] : mentionItems.map((item) => ({
    label: item.ref.type === "image" ? `图片${item.ordinal}` : item.ref.type === "video" ? `视频${item.ordinal}` : `音频${item.ordinal}`,
    title: item.ref.name, kind: item.ref.type, previewUrl: item.ref.url, insert: mentionText(item),
  })), [mentionItems, promptMode]);

  return (
    <label className="minimax-prompt-field minimax-prompt-field--mention">
      <span key="prompt-header">
        <H3Icon key="prompt-icon" name="prompt" /> <span key="prompt-label">Prompt</span>{" "}
        <button
          key="enhance"
          type="button"
          disabled={enhancing || !prompt.trim()}
          onClick={() => void enhancePrompt()}
          title={!prompt.trim() ? "请先输入提示词" : "调用当前文本模型增强提示词"}
        >
          {enhancing ? "增强中…" : "增强提示词"}
        </button>
        <label
          key="storyboard-toggle"
          style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, marginLeft: 6, opacity: imageRefs.length >= 2 ? 1 : 0.45, cursor: imageRefs.length >= 2 ? "pointer" : "not-allowed" }}
        >
          <input
            type="checkbox"
            disabled={imageRefs.length < 2}
            checked={ctx.node.metadata?.promptEnhanceStoryboard === true}
            onChange={(event) => ctx.updateMetadata({ promptEnhanceStoryboard: event.target.checked })}
            title={imageRefs.length < 2 ? "分镜图过渡需要至少 2 张图片参考" : "开启后按分镜图顺序把段尾设计成过渡到下一张分镜姿势"}
          />
          分镜图过渡
        </label>

      </span>
      <div key="prompt-modes" className="minimax-prompt-modes">
        <span className="minimax-prompt-mode-tools">
        {Object.keys(toolBlocks).map((label) => (
          <button
            type="button"
            key={label}
            onClick={() => insertAtCursor(toolBlocks[label])}
          >
            {label}
          </button>
        ))}
        </span>
        <button
          type="button"
          className="minimax-prompt-help"
          title="提示词结构说明"
          aria-expanded={helpOpen}
          onClick={() => setHelpOpen((open) => !open)}
        >
          说明
        </button>
      </div>
      {helpOpen ? <div key="prompt-help" className="minimax-prompt-help-panel" role="note">
        <b>{modeConfig.title}</b>
        <span>字段：{modeConfig.fields}</span>
        <span>{modeConfig.refs}</span>
      </div> : null}
      <small key="prompt-syntax" className="minimax-prompt-syntax">
        <code key="subject">&lt;Subject P&gt; 指认第 P 张参考图</code>{" "}
        <code key="picture">&lt;Picture P&gt; 指认第 P 张参考图</code>{" "}
        <code key="video">&lt;Video V&gt; 指认第 V 段参考视频</code>{" "}
        <code key="audio">&lt;Audio A&gt; 指认第 A 段参考音频</code>
        {enhancement?.error ? (
          <span key="enhance-error" role="alert">
            增强失败：{enhancement.error}
          </span>
        ) : null}
      </small>
      {suggestionState.error || suggestionState.pending ? <div role="status" className="minimax-prompt-help-panel">
        {suggestionState.error || "候选正在保存"}{suggestionState.pending ? "；未确认结果已保留为本地草稿" : ""}
        <button type="button" onClick={() => void suggestions.refresh(true).catch(() => {})}>重新同步候选</button>
      </div> : null}
      {suggestionState.items.filter((item) => item.status === "pending").map((item) => (
        <details key={item.id} className="minimax-prompt-help-panel">
          <summary>{item.documentId !== textDocument.getDocumentId() ? "旧文本对象的强化候选（只读保留）" : "待确认的强化候选（仅对应此 Clip）"}</summary>
          <textarea value={item.text} readOnly aria-label="待确认的强化提示词" />
          <button type="button" disabled={!textStatus.ready || textStatus.blocked || item.documentId !== textDocument.getDocumentId() || !item.revision}
            onClick={() => void suggestions.apply(item.id, textDocument.getDocumentId(), prompt).catch(() => {})}>用此结果替换当前显示的原文</button>
          <button type="button" disabled={!item.revision} onClick={() => void suggestions.dismiss(item.id).catch(() => {})}>保留原文并忽略此候选</button>
        </details>
      ))}
      {enhancement?.text && enhancement.status === "suggestion" && !suggestionState.items.some((item) => item.id === enhancement.requestId) ? <details className="minimax-prompt-help-panel">
        <summary>候选尚未存入草稿，请先复制保留</summary>
        <textarea value={enhancement.text} readOnly aria-label="未保存的强化提示词" />
      </details> : null}
      <div key="prompt-actions" className="nfh3-prompt-actions">
        <Select
          className="minimax-prompt-model"
          size="small"
          value={promptModel || undefined}
          placeholder="提示词增强模型"
          options={models.map((model) => ({
            value: model.value,
            label: model.label,
          }))}
          onChange={(value) => ctx.updateMetadata({ minimaxLlmModel: value })}
        />
        <button
          type="button"
          className={`minimax-aux-storyboard${String(ctx.node.metadata?.smartStoryboardStatus || "") === "error" ? " is-error" : ""}`}
          onClick={onOpenStoryboard}
          disabled={String(ctx.node.metadata?.smartStoryboardStatus || "") === "loading"}
          title={String(ctx.node.metadata?.smartStoryboardStatus || "") === "error" ? String(ctx.node.metadata?.smartStoryboardError || "") : undefined}
        >
          {String(ctx.node.metadata?.smartStoryboardStatus || "") === "loading" ? "智能分镜生成中…" : String(ctx.node.metadata?.smartStoryboardStatus || "") === "error" ? "分镜失败·点击重试" : "智能分镜"}
        </button>
      </div>
      <div key="prompt-options" className="nfh3-prompt-options">
        <label>
          <span>恒定触发词</span>
          <input
            value={String(selected?.constantTriggerWord || "")}
            onChange={(event) =>
              patchSelected({ constantTriggerWord: event.target.value })
            }
            placeholder="可选，置于每段提示词前"
          />
        </label>
        <span className="nfh3-prompt-ref-hint">
          {mode === "ref2va"
            ? "当前可引用：@图片1 · @视频1 · @视频音频1 · @音频1"
            : mode === "t2v"
              ? "当前模式无需引用素材"
              : "当前可引用：@图片1"}
        </span>
      </div>
      <div key="prompt-textarea-wrap" className="minimax-prompt-translate-wrap">
        {isTranslated && translation && translation.segmentId === selected?.id && translation.prompt === prompt
          ? <textarea readOnly value={translation.text} aria-label="中文翻译（只读）" />
          : selected ? <TextEditor key={selected.id} projectId={ctx.projectId} target={textTarget} editorRef={editorRef} references={editorReferences} placeholder="请输入提示词" className="minimax-collaborative-prompt" style={{ minHeight: 160, height: 240, fontSize: 18 }} /> : null}
        <button
          key="prompt-translate"
          type="button"
          onClick={() => void handleTranslateToggle()}
          disabled={translating || (!isTranslated && !prompt.trim())}
          className={`minimax-prompt-translate${isTranslated ? " is-translated" : ""}`}
          aria-label={
            isTranslated
              ? "切换回原提示词"
              : translating
                ? "正在翻译"
                : "查看中文翻译"
          }
          title={
            isTranslated
              ? "切换回原提示词"
              : translating
                ? "正在翻译…"
                : !prompt.trim()
                  ? "请先输入提示词"
                  : "查看中文翻译"
          }
        >
          {translating ? "…" : isTranslated ? "EN" : "译"}
        </button>
        {translateError ? (
          <div key="prompt-translate-error" className="minimax-prompt-translate-error" role="alert">
            翻译失败：{translateError}
          </div>
        ) : null}
      </div>
    </label>
  );
}

// 分镜图参考过渡分析：对连续相邻的两张关键帧提取「姿势如何连续过渡」的可执行动作，
// 供增强提示词把段尾落到下一张分镜姿势（如站→蹲，末句写「此人蹲了下来」）。
async function analyzeStoryboardTransitions(
  ctx: CanvasNodeContext,
  refs: H3Ref[],
  model: string,
): Promise<string> {
  const lines: string[] = [];
  for (let k = 0; k < refs.length - 1; k++) {
    const from = refs[k];
    const to = refs[k + 1];
    const fromOrd = k + 1;
    const toOrd = k + 2;
    try {
      const res = await ctx.ai.generateText(
        `下面是连续分镜姿势序列中的两张关键帧：图${fromOrd}（起始姿势）与图${toOrd}（目标姿势）。只提取从图${fromOrd}到图${toOrd}的连续过渡动作：主体肢体如何运动、重心如何转移、身体朝向/视线/姿态如何变化，用若干可执行的自然语言短句描述这段过渡（不重复身份、服装、外观，只写动作与姿态变化）。只返回过渡动作正文，不要追问、不要写英文模板。`,
        {
          model,
          system: "你是 H3 分镜姿势过渡分析器。严格按图序对比两张关键帧，只输出从前者到后者的连续动作描述，不编造图中未出现的变化。",
          references: [
            { url: from.url, name: from.name },
            { url: to.url, name: to.name },
          ],
        },
      );
      const text = res.text.trim();
      if (text) lines.push(`图${fromOrd}→图${toOrd}：${text}`);
    } catch {
      lines.push(`图${fromOrd}→图${toOrd}：（过渡分析失败，请人工核对姿势变化）`);
    }
  }
  return lines.join("\n\n");
}
