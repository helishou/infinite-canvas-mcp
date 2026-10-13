import { useEffect, useRef, useState } from "react";
import { Button, Input, InputNumber } from "antd";
import { Plus, Trash2, Volume2 } from "lucide-react";
import { useTranslation } from "react-i18next";

// A 类补齐：源稿结构化声音字段（shots[].audio.foley / low_frequency_hz / no_low_frequency_reason）
// 此前前端完全不可见——v2「声音」标签页的文本框只覆盖自由描述，逐条拟音与低频约束无法编辑。
type AudioObject = Record<string, any>;
const readAudio = (value: unknown): AudioObject => (value && typeof value === "object" && !Array.isArray(value) ? value as AudioObject : {});
const cueTexts = (audio: AudioObject): string[] => Array.isArray(audio.foley) ? audio.foley.map(item => typeof item === "string" ? item : JSON.stringify(item)) : [];
const reasonOf = (audio: AudioObject): string => String(audio.no_low_frequency_reason || "");
const hzOf = (audio: AudioObject): number | null | undefined => typeof audio.low_frequency_hz === "number" ? audio.low_frequency_hz : undefined;
const nextAudioFrom = (base: unknown, cues: string[], hz: number | null | undefined, reason: string): AudioObject => ({ ...readAudio(base), foley: cues.filter(text => text.trim()), low_frequency_hz: hz ?? null, no_low_frequency_reason: reason });

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
    const [reason, setReason] = useState(() => reasonOf(source));
    const [saving, setSaving] = useState(false);
    // 外部源稿更新（他人保存、重新加载）后把本地草稿同步回去，避免旧值覆盖新源。
    const sourceSnapshot = useRef(JSON.stringify(source));
    useEffect(() => {
        const now = JSON.stringify(readAudio(value));
        if (now !== sourceSnapshot.current) { setCues(cueTexts(readAudio(value))); setHz(hzOf(readAudio(value))); setReason(reasonOf(readAudio(value))); sourceSnapshot.current = now; }
    }, [value]);
    const dirty = JSON.stringify(cues) !== JSON.stringify(cueTexts(source)) || JSON.stringify(hz ?? null) !== JSON.stringify(hzOf(source) ?? null) || reason !== reasonOf(source);
    const applyChange = (patch: { cues?: string[]; hz?: number | null | undefined; reason?: string }) => {
        const nextCues = patch.cues ?? cues, nextHz = patch.hz === undefined ? hz : patch.hz, nextReason = patch.reason === undefined ? reason : patch.reason;
        if (onChange) { onChange(nextAudioFrom(value, nextCues, nextHz, nextReason)); return; }
        if (patch.cues !== undefined) setCues(patch.cues);
        if (patch.hz !== undefined) setHz(patch.hz);
        if (patch.reason !== undefined) setReason(patch.reason);
    };
    const resetToSource = () => { setCues(cueTexts(source)); setHz(hzOf(source)); setReason(reasonOf(source)); };
    const persist = async () => { if (!onPersist || saving) return; setSaving(true); try { const saved = await onPersist(nextAudioFrom(value, cues, hz, reason)); if (!saved) resetToSource(); } finally { setSaving(false); } };
    return <div className="space-y-3">
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Volume2 className="size-3.5" />{t("director.atomic.soundDesign")}</p>
        {cues.map((cue, index) => <div key={index} className="flex gap-2"><Input value={cue} aria-label={t("director.atomic.foleyCue", { count: index + 1 })} placeholder={t("director.atomic.foleyCuePlaceholder")} disabled={disabled} onChange={event => applyChange({ cues: cues.map((item, i) => i === index ? event.target.value : item) })} /><Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} aria-label={t("common.remove")} disabled={disabled} onClick={() => applyChange({ cues: cues.filter((_, i) => i !== index) })}>{t("common.remove")}</Button></div>)}
        <Button size="small" icon={<Plus className="size-3.5" />} disabled={disabled} onClick={() => applyChange({ cues: [...cues, ""] })}>{t("director.atomic.addFoleyCue")}</Button>
        <div className="grid gap-2 sm:grid-cols-[140px_minmax(0,1fr)]">
            <label className="grid gap-1 text-xs text-muted-foreground"><span>{t("director.atomic.lowFrequencyHz")}</span><InputNumber className="w-full" min={1} max={200} precision={0} value={hz} disabled={disabled} placeholder="—" onChange={next => applyChange({ hz: next ?? null })} /></label>
            <label className="grid gap-1 text-xs text-muted-foreground"><span>{t("director.atomic.noLowFrequencyReason")}</span><Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} value={reason} disabled={disabled} onChange={event => applyChange({ reason: event.target.value })} /></label>
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
