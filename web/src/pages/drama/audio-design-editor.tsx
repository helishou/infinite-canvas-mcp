import { useEffect, useRef, useState } from "react";
import { Button, Input, InputNumber, Select } from "antd";
import { Plus, Trash2, Volume2 } from "lucide-react";
import { useTranslation } from "react-i18next";

// Shot-level foley cues and optional low-frequency limit.
// 此前前端完全不可见——v2「声音」标签页的文本框只覆盖自由描述，逐条拟音与低频约束无法编辑。
type AudioObject = Record<string, any>;
const readAudio = (value: unknown): AudioObject => (value && typeof value === "object" && !Array.isArray(value) ? value as AudioObject : {});
const cueTexts = (audio: AudioObject): string[] => Array.isArray(audio.foley) ? audio.foley.map(item => typeof item === "string" ? item : JSON.stringify(item)) : [];
const hzOf = (audio: AudioObject): number | null | undefined => typeof audio.low_frequency_hz === "number" ? audio.low_frequency_hz : undefined;
const nextAudioFrom = (base: unknown, cues: string[], hz: number | null | undefined, keepPendingEmpty = false): AudioObject => {
    // 标注为 AudioObject：把 Record<string,any> 展开进对象字面量时 TS 会丢掉索引签名，
    // 不标注的话 next 被收窄成 {foley, low_frequency_hz}，下面的 delete 和返回类型都站不住。
    const next: AudioObject = { ...readAudio(base), foley: keepPendingEmpty ? cues : cues.filter(text => text.trim()), low_frequency_hz: hz ?? null };
    delete next.no_low_frequency_reason;
    return next;
};

type Props = {
    value: unknown;
    disabled: boolean;
    /** 受控模式：每次改动直接写回父级草稿（SubjectShotEditor 整表单保存流），不显示自己的保存按钮。 */
    onChange?: (next: AudioObject) => void;
    /** 就地保存模式：点保存时才提交；返回 false 时内部回滚（ShotSourceFields 流程）。 */
    onPersist?: (next: AudioObject) => Promise<boolean>;
};

export function AudioDesignEditor({ value, disabled, onChange, onPersist }: Props) {
    const { t } = useTranslation();
    const source = readAudio(value);
    const [cues, setCues] = useState(() => cueTexts(source));
    const [hz, setHz] = useState<number | null | undefined>(() => hzOf(source));
    const [saving, setSaving] = useState(false);
    // 外部源稿更新（他人保存、重新加载）后把本地草稿同步回去，避免旧值覆盖新源。
    const sourceSnapshot = useRef(JSON.stringify(source));
    useEffect(() => {
        const now = JSON.stringify(readAudio(value));
        if (now !== sourceSnapshot.current) { setCues(cueTexts(readAudio(value))); setHz(hzOf(readAudio(value))); sourceSnapshot.current = now; }
    }, [value]);
    const dirty = JSON.stringify(cues) !== JSON.stringify(cueTexts(source)) || JSON.stringify(hz ?? null) !== JSON.stringify(hzOf(source) ?? null);
    const applyChange = (patch: { cues?: string[]; hz?: number | null | undefined }) => {
        const nextCues = patch.cues ?? cues, nextHz = patch.hz === undefined ? hz : patch.hz;
        if (onChange) {
            // 受控模式也要保留编辑期空槽位并同步本地草稿：否则新增的空串会被 filter 掉，父级判定"无变化"直接重置，按钮看起来完全没反应。
            onChange(nextAudioFrom(value, nextCues, nextHz, true));
            if (patch.cues !== undefined) setCues(patch.cues);
            if (patch.hz !== undefined) setHz(patch.hz);
            return;
        }
        if (patch.cues !== undefined) setCues(patch.cues);
        if (patch.hz !== undefined) setHz(patch.hz);
    };
    const resetToSource = () => { setCues(cueTexts(source)); setHz(hzOf(source)); };
    const persist = async () => { if (!onPersist || saving) return; setSaving(true); try { const saved = await onPersist(nextAudioFrom(value, cues, hz)); if (!saved) resetToSource(); } finally { setSaving(false); } };
    return <div className="space-y-3">
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Volume2 className="size-3.5" />{t("director.atomic.soundDesign")}</p>
        {cues.map((cue, index) => <div key={index} className="flex gap-2"><Input value={cue} aria-label={t("director.atomic.foleyCue", { count: index + 1 })} placeholder={t("director.atomic.foleyCuePlaceholder")} disabled={disabled} onChange={event => applyChange({ cues: cues.map((item, i) => i === index ? event.target.value : item) })} /><Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} aria-label={t("common.remove")} disabled={disabled} onClick={() => applyChange({ cues: cues.filter((_, i) => i !== index) })}>{t("common.remove")}</Button></div>)}
        <Button size="small" icon={<Plus className="size-3.5" />} disabled={disabled} onClick={() => applyChange({ cues: [...cues, ""] })}>{t("director.atomic.addFoleyCue")}</Button>
        <div className="grid gap-2 sm:grid-cols-[140px]">
            <label className="grid gap-1 text-xs text-muted-foreground"><span>{t("director.atomic.lowFrequencyHz")}</span><InputNumber className="w-full" min={1} max={200} precision={0} value={hz} disabled={disabled} placeholder="—" onChange={next => applyChange({ hz: next ?? null })} /></label>
        </div>
        {onPersist && <div className="flex items-center gap-2">{dirty && <span className="text-xs text-amber-600">{t("director.studio.unsavedText")}</span>}<Button type="primary" size="small" loading={saving} disabled={disabled || !dirty} onClick={() => void persist()}>{t("director.atomic.saveAudio")}</Button>{dirty && <Button size="small" type="text" disabled={disabled} onClick={resetToSource}>{t("common.cancel")}</Button>}</div>}
    </div>;
}

// 资产卡 im2 七步法与参考引用（asset_cards[].seven_steps / references）：契约可 patch，UI 原先缺失。
// 非字符串参考条目只允许整体移除（结构未知，不代写）；步骤在保存时按当前顺序重新编号。
export function SevenStepsReferencesEditor({ card, disabled, onSave }: { card: Record<string, any>; disabled: boolean; onSave: (patch: { seven_steps: Array<{ step: number; content: string }>; references: unknown[] }) => Promise<boolean> | boolean | void }) {
    const { t } = useTranslation();
    const initialSteps = Array.isArray(card.seven_steps) ? card.seven_steps.map(item => String(item && typeof item === "object" ? item.content || "" : typeof item === "string" ? item : "")) : [];
    const initialRefs = Array.isArray(card.references) ? card.references : [];
    const stringRefs = initialRefs.filter(item => typeof item === "string") as string[];
    const objectRefs = initialRefs.filter(item => typeof item !== "string");
    const [contents, setContents] = useState(initialSteps);
    const [refTexts, setRefTexts] = useState(stringRefs);
    const [droppedObjects, setDroppedObjects] = useState<number[]>([]);
    const [saving, setSaving] = useState(false);
    const dirty = contents.some((item, index) => item !== (initialSteps[index] ?? "")) || contents.length !== initialSteps.length || refTexts.some((item, index) => item !== (stringRefs[index] ?? "")) || refTexts.length !== stringRefs.length || droppedObjects.length > 0;
    const reset = () => { setContents(initialSteps); setRefTexts(stringRefs); setDroppedObjects([]); };
    const save = async () => { if (saving) return; setSaving(true); try { const saved = await onSave({ seven_steps: contents.filter(content => content.trim()).map((content, index) => ({ step: index + 1, content })), references: [...refTexts.filter(text => text.trim()), ...objectRefs.filter((_, index) => !droppedObjects.includes(index))] }); if (!saved) reset(); } catch { /* 错误由上层 Alert 呈现；本地草稿保留待重试 */ } finally { setSaving(false); } };
    return <div className="space-y-4">
        <div className="space-y-2">{contents.map((content, index) => <div key={index} className="flex gap-2"><Input value={content} aria-label={t("director.crud.stepContent", { step: index + 1 })} placeholder={t("director.crud.stepContentPlaceholder", { step: index + 1 })} disabled={disabled} onChange={event => setContents(current => current.map((item, i) => i === index ? event.target.value : item))} /><Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} aria-label={t("common.remove")} disabled={disabled} onClick={() => setContents(current => current.filter((_, i) => i !== index))}>{t("common.remove")}</Button></div>)}<Button size="small" icon={<Plus className="size-3.5" />} disabled={disabled} onClick={() => setContents(current => [...current, ""])}>{t("director.crud.addStep")}</Button></div>
        <div className="space-y-2">
            {refTexts.map((text, index) => <div key={`text:${index}`} className="flex gap-2"><Input value={text} aria-label={t("director.crud.referenceItem")} placeholder={t("director.crud.referenceItemPlaceholder")} disabled={disabled} onChange={event => setRefTexts(current => current.map((item, i) => i === index ? event.target.value : item))} /><Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} aria-label={t("common.remove")} disabled={disabled} onClick={() => setRefTexts(current => current.filter((_, i) => i !== index))}>{t("common.remove")}</Button></div>)}
            {objectRefs.map((item, index) => <div key={`obj:${index}`} className="flex items-center gap-2 rounded border border-border px-2 py-1 text-xs text-muted-foreground" aria-hidden={droppedObjects.includes(index)}><span className="min-w-0 truncate">{JSON.stringify(item)}</span><Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} aria-label={t("common.remove")} disabled={disabled} onClick={() => setDroppedObjects(current => [...current, index])} /></div>)}
            <Button size="small" icon={<Plus className="size-3.5" />} disabled={disabled} onClick={() => setRefTexts(current => [...current, ""])}>{t("director.crud.addReference")}</Button>
        </div>
        <div className="flex items-center gap-2">{dirty && <span className="text-xs text-amber-600">{t("director.studio.unsavedText")}</span>}<Button type="primary" size="small" loading={saving} disabled={disabled || !dirty} onClick={() => void save()}>{t("director.crud.saveCardDetails")}</Button></div>
    </div>;
}

// B 类补齐：Clip 级精确音频绑定（segments[].audio_bindings）。新增只能从制作画布已归档的音频源里选
// （_canvas_subject_audio_sources 注册表给出 storageKey/sha256/nodeId，mimeType 按扩展名派生），
// 手写存储键会绕过哈希校验，所以不让用户自由填。
export type AudioSourceEntry = { nodeId?: string; storageKey?: string; sha256?: string; file?: string };
const audioMimeFrom = (file: string): string | undefined => /\.wav$/i.test(file) ? "audio/wav" : /\.ogg$/i.test(file) || /\.oga$/i.test(file) ? "audio/ogg" : /\.flac$/i.test(file) ? "audio/flac" : /\.m4a$/i.test(file) ? "audio/mp4" : /\.aac$/i.test(file) ? "audio/aac" : /\.webm$/i.test(file) ? "audio/webm" : /\.opus$/i.test(file) ? "audio/opus" : /\.(mp3|mpga)$/i.test(file) ? "audio/mpeg" : undefined;

export function SegmentAudioBindingEditor({ bindings, shots, sources, projectId, disabled, onPersist }: {
    bindings: Array<Record<string, any>>;
    shots: string[];
    sources: Record<string, AudioSourceEntry>;
    projectId: string;
    disabled: boolean;
    onPersist: (next: Array<Record<string, unknown>>) => Promise<boolean>;
}) {
    const { t } = useTranslation();
    const sourceIds = Object.entries(sources).filter(([, source]) => Boolean(source.nodeId && source.storageKey && source.sha256 && audioMimeFrom(source.file || ""))).map(([id]) => id);
    const [nodeId, setNodeId] = useState("");
    const [label, setLabel] = useState("");
    const [role, setRole] = useState("source_audio");
    const [shotIds, setShotIds] = useState<string[]>([]);
    const [saving, setSaving] = useState(false);
    useEffect(() => { setShotIds(shots); }, [JSON.stringify(shots)]);
    const persist = (next: Array<Record<string, unknown>>) => (async () => { setSaving(true); try { return await onPersist(next); } catch { return false; } finally { setSaving(false); } })();
    return <div className="space-y-2">
        {bindings.map(binding => {
            const meta = sources[String(binding.id)];
            return <div key={String(binding.id)} className="grid gap-2 rounded border border-border px-2 py-2 text-xs md:grid-cols-[minmax(0,1fr)_minmax(150px,0.8fr)_auto]">
                <div className="grid min-w-0 gap-1 md:grid-cols-2"><Input size="small" aria-label={t("director.workspace.audioBindingLabel")} defaultValue={String(binding.label || "")} disabled={disabled || saving} onBlur={event => { const value = event.target.value.trim(); if (value && value !== binding.label) void persist(bindings.map(item => String(item.id) === String(binding.id) ? { ...item, label: value } : item)); }} /><Input size="small" aria-label={t("director.workspace.audioBindingRole")} defaultValue={String(binding.role || "")} disabled={disabled || saving} onBlur={event => { const value = event.target.value.trim(); if (value && value !== binding.role) void persist(bindings.map(item => String(item.id) === String(binding.id) ? { ...item, role: value } : item)); }} /><span className="col-span-full truncate text-muted-foreground">{meta?.file ? meta.file.split(/[\\/]/).pop() : String(binding.sourceNode?.nodeId || "")}</span></div>
                <Select size="small" mode="multiple" value={Array.isArray(binding.shotIds) ? binding.shotIds.map(String) : []} disabled={disabled || saving} placeholder={t("director.workspace.pickBoundShots")} options={shots.map(id => ({ value: id, label: id }))} onChange={ids => void persist(bindings.map(item => String(item.id) === String(binding.id) ? { ...item, shotIds: ids } : item))} />
                <Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} aria-label={t("common.remove")} disabled={disabled || saving} onClick={() => void persist(bindings.filter(item => String(item.id) !== String(binding.id)))} />
            </div>;
        })}
        {sourceIds.length ? <div className="flex flex-wrap items-end gap-2">
            <Select size="small" className="min-w-40 flex-1" value={nodeId || undefined} placeholder={t("director.workspace.pickAudioSource")} options={sourceIds.map(id => ({ value: id, label: `${id} · ${(sources[id].file || "").split(/[\\/]/).pop()}` }))} onChange={setNodeId} />
            <Input size="small" className="w-28" value={label} placeholder={`<Audio ${bindings.length + 1}>`} onChange={event => setLabel(event.target.value)} />
            <Input size="small" className="w-28" value={role} placeholder="source_audio" onChange={event => setRole(event.target.value)} />
            <Select size="small" mode="multiple" className="min-w-36 max-w-56" value={shotIds} placeholder={t("director.workspace.pickBoundShots")} options={shots.map(id => ({ value: id, label: id }))} onChange={setShotIds} />
            <Button size="small" icon={<Plus className="size-3.5" />} loading={saving} disabled={disabled || !nodeId || !shotIds.length} onClick={() => { const source = sources[nodeId]; const mimeType = audioMimeFrom(String(source?.file || "")); if (!source || !mimeType) return; void (async () => { const ok = await persist([...bindings, { id: `AUD-UI-${Date.now()}`, label: label.trim() || `<Audio ${bindings.length + 1}>`, sourceNode: { projectId, nodeId: String(source.nodeId || nodeId) }, storageKey: String(source.storageKey || ""), sha256: String(source.sha256 || ""), role: role.trim() || "source_audio", shotIds, mimeType }]); if (ok) { setNodeId(""); setLabel(""); setRole("source_audio"); } })(); }}>{t("director.workspace.addAudioBinding")}</Button>
        </div> : <p className="text-xs text-muted-foreground">{t("director.workspace.noArchivedAudio")}</p>}
    </div>;
}
