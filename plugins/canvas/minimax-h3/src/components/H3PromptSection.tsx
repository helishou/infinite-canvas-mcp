import { useMemo, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { KeyboardEvent } from "react";
import { Select } from "antd";
import type { H3Ref, H3Segment } from "../types";
import { H3Icon } from "./H3Icon";
import { refsForSegment } from "../services/h3-data";
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
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const prompt = String(selected?.prompt || "");
  const mode = String(selected?.mode || selected?.taskMode || "ref2va");
  const promptMode = mode in H3_PROMPT_MODE_CONFIG ? mode as keyof typeof H3_PROMPT_MODE_CONFIG : "ref2va";
  const modeConfig = H3_PROMPT_MODE_CONFIG[promptMode];
  const toolBlocks = modeConfig.tools as Record<string, string>;
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionActive, setMentionActive] = useState(0);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionPosition, setMentionPosition] = useState({ left: 8, top: 106 });
  const [helpOpen, setHelpOpen] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
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
  const visibleMentionItems = useMemo(() => {
    if (promptMode === "t2v") return [];
    const query = mentionQuery.trim().toLowerCase();
    if (!query) return mentionItems;
    return mentionItems.filter(({ ref }) => {
      const aliases = ref.type === "image" ? ["图片", "picture", "subject"] : ref.type === "video" ? ["视频", "video"] : ["音频", "audio"];
      return aliases.some((alias) => alias.includes(query) || query.includes(alias)) || String(ref.name || "").toLowerCase().includes(query);
    });
  }, [mentionItems, mentionQuery, promptMode]);

  const setPrompt = (value: string) => patchSelected({ prompt: value });
  const enhancePrompt = async () => {
    if (!prompt.trim() || enhancing) return;
    setEnhancing(true);
    ctx.updateMetadata({ promptEnhancing: true, promptEnhanceError: "" });
    try {
      const model = String(
        ctx.node.metadata?.minimaxLlmModel ||
          ctx.node.metadata?.llmModel ||
          ctx.ai.defaultModel("text") ||
          "",
      );
      const normalizedMode = mode === "t2v" ? "t2va" : mode === "i2v" ? "i2va" : mode === "fl2v" ? "fl2va" : "ref2va";
      const references = selected ? refsForSegment(selected) : [];
      const ordinals = { image: 0, video: 0, audio: 0 };
      const manifest = references.map((ref) => {
        const ordinal = ++ordinals[ref.type];
        return `${ref.type === "image" ? "Picture" : ref.type === "video" ? "Video" : "Audio"} ${ordinal}: ${ref.name || "unnamed reference"}`;
      }).join("\n") || "None";
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
      const system = [
        "You are the official MiniMax H3 video prompt writer.",
        "Follow the embedded official H3 prompt-writing reference exactly; it is the format authority.",
        officialReference,
        `The selected mode is ${normalizedMode.toUpperCase()} and the selected clip duration is ${Number(selected?.duration || 5).toFixed(2)} seconds.`,
        structure,
        alignment,
        "Rewrite the user intent into one production-ready prompt. Preserve characters, actions, dialogue, visible text, reference numbering, and hard constraints; never invent facts.",
        "Make every requested visual detail explicit: composition, subject appearance, pose, gaze, action phases, camera type/amplitude/speed, lighting, materials, continuity, environment, and sound.",
        "Use the exact official field names, section order, reference tags, timestamp conventions, dialogue tags, and language rules. Do not replace official tags with @ aliases.",
        "Keep exact user dialogue and visible text unchanged. Do not repeat dialogue in overall_soundscape or non_diegetic_music.",
        "Return only the final prompt, without Markdown fences, explanations, or prefaces.",
      ].join("\n\n");
      const userPrompt = [
        prompt.trim(),
        String(ctx.node.metadata?.globalPrompt || "").trim(),
        `Reference manifest (fixed numbering; do not reorder):\n${manifest}`,
      ].filter(Boolean).join("\n\n");
      const result = await ctx.ai.generateText(userPrompt, {
        model,
        system,
        references: references.map((ref) => ({ url: ref.url, name: ref.name })),
      });
      if (result.text.trim()) setPrompt(result.text.trim());
    } catch (error) {
      ctx.updateMetadata({
        promptEnhanceError:
          error instanceof Error ? error.message : String(error),
      });
    } finally {
      setEnhancing(false);
      ctx.updateMetadata({ promptEnhancing: false });
    }
  };

  // 南风 insertPromptBlock:光标处 setRangeText,插入点前一个字符不是换行就补 \n,光标落在插入内容末尾
  const insertAtCursor = (
    text: string,
    opts: { prefixNewline?: boolean; select?: boolean } = {},
  ) => {
    const ta = textareaRef.current;
    if (!ta) {
      const insert =
        (opts.prefixNewline !== false && prompt && !prompt.endsWith("\n")
          ? "\n"
          : "") + text;
      setPrompt(prompt + insert);
      return;
    }
    const start = ta.selectionStart ?? prompt.length;
    const end = ta.selectionEnd ?? start;
    const before = ta.value.slice(0, start);
    const insert =
      (opts.prefixNewline !== false &&
      before.length > 0 &&
      !before.endsWith("\n")
        ? "\n"
        : "") + text;
    if (opts.select) {
      ta.setRangeText(insert, start, end, "select");
    } else {
      ta.setRangeText(insert, start, end, "end");
    }
    setPrompt(ta.value);
    requestAnimationFrame(() => ta.focus());
  };

  // 南风 mention 插入文案:图片 <Subject N>…<Picture N>,视频 <Video N>,音频 <Audio N>（与 nativeMention/多参绑定一致）
  const mentionText = (item: MentionItem) =>
    item.ref.type === "image"
      ? `<Subject ${item.ordinal}> is the visual content referenced from <Picture ${item.ordinal}>`
      : item.ref.type === "video"
        ? `<Video ${item.ordinal}>`
        : `<Audio ${item.ordinal}>`;

  const insertMention = (
    item: MentionItem,
    event?: { preventDefault: () => void },
  ) => {
    event?.preventDefault();
    const ta = textareaRef.current;
    if (ta && ta.isConnected) {
      const start = ta.selectionStart ?? ta.value.length;
      const atMatch = ta.value.slice(0, start).match(/@(\S*)$/);
      if (atMatch) {
        const insertStart = start - atMatch[0].length;
        ta.setRangeText(mentionText(item), insertStart, start, "end");
        setPrompt(ta.value);
      } else {
        insertAtCursor(mentionText(item));
      }
    } else {
      insertAtCursor(mentionText(item));
    }
    setMentionOpen(false);
    setMentionActive(0);
    setMentionPosition({ left: 8, top: 106 });
  };

  const updateMentionPosition = (ta: HTMLTextAreaElement, caretIndex?: number) => {
    const field = ta.closest(".minimax-prompt-field") as HTMLElement | null;
    if (!field) return;
    const point = getCaretPoint(ta, caretIndex ?? ta.selectionStart ?? 0);
    const fieldRect = field.getBoundingClientRect();
    const textareaRect = ta.getBoundingClientRect();
    const computed = window.getComputedStyle(ta);
    const lineHeight = Number.parseFloat(computed.lineHeight) || 17;
    const menuWidth = Math.min(360, Math.max(220, fieldRect.width - 16));
    const rawLeft = textareaRect.left - fieldRect.left + point.left - ta.scrollLeft;
    const left = Math.max(8, Math.min(rawLeft, Math.max(8, fieldRect.width - menuWidth - 8)));
    const top = textareaRect.top - fieldRect.top + point.top - ta.scrollTop + lineHeight + 4;
    setMentionPosition({ left, top });
  };

  // 检测游标前的 @ 前缀,更新 mention 下拉(南风 openMentions:键入 @ 即弹)
  const syncMention = (ta: HTMLTextAreaElement) => {
    const start = ta.selectionStart ?? 0;
    const match = ta.value.slice(0, start).match(/@(\S*)$/);
    setMentionQuery(match?.[1] || "");
    setMentionOpen(Boolean(match) && promptMode !== "t2v");
    if (match && promptMode !== "t2v") updateMentionPosition(ta, start);
    if (mentionActive >= visibleMentionItems.length) setMentionActive(0);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!mentionOpen || !visibleMentionItems.length) return;
    const active = Math.min(mentionActive, visibleMentionItems.length - 1);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setMentionActive((current) => (current + 1) % visibleMentionItems.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setMentionActive(
        (current) => (current + visibleMentionItems.length - 1) % visibleMentionItems.length,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      insertMention(visibleMentionItems[active]);
    } else if (event.key === "Escape") {
      setMentionOpen(false);
    }
  };

  return (
    <label className="minimax-prompt-field minimax-prompt-field--mention">
      <span key="prompt-header">
        <H3Icon key="prompt-icon" name="prompt" /> <span key="prompt-label">Prompt</span>{" "}
        <button
          key="enhance"
          type="button"
          disabled={enhancing}
          onClick={() => void enhancePrompt()}
          title="调用当前文本模型增强提示词"
        >
          {enhancing ? "增强中…" : "增强提示词"}
        </button>
        {mentionOpen ? (
          <button
            key="cancel-mention"
            type="button"
            onClick={() => setMentionOpen(false)}
          >
            取消 @
          </button>
        ) : null}
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
        {ctx.node.metadata?.promptEnhanceError ? (
          <span key="enhance-error" style={{ color: "#fca5a5" }}>
            增强失败：{String(ctx.node.metadata.promptEnhanceError)}
          </span>
        ) : null}
      </small>
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
      <textarea
        key="prompt-textarea"
        ref={textareaRef}
        value={prompt}
        placeholder="请输入提示词"
        onChange={(event) => {
          setPrompt(event.target.value);
          syncMention(event.target);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          setMentionOpen(false);
          setMentionPosition({ left: 8, top: 106 });
        }}
        onScroll={() => {
          if (mentionOpen) updateMentionPosition(textareaRef.current!);
        }}
        onMouseUp={() => {
          const ta = textareaRef.current;
          if (ta) syncMention(ta);
        }}
        onKeyUp={() => {
          const ta = textareaRef.current;
          if (ta) syncMention(ta);
        }}
      />
      {mentionOpen && visibleMentionItems.length ? (
        <div
          key="prompt-mentions"
          className="minimax-prompt-mentions"
          role="listbox"
          style={{ left: mentionPosition.left, top: mentionPosition.top }}
          onMouseDown={(event) => event.preventDefault()}
        >
          {visibleMentionItems.map((item, index) => (
            <MentionRow
              key={`${item.ref.type}-${item.ref.url}-${index}`}
              item={item}
              active={
                index === Math.min(mentionActive, visibleMentionItems.length - 1)
              }
              onHover={() => setMentionActive(index)}
              onPick={() => insertMention(item)}
            />
          ))}
        </div>
      ) : null}
      {mentionOpen && !visibleMentionItems.length ? (
        <div
          key="prompt-mentions-empty"
          className="minimax-prompt-mentions"
          style={{ left: mentionPosition.left, top: mentionPosition.top }}
        >
          <span className="minimax-prompt-mention-empty">
            请先在下方添加图片、视频或音频
          </span>
        </div>
      ) : null}
    </label>
  );
}

function MentionRow({
  item,
  active,
  onHover,
  onPick,
}: {
  item: MentionItem;
  active: boolean;
  onHover: () => void;
  onPick: (item?: MentionItem) => void;
}) {
  const text =
    item.ref.type === "image"
      ? `<Subject ${item.ordinal}> is the visual content referenced from <Picture ${item.ordinal}>`
      : item.ref.type === "video"
        ? `<Video ${item.ordinal}>`
        : `<Audio ${item.ordinal}>`;
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      className={
        active ? "minimax-prompt-mention is-active" : "minimax-prompt-mention"
      }
      onMouseEnter={onHover}
      onClick={(event) => onPick(item)}
    >
      <img src={item.ref.url} alt="" loading="lazy" />
      {item.ref.type === "video" ? (
        <H3Icon name="clapperboard" />
      ) : item.ref.type === "audio" ? (
        <H3Icon name="output" />
      ) : null}
      <span className="minimax-prompt-mention-name">
        {text} · {item.ref.name}
      </span>
    </button>
  );
}
