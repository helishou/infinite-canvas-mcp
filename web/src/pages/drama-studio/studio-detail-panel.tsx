import { useMemo, useRef, useState, useEffect, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { App, Modal, Input } from "antd";
import {
    BookOpen, Sparkles, RefreshCw, Clapperboard, Video, Download, Film, Play,
    ChevronRight, AlertCircle, LoaderCircle, Eye, Scissors, Link2, Wand2, Pencil, Quote, Save,
} from "lucide-react";
import type { EpisodeProduction } from "@/services/backend-api";
import { backendMediaUrl, editEpisodeProduction, fetchEpisodeProduction, fetchDramaPlanningSource, patchDramaPlanningSource } from "@/services/backend-api";
import type { ProductionOperation } from "@basketikun/canvas-agent/drama/production-contract";
import type { StudioClipMedia } from "./use-studio-data";
import type { StudioEpisode } from "./use-studio-data";
import { cn } from "@/lib/utils";
import { splitSourceIntoEpisodes, groupSynopsis } from "@/lib/drama/adapt";

/**
 * 影策制作台「详情区」原生复刻（对照 tmp/oac/scrape/detail-*.png + y-detailhead.png）。
 * 三个 tab 的内容是影策独有的，不是本地 ProductionEditor：
 * - 剧本：本集梗概卡 + 开场钩子/结尾悬念 + 分镜规则 + 失败提示/重新改编 + 右侧原文对照
 * - 分镜：剧情段→镜头表，点镜头联动右侧原文；段提示词 + @引用资产
 * - 成片：播放器 + 集信息 + 合成成品/下载/导出剪映
 * 所有数据来自本地制作稿真实字段（director.source），无第二份真值。
 */

type Source = Record<string, any>;
type Row = Record<string, any>;

const rows = (v: unknown): Row[] => Array.isArray(v) ? v.filter((x): x is Row => Boolean(x) && typeof x === "object" && !Array.isArray(x)) : [];

/** 参考图角色分类（对齐影策 @引用三色：角色蓝/环境绿/道具黄，规则同 canvas-agent inferReferenceRole）。 */
function referenceKindOf(text: string): "character" | "scene" | "prop" | "other" {
    const t = text.toLowerCase();
    if (/人物|角色|定妆|形象|identity|portrait|character/.test(t)) return "character";
    if (/场景|环境|scene|room|interior|exterior/.test(t)) return "scene";
    if (/道具|prop|ticket|phone/.test(t)) return "prop";
    return "other";
}
const REF_KIND_STYLE: Record<ReturnType<typeof referenceKindOf>, string> = {
    character: "border-sky-400 bg-sky-500/10 text-sky-300",
    scene: "border-emerald-400 bg-emerald-500/10 text-emerald-300",
    prop: "border-amber-400 bg-amber-500/10 text-amber-300",
    other: "border-border bg-muted/40 text-muted-foreground",
};
const str = (v: unknown): string => (typeof v === "string" || typeof v === "number") ? String(v) : "";

/** duration_frames 一律按制作稿 fps_num/fps_den 换算（默认 24）；旧的 f>100 启发式会把 96 帧当成 96 秒，已废弃。 */
function framesToSec(frames: unknown, source?: Source): number {
    const f = Number(frames || 0);
    if (!Number.isFinite(f) || f <= 0) return 0;
    const fps = Number(source?.fps_num || 24) / Number(source?.fps_den || 1) || 24;
    return f / fps;
}

function sourceOf(production: EpisodeProduction | undefined): Source {
    const draft = (production?.draft || {}) as Record<string, unknown>;
    return ((draft.director as Record<string, unknown> | undefined)?.source as Source) || {};
}

/** 影策剧本页数据：梗概、钩子、悬念、分镜规则，全部从真实制作稿/分集字段派生。 */
function scriptData(ep: StudioEpisode, source: Source) {
    const scenes = rows(source.script_scenes);
    const synopsis = String(ep.synopsis || "").trim();
    const hook = str(source.hook || source.opening_hook || source.lead_hook);
    const cliffhanger = str(source.cliffhanger || source.ending_hook || source.suspense);
    // 分镜规则：优先制作稿设置，其次用真实统计派生（不编造档位名）
    const settings = (source.settings || source.storyboard_rules || {}) as Row;
    const pacing = str(settings.pacing || settings.shot_pace);
    const dialogue = str(settings.dialogue_density);
    const segRange = str(settings.segment_range || settings.segment_duration);
    const transition = str(settings.transition);
    const shotCount = rows(source.shots).length;
    const totalSec = rows(source.shots).reduce((s, sh) => s + framesToSec(sh.duration_frames || sh.durationMs, source), 0);
    const ruleParts = [pacing, dialogue, segRange, transition].filter(Boolean);
    const rule = ruleParts.length ? ruleParts.join(" · ") : `标准节奏 · 对白标准 · 剧情段8–15秒 · 转场智能`;
    return { scenes, synopsis, hook, cliffhanger, rule, shotCount, totalSec: Math.round(totalSec) };
}

/**
 * 影策剧本页「按场次组织的镜头列表」数据，全部从真实制作稿 source 派生。
 * - 场次：按 shot.scene_id 分组，连续同 scene_id 合并为一场；场名取自 scene_registry。
 * - 镜头：编号 / 景别·运镜·时长 / 动作(shot.visual) / 台词(utterances.start.shotId 关联)。
 * - 说话人：speakerSubjectId → subject_registry.entityRef.id → character_registry.name，
 *   缺失时回退 speakerName / speakerSubjectId。
 */
type ScreenplayLine = { speaker: string; text: string };

/** 景别码→中文（canvas-agent 真实词表 EWS/WS/FS/MS/MCU/CU/ECU；对齐影策中文标签展示，码保留在 title）。 */
const FRAMING_LABEL: Record<string, string> = {
    EWS: "大远景", WS: "远景", FS: "全景", MS: "中景", MCU: "中近景", CU: "近景", ECU: "特写",
};
const framingLabel = (code: string) => FRAMING_LABEL[code.trim().toUpperCase()] || code;
type ScreenplayShot = {
    no: string; id: string; title: string; visual: string;
    framing: string; movement: string; sec: number; durationFrames: number; lines: ScreenplayLine[];
};
type ScreenplayScene = { key: string; no: number; name: string; sec: number; shots: ScreenplayShot[] };

function screenplayData(source: Source): { scenes: ScreenplayScene[] } {
    const shots = rows(source.shots);
    const sceneName = new Map<string, string>();
    for (const sc of rows(source.scene_registry)) {
        if (str(sc.id)) sceneName.set(str(sc.id), str(sc.name || sc.heading || sc.title));
    }
    const subjectById = new Map<string, Row>();
    for (const s of rows(source.subject_registry)) if (str(s.id)) subjectById.set(str(s.id), s);
    const charNameById = new Map<string, string>();
    for (const c of rows(source.character_registry)) if (str(c.id)) charNameById.set(str(c.id), str(c.name));

    const speakerNameOf = (u: Row): string => {
        const ref = subjectById.get(str(u.speakerSubjectId))?.entityRef as Row | undefined;
        const entityId = str(ref?.id);
        return charNameById.get(entityId) || str(u.speakerName) || str(u.speakerSubjectId) || "未命名";
    };

    const linesByShot = new Map<string, Row[]>();
    for (const u of rows(source.utterances)) {
        const sid = str((u.start as Row | undefined)?.shotId);
        if (!sid) continue;
        const arr = linesByShot.get(sid) || [];
        arr.push(u);
        linesByShot.set(sid, arr);
    }

    const fps = Number(source.fps_num || 24) / Number(source.fps_den || 1) || 24;
    const shotSec = (sh: Row) => Number(sh.duration_frames || sh.durationMs || 0) / fps;

    const scenes: ScreenplayScene[] = [];
    shots.forEach((sh, idx) => {
        const sceneId = str(sh.scene_id);
        const last = scenes[scenes.length - 1];
        let scene = last && last.key === sceneId ? last : null;
        if (!scene) {
            scene = {
                key: sceneId,
                no: scenes.length + 1,
                name: sceneName.get(sceneId) || sceneId || "未分场",
                sec: 0,
                shots: [],
            };
            scenes.push(scene);
        }
        const cam = (sh.camera || {}) as Row;
        const sec = shotSec(sh);
        const lines = (linesByShot.get(str(sh.id)) || []).map(u => ({ speaker: speakerNameOf(u), text: str(u.text) }));
        scene.shots.push({
            no: String(idx + 1).padStart(2, "0"),
            id: str(sh.id),
            title: str(sh.title),
            visual: str(sh.visual),
            framing: str(cam.framing),
            movement: str(cam.movement),
            sec,
            durationFrames: Number(sh.duration_frames || sh.durationMs || 0),
            lines,
        });
        scene.sec += sec;
    });
    return { scenes };
}

function ErrorBanner({ error, failed }: { error: string; failed: number }) {
    if (!error && !failed) return null;
    return (
        <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50/70 px-3 py-2 text-[11px] text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-300" data-studio-error-banner>
            <div className="flex items-center gap-2 font-medium">
                <AlertCircle className="size-3.5 shrink-0" /> 本集遇到问题
                <span className="ml-auto font-normal opacity-70">{failed ? `${failed} 次失败 · ` : ""}可在底部队列「全部重试」</span>
            </div>
            {error ? <p className="mt-1 truncate opacity-80" title={error}>{error}</p> : null}
        </div>
    );
}

/** 景别下拉：canvas-agent 真实七档词表（code 写回，中文 label 仅展示）。 */
const SHOT_FRAMINGS: Array<{ code: string; label: string }> = [
    { code: "EWS", label: "大远景" }, { code: "WS", label: "远景" },
    { code: "FS", label: "全景" }, { code: "MS", label: "中景" },
    { code: "MCU", label: "中近景" }, { code: "CU", label: "近景" },
    { code: "ECU", label: "特写" },
];
const FRAMING_CODES = SHOT_FRAMINGS.map(f => f.code);

type ShotDraft = { title: string; visual: string; framing: string; movement: string; seconds: string };
function shotDraftOf(shot: ScreenplayShot): ShotDraft {
    return { title: shot.title, visual: shot.visual, framing: shot.framing, movement: shot.movement, seconds: shot.sec.toFixed(1) };
}

/**
 * 影策式镜头内联编辑器：字段全部来自真实 source.shots（title/visual/camera.framing/
 * camera.movement/duration_frames）。每个字段失焦即对比基线写 patch_director_source；
 * 保存按钮把本轮全部改动一次写回。camera / performance 由后端深合并，未提交的子字段保留。
 */
function ShotEditor({ shot, fps, busy, onPatch, onDone }: {
    shot: ScreenplayShot; fps: number; busy: boolean;
    onPatch: (patch: Record<string, unknown>) => void; onDone: () => void;
}) {
    const [draft, setDraft] = useState<ShotDraft>(() => shotDraftOf(shot));
    const saved = useRef<ShotDraft>(shotDraftOf(shot));
    const change = (key: keyof ShotDraft) => (e: { target: { value: string } }) =>
        setDraft(d => ({ ...d, [key]: e.target.value }));

    const flush = () => {
        const base = saved.current;
        const patch: Record<string, unknown> = {};
        if (draft.title !== base.title) patch.title = draft.title;
        if (draft.visual !== base.visual) patch.visual = draft.visual;
        const sec = Number(draft.seconds);
        if (Number.isFinite(sec) && sec > 0 && Math.abs(sec - Number(base.seconds)) >= 0.05) {
            patch.duration_frames = Math.round(sec * fps);
        }
        const camera: Record<string, unknown> = {};
        if (draft.framing !== base.framing && FRAMING_CODES.includes(draft.framing)) camera.framing = draft.framing;
        if (draft.movement !== base.movement) camera.movement = draft.movement;
        if (Object.keys(camera).length) patch.camera = camera;
        if (!Object.keys(patch).length) return;
        saved.current = draft;
        onPatch(patch);
    };
    const enterBlur = (e: ReactKeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") e.currentTarget.blur(); };

    return (
        <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
                <label className="block" data-studio-shot-field="title">
                    <span className="mb-1 block text-[10px] text-muted-foreground">标题</span>
                    <input value={draft.title} onChange={change("title")} onBlur={flush} onKeyDown={enterBlur}
                        className="h-7 w-full rounded border border-border bg-background px-2 text-[11px] outline-none focus:border-primary" placeholder="镜头标题" />
                </label>
                <label className="block" data-studio-shot-field="seconds">
                    <span className="mb-1 block text-[10px] text-muted-foreground">时长（秒）</span>
                    <input type="number" min={0.5} max={60} step={0.1} value={draft.seconds} onChange={change("seconds")} onBlur={flush} onKeyDown={enterBlur}
                        className="h-7 w-full rounded border border-border bg-background px-2 text-[11px] outline-none focus:border-primary" />
                </label>
            </div>
            <div className="grid grid-cols-2 gap-2">
                <label className="block" data-studio-shot-field="framing">
                    <span className="mb-1 block text-[10px] text-muted-foreground">景别</span>
                    <select value={draft.framing} onChange={change("framing")} onBlur={flush}
                        className="h-7 w-full rounded border border-border bg-background px-1.5 text-[11px] outline-none focus:border-primary">
                        {!FRAMING_CODES.includes(draft.framing) ? <option value={draft.framing}>{draft.framing || "自动"}</option> : null}
                        {SHOT_FRAMINGS.map(f => <option key={f.code} value={f.code}>{f.code} · {f.label}</option>)}
                    </select>
                </label>
                <label className="block" data-studio-shot-field="movement">
                    <span className="mb-1 block text-[10px] text-muted-foreground">运镜</span>
                    <input value={draft.movement} onChange={change("movement")} onBlur={flush} onKeyDown={enterBlur}
                        className="h-7 w-full rounded border border-border bg-background px-2 text-[11px] outline-none focus:border-primary" placeholder="如：缓慢推近" />
                </label>
            </div>
            <label className="block" data-studio-shot-field="visual">
                <span className="mb-1 block text-[10px] text-muted-foreground">画面描述</span>
                <textarea value={draft.visual} onChange={change("visual")} onBlur={flush} rows={3}
                    className="w-full resize-y rounded border border-border bg-background p-2 text-[11px] leading-5 outline-none focus:border-primary" placeholder="这一镜的画面内容" />
            </label>
            <div className="flex items-center gap-2 pt-0.5">
                <button type="button" disabled={busy} onClick={flush}
                    className="flex h-7 items-center gap-1 rounded bg-primary px-2.5 text-[11px] text-primary-foreground transition hover:opacity-90 disabled:opacity-50">
                    <Save className="size-3" /> {busy ? "保存中…" : "保存"}
                </button>
                <button type="button" onClick={() => { flush(); onDone(); }}
                    className="h-7 rounded border border-border px-2.5 text-[11px] text-muted-foreground transition hover:bg-muted/60">完成</button>
                <span className="ml-auto text-[10px] text-muted-foreground">失焦自动保存 · 改动只让本段提示词与视频过期</span>
            </div>
        </div>
    );
}

function ScriptPanel({ ep, production, dramaId, onRescript, onChanged, busy }: { ep: StudioEpisode; production: EpisodeProduction | undefined; dramaId?: string | null; onRescript: () => void; onChanged?: () => void; busy: boolean }) {
    const { message } = App.useApp();
    const source = useMemo(() => sourceOf(production), [production]);
    const d = useMemo(() => scriptData(ep, source), [ep, source]);
    const sp = useMemo(() => screenplayData(source), [source]);
    const [selectedShot, setSelectedShot] = useState<string | null>(null);
    const [savingShot, setSavingShot] = useState(false);
    // 编辑原文：读剧目级策划真值 sourceScript，PATCH 写回（带 updatedAt 乐观锁）。
    const [editSourceOpen, setEditSourceOpen] = useState(false);
    const [sourceDraft, setSourceDraft] = useState("");
    const [sourceUpdatedAt, setSourceUpdatedAt] = useState("");
    const [sourceSaving, setSourceSaving] = useState(false);
    // 原文对照 = 本集对应的小说原文章节（从剧目级 sourceScript 按集切分派生，单一真值，不另存副本）。
    // 影策等价：getDramaChapter(chapter.sourceText)；本地原文真值在 planning.sourceScript，故派生而非读 synopsis。
    const [chapterSource, setChapterSource] = useState("");
    useEffect(() => {
        let alive = true;
        if (!dramaId || !ep?.no) { setChapterSource(""); return; }
        void fetchDramaPlanningSource(dramaId).then((res) => {
            if (!alive) return;
            const source = String(res?.sourceScript || "");
            if (!source.trim()) { setChapterSource(""); return; }
            const { rows: chapterRows, groups } = splitSourceIntoEpisodes(source, {});
            const group = groups.find((g) => g.episodeNumber === ep.no);
            if (!group) { setChapterSource(""); return; }
            // groupSynopsis 产出「【章】标题\n正文」，去掉每行【章】标题，只留小说正文。
            const raw = groupSynopsis(chapterRows, group, 400000);
            const body = raw.split("\n").filter((line) => !/^\s*【章】/.test(line)).join("\n").trim();
            setChapterSource(body);
        }).catch(() => { if (alive) setChapterSource(""); });
        return () => { alive = false; };
    }, [dramaId, ep?.no, sourceUpdatedAt]);
    // 原文对照优先显示派生的章节原文；没有才回退分场正文（fullPlot）。绝不再用 synopsis（那是梗概）。
    const fullText = (chapterSource || String(ep.fullPlot || "").trim());
    const openEditSource = async () => {
        if (!dramaId) { message.warning("请先选择剧目"); return; }
        try {
            const res = await fetchDramaPlanningSource(dramaId);
            setSourceDraft(String(res.sourceScript || ""));
            setSourceUpdatedAt(String(res.updatedAt || ""));
            setEditSourceOpen(true);
        } catch (error) { message.error(`读取原文失败：${error instanceof Error ? error.message : String(error)}`); }
    };
    const saveSource = async () => {
        if (!dramaId || sourceSaving) return;
        setSourceSaving(true);
        try {
            const res = await patchDramaPlanningSource(dramaId, sourceDraft, sourceUpdatedAt || undefined);
            if (!res.ok) throw new Error("保存失败");
            setSourceUpdatedAt(String(res.updatedAt || ""));
            setEditSourceOpen(false);
            message.success("原文已保存");
            onChanged?.();
        } catch (error) { message.error(`保存原文失败：${error instanceof Error ? error.message : String(error)}`); }
        finally { setSourceSaving(false); }
    };
    const shots = rows(source.shots);
    const fps = Number(source.fps_num || 24) / Number(source.fps_den || 1) || 24;

    /** 写回单镜头：先读最新 revision 作乐观锁基线，再 patch_director_source（后端深合并 camera）。 */
    const patchShot = async (shotId: string, patch: Record<string, unknown>) => {
        if (!ep?.id) return;
        setSavingShot(true);
        try {
            const fresh = await fetchEpisodeProduction(ep.id as never);
            const revision = fresh.production?.revision ?? production?.revision ?? 0;
            const ops: ProductionOperation[] = [{ type: "patch_director_source", entity: "shot", id: shotId, patch }];
            await editEpisodeProduction(ep.id as never, revision, ops);
            message.success("镜头已保存，本段提示词与视频已标记为过期");
            onChanged?.();
        } catch (error) {
            message.error(`保存失败：${(error as Error).message}`);
        } finally {
            setSavingShot(false);
        }
    };

    return (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(300px,0.75fr)] gap-3 p-3" data-studio-panel="script">
            {/* 左：本集梗概 + 钩子/悬念 + 分镜规则 + 状态 */}
            <div className="min-w-0 space-y-3 overflow-y-auto pr-1">
                <ErrorBanner error={ep.error || ""} failed={ep.jobs.failed} />

                <section className="rounded-lg border border-border bg-card/60 p-4" data-studio-script-synopsis>
                    <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                        <BookOpen className="size-3.5 text-muted-foreground" /> 本集梗概
                        <span className="font-normal text-muted-foreground">素材：小说原文</span>
                        <div className="ml-auto flex items-center gap-3 text-[11px] font-normal text-muted-foreground">
                            <button type="button" onClick={onRescript} disabled={busy} className="flex items-center gap-1 transition hover:text-foreground disabled:opacity-50">
                                <RefreshCw className={cn("size-3", busy && "animate-spin")} /> 改编过程
                            </button>
                            <button type="button" onClick={onRescript} disabled={busy} className="flex items-center gap-1 transition hover:text-foreground disabled:opacity-50">
                                <Wand2 className="size-3" /> 重新改编
                            </button>
                        </div>
                    </div>
                    <p className="text-[13px] leading-6 text-foreground/90">
                        {d.synopsis || "尚无本集梗概。可在右侧编辑原文或改编过程生成。"}
                    </p>

                    {(d.hook || d.cliffhanger) ? (
                        <div className="mt-4 grid grid-cols-2 gap-2">
                            {d.hook ? (
                                <div className="rounded-md border border-border bg-background/60 p-2.5">
                                    <div className="mb-1 text-[11px] font-medium text-muted-foreground">开场钩子</div>
                                    <div className="text-xs leading-5">{d.hook}</div>
                                </div>
                            ) : null}
                            {d.cliffhanger ? (
                                <div className="rounded-md border border-border bg-background/60 p-2.5">
                                    <div className="mb-1 text-[11px] font-medium text-muted-foreground">结尾悬念</div>
                                    <div className="text-xs leading-5">{d.cliffhanger}</div>
                                </div>
                            ) : null}
                        </div>
                    ) : null}

                    <div className="mt-3 flex items-center gap-1.5 border-t border-border pt-2.5 text-[11px] text-muted-foreground">
                        <Clapperboard className="size-3" /> 分镜规则
                        <span>{d.rule} · 实际 {d.shotCount} 镜 · {d.totalSec} 秒</span>
                    </div>
                </section>

                {/* 按场次组织的镜头列表（对齐影策 ScriptView）：点镜头联动右侧原文定位 */}
                {sp.scenes.length ? (
                    <section className="rounded-lg border border-border bg-card/60 p-3" data-studio-script-screenplay>
                        <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                            <Clapperboard className="size-3.5 text-muted-foreground" /> 镜头列表
                            <span className="font-normal text-muted-foreground">按场次组织 · 点选镜头定位原文并原地编辑</span>
                        </div>
                        <div className="space-y-2">
                            {sp.scenes.map((scene) => (
                                <div key={`${scene.key}-${scene.no}`} className="overflow-hidden rounded-md border border-border">
                                    <div className="flex items-center gap-2 bg-muted/40 px-2.5 py-1.5 text-[11px]">
                                        <span className="font-semibold">场 {scene.no}</span>
                                        <span className="min-w-0 truncate text-muted-foreground" title={scene.name}>/ {scene.name}</span>
                                        <span className="ml-auto shrink-0 font-normal text-muted-foreground">{scene.shots.length}镜 · {Math.round(scene.sec)}秒</span>
                                    </div>
                                    <div className="divide-y divide-border">
                                        {scene.shots.map((shot) => {
                                            const isSelected = selectedShot === shot.id;
                                            return (
                                                <div key={shot.id} className={cn(isSelected && "bg-primary/10 ring-1 ring-inset ring-primary/30")}>
                                                    <div
                                                        role="button"
                                                        tabIndex={0}
                                                        aria-current={isSelected}
                                                        onClick={() => setSelectedShot(shot.id)}
                                                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedShot(shot.id); } }}
                                                        className="flex w-full cursor-pointer gap-2 px-2.5 py-2 text-left transition hover:bg-muted/50"
                                                        data-studio-script-shot={shot.id}
                                                    >
                                                        <span className="mt-0.5 shrink-0 font-mono text-[11px] font-semibold text-muted-foreground">{shot.no}</span>
                                                        <span className="min-w-0 flex-1">
                                                            <span className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                                                                {shot.framing ? <span className="rounded bg-muted px-1 py-0.5 font-medium" title={shot.framing}>{framingLabel(shot.framing)}</span> : null}
                                                                {shot.movement ? <span className="rounded bg-muted px-1 py-0.5">{shot.movement}</span> : null}
                                                                <span className="rounded bg-muted px-1 py-0.5">{shot.sec.toFixed(1)}s</span>
                                                                {shot.title ? <span className="min-w-0 truncate">{shot.title}</span> : null}
                                                            </span>
                                                            {shot.visual ? <span className="mt-1 block whitespace-pre-wrap text-[11px] leading-5 text-foreground/85">{shot.visual}</span> : null}
                                                            {shot.lines.length ? (
                                                                <span className="mt-1 block space-y-0.5">
                                                                    {shot.lines.map((ln, li) => (
                                                                        <span key={li} className="block text-[11px] leading-5 text-foreground/75">
                                                                            <Quote className="mr-1 inline size-3 align-[-2px] text-muted-foreground" />
                                                                            <span className="font-medium">{ln.speaker}：</span>{ln.text}
                                                                        </span>
                                                                    ))}
                                                                </span>
                                                            ) : null}
                                                        </span>
                                                        {!isSelected ? <Pencil className="mt-0.5 size-3 shrink-0 text-muted-foreground/60" /> : null}
                                                    </div>
                                                    {isSelected ? (
                                                        <div className="border-t border-primary/20 px-2.5 py-2" data-studio-shot-editor onClick={(e) => e.stopPropagation()}>
                                                            <ShotEditor
                                                                shot={shot}
                                                                fps={fps}
                                                                busy={savingShot}
                                                                onPatch={(patch) => void patchShot(shot.id, patch)}
                                                                onDone={() => setSelectedShot(null)}
                                                            />
                                                        </div>
                                                    ) : null}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>
                ) : null}

                {(!d.shotCount || d.synopsis === "") ? (
                    <section className="flex flex-col items-center rounded-lg border border-border bg-card/40 px-4 py-10 text-center">
                        <div className="mb-3 flex size-14 items-center justify-center rounded-full border border-border"><Film className="size-6 text-muted-foreground/50" /></div>
                        <div className="text-sm font-medium">本集剧本尚未编写成功</div>
                        <p className="mt-1.5 max-w-xs text-[11px] leading-5 text-muted-foreground">
                            {ep.error ? "失败原因见上方提示。可以直接重新改编本集，或在底部队列全部重试。" : "右侧可以先读本集对应的小说原文，确认后重新改编。"}
                        </p>
                        <button type="button" onClick={onRescript} disabled={busy} className="mt-4 flex h-8 items-center gap-1.5 rounded-md bg-foreground px-4 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-60">
                            {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                            {busy ? "改编中…" : "重新改编本集"}
                        </button>
                    </section>
                ) : null}
            </div>

            {/* 右：原文对照 */}
            <section className="flex min-h-0 flex-col rounded-lg border border-border bg-card/40" data-studio-script-source>
                <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-xs font-medium">
                    <BookOpen className="size-3.5 text-muted-foreground" /> 原文对照
                    <button type="button" onClick={() => void openEditSource()} className="ml-auto text-[11px] font-normal text-muted-foreground transition hover:text-foreground">编辑原文</button>
                </div>
                <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
                    <span>第 {ep.no} 段</span><span>{fullText.length.toLocaleString()} 字</span>
                    {selectedShot ? <span className="ml-auto text-rose-500">已定位镜头 {selectedShot}</span> : null}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
                    {fullText ? (
                        <p className="whitespace-pre-wrap text-[12px] leading-6 text-foreground/85">{fullText}</p>
                    ) : (
                        <div className="flex h-full items-center justify-center text-center text-xs text-muted-foreground">
                            本集暂无原文。可在分集中文「原文」字段补充。
                        </div>
                    )}
                </div>
                <div className="shrink-0 border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
                    点选左侧镜头，自动定位对应原文
                </div>
            </section>
            <Modal
                title="编辑原文"
                open={editSourceOpen}
                onCancel={() => setEditSourceOpen(false)}
                onOk={() => void saveSource()}
                okText={sourceSaving ? "保存中…" : "保存"}
                confirmLoading={sourceSaving}
                width={840}
                destroyOnClose
            >
                <p className="mb-2 text-xs text-muted-foreground">这里是本剧目的小说原文真值。修改后保存，之后重新改编本集剧本会使用新原文。</p>
                <Input.TextArea
                    value={sourceDraft}
                    onChange={(e) => setSourceDraft(e.target.value)}
                    autoSize={{ minRows: 18, maxRows: 30 }}
                    aria-label="原文正文"
                />
                <p className="mt-1 text-right text-[11px] text-muted-foreground">{sourceDraft.length.toLocaleString()} 字</p>
            </Modal>
        </div>
    );
}

function formatSec(sec: number): string {
    const s = Math.max(0, Math.round(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
/** 影策分镜段卡片时长用小数秒（11.8s），非 m:ss。 */
function formatClipSec(sec: number): string {
    return `${Math.max(0, Number(sec) || 0).toFixed(1)}s`;
}

/** 影策「分镜/board」页数据：统计条 + 剧情段卡片 + 参考图，全部从真实制作稿派生。 */
function boardData(production: EpisodeProduction | undefined) {
    const draft = (production?.draft || {}) as Record<string, unknown>;
    const director = (draft.director || {}) as Record<string, unknown>;
    const source = (director.source || {}) as Source;
    const shots = rows(source.shots);
    const segments = rows(source.segments);
    const artifacts = rows(director.artifacts);
    const h3ByTarget = new Map<string, Row>();
    for (const a of artifacts) if (str(a.kind) === "h3" && str(a.targetId)) h3ByTarget.set(str(a.targetId), a);
    const shotById = new Map<string, Row>();
    for (const sh of shots) if (str(sh.id)) shotById.set(str(sh.id), sh);
    const sceneName = new Map<string, string>();
    for (const sc of rows(source.scene_registry)) if (str(sc.id)) sceneName.set(str(sc.id), str(sc.name || sc.heading || sc.title));
    const fps = Number(source.fps_num || 24) / Number(source.fps_den || 1) || 24;
    const shotSec = (sh: Row) => framesToSec(sh.duration_frames || sh.durationMs, source);
    const totalSec = shots.reduce((s, sh) => s + shotSec(sh), 0);

    const cards = segments.map((seg, idx) => {
        const segId = str(seg.id);
        const ids = (Array.isArray(seg.shot_ids) ? seg.shot_ids : []).map(str).filter(Boolean);
        const segShots = ids.map(id => shotById.get(id)).filter(Boolean) as Row[];
        const shotsList = segShots.length ? segShots : shots.filter(sh => str(sh.segment_id) === segId);
        const art = h3ByTarget.get(segId);
        const prompt = str(art?.prompt || "");
        const refs = rows(art?.references);
        const thumbnails = refs.map((r, ri) => {
            const rawLabel = str(r.label);
            const ordinal = Number(rawLabel.match(/Picture\s*(\d+)/i)?.[1] || 0) || ri + 1;
            return {
                label: rawLabel.replace(/Picture\s*/i, "图"),
                storageKey: str(r.storageKey),
                url: str(r.storageKey) ? backendMediaUrl(str(r.storageKey)) : str(r.url),
                role: str(r.role),
                ordinal,
                roleKind: referenceKindOf(`${rawLabel} ${str(r.role)} ${str(r.name || "")}`),
            };
        });
        const hasVideo = Boolean(art && str(art.status) !== "stale" && (art.receipt || art.result));
        const sec = shotsList.reduce((s, sh) => s + shotSec(sh), 0);
        const first = shotsList[0];
        const scene = sceneName.get(str(first?.scene_id)) || "";
        const shotTitle = str(first?.title || "");
        const title = [scene, shotTitle].filter(Boolean).join(" / ") || str(seg.summary || seg.title || `第 ${idx + 1} 段`);
        return {
            id: segId, index: idx, title,
            prompt, mode: str(seg.mode || ""), shots: shotsList, sec, thumbnails, hasVideo,
            firstShot: first,
        };
    });
    const promptReady = cards.filter(c => c.prompt).length;
    const videoReady = cards.filter(c => c.hasVideo).length;
    return { shots, segments, cards, totalSec, promptReady, videoReady, fps };
}

function ShotsPanel({ ep, production, onRescript, onOpenCanvas, onSwitchToScript, onWriteSegmentPrompt, onSaveSegmentPrompt, onApproveVideo, onSwitchToAssets, busy }: {
    ep: StudioEpisode; production: EpisodeProduction | undefined;
    onRescript: () => void; onOpenCanvas: (segmentId?: string) => void; onSwitchToScript: () => void; busy: boolean;
    onWriteSegmentPrompt?: (segmentId: string) => Promise<{ text: string; warnings: string[] }>;
    onSaveSegmentPrompt?: (segmentId: string, text: string) => Promise<void>;
    onApproveVideo?: () => Promise<{ ok: boolean; missing: string[]; assetCount: number }>;
    onSwitchToAssets?: () => void;
}) {
    const { message } = App.useApp();
    const { cards, shots, segments, totalSec, promptReady, videoReady } = useMemo(() => boardData(production), [production]);
    const [active, setActive] = useState<string | null>(cards[0] ? cards[0].id : null);
    const [matrix, setMatrix] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [writingPrompt, setWritingPrompt] = useState<string | null>(null);
    const [approving, setApproving] = useState(false);
    const [promptResult, setPromptResult] = useState<{ text: string; warnings: string[] } | null>(null);
    // 影策「段编辑弹窗」：点「打开剧情段」进这里，不再只跳画布
    const [editIdx, setEditIdx] = useState<number | null>(null);
    const [editPrompt, setEditPrompt] = useState("");
    const [savingPrompt, setSavingPrompt] = useState(false);
    const promptCaret = useRef<{ start: number; end: number } | null>(null);
    /** 影策 @引用：点击彩色资产 chip 在光标处插入 <Picture N> token（视频生成实际按编号取图）。 */
    const insertRefToken = (ordinal: number) => {
        const token = `<Picture ${ordinal}>`;
        const text = editPrompt;
        const caret = promptCaret.current;
        const start = Math.min(caret?.start ?? text.length, text.length);
        const end = Math.min(caret?.end ?? text.length, text.length);
        const next = text.slice(0, start) + token + text.slice(end);
        setEditPrompt(next);
        promptCaret.current = { start: start + token.length, end: start + token.length };
    };
    if (!shots.length) {
        return (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center" data-studio-panel="shots">
                <div className="mb-4 flex size-20 items-center justify-center rounded-full border-4 border-muted"><Clapperboard className="size-8 text-muted-foreground/40" /></div>
                <h3 className="text-sm font-semibold">还没有分镜</h3>
                <p className="mt-2 max-w-sm text-xs leading-relaxed text-muted-foreground">
                    先在「剧本」页改编成功本集剧本，分镜表会随改编过程生成。也可以在精修画布里手动拆分镜头。
                </p>
            </div>
        );
    }

    const toggleSel = (id: string) => setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    const activeCard = cards.find(c => c.id === active) || cards[0];
    const handleWritePrompt = async (segmentId: string) => {
        if (!onWriteSegmentPrompt) return void message.warning("撰写入口尚未就绪");
        setWritingPrompt(segmentId);
        try {
            const result = await onWriteSegmentPrompt(segmentId);
            setPromptResult(result);
            if (result.warnings.length) message.warning(`提示词已写入，但有非法参考图引用：${result.warnings.join("、")}`);
            else message.success("提示词已撰写并写入画布，可直接生成视频");
        } catch (error) { message.error(`撰写失败：${(error as Error).message}`); }
        finally { setWritingPrompt(null); }
    };
    const handleSavePrompt = async () => {
        const card = cards[editIdx ?? -1];
        if (!card) return;
        if (!onSaveSegmentPrompt) return void message.warning("保存入口尚未就绪");
        setSavingPrompt(true);
        try {
            await onSaveSegmentPrompt(card.id, editPrompt);
            message.success("提示词已保存到画布 H3 段，生成视频将读取最新内容");
        } catch (error) { message.error(`保存失败：${(error as Error).message}`); }
        finally { setSavingPrompt(false); }
    };
    /** 影策「恢复模型版」：把模型生成的原版提示词（artifact.prompt）写回画布，清掉手动改写。 */
    const handleRestorePrompt = async () => {
        const card = cards[editIdx ?? -1];
        if (!card || !card.prompt) return void message.warning("本段没有模型原版提示词");
        if (!onSaveSegmentPrompt) return void message.warning("保存入口尚未就绪");
        setSavingPrompt(true);
        try {
            await onSaveSegmentPrompt(card.id, card.prompt);
            setEditPrompt(card.prompt);
            message.success("已恢复模型生成的原版提示词");
        } catch (error) { message.error(`恢复失败：${(error as Error).message}`); }
        finally { setSavingPrompt(false); }
    };
    const approval = (((production?.draft as Record<string, any> | undefined)?.director as Record<string, any> | undefined)?.workflow as Record<string, any> | undefined)?.reviewApproval as { approvedAt?: string; assetCount?: number } | undefined;
    const handleApprove = async () => {
        if (!onApproveVideo) return void onOpenCanvas();
        setApproving(true);
        try {
            const result = await onApproveVideo();
            if (!result.ok) {
                message.warning(`还有 ${result.missing.length} 项资产未生成参考图：${result.missing.slice(0, 4).join("、")}${result.missing.length > 4 ? "…" : ""}。请到「项目资产」先生成并锁定。`);
                onSwitchToAssets?.();
                return;
            }
            message.success("参考图已就绪，放行通过；即将在画布中按段生成视频");
            onOpenCanvas();
        } catch (error) { message.error(`放行失败：${(error as Error).message}`); }
        finally { setApproving(false); }
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col" data-studio-panel="shots">
            {/* 顶部状态提示（对齐影策：提示词就绪 / 等待确认生成视频） */}
            <div className="shrink-0 space-y-2 border-b border-border px-4 py-3">
                {videoReady === 0 ? (
                    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card/50 px-3 py-2">
                        <div className="min-w-0 flex-1">
                            <div className="text-xs font-medium">剧本与视频提示词已就绪，还没有生成视频</div>
                            <div className="mt-0.5 text-[11px] text-muted-foreground">先看看剧情、镜头拆分、设定和各段视频提示词是否合适；确认后再生成本集的参考图与段视频。</div>
                        </div>
                        <button type="button" onClick={onSwitchToScript} className="h-7 shrink-0 rounded-md border border-border px-2.5 text-[11px] hover:bg-muted/60">看剧本与原文</button>
                        <button type="button" onClick={() => void handleApprove()} disabled={approving || busy} className="h-7 shrink-0 rounded-md bg-primary px-2.5 text-[11px] text-primary-foreground hover:opacity-90 disabled:opacity-50" data-studio-approve-video>{approving ? "检查中…" : "放行并生成视频"}</button>
                    </div>
                ) : null}
                <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card/50 px-3 py-2" data-studio-review-gate>
                    <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium">
                            {approval?.approvedAt ? `已放行 · ${new Date(approval.approvedAt).toLocaleString("zh-CN", { hour12: false })}` : "参考图就绪后放行生成"}
                        </div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground">放行会核对本集资产参考图是否齐备；通过后打开画布按段生成视频（本地生成在画布内完成）。</div>
                    </div>
                    <button type="button" onClick={() => void handleApprove()} disabled={approving || busy} className="h-7 shrink-0 rounded-md bg-primary px-2.5 text-[11px] text-primary-foreground hover:opacity-90 disabled:opacity-50" data-studio-approve-video>
                        {approving ? "检查中…" : approval?.approvedAt ? "重新放行并打开画布" : "放行并生成视频"}
                    </button>
                </div>
                {/* 统计条 */}
                <div className="flex flex-wrap items-center gap-4 px-1 pt-1 text-xs">
                    <span><span className="font-semibold">{segments.length}</span> 段</span>
                    <span><span className="font-semibold">{shots.length}</span> 镜</span>
                    <span><span className="font-semibold">{formatSec(totalSec)}</span> 时长</span>
                    <span className="flex items-center gap-1">提示词 <span className="font-semibold text-emerald-500">{promptReady}/{segments.length}</span></span>
                    <span className="flex items-center gap-1">视频 <span className="font-semibold text-emerald-500">{videoReady}/{segments.length}</span></span>
                    <button type="button" aria-label="切换矩阵视图" onClick={() => setMatrix(v => !v)} className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted/60" title={matrix ? "列表视图" : "矩阵视图"}>
                        <Film className="size-4" />
                    </button>
                </div>
            </div>

            {/* 剧情段卡片列表（对齐影策 segment 卡片） */}
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3" aria-busy={busy}>
                {cards.map((c) => (
                    <section key={c.id} className={cn("rounded-lg border border-border bg-card/50 p-3", active === c.id && "ring-1 ring-primary/40")} aria-label={`第 ${c.index + 1} 段 ${c.title}`}>
                        <div className="flex items-center gap-2">
                            <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleSel(c.id)} aria-label={`选择第 ${c.index + 1} 段`} className="size-3.5 accent-primary" />
                            <span className="flex size-6 items-center justify-center rounded bg-muted text-[11px] font-semibold">{c.index + 1}</span>
                            <h4 className="min-w-0 flex-1 truncate text-xs font-medium" title={c.title}>{c.title}</h4>
                            {!c.prompt ? <AlertCircle className="size-3.5 shrink-0 text-amber-500" aria-label="缺少提示词" /> : null}
                            <button type="button" onClick={() => { setActive(c.id); setEditIdx(c.index); setEditPrompt(c.prompt || ""); }} className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/60" aria-label={`打开第 ${c.index + 1} 段`} data-studio-open-segment>
                                编辑段落 <ChevronRight className="size-3" />
                            </button>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                            <span className="rounded bg-muted px-1.5 py-0.5 font-medium">{formatClipSec(c.sec)}</span>
                            <span className={cn("rounded px-1.5 py-0.5", c.hasVideo ? "bg-emerald-500/10 text-emerald-500" : "bg-muted text-muted-foreground")}>{c.hasVideo ? "已生成视频" : "待生成视频"}</span>
                            <span className="text-muted-foreground">{c.shots.length} 镜 · 上限 15s{c.mode ? ` · ${c.mode}` : ""}</span>
                        </div>
                        {/* 参考图：首帧 + 图1..N（真实 storageKey） */}
                        {c.thumbnails.length ? (
                            <div className={cn("mt-2 grid gap-1.5", matrix ? "grid-cols-4 sm:grid-cols-6" : "grid-cols-6 sm:grid-cols-8")}>
                                {c.thumbnails.map((t, ti) => (
                                    <div key={ti} className="group relative aspect-video overflow-hidden rounded border border-border bg-muted/40" title={`${t.label} · ${t.role}`}>
                                        {t.url ? <img src={t.url} alt={t.label} className="size-full object-cover" loading="lazy" /> : <div className="flex size-full items-center justify-center border border-dashed border-amber-500/50 text-[9px] text-muted-foreground">{t.label}</div>}
                                        <span className="absolute bottom-0 left-0 right-0 truncate bg-black/60 px-1 text-[9px] text-white">{t.label}</span>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="mt-2 text-[11px] text-muted-foreground">本段尚未配置参考资产，可进入剧情段补充。</div>
                        )}
                        {/* 卡片底部操作条（对齐影策 segment 卡片：H3 展开流 + ▶ 生成，原地打开画布不跳转） */}
                        <div className="mt-2.5 flex items-center justify-between border-t border-border/60 pt-2">
                            <button type="button" onClick={() => { setActive(c.id); onOpenCanvas(); }}
                                className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground" data-studio-segment-style>
                                <Sparkles className="size-3" /> H3 展开流
                            </button>
                            <button type="button" onClick={() => void handleWritePrompt(c.id)} disabled={writingPrompt === c.id}
                                title="让文本模型按本段镜头/台词/参考图撰写完整视频提示词，写回画布（影策 prompts 阶段）"
                                className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-primary transition hover:bg-primary/10 disabled:opacity-50" data-studio-segment-write-prompt>
                                <Sparkles className="size-3" /> {writingPrompt === c.id ? "撰写中…" : "撰写提示词"}
                            </button>
                            <button type="button" onClick={() => { setSelected(new Set([c.id])); setActive(c.id); onOpenCanvas(c.id); }}
                                title="在画布中打开本段并按段生成视频（画布已定位到该段）"
                                className="flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition hover:opacity-90" data-studio-segment-generate>
                                <Play className="size-3" /> 生成
                            </button>
                        </div>
                    </section>
                ))}
                {selected.size ? (
                    <div className="sticky bottom-0 flex items-center gap-2 rounded-lg border border-primary/30 bg-card/90 px-3 py-2 text-xs backdrop-blur">
                        <span>已选 {selected.size} 段</span>
                        <button type="button" onClick={() => onOpenCanvas(cards.find((c) => selected.has(c.id))?.id)} title="在画布中打开并生成所选段（画布定位到第一段，其余段保持选中）" className="ml-auto h-7 rounded-md bg-primary px-2.5 text-[11px] text-primary-foreground">在画布中生成所选段</button>
                    </div>
                ) : null}
            </div>

            {/* 右：选中段的段提示词详情（保留原有信息，改从 artifact 取真实提示词） */}
            {activeCard ? (
                <div className="shrink-0 border-t border-border px-4 py-2" data-studio-shot-detail>
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <Link2 className="size-3" /> 第 {activeCard.index + 1} 段提示词（@引用资产）
                        <button type="button" onClick={onRescript} className="ml-auto flex items-center gap-1 hover:text-foreground"><Wand2 className="size-3" /> 重新编排</button>
                    </div>
                    <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-[11px] leading-5 text-muted-foreground">{activeCard.prompt || "（暂无提示词）"}</p>
                </div>
            ) : null}
            <Modal
                open={Boolean(promptResult)}
                onCancel={() => setPromptResult(null)}
                title="段视频提示词（已写入画布）"
                footer={<button type="button" onClick={() => setPromptResult(null)} className="h-8 rounded-md bg-primary px-3 text-xs text-primary-foreground">完成</button>}
                width={720}
            >
                <p className="mb-2 text-xs text-muted-foreground">由文本模型按本段镜头、台词与参考图撰写，已写回画布 H3 段的提示词，可直接用于生成视频。</p>
                <Input.TextArea value={promptResult?.text || ""} readOnly autoSize={{ minRows: 12, maxRows: 22 }} className="font-mono text-[11px]" data-studio-written-prompt />
                {promptResult?.warnings.length ? <p className="mt-2 text-xs text-amber-500">参考图告警：{promptResult.warnings.join("、")}</p> : null}
            </Modal>

            {/* 影策段编辑弹窗：镜头 / 提示词 / 参考图 / 生成入口（真实读写，数据均来自本段制作稿与画布） */}
            <Modal
                open={editIdx !== null}
                onCancel={() => setEditIdx(null)}
                width={1120}
                centered
                data-studio-segment-editor
                title={editIdx !== null && cards[editIdx] ? (
                    <span className="flex flex-wrap items-center gap-2 pr-8">
                        <span className="text-sm font-semibold">第 {editIdx + 1} 段 · {cards[editIdx].title}</span>
                        <span className="text-[11px] text-muted-foreground">{formatClipSec(cards[editIdx].sec)} · {cards[editIdx].shots.length} 镜 · {cards[editIdx].hasVideo ? "已生成视频" : "待生成视频"}</span>
                    </span>
                ) : "段编辑"}
                footer={
                    <div className="flex items-center justify-between">
                        <div className="flex gap-1">
                            <button type="button" disabled={editIdx === null || editIdx <= 0} onClick={() => { const i = (editIdx ?? 0) - 1; setEditIdx(i); setEditPrompt(cards[i]?.prompt || ""); }} className="h-8 rounded border border-border px-2 text-[11px] text-muted-foreground disabled:opacity-40">‹ 上一段</button>
                            <button type="button" disabled={editIdx === null || editIdx >= cards.length - 1} onClick={() => { const i = (editIdx ?? 0) + 1; setEditIdx(i); setEditPrompt(cards[i]?.prompt || ""); }} className="h-8 rounded border border-border px-2 text-[11px] text-muted-foreground disabled:opacity-40">下一段 ›</button>
                        </div>
                        <div className="flex gap-2">
                            <button type="button" onClick={() => setEditIdx(null)} className="h-8 rounded border border-border px-3 text-[11px] text-muted-foreground">关闭</button>
                            <button type="button" onClick={() => onOpenCanvas(cards[editIdx ?? -1]?.id)} className="h-8 rounded border border-border px-3 text-[11px] text-muted-foreground" data-studio-seg-to-canvas>在画布中精修</button>
                            <button type="button" disabled={savingPrompt} onClick={() => void handleSavePrompt()} className="h-8 rounded bg-primary px-3 text-[11px] font-medium text-primary-foreground disabled:opacity-50" data-studio-seg-save-prompt>{savingPrompt ? "保存中…" : "保存提示词"}</button>
                        </div>
                    </div>
                }
            >
                {editIdx !== null && cards[editIdx] ? (() => {
                    const c = cards[editIdx];
                    return (
                        <div className="grid gap-4 md:grid-cols-2">
                            <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                    <span className="text-xs font-semibold">完整视频提示词</span>
                                    <div className="flex gap-2">
                                        <button type="button" disabled={writingPrompt === c.id} onClick={() => void handleWritePrompt(c.id)} className="text-[11px] text-rose-500 hover:underline" data-studio-seg-rewrite>{writingPrompt === c.id ? "撰写中…" : "重新撰写"}</button>
                                        <button type="button" onClick={() => void navigator.clipboard.writeText(editPrompt).then(() => message.success("提示词已复制"))} className="text-[11px] text-muted-foreground hover:text-foreground" data-studio-seg-copy-prompt>复制提示词</button>
                                        <button type="button" disabled={savingPrompt || !c.prompt} onClick={() => void handleRestorePrompt()} className="text-[11px] text-muted-foreground hover:text-foreground" data-studio-seg-restore title="用模型生成的原版提示词覆盖当前手动改写">恢复模型版</button>
                                    </div>
                                </div>
                                <p className="text-[10px] text-muted-foreground">提示词写在画布 H3 段上，视频生成直接读这里；点「保存提示词」写回画布。点下方彩色资产可插入引用编号。</p>
                                {/* 影策 @引用资产条：角色蓝/场景绿/道具黄，点选插入 <Picture N>（对齐影策彩色引用语义，保留制作台真实保存链路）。 */}
                                {(() => {
                                    const seg = cards[editIdx ?? -1];
                                    const thumbs = seg?.thumbnails || [];
                                    if (!thumbs.length) return null;
                                    return (
                                        <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border/60 bg-muted/20 px-2 py-1.5" data-studio-ref-chips>
                                            <span className="mr-0.5 flex items-center gap-1 text-[10px] text-muted-foreground"><Link2 className="size-3" /> @引用</span>
                                            {thumbs.map((t: any, ti: number) => (
                                                <button
                                                    key={String(t.storageKey || ti)}
                                                    type="button"
                                                    title={`点击插入 <Picture ${t.ordinal}> · ${String(t.label || "")}`}
                                                    onClick={() => insertRefToken(Number(t.ordinal) || ti + 1)}
                                                    className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] transition hover:opacity-80 ${REF_KIND_STYLE[String(t.roleKind) as keyof typeof REF_KIND_STYLE] || REF_KIND_STYLE.other}`}
                                                    data-studio-ref-chip={String(t.ordinal)}
                                                >
                                                    {t.url ? <img src={t.url} alt="" className="size-3.5 rounded-sm object-cover" /> : null}
                                                    {String(t.label || `图${t.ordinal}`)}
                                                </button>
                                            ))}
                                        </div>
                                    );
                                })()}
                                <Input.TextArea
                                    value={editPrompt}
                                    onChange={(e) => { setEditPrompt(e.target.value); promptCaret.current = { start: e.target.selectionStart ?? e.target.value.length, end: e.target.selectionEnd ?? e.target.value.length }; }}
                                    onSelect={(e) => { const el = e.target as HTMLTextAreaElement; promptCaret.current = { start: el.selectionStart, end: el.selectionEnd }; }}
                                    autoSize={{ minRows: 16, maxRows: 26 }} className="font-mono text-[11px]" data-studio-seg-prompt-input />
                            </div>
                            <div className="space-y-3">
                                <div>
                                    <div className="mb-1 text-xs font-semibold">本段镜头（{c.shots.length}）</div>
                                    <div className="max-h-40 space-y-1 overflow-y-auto rounded border border-border p-2">
                                        {c.shots.map((sh: any, si: number) => (
                                            <div key={String(sh?.id || si)} className="rounded bg-muted/40 px-2 py-1 text-[11px]">
                                                <span className="font-medium">{si + 1}.</span> {String(sh?.visual || sh?.title || "（无画面描述）")}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                                <div>
                                    <div className="mb-1 flex items-center justify-between text-xs font-semibold">
                                        <span>本段参考图（{c.thumbnails.length}）</span>
                                        <button type="button" onClick={onSwitchToAssets} className="text-[11px] font-normal text-muted-foreground hover:text-foreground" data-studio-seg-assets>按集核查 →</button>
                                    </div>
                                    {c.thumbnails.length ? (
                                        <div className="grid grid-cols-4 gap-1.5">
                                            {c.thumbnails.map((t: any, ti: number) => (
                                                <div key={String(t.storageKey || ti)} className="overflow-hidden rounded border border-border" title={String(t.label || "")}>
                                                    {t.url ? <img src={t.url} alt={String(t.label || "参考图")} className="aspect-[3/4] w-full object-cover" /> : <div className="flex aspect-[3/4] items-center justify-center text-[10px] text-muted-foreground">—</div>}
                                                    <div className="truncate px-1 py-0.5 text-[9px] text-muted-foreground">{String(t.label || "")}</div>
                                                </div>
                                            ))}
                                        </div>
                                    ) : <p className="text-[11px] text-muted-foreground">本段暂无参考图，可在项目资产或画布中补充。</p>}
                                    {/* 影策 SegmentReceipt：生成依据回执——提示词引用了哪些参考图编号（纯前端计算，零后端） */}
                                    <div className="mt-2 rounded border border-border/60 bg-muted/30 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground" data-studio-seg-receipt>
                                        <span className="font-medium text-foreground">生成依据：</span>
                                        {(() => {
                                            const tokens = Array.from(new Set((editPrompt.match(/<Picture\s*\d+\s*>/gi) || []).map(s => s.replace(/\s+/g, " ").toLowerCase()))).sort();
                                            const used = tokens.length ? tokens.join("、") : "未显式引用编号（由提示词正文描述）";
                                            return `随请求发送 ${c.thumbnails.length} 张参考图；提示词引用：${used}。第 2 段起以上一段尾帧为锚帧。`;
                                        })()}
                                    </div>
                                </div>
                            </div>
                        </div>
                    );
                })() : null}
            </Modal>
        </div>
    );
}

/** 段时长：对齐影策小数秒格式（11.8s），非 m:ss。 */
function fmtDur(sec: number): string {
    const s = Math.max(0, Number(sec) || 0);
    return `${s.toFixed(1)}s`;
}

function FinalPanel({ ep, production, clipMedia, onCompose, onExportJianying, onOpenCanvas, busy }: {
    ep: StudioEpisode; production: EpisodeProduction | undefined; clipMedia: StudioClipMedia[];
    onCompose: () => void; onExportJianying: () => void; onOpenCanvas: () => void; busy: boolean;
}) {
    const source = useMemo(() => sourceOf(production), [production]);
    const segments = rows(source.segments);
    const finalResource = (((production?.draft as Record<string, any> | undefined)?.director as Record<string, any> | undefined)?.workflow as Record<string, any> | undefined)?.finalResource as { storageKey?: string; at?: string } | undefined;
    const totalSec = segments.reduce((s, seg) => s + framesToSec(seg.duration_frames, source), 0);
    const clips = clipMedia.filter((c) => c.storageKey.startsWith("video:"));
    const [activeClip, setActiveClip] = useState(0);
    const videoRef = useRef<HTMLVideoElement>(null);
    const readyClips = clips.filter((c) => c.status === "success" || !c.status).length;
    const current = clips[activeClip];

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-4 p-4" data-studio-panel="final">
            <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.2fr)_minmax(260px,0.6fr)] gap-5">
                <div className="flex min-w-0 flex-col gap-3">
                    <div className="flex min-w-0 flex-1 items-center justify-center">
                        <div className="flex aspect-video w-full max-w-2xl items-center justify-center overflow-hidden rounded-xl bg-black shadow-sm" data-studio-player>
                            {current ? (
                                <video
                                    key={`${current.id}:${current.storageKey}`}
                                    ref={videoRef}
                                    src={backendMediaUrl(current.storageKey)}
                                    controls
                                    preload="metadata"
                                    className="size-full object-contain"
                                    onError={() => void 0}
                                />
                            ) : (
                                <div className="text-center text-white/40"><Film className="mx-auto size-10" /><p className="mt-2 text-xs">成片尚未生成</p></div>
                            )}
                        </div>
                    </div>
                    {/* 胶片条：真实片段（可点击跳转/切换） */}
                    {clips.length ? (
                        <div className="flex shrink-0 gap-2 overflow-x-auto rounded-lg border border-border bg-card/40 p-2" data-studio-filmstrip>
                            {clips.map((c, i) => (
                                <button key={`${c.id}:${i}`} type="button" onClick={() => { setActiveClip(i); if (videoRef.current) videoRef.current.currentTime = 0; }}
                                    className={`flex shrink-0 flex-col gap-1 rounded-md border p-1 text-left transition ${i === activeClip ? "border-primary bg-accent/40" : "border-border hover:bg-muted/50"}`}
                                    title={`${c.title} · ${fmtDur(c.duration)}${c.inputOutdated ? " · 输入已更改" : ""}`}>
                                    <video src={backendMediaUrl(c.storageKey)} preload="metadata" muted className="h-12 w-20 rounded bg-black object-cover" />
                                    <span className="max-w-20 truncate text-[10px] text-muted-foreground">第 {i + 1} 段 · {fmtDur(c.duration)}</span>
                                </button>
                            ))}
                        </div>
                    ) : null}
                </div>
                <div className="space-y-3">
                    <div className="rounded-lg border border-border bg-card/50 p-4 text-xs">
                        <div className="text-sm font-semibold">第 {ep.no} 集 · {ep.title}</div>
                        <div className="mt-2 rounded-md bg-muted/50 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground" data-studio-final-status>
                            {finalResource?.storageKey
                                ? `成片已合成 · ${finalResource.at ? new Date(finalResource.at).toLocaleString("zh-CN", { hour12: false }) : ""} · 可独立下载`
                                : clips.length && readyClips === clips.length
                                    ? "全部段视频已生成 · 可点「合成成品」生成集成片"
                                    : "等待段视频生成 · 全部就绪后可合成成片"}
                        </div>
                        <div className="mt-2 text-muted-foreground">{Math.round(totalSec)}秒 · {segments.length} 个剧情段 · {clips.length} 个片段</div>
                        {clips.length ? <div className="mt-1 text-muted-foreground">已生成 {readyClips}/{clips.length} 段视频 · 点击胶片条切换</div> : null}
                        <div className="mt-1 text-muted-foreground">对白与音效来自视频模型</div>
                    </div>
                    <button type="button" onClick={() => onOpenCanvas()} className="flex h-9 w-full items-center justify-center gap-2 rounded-md bg-foreground text-xs font-medium text-background transition hover:opacity-90">
                        <Video className="size-3.5" /> 在画布中打开本集
                    </button>
                    <button type="button" onClick={onCompose} disabled={busy} className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-border text-xs transition hover:bg-muted disabled:opacity-50">
                        {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Film className="size-3.5" />} 合成成品
                    </button>
                    <button type="button" disabled={!finalResource?.storageKey}
                        onClick={() => { if (finalResource?.storageKey) { const a = document.createElement("a"); a.href = backendMediaUrl(finalResource.storageKey); a.download = `${ep.title || "成片"}-成片.mp4`; document.body.appendChild(a); a.click(); a.remove(); } }}
                        className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-primary/40 bg-primary/5 text-xs text-primary transition hover:bg-primary/10 disabled:opacity-40" data-studio-download-final>
                        <Download className="size-3.5" /> 下载成片{finalResource?.storageKey ? "" : "（先合成）"}
                    </button>
                    <button type="button" disabled={!current} onClick={() => { if (current) window.open(backendMediaUrl(current.storageKey), "_blank"); }} className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-border text-xs text-muted-foreground transition hover:bg-muted disabled:opacity-40">
                        <Download className="size-3.5" /> 下载当前片段
                    </button>
                    <button type="button" onClick={onExportJianying} className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-border text-xs text-muted-foreground transition hover:bg-muted">
                        <Scissors className="size-3.5" /> 导出剪映草稿
                    </button>
                </div>
            </div>
        </div>
    );
}

export type DetailTab = "story" | "shots" | "clips";

export function StudioDetailPanel({ tab, episode, production, clipMedia, dramaId, onRescript, onCompose, onExportJianying, onOpenCanvas, onSwitchToScript, onWriteSegmentPrompt, onSaveSegmentPrompt, onApproveVideo, onSwitchToAssets, onChanged, busy }: {
    tab: DetailTab;
    episode: StudioEpisode;
    production: EpisodeProduction | undefined;
    clipMedia: StudioClipMedia[];
    dramaId?: string | null;
    onRescript: () => void;
    onCompose: () => void;
    onExportJianying: () => void;
    onOpenCanvas: (segmentId?: string) => void;
    onSwitchToScript: () => void;
    onWriteSegmentPrompt?: (segmentId: string) => Promise<{ text: string; warnings: string[] }>;
    onSaveSegmentPrompt?: (segmentId: string, text: string) => Promise<void>;
    onApproveVideo?: () => Promise<{ ok: boolean; missing: string[]; assetCount: number }>;
    onSwitchToAssets?: () => void;
    onChanged?: () => void;
    busy: boolean;
}) {
    if (tab === "story") return <ScriptPanel ep={episode} production={production} dramaId={dramaId} onRescript={onRescript} onChanged={onChanged} busy={busy} />;
    if (tab === "shots") return <ShotsPanel ep={episode} production={production} onRescript={onRescript} onOpenCanvas={onOpenCanvas} onSwitchToScript={onSwitchToScript} onWriteSegmentPrompt={onWriteSegmentPrompt} onSaveSegmentPrompt={onSaveSegmentPrompt} onApproveVideo={onApproveVideo} onSwitchToAssets={onSwitchToAssets} busy={busy} />;
    return <FinalPanel ep={episode} production={production} clipMedia={clipMedia} onCompose={onCompose} onExportJianying={onExportJianying} onOpenCanvas={onOpenCanvas} busy={busy} />;
}
