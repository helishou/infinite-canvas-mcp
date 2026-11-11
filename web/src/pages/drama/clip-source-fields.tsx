import { useRef, useState, type ReactNode } from "react";
import { Alert, Button, Input, InputNumber, Switch } from "antd";
import { AlignLeft, AudioLines, Check, Layers, Move, Music2, Pencil } from "lucide-react";
import { useTranslation } from "react-i18next";
import { draftFieldConflicts, mergeDraftFields } from "./draft-field-merge";
import "./clip-source-fields.css";

const TEXT_FIELDS = ["summary", "overall_soundscape", "non_diegetic_music"] as const;
const META_FIELDS = new Set<string>([...TEXT_FIELDS, "id", "shot_ids", "mode", "mode_lock", "styleTemplateId", "locked", "preLockNoiseSeedMode", "start_frame", "end_frame", "duration", "duration_frames", "generation_clip_duration"]);
const REQUIREMENT_ORDER = ["motion_profile", "audio", "sound", "audio_bindings", "references", "subjects", "execution_gate"];
const SYNCED_MODE_REASON = "Synchronized from the authoritative H3 Clip taskMode.";
const objectValue = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const textValue = (value: unknown): string => value == null ? "" : typeof value === "string" ? value : JSON.stringify(value) ?? "";

/** Paragraph breaks are a reading aid; the saved source text is kept verbatim. */
function ClipProse({ text, empty }: { text: string; empty: string }) {
    if (!text) return <p className="clip-content-empty">{empty}</p>;
    const paragraphs = text.split(/\n+|(?<=[。])\s*(?=\[STAGE\]|(?:场地|站位|累积破坏|推进向量|硬约束|空间锚|转场规则)[（:：])/u).filter(Boolean);
    return <div className="clip-content-prose">{paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>;
}

function ClipValue({ value, labelFor, names, empty }: { value: unknown; labelFor: (key: string) => string; names: Record<string, string>; empty: string }) {
    if (value == null || value === "" || (Array.isArray(value) && !value.length)) return <span className="clip-content-empty">{empty}</span>;
    if (Array.isArray(value)) return <ul className="clip-value-list">{value.map((item, index) => <li key={index}><ClipValue value={item} labelFor={labelFor} names={names} empty={empty} /></li>)}</ul>;
    if (objectValue(value)) return <dl className="clip-requirement-grid">{Object.entries(value).map(([key, item]) => <div key={key} className="clip-requirement-item"><dt>{labelFor(key)}</dt><dd><ClipValue value={item} labelFor={labelFor} names={names} empty={empty} /></dd></div>)}</dl>;
    return <span className="clip-value-text">{names[String(value)] || String(value)}</span>;
}

/** Existing structured values are edited through labelled controls, retaining their original types. */
function ClipValueEditor({ value, label, labelFor, disabled, onChange }: { value: unknown; label: string; labelFor: (key: string) => string; disabled: boolean; onChange: (next: unknown) => void }) {
    if (objectValue(value)) return <div className="clip-value-editor-grid">{Object.entries(value).map(([key, item]) => <div key={key} className="clip-value-editor-field"><span>{labelFor(key)}</span><ClipValueEditor value={item} label={labelFor(key)} labelFor={labelFor} disabled={disabled} onChange={next => onChange({ ...value, [key]: next })} /></div>)}</div>;
    if (Array.isArray(value)) return <div className="clip-value-editor-array">{value.map((item, index) => <ClipValueEditor key={index} value={item} label={`${label} ${index + 1}`} labelFor={labelFor} disabled={disabled} onChange={next => onChange(value.map((current, currentIndex) => currentIndex === index ? next : current))} />)}</div>;
    if (typeof value === "boolean") return <Switch aria-label={label} checked={value} disabled={disabled} onChange={onChange} />;
    if (typeof value === "number") return <InputNumber aria-label={label} value={value} disabled={disabled} onChange={onChange} className="w-full" />;
    return <Input.TextArea aria-label={label} value={textValue(value)} disabled={disabled} autoSize={{ minRows: 1, maxRows: 8 }} onChange={event => onChange(event.target.value)} />;
}

export function ClipSourceFields({ segment, busy, names, sourceDrafts, onDraftChange, onSave, settings, musicEnabled = false }: {
    segment: Record<string, any>; busy: boolean; names: Record<string, string>; sourceDrafts: Record<string, string>;
    onDraftChange: (key: string, value: string | undefined) => void;
    onSave: (patch: Record<string, unknown>) => Promise<boolean | void>;
    settings?: ReactNode;
    musicEnabled?: boolean;
}) {
    const { t } = useTranslation();
    const [editing, setEditing] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [editingRequirement, setEditingRequirement] = useState<string>();
    const [requirementDraft, setRequirementDraft] = useState<unknown>();
    const requirementBase = useRef<unknown>(undefined);
    const [savingRequirement, setSavingRequirement] = useState(false);
    const [requirementError, setRequirementError] = useState("");
    const id = String(segment.id);
    const draftKey = (field: string) => `segment:${id}:${field}`;
    const editableFields = TEXT_FIELDS.filter(field => field !== "non_diegetic_music" || musicEnabled);
    const pending = editableFields.some(field => sourceDrafts[draftKey(field)] !== undefined);
    const labelFor = (key: string) => t(`director.studio.sourceField.${key}`, { defaultValue: t(`director.workspace.motionField.${key}`, { defaultValue: key.replace(/[_-]/g, " ") }) });
    const additionalKeys = Object.keys(segment).filter(key => !META_FIELDS.has(key) && !key.startsWith("_") && !(key === "mode_selection_reason" && segment[key] === SYNCED_MODE_REASON));
    const requirements = [...REQUIREMENT_ORDER.filter(key => additionalKeys.includes(key)), ...additionalKeys.filter(key => !REQUIREMENT_ORDER.includes(key))];
    const clearDrafts = () => editableFields.forEach(field => onDraftChange(draftKey(field), undefined));
    const save = async () => {
        const patch = Object.fromEntries(editableFields.flatMap(field => {
            const draft = sourceDrafts[draftKey(field)];
            return (field !== "non_diegetic_music" || musicEnabled) && draft !== undefined && draft !== textValue(segment[field]) ? [[field, draft]] : [];
        }));
        if (!Object.keys(patch).length) { clearDrafts(); setEditing(false); return; }
        setSaving(true); setError("");
        try {
            if (await onSave(patch) === false) { setError(t("director.workspace.sourceJsonSaveFailed")); return; }
            clearDrafts(); setEditing(false);
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        finally { setSaving(false); }
    };
    const saveRequirement = async (field: string) => {
        if (draftFieldConflicts(requirementBase.current, requirementDraft, segment[field]).length) { setRequirementError(t("director.studio.clipFieldConflict")); return; }
        setSavingRequirement(true); setRequirementError("");
        try {
            const next = mergeDraftFields(requirementBase.current, requirementDraft, segment[field]);
            if (JSON.stringify(next) !== JSON.stringify(segment[field]) && await onSave({ [field]: next }) === false) { setRequirementError(t("director.workspace.sourceJsonSaveFailed")); return; }
            setEditingRequirement(undefined);
        } catch (cause) { setRequirementError(cause instanceof Error ? cause.message : String(cause)); }
        finally { setSavingRequirement(false); }
    };
    const textField = (field: typeof TEXT_FIELDS[number]) => field === "non_diegetic_music" && !musicEnabled
        ? <div><ClipProse text="N/A" empty="" /><p className="clip-content-empty">{t("director.studio.backgroundMusicDisabled")}</p></div>
        : editing
        ? <Input.TextArea id={`${id}-${field}`} aria-label={labelFor(field)} value={sourceDrafts[draftKey(field)] ?? textValue(segment[field])} autoSize={{ minRows: field === "summary" ? 6 : 3, maxRows: 24 }} disabled={busy || saving} onChange={event => { onDraftChange(draftKey(field), event.target.value); setError(""); }} />
        : <ClipProse text={textValue(segment[field])} empty={t("director.studio.clipFieldEmpty")} />;
    return <section className="clip-source-fields" data-clip-source-fields={id}>
        <div className="clip-content-toolbar">
            <div className="clip-content-settings">{settings}{pending && <span className="clip-content-pending">{t("director.atomic.unsavedShort")}</span>}</div>
            {editing ? <div className="clip-content-actions"><Button size="small" type="primary" icon={<Check className="size-3.5" />} loading={saving} disabled={busy || saving} onClick={() => void save()}>{t("common.save")}</Button><Button size="small" disabled={saving} onClick={() => { clearDrafts(); setEditing(false); setError(""); }}>{t("common.cancel")}</Button></div>
                : <Button size="small" type="text" icon={<Pencil className="size-3.5" />} disabled={busy} onClick={() => setEditing(true)}>{t("director.studio.editClipFields")}</Button>}
        </div>
        <div className="clip-content-layout">
            <section className="clip-narrative" data-clip-source-field="summary"><h3 className="clip-content-heading"><AlignLeft aria-hidden="true" />{t("director.studio.clipNarrative")}</h3>{textField("summary")}</section>
            <aside className="clip-sound-design"><h3 className="clip-content-heading"><AudioLines aria-hidden="true" />{t("director.studio.clipSoundDesign")}</h3>
                <div className="clip-sound-field" data-clip-source-field="overall_soundscape"><label htmlFor={editing ? `${id}-overall_soundscape` : undefined}>{labelFor("overall_soundscape")}</label>{textField("overall_soundscape")}</div>
                <div className="clip-sound-field" data-clip-source-field="non_diegetic_music"><label htmlFor={editing ? `${id}-non_diegetic_music` : undefined}><Music2 className="size-3.5" aria-hidden="true" />{labelFor("non_diegetic_music")}</label>{textField("non_diegetic_music")}</div>
            </aside>
        </div>
        {error && <Alert type="error" showIcon message={error} />}
        {requirements.length > 0 && <div className="clip-requirements">{requirements.map(field => {
            const isEditing = editingRequirement === field;
            const Icon = field === "motion_profile" ? Move : /audio|sound/.test(field) ? AudioLines : Layers;
            return <section key={field} className="clip-requirement-section" data-clip-requirement={field}>
                <div className="clip-requirement-heading"><h3 className="clip-content-heading"><Icon aria-hidden="true" />{labelFor(field)}</h3>{isEditing ? <div className="clip-content-actions"><Button size="small" type="primary" icon={<Check className="size-3.5" />} loading={savingRequirement} disabled={busy || savingRequirement} onClick={() => void saveRequirement(field)}>{t("common.save")}</Button><Button size="small" disabled={savingRequirement} onClick={() => { setEditingRequirement(undefined); setRequirementError(""); }}>{t("common.cancel")}</Button></div>
                    : <Button type="text" size="small" icon={<Pencil className="size-3.5" />} aria-label={`${t("common.edit")} ${labelFor(field)}`} disabled={busy || saving || savingRequirement || Boolean(editingRequirement)} onClick={() => { requirementBase.current = structuredClone(segment[field]); setRequirementDraft(structuredClone(segment[field])); setRequirementError(""); setEditingRequirement(field); }}>{t("common.edit")}</Button>}</div>
                {isEditing ? <ClipValueEditor value={requirementDraft} label={labelFor(field)} labelFor={labelFor} disabled={busy || savingRequirement} onChange={setRequirementDraft} /> : <ClipValue value={segment[field]} labelFor={labelFor} names={names} empty={t("director.studio.clipFieldEmpty")} />}
                {isEditing && requirementError && <Alert type="error" showIcon message={requirementError} />}
            </section>;
        })}</div>}
        {segment.mode_selection_reason === SYNCED_MODE_REASON && <p className="clip-mode-note">{t("director.studio.clipModeSynced")}</p>}
    </section>;
}
