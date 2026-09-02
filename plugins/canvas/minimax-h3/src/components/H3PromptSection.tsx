import { useMemo, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import type { KeyboardEvent } from "react";
import type { H3Ref, H3Segment } from "../types";
import { H3Icon } from "./H3Icon";

type Props = {
    ctx: CanvasNodeContext;
    selected?: H3Segment;
    imageRefs: H3Ref[];
    videoRefs: H3Ref[];
    audioRefs: H3Ref[];
    patchSelected: (patch: Partial<H3Segment>) => void;
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

export const H3_PROMPT_TOOLS = Object.keys(H3_SECTION_BLOCKS);

type MentionItem = { ref: H3Ref; ordinal: number };

export function H3PromptSection({ ctx, selected, imageRefs, videoRefs, audioRefs, patchSelected }: Props) {
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const prompt = String(selected?.prompt || "");
    const [mentionOpen, setMentionOpen] = useState(false);
    const [mentionActive, setMentionActive] = useState(0);
    const [enhancing, setEnhancing] = useState(false);

    // 按 type 分组的序号（与 H3 工作台的 refsForSegment 语义一致：图片/视频/音频各自从 1 起）
    const mentionItems = useMemo<MentionItem[]>(() => [
        ...imageRefs.map((ref, index) => ({ ref, ordinal: index + 1 })),
        ...videoRefs.map((ref, index) => ({ ref, ordinal: index + 1 })),
        ...audioRefs.map((ref, index) => ({ ref, ordinal: index + 1 })),
    ], [imageRefs, videoRefs, audioRefs]);

    const setPrompt = (value: string) => patchSelected({ prompt: value });
    const enhancePrompt = async () => {
        if (!prompt.trim() || enhancing) return;
        setEnhancing(true);
        ctx.updateMetadata({ promptEnhancing: true, promptEnhanceError: "" });
        try {
            const model = String(ctx.node.metadata?.minimaxLlmModel || ctx.node.metadata?.llmModel || ctx.ai.defaultModel("text") || "");
            const result = await ctx.ai.generateText(prompt, { model, system: "你是 MiniMax H3 提示词整理器。保留用户意图、对白、图片/视频/音频编号和官方字段，只补充主体一致性、动作阶段、镜头运动、声音和时间顺序。直接输出完整可执行提示词，不要解释。" });
            if (result.text.trim()) setPrompt(result.text.trim());
        } catch (error) {
            ctx.updateMetadata({ promptEnhanceError: error instanceof Error ? error.message : String(error) });
        } finally {
            setEnhancing(false);
            ctx.updateMetadata({ promptEnhancing: false });
        }
    };

    // 南风 insertPromptBlock:光标处 setRangeText,插入点前一个字符不是换行就补 \n,光标落在插入内容末尾
    const insertAtCursor = (text: string, opts: { prefixNewline?: boolean; select?: boolean } = {}) => {
        const ta = textareaRef.current;
        if (!ta) {
            const insert = (opts.prefixNewline !== false && prompt && !prompt.endsWith("\n") ? "\n" : "") + text;
            setPrompt(prompt + insert);
            return;
        }
        const start = ta.selectionStart ?? prompt.length;
        const end = ta.selectionEnd ?? start;
        const before = ta.value.slice(0, start);
        const insert = (opts.prefixNewline !== false && before.length > 0 && !before.endsWith("\n") ? "\n" : "") + text;
        if (opts.select) {
            ta.setRangeText(insert, start, end, "select");
        } else {
            ta.setRangeText(insert, start, end, "end");
        }
        setPrompt(ta.value);
        requestAnimationFrame(() => ta.focus());
    };

    // 南风 mention 插入文案:图片 <Subject N>…<Picture N>,视频 <Video N>,音频 <Audio N>（与 nativeMention/多参绑定一致）
    const mentionText = (item: MentionItem) => item.ref.type === "image"
        ? `<Subject ${item.ordinal}> is the visual content referenced from <Picture ${item.ordinal}>`
        : item.ref.type === "video"
            ? `<Video ${item.ordinal}>`
            : `<Audio ${item.ordinal}>`;

    const insertMention = (item: MentionItem, event?: { preventDefault: () => void }) => {
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
    };

    // 检测游标前的 @ 前缀,更新 mention 下拉(南风 openMentions:键入 @ 即弹)
    const syncMention = (ta: HTMLTextAreaElement) => {
        const start = ta.selectionStart ?? 0;
        const match = ta.value.slice(0, start).match(/@(\S*)$/);
        setMentionOpen(Boolean(match));
        if (mentionActive >= mentionItems.length) setMentionActive(0);
    };

    const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (!mentionOpen || !mentionItems.length) return;
        const active = Math.min(mentionActive, mentionItems.length - 1);
        if (event.key === "ArrowDown") { event.preventDefault(); setMentionActive((current) => (current + 1) % mentionItems.length); }
        else if (event.key === "ArrowUp") { event.preventDefault(); setMentionActive((current) => (current + mentionItems.length - 1) % mentionItems.length); }
        else if (event.key === "Enter") { event.preventDefault(); insertMention(mentionItems[active]); }
        else if (event.key === "Escape") { setMentionOpen(false); }
    };

    return <label className="minimax-prompt-field minimax-prompt-field--mention">
        <span><H3Icon name="prompt" /> Prompt <button type="button" disabled={enhancing} onClick={() => void enhancePrompt()} title="调用当前文本模型增强提示词">{enhancing ? "增强中…" : "增强提示词"}</button><button type="button" onClick={() => { ctx.openPanel(); if (!prompt.trim()) insertAtCursor(H3_OFFICIAL_BLOCK, { prefixNewline: false }); else if (!/^\s*subject_definitions:\s*\n/.test(prompt)) insertAtCursor(H3_OFFICIAL_BLOCK, { prefixNewline: false, select: true }); }} title="补官方 H3 提示词骨架">补骨架</button>{mentionOpen ? <button type="button" onClick={() => setMentionOpen(false)}>取消 @</button> : null}</span>
        <textarea
            ref={textareaRef}
            value={prompt}
            placeholder="请输入提示词"
            onChange={(event) => { setPrompt(event.target.value); syncMention(event.target); }}
            onKeyDown={handleKeyDown}
            onBlur={() => setMentionOpen(false)}
            onMouseUp={() => { const ta = textareaRef.current; if (ta) syncMention(ta); }}
            onKeyUp={() => { const ta = textareaRef.current; if (ta) syncMention(ta); }}
        />
        {mentionOpen && mentionItems.length ? <div className="minimax-prompt-mentions" role="listbox" onMouseDown={(event) => event.preventDefault()}>{mentionItems.map((item, index) => <MentionRow key={`${item.ref.type}-${item.ref.url}`} item={item} active={index === Math.min(mentionActive, mentionItems.length - 1)} onHover={() => setMentionActive(index)} onPick={() => insertMention(item)} />)}</div> : null}
        {mentionOpen && !mentionItems.length ? <div className="minimax-prompt-mentions"><span className="minimax-prompt-mention-empty">请先在下方添加图片、视频或音频</span></div> : null}
        <div className="minimax-prompt-modes">{H3_PROMPT_TOOLS.map((label) => <button type="button" key={label} onClick={() => insertAtCursor(H3_SECTION_BLOCKS[label])}>{label}</button>)}<button type="button" className="minimax-prompt-help" title="提示词结构说明">说明</button></div>
        <small className="minimax-prompt-syntax"><code>&lt;Subject P&gt; 指认第 P 张参考图</code> <code>&lt;Picture P&gt; 指认第 P 张参考图</code> <code>&lt;Video V&gt; 指认第 V 段参考视频</code> <code>&lt;Audio A&gt; 指认第 A 段参考音频</code>{ctx.node.metadata?.promptEnhanceError ? <span style={{ color: "#fca5a5" }}>增强失败：{String(ctx.node.metadata.promptEnhanceError)}</span> : null}</small>
    </label>;
}

function MentionRow({ item, active, onHover, onPick }: { item: MentionItem; active: boolean; onHover: () => void; onPick: (item?: MentionItem) => void }) {
    const text = item.ref.type === "image" ? `<Subject ${item.ordinal}> is the visual content referenced from <Picture ${item.ordinal}>` : item.ref.type === "video" ? `<Video ${item.ordinal}>` : `<Audio ${item.ordinal}>`;
    return <button type="button" role="option" aria-selected={active} className={active ? "minimax-prompt-mention is-active" : "minimax-prompt-mention"} onMouseEnter={onHover} onClick={(event) => onPick(item)}>
        <img src={item.ref.url} alt="" loading="lazy" />
        {item.ref.type === "video" ? <H3Icon name="clapperboard" /> : item.ref.type === "audio" ? <H3Icon name="output" /> : null}
        <span className="minimax-prompt-mention-name">{text} · {item.ref.name}</span>
    </button>;
}
