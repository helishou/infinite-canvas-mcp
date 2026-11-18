import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Music2, Sparkles, Wand2, SlidersHorizontal, Rows3, Gauge, Save, Plus, Trash2, Mic2, Film, Eye, Play, Image as ImageIcon, BookOpen, RotateCcw } from "lucide-react";

import {
    modelOptionLabel,
    selectableModelsByCapability,
    useConfigStore,
    type ReasoningEffort,
} from "@/stores/use-config-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { dramaWorkbenchPath } from "@/pages/drama/workbench-entry";
import { TOPIC_OPTIONS } from "@basketikun/canvas-agent/drama/topic-options";
import { ASSET_KIND_SKILL } from "@basketikun/canvas-agent/drama/asset-spec";
import { SkillPickerField, type SkillRef } from "./studio-skill-picker";
import { cn } from "@/lib/utils";

/**
 * 影策短剧制作台「制作设置」逐项复刻。
 *
 * 本地后端 folder.productionPlan 是权威剧目设置，但它的 schema 是 strict 的，
 * 影策那批新增项（节奏档位/表演强度/运镜动感/并发数/段落衔接/hook/音色库/
 * 分镜规则/思考等级/设定版式）本地没有对应字段——这类不伪造后端，按剧目存 localStorage；
 * 视觉风格/对白语言来自剧目规划的真实值，只读展示，不做填了没用的假输入框；
 * 「重做参考图」本地无等价后端能力，做引导去画布精修的入口，不造假按钮。
 */

/** 思考等级用本地文本设置里真实存在的档位（text-settings-panel.tsx）。 */
const THINKING_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
    { value: "auto", label: "自动" },
    { value: "low", label: "低" },
    { value: "medium", label: "中" },
    { value: "high", label: "高" },
    { value: "xhigh", label: "极高" },
];

/** 设定版式用本地真实存在的资产图类型（asset-spec.ts 的 ASSET_KIND_SKILL.imageKind），不编造影策的「声纹/四格资产板」。 */
const LAYOUT_OPTIONS: string[] = [...new Set(Object.values(ASSET_KIND_SKILL).map((s) => s.imageKind))];

export type StudioProductionSettings = {
    // 文字步骤模型（#29）
    assetExtractModel: string;
    storyboardModel: string;
    videoPromptModel: string;
    // 参考图模型与分辨率（#30）
    characterImageModel: string;
    propImageModel: string;
    sceneImageModel: string;
    imageResolution: "1k" | "2k" | "4k";
    // 段落衔接（#31 #46）
    continuationMode: "tail" | "parallel";
    // 同时生成数（#32）
    concurrency: { text: number; image: number; video: number; assemble: number };
    // 镜头节奏（#33）
    pacing: "极快" | "快" | "标准" | "舒缓" | "慢";
    transitionMs: number;
    // 表演与运镜（#34）
    performanceIntensity: number; // 1-10
    cameraDynamics: number; // 1-10
    // 剧情段视频分辨率（#35）
    videoResolution: string;
    videoModel: string;
    // 钩子与悬念（#36）
    hook: string;
    cliffhanger: string;
    // 音色库（#43）
    voiceProfiles: Array<{ id: string; name: string; description: string; sampleRef: string }>;
    // 样片模式（#10）
    sampleMode: boolean;
    // 审阅方式（影策 reviewMode：sample|every|auto，仅本地偏好）
    reviewMode: "sample" | "every" | "auto";
    // 每集确认前的生成节奏（影策 mediaMode：manual|auto，仅本地偏好）
    mediaMode: "manual" | "auto";
    // 每段最多参考图（影策 referenceLimit：0=按模型上限，仅本地偏好）
    referenceLimit: number;

    // ===== 差异#6 补齐项（全部沿用按剧目 localStorage 持久化） =====
    // 分镜规则
    episodeSeconds: number;                                        // 单集时长（秒），影策约 90s
    segmentMode: "smart" | "fixed";                                // 剧情段：智能 / 固定
    segmentRange: { min: number; max: number };                    // 固定模式段时长范围（秒）
    dialogueDensity: "dense" | "standard" | "restrained" | "custom"; // 对白密度
    transitionMode: "smart" | "hard" | "fade" | "flash";           // 转场（转场时长见 transitionMs）
    // 文字步骤：新增「分集规划」模型 + 每步思考等级
    planModel: string;
    textThinking: { plan: ReasoningEffort; extract: ReasoningEffort; storyboard: ReasoningEffort; prompt: ReasoningEffort };
    // 写作技能（来自本地技能库，真值引用 {name,title,path}；分集规划无对应技能槽，影策只有 bible/script/prompt）
    textSkills: { extract: SkillRef | null; storyboard: SkillRef | null; prompt: SkillRef | null };
    // 参考图设定版式（用真实 imageKind 值，"auto" = 跟随资产类型）
    referenceLayout: "auto" | string;
};

export const DEFAULT_STUDIO_SETTINGS: StudioProductionSettings = {
    assetExtractModel: "",
    storyboardModel: "",
    videoPromptModel: "",
    characterImageModel: "",
    propImageModel: "",
    sceneImageModel: "",
    imageResolution: "1k",
    continuationMode: "tail",
    concurrency: { text: 2, image: 2, video: 1, assemble: 1 },
    pacing: "快",
    transitionMs: 150,
    performanceIntensity: 5,
    cameraDynamics: 5,
    videoResolution: "",
    videoModel: "",
    hook: "",
    cliffhanger: "",
    voiceProfiles: [],
    sampleMode: false,
    reviewMode: "auto",
    mediaMode: "auto",
    referenceLimit: 0,
    // 差异#6
    episodeSeconds: 90,
    segmentMode: "smart",
    segmentRange: { min: 8, max: 15 },
    dialogueDensity: "standard",
    transitionMode: "smart",
    planModel: "",
    textThinking: { plan: "auto", extract: "auto", storyboard: "auto", prompt: "auto" },
    textSkills: { extract: null, storyboard: null, prompt: null },
    referenceLayout: "auto",
};

const storageKey = (dramaId: string) => `drama-studio:settings:${dramaId}`;

export function loadStudioSettings(dramaId: string | null): StudioProductionSettings {
    if (!dramaId) return { ...DEFAULT_STUDIO_SETTINGS };
    try {
        const raw = localStorage.getItem(storageKey(dramaId));
        if (!raw) return { ...DEFAULT_STUDIO_SETTINGS };
        const parsed = JSON.parse(raw) as Partial<StudioProductionSettings>;
        return {
            ...DEFAULT_STUDIO_SETTINGS,
            ...parsed,
            concurrency: { ...DEFAULT_STUDIO_SETTINGS.concurrency, ...(parsed.concurrency || {}) },
            segmentRange: { ...DEFAULT_STUDIO_SETTINGS.segmentRange, ...(parsed.segmentRange || {}) },
            textThinking: { ...DEFAULT_STUDIO_SETTINGS.textThinking, ...(parsed.textThinking || {}) },
            textSkills: { ...DEFAULT_STUDIO_SETTINGS.textSkills, ...(parsed.textSkills || {}) },
            voiceProfiles: Array.isArray(parsed.voiceProfiles) ? parsed.voiceProfiles : [],
        };
    } catch {
        return { ...DEFAULT_STUDIO_SETTINGS };
    }
}

function Section({ icon, title, desc, children, marker }: { icon: React.ReactNode; title: string; desc?: string; children: React.ReactNode; marker?: string }) {
    return (
        <section className="rounded-lg border border-border bg-card/40 p-4" data-studio-settings-section={marker}>
            <div className="mb-3 flex items-center gap-2">
                <span className="text-foreground/70">{icon}</span>
                <h3 className="text-sm font-semibold">{title}</h3>
            </div>
            {desc ? <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">{desc}</p> : null}
            <div className="space-y-3">{children}</div>
        </section>
    );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
    return (
        <label className="flex items-center gap-3 text-xs">
            <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
            <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
            {hint ? <span className="shrink-0 text-[10px] text-muted-foreground/70">{hint}</span> : null}
        </label>
    );
}

/** 一组并列选项按钮（分段控件），用于智能/固定、对白密度、转场等本地偏好。 */
function ChoiceButtons<T extends string>({ value, options, onChange, marker }: {
    value: T;
    options: ReadonlyArray<{ value: T; label: string }>;
    onChange: (v: T) => void;
    marker?: string;
}) {
    return (
        <div className="flex flex-1 flex-wrap gap-1" data-studio-choice={marker}>
            {options.map((o) => (
                <button key={o.value} type="button" onClick={() => onChange(o.value)}
                    className={cn("rounded-md border px-2.5 py-1 text-[11px] transition",
                        value === o.value ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted")}>
                    {o.label}
                </button>
            ))}
        </div>
    );
}

function ModelSelect({ value, capability, onChange, config }: {
    value: string;
    capability: "text" | "image" | "video";
    onChange: (value: string) => void;
    config: ReturnType<typeof useConfigStore.getState>["config"];
}) {
    const options = useMemo(() => selectableModelsByCapability(config, capability), [config, capability]);
    return (
        <select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary"
        >
            <option value="">跟随默认</option>
            {options.map((option) => (
                <option key={option} value={option}>{modelOptionLabel(config, option)}</option>
            ))}
        </select>
    );
}

export function StudioSettingsTab({ dramaId, settings, onChange, onSave, onReset, saving, studioInfo }: {
    dramaId: string | null;
    settings: StudioProductionSettings;
    onChange: (next: StudioProductionSettings) => void;
    onSave: () => void;
    onReset: () => void;
    saving: boolean;
    /** 作品/分集方式的只读真实数据（来自 folder.productionPlan 与剧集统计），不造假可编辑框。 */
    studioInfo?: {
        dramaName: string;
        episodeCount: number;
        chapterCount: number;
        perEpisode: number;
        excludedCount: number;
    };
}) {
    const config = useConfigStore((state) => state.config);
    const navigate = useNavigate();
    const folders = useCanvasStore((state) => state.folders);
    const patch = <K extends keyof StudioProductionSettings>(key: K, value: StudioProductionSettings[K]) =>
        onChange({ ...settings, [key]: value });

    // 视觉风格 / 对白语言：剧目规划（folder.productionPlan.topic）里的真实值，只读展示。
    const artStyle = useMemo(() => {
        const folder = folders.find((f) => f.id === dramaId);
        const topic = (folder?.productionPlan as Record<string, unknown> | undefined)?.topic as Record<string, unknown> | undefined;
        return String(topic?.artStyle || "");
    }, [folders, dramaId]);
    const dialogueLanguage = useMemo(() => {
        const folder = folders.find((f) => f.id === dramaId);
        const topic = (folder?.productionPlan as Record<string, unknown> | undefined)?.topic as Record<string, unknown> | undefined;
        return String(topic?.language || "");
    }, [folders, dramaId]);

    const videoResolutions = useMemo(() => {
        const names = new Set<string>();
        for (const channel of config.channels) {
            for (const model of channel.models) {
                const value = model.workflowParams?.multi?.resolution ?? model.workflowParams?.single?.resolution ?? model.workflowParams?.text?.resolution;
                if (typeof value === "string") names.add(value);
            }
        }
        return [...names].sort();
    }, [config.channels]);

    return (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4" data-studio-settings>
            <div className="mx-auto max-w-3xl space-y-4">
                <div className="flex items-center justify-between">
                    <div>
                        <h2 className="text-base font-semibold">制作设置</h2>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">对应影策「制作设置 / 新建页」的全部配置项 · 按剧目独立保存</p>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={onReset}
                            disabled={!dramaId || saving}
                            title="还原到最后保存的设置"
                            className="flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
                        >
                            <RotateCcw className="size-3.5" /> 还原
                        </button>
                        <button
                            type="button"
                            onClick={onSave}
                            disabled={!dramaId || saving}
                            className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
                        >
                            <Save className="size-3.5" /> {saving ? "保存中…" : "保存设置"}
                        </button>
                    </div>
                </div>

                <Section marker="storyboard-rules" icon={<Rows3 className="size-4" />} title="分镜规则" desc="影策「分镜规则」：单集时长、剧情段、对白密度、转场。按剧目存本地偏好；转场时长在下方「镜头节奏与表演」。">
                    <Field label="单集时长" hint="≈ 1.5 分钟">
                        <input type="number" min={30} max={600} step={5} value={settings.episodeSeconds}
                            onChange={(e) => patch("episodeSeconds", Math.max(30, Math.min(600, Number(e.target.value) || 90)))}
                            className="h-8 w-24 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary" />
                        <span className="text-[10px] text-muted-foreground">秒 · 当前约 {(settings.episodeSeconds / 60).toFixed(1)} 分钟</span>
                    </Field>
                    <Field label="剧情段">
                        <ChoiceButtons marker="segment-mode" value={settings.segmentMode}
                            options={[{ value: "smart", label: "智能" }, { value: "fixed", label: "固定" }]}
                            onChange={(v) => patch("segmentMode", v)} />
                    </Field>
                    {settings.segmentMode === "fixed" ? (
                        <Field label="段时长范围" hint="秒 / 段">
                            <input type="number" min={2} max={60} value={settings.segmentRange.min}
                                onChange={(e) => patch("segmentRange", { ...settings.segmentRange, min: Math.max(2, Number(e.target.value) || 2) })}
                                className="h-8 w-16 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary" />
                            <span className="text-muted-foreground">—</span>
                            <input type="number" min={2} max={60} value={settings.segmentRange.max}
                                onChange={(e) => patch("segmentRange", { ...settings.segmentRange, max: Math.max(2, Number(e.target.value) || 2) })}
                                className="h-8 w-16 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary" />
                        </Field>
                    ) : null}
                    <Field label="对白密度">
                        <ChoiceButtons marker="dialogue-density" value={settings.dialogueDensity}
                            options={[
                                { value: "dense", label: "密集" }, { value: "standard", label: "标准" },
                                { value: "restrained", label: "克制" }, { value: "custom", label: "自定义" },
                            ]}
                            onChange={(v) => patch("dialogueDensity", v)} />
                    </Field>
                    <Field label="转场">
                        <ChoiceButtons marker="transition-mode" value={settings.transitionMode}
                            options={[
                                { value: "smart", label: "智能" }, { value: "hard", label: "硬切" },
                                { value: "fade", label: "黑场过渡" }, { value: "flash", label: "闪白" },
                            ]}
                            onChange={(v) => patch("transitionMode", v)} />
                    </Field>
                </Section>

                <Section marker="text-steps" icon={<Wand2 className="size-4" />} title="文字步骤" desc="每步可选文本模型 + 思考等级 + 写作技能；留空跟随默认。技能来自本地「技能」库，选中后其方法要点会注入改编请求（后端 instruction 上限 2000 字）。">
                    {([
                        { key: "plan", label: "分集规划", modelKey: "planModel" as const, thinkKey: "plan" as const, skillKey: null },
                        { key: "extract", label: "提取设定", modelKey: "assetExtractModel" as const, thinkKey: "extract" as const, skillKey: "extract" as const },
                        { key: "storyboard", label: "分镜拆分", modelKey: "storyboardModel" as const, thinkKey: "storyboard" as const, skillKey: "storyboard" as const },
                        { key: "prompt", label: "视频提示词", modelKey: "videoPromptModel" as const, thinkKey: "prompt" as const, skillKey: "prompt" as const },
                    ]).map((row) => (
                        <div key={row.key} className="rounded-md border border-border/60 p-2.5">
                            <Field label={row.label}>
                                <ModelSelect capability="text" config={config} value={settings[row.modelKey]}
                                    onChange={(v) => patch(row.modelKey, v)} />
                                <select value={settings.textThinking[row.thinkKey]}
                                    onChange={(e) => patch("textThinking", { ...settings.textThinking, [row.thinkKey]: e.target.value as ReasoningEffort })}
                                    className="h-8 w-20 shrink-0 rounded-md border border-border bg-background px-1.5 text-xs outline-none focus:border-primary"
                                    aria-label={`${row.label}思考等级`} data-studio-thinking={row.thinkKey}>
                                    {THINKING_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                                </select>
                            </Field>
                            {row.skillKey ? (
                                <div className="mt-2 flex items-start gap-3 pl-1">
                                    <span className="w-14 shrink-0 pt-0.5 text-[11px] text-muted-foreground">写作技能</span>
                                    <SkillPickerField step={row.skillKey}
                                        value={settings.textSkills[row.skillKey]}
                                        onChange={(ref) => patch("textSkills", { ...settings.textSkills, [row.skillKey]: ref })} />
                                </div>
                            ) : null}
                        </div>
                    ))}
                </Section>

                <Section marker="reference" icon={<Sparkles className="size-4" />} title="参考图" desc="角色、道具、场景可分别选图片模型；设定详情仍可上传或绑定素材库图片。">
                    <Field label="角色"><ModelSelect capability="image" config={config} value={settings.characterImageModel} onChange={(v) => patch("characterImageModel", v)} /></Field>
                    <Field label="道具"><ModelSelect capability="image" config={config} value={settings.propImageModel} onChange={(v) => patch("propImageModel", v)} /></Field>
                    <Field label="场景"><ModelSelect capability="image" config={config} value={settings.sceneImageModel} onChange={(v) => patch("sceneImageModel", v)} /></Field>
                    <Field label="分辨率">
                        <div className="flex gap-1.5">
                            {(["1k", "2k", "4k"] as const).map((r) => (
                                <button key={r} type="button" onClick={() => patch("imageResolution", r)}
                                    className={cn("rounded-md border px-3 py-1 text-xs transition", settings.imageResolution === r ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted")}>
                                    {r.toUpperCase()}
                                </button>
                            ))}
                        </div>
                    </Field>
                    <Field label="设定版式" hint="由技能模板决定">
                        <select value={settings.referenceLayout} disabled
                            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-muted/40 px-2 text-xs text-muted-foreground outline-none"
                            data-studio-reference-layout title="版式由资产技能模板（ASSET_KIND_SKILL.imageKind）真实决定，此处只读展示偏好">
                            <option value="auto">跟随资产类型（自动）</option>
                            {LAYOUT_OPTIONS.map((layout) => <option key={layout} value={layout}>{layout}</option>)}
                        </select>
                    </Field>
                    <p className="pl-1 text-[10px] text-muted-foreground">实际版式由资产设定卡按技能模板拼装（见下方预览），此处只读。</p>
                    <div className="rounded-md border border-border bg-background/40 p-2.5" data-studio-ref-preview>
                        <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">实际发送预览（只读 · 来自本地技能模板）</div>
                        <ul className="space-y-0.5 text-[11px] leading-relaxed">
                            <li>角色 · {ASSET_KIND_SKILL.character.imageKind}｜{ASSET_KIND_SKILL.character.section}</li>
                            <li>场景 · {ASSET_KIND_SKILL.scene.imageKind}｜{ASSET_KIND_SKILL.scene.section}</li>
                            <li>道具 · {ASSET_KIND_SKILL.prop.imageKind}｜{ASSET_KIND_SKILL.prop.section}</li>
                        </ul>
                        <p className="mt-1.5 text-[10px] text-muted-foreground">真实提示词由资产设定卡按技能模板拼装；到「项目资产 · 设定详情」可查看并精修发送内容。</p>
                    </div>
                </Section>

                <Section marker="redo-guide" icon={<ImageIcon className="size-4" />} title="重做参考图" desc="影策可按当前方案重做角色 / 道具 / 场景参考图；本地无一键重做的后端能力，提供引导入口而非假按钮。">
                    <p className="text-xs leading-relaxed text-muted-foreground">
                        上方已保存当前方案（画风 / 模型 / 版式）。要按新方案更新已有参考图，请到画布选中对应资产，用「在画布中精修」重新生成——这是本地真实可用的入口。
                    </p>
                    <button type="button" disabled={!dramaId}
                        onClick={() => { if (dramaId) navigate(dramaWorkbenchPath(dramaId, undefined, "assets")); }}
                        className="flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-foreground transition hover:bg-muted disabled:opacity-50"
                        data-studio-redo-canvas>
                        <Sparkles className="size-3.5" /> 去画布精修参考图（角色 / 道具 / 场景）
                    </button>
                </Section>

                <Section icon={<Rows3 className="size-4" />} title="段落衔接" desc="尾帧续接：第2段起用上段尾帧做首帧、依次衔接；并行出片：各段只按参考图独立成片、不带尾帧首帧。保存后撰写段提示词真实生效。">
                    <div className="flex gap-2">
                        <button type="button" onClick={() => patch("continuationMode", "tail")}
                            className={cn("flex-1 rounded-md border p-3 text-left transition", settings.continuationMode === "tail" ? "border-primary bg-primary/10" : "border-border hover:bg-muted")}>
                            <div className="text-xs font-medium">尾帧续接</div>
                            <div className="mt-1 text-[10px] text-muted-foreground">默认 · 顺序逐段 · 上段尾帧做首帧</div>
                        </button>
                        <button type="button" onClick={() => patch("continuationMode", "parallel")}
                            className={cn("flex-1 rounded-md border p-3 text-left transition", settings.continuationMode === "parallel" ? "border-primary bg-primary/10" : "border-border hover:bg-muted")}>
                            <div className="text-xs font-medium">并行出片</div>
                            <div className="mt-1 text-[10px] text-muted-foreground">不带首帧 · 各段按参考图独立成片</div>
                        </button>
                    </div>
                </Section>

                <Section icon={<Gauge className="size-4" />} title="同时生成数" desc="按工作类型分别限制；排队顺序先按集号，同集内按成片→剧本→段提示词→段视频。">
                    {(["text", "image", "video", "assemble"] as const).map((key) => (
                        <Field key={key} label={{ text: "文字", image: "参考图", video: "段视频", assemble: "成片合成" }[key]}>
                            <input type="range" min={1} max={8} value={settings.concurrency[key]}
                                onChange={(e) => patch("concurrency", { ...settings.concurrency, [key]: Number(e.target.value) })}
                                className="flex-1" />
                            <span className="w-6 text-center tabular-nums">{settings.concurrency[key]}</span>
                        </Field>
                    ))}
                </Section>

                <Section icon={<SlidersHorizontal className="size-4" />} title="镜头节奏与表演" desc="五档节奏滑杆 + 表演强度/运镜动感 1–10 档，写进剧本与段视频提示词。">
                    <Field label="镜头节奏">
                        <div className="flex flex-1 gap-1">
                            {(["极快", "快", "标准", "舒缓", "慢"] as const).map((p) => (
                                <button key={p} type="button" onClick={() => patch("pacing", p)}
                                    className={cn("flex-1 rounded-md border py-1 text-[11px] transition", settings.pacing === p ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted")}>{p}</button>
                            ))}
                        </div>
                    </Field>
                    <Field label="转场时长"><input type="range" min={0} max={1000} step={50} value={settings.transitionMs}
                        onChange={(e) => patch("transitionMs", Number(e.target.value))} className="flex-1" /><span className="w-14 text-right tabular-nums">{settings.transitionMs}ms</span></Field>
                    <Field label="表演强度"><input type="range" min={1} max={10} value={settings.performanceIntensity}
                        onChange={(e) => patch("performanceIntensity", Number(e.target.value))} className="flex-1" /><span className="w-6 text-center tabular-nums">{settings.performanceIntensity}</span></Field>
                    <Field label="运镜动感"><input type="range" min={1} max={10} value={settings.cameraDynamics}
                        onChange={(e) => patch("cameraDynamics", Number(e.target.value))} className="flex-1" /><span className="w-6 text-center tabular-nums">{settings.cameraDynamics}</span></Field>
                </Section>

                <Section icon={<FilmIcon />} title="视频" desc="剧情段视频模型与分辨率档位；档位由所选视频模型决定。">
                    <Field label="视频模型"><ModelSelect capability="video" config={config} value={settings.videoModel} onChange={(v) => patch("videoModel", v)} /></Field>
                    <Field label="分辨率">
                        <select value={settings.videoResolution} onChange={(e) => patch("videoResolution", e.target.value)}
                            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary">
                            <option value="">跟随模型默认</option>
                            {videoResolutions.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                    </Field>
                </Section>

                <Section icon={<Sparkles className="size-4" />} title="钩子与悬念" desc="影策每集的 hook（开篇钩子）与 cliffhanger（结尾悬念）结构化字段。保存后「重新改编本集」会作为创作方向注入改编指令，真实影响剧本。">
                    <Field label="开篇钩子"><input value={settings.hook} onChange={(e) => patch("hook", e.target.value)} placeholder="前3秒如何抓住观众"
                        className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary" /></Field>
                    <Field label="结尾悬念"><input value={settings.cliffhanger} onChange={(e) => patch("cliffhanger", e.target.value)} placeholder="本集结尾留什么悬念"
                        className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary" /></Field>
                </Section>

                <Section icon={<Music2 className="size-4" />} title="音色库" desc="影策 voice-profiles：登记音色档案与声音样本 storageKey。登记后可在「项目资产 → 角色 → 声音样本」里直接绑定，真实写进 character.voice，随角色开口段发送。">
                    <div className="space-y-2">
                        {settings.voiceProfiles.map((vp, index) => (
                            <div key={vp.id} className="flex items-center gap-2 rounded-md border border-border bg-background/40 p-2">
                                <Mic2 className="size-3.5 shrink-0 text-muted-foreground" />
                                <input value={vp.name} onChange={(e) => { const next = [...settings.voiceProfiles]; next[index] = { ...vp, name: e.target.value }; patch("voiceProfiles", next); }}
                                    placeholder="音色名称" className="h-7 w-32 rounded border border-border bg-background px-2 text-xs outline-none" />
                                <input value={vp.description} onChange={(e) => { const next = [...settings.voiceProfiles]; next[index] = { ...vp, description: e.target.value }; patch("voiceProfiles", next); }}
                                    placeholder="音色描述" className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-2 text-xs outline-none" />
                                <input value={vp.sampleRef} onChange={(e) => { const next = [...settings.voiceProfiles]; next[index] = { ...vp, sampleRef: e.target.value }; patch("voiceProfiles", next); }}
                                    placeholder="样本 storageKey" className="h-7 w-40 rounded border border-border bg-background px-2 text-[11px] outline-none" />
                                <button type="button" onClick={() => patch("voiceProfiles", settings.voiceProfiles.filter((_, i) => i !== index))}
                                    className="text-muted-foreground hover:text-rose-500"><Trash2 className="size-3.5" /></button>
                            </div>
                        ))}
                        <button type="button" onClick={() => patch("voiceProfiles", [...settings.voiceProfiles, { id: `vp-${Date.now()}`, name: "", description: "", sampleRef: "" }])}
                            className="flex items-center gap-1.5 rounded-md border border-dashed border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
                            <Plus className="size-3.5" /> 添加音色
                        </button>
                    </div>
                </Section>

                <Section icon={<FilmIcon />} title="样片模式" desc="影策以第1集为样片：在第1集前插入或删除第1集会改变样片集。">
                    <label className="flex items-center gap-2 text-xs">
                        <input type="checkbox" checked={settings.sampleMode} onChange={(e) => patch("sampleMode", e.target.checked)} className="size-3.5" />
                        启用样片模式（第1集作为样片）
                    </label>
                </Section>

                <Section icon={<Eye className="size-4" />} title="审阅方式" desc="影策 reviewMode：只在关键点打断你。保存后启动流水线时真实下发到服务端闸门（sample=第1集成片后确认 / every=每集视频前审阅 / auto=不打断）。">
                    <div className="grid gap-1.5">
                        {([
                            { value: "sample", title: "先看样片", detail: "第 1 集成片确认后继续其余集" },
                            { value: "every", title: "每集确认", detail: "每集生成视频前停下来审阅段视频提示词" },
                            { value: "auto", title: "全自动", detail: "不打断，直接跑到成片" },
                        ] as const).map((opt) => (
                            <label key={opt.value} className={cn("flex cursor-pointer items-start gap-2 rounded-md border p-2 text-xs transition", settings.reviewMode === opt.value ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40")}>
                                <input type="radio" name="studio-review-mode" className="mt-0.5 size-3.5" checked={settings.reviewMode === opt.value} onChange={() => patch("reviewMode", opt.value)} />
                                <span className="min-w-0">
                                    <span className="block font-medium">{opt.title}</span>
                                    <span className="block text-[10px] text-muted-foreground">{opt.detail}</span>
                                </span>
                            </label>
                        ))}
                    </div>
                </Section>

                <Section icon={<Play className="size-4" />} title="生成节奏" desc="影策 mediaMode：手动先出剧本与提示词、确认后再生成视频；自动一路跑到成片。保存后启动流水线真实生效（manual 模式下素材就绪后需在「待处理」页放行媒体）。">
                    <div className="grid grid-cols-2 gap-2">
                        {([
                            { value: "manual", title: "手动生成", detail: "先出剧本与提示词，确认后再生成参考图与视频" },
                            { value: "auto", title: "全自动出片", detail: "剧本写好后直接生成参考图和带原声的段视频" },
                        ] as const).map((opt) => (
                            <label key={opt.value} className={cn("flex cursor-pointer items-start gap-2 rounded-md border p-2 text-xs transition", settings.mediaMode === opt.value ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40")}>
                                <input type="radio" name="studio-media-mode" className="mt-0.5 size-3.5" checked={settings.mediaMode === opt.value} onChange={() => patch("mediaMode", opt.value)} />
                                <span className="min-w-0">
                                    <span className="block font-medium">{opt.title}</span>
                                    <span className="block text-[10px] leading-relaxed text-muted-foreground">{opt.detail}</span>
                                </span>
                            </label>
                        ))}
                    </div>
                </Section>

                <Section icon={<ImageIcon className="size-4" />} title="每段最多参考图" desc="影策 referenceLimit：自动取参考图时的上限，人物优先；0 为按视频模型上限。本地偏好。">
                    <Field label="上限张数" hint="0 = 按模型上限">
                        <input type="number" min={0} max={20} step={1} value={settings.referenceLimit}
                            onChange={(e) => patch("referenceLimit", Math.max(0, Math.min(20, Number(e.target.value) || 0)))}
                            className="h-8 w-24 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary" />
                    </Field>
                    <p className="text-[10px] text-muted-foreground">超出的设定按文字描述生成，不附图；个别段可在剧情段弹窗手动指定。</p>
                </Section>

                <Section marker="work" icon={<BookOpen className="size-4" />} title="作品" desc="影策记为“开工时确定”，只读展示当前剧目的真实信息。">
                    <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1.5 text-xs">
                        <dt className="text-muted-foreground">剧目</dt><dd className="truncate">{studioInfo?.dramaName || "—"}</dd>
                        <dt className="text-muted-foreground">分集</dt><dd>{studioInfo ? `${studioInfo.episodeCount} 集` : "—"}</dd>
                        <dt className="text-muted-foreground">原文章节</dt><dd>{studioInfo ? `${studioInfo.chapterCount} 章` : "—"}</dd>
                        <dt className="text-muted-foreground">画幅</dt><dd className="text-muted-foreground">在「剧目规划」中确定</dd>
                        <dt className="text-muted-foreground">视觉风格</dt><dd className="truncate">{artStyle || <span className="text-muted-foreground">剧目规划未设置</span>}</dd>
                        <dt className="text-muted-foreground">对白语言</dt><dd>{dialogueLanguage || <span className="text-muted-foreground">剧目规划未设置</span>}
                            <span className="ml-1 text-[10px] text-muted-foreground/70">（可选：{TOPIC_OPTIONS.language.join(" / ")}）</span></dd>
                    </dl>
                </Section>

                <Section icon={<FilmIcon />} title="分集方式" desc="影策：分集完成后不可再调整，只读展示。要改分集口径请到「剧目规划 · 原剧本」页。">
                    <p className="text-xs leading-relaxed">
                        {studioInfo
                            ? <>按章分集 · {studioInfo.perEpisode > 1 ? `每 ${studioInfo.perEpisode} 章一集` : "每章一集"} · 共 {studioInfo.chapterCount} 章 {studioInfo.episodeCount} 集{studioInfo.excludedCount ? ` · ${studioInfo.excludedCount} 章预留` : ""}</>
                            : "已分集"}
                    </p>
                </Section>

                <div className="pb-4 text-center">
                    <button type="button" onClick={onSave} disabled={!dramaId || saving}
                        className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
                        <Save className="size-3.5" /> {saving ? "保存中…" : "保存全部设置"}
                    </button>
                    <p className="mt-2 text-[10px] text-muted-foreground">保存后按剧目隔离；模型/画幅等本地已有项由真实数据提供。</p>
                </div>
            </div>
        </div>
    );
}

function FilmIcon() {
    return <Film className="size-4" />;
}
