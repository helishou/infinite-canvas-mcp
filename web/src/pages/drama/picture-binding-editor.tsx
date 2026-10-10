import { Alert, Button, Input, Select } from "antd";
import { useTranslation } from "react-i18next";
import { canonicalProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { useRef } from "react";
import { draftFieldConflicts, mergeDraftFields } from "./draft-field-merge";
type Row = Record<string, any>;
const fields = (binding: Row) => ({ provides: binding.provides || [], retain: binding.retain || [], exclude: binding.exclude || [], applicableState: binding.applicableState || {} });
export function PictureBindingEditor({ binding, draftValue, onDraftChange, busy, onSave }: { binding: Row; draftValue?: string; onDraftChange: (value?: string) => void; busy: boolean; onSave: (patch: Row) => Promise<boolean> }) {
    const { t } = useTranslation(), formal = fields(binding);
    const latest = useRef(draftValue); latest.current = draftValue;
    let draft = { base: formal, value: structuredClone(formal) }, invalid = false;
    if (draftValue) try { draft = JSON.parse(draftValue); if (!draft?.base || !draft?.value || !(["retain", "exclude", "provides"] as const).every(field => Array.isArray(draft.value[field]) && draft.value[field].every((item: unknown) => typeof item === "string"))) throw new Error(); } catch { invalid = true; draft = { base: formal, value: structuredClone(formal) }; }
    const conflict = draftFieldConflicts(draft.base, draft.value, formal).length > 0;
    if (!invalid && !conflict) draft = { base: formal, value: mergeDraftFields(draft.base, draft.value, formal) };
    const update = (patch: Row) => onDraftChange(JSON.stringify({ ...draft, value: { ...draft.value, ...patch } }));
    const purposes = [...new Set(["identity", "appearance", "clothing", "geometry", "material", "composition", "pose", "scene", "prop", "style", ...draft.value.provides])];
    return <details className="border-t border-border pt-2"><summary className="cursor-pointer text-xs">{t("director.crud.editImageUse")}</summary><div className="mt-3 space-y-3">
        {(invalid || conflict) && <Alert type="warning" message={t(invalid ? "director.atomic.invalidDraft" : "director.atomic.sourceChanged")} description={<><pre className="max-h-32 overflow-auto whitespace-pre-wrap text-xs">{draftValue}</pre>{conflict && <Button size="small" disabled={busy} onClick={() => onDraftChange(JSON.stringify({ base: formal, value: mergeDraftFields(draft.base, draft.value, formal) }))}>{t("director.atomic.keepReviewedDraft")}</Button>}<Button size="small" disabled={busy} onClick={() => onDraftChange(undefined)}>{t("director.atomic.resetDraft")}</Button></>} />}
        <label className="grid gap-1 text-xs"><span>{t("director.crud.provides")}</span><Select mode="multiple" value={draft.value.provides} disabled={busy || invalid} options={purposes.map(value => ({ value, label: t(`director.crud.purpose.${value}`, { defaultValue: value }) }))} onChange={provides => update({ provides })} /></label>
        {(["retain", "exclude"] as const).map(field => <label key={field} className="grid gap-1 text-xs"><span>{t("director.crud." + field)}</span><Input.TextArea value={draft.value[field].join("\n")} disabled={busy || invalid} autoSize={{ minRows: 2, maxRows: 6 }} placeholder={t("director.crud.chineseLines")} onChange={event => update({ [field]: event.target.value.split("\n") })} /></label>)}
        <Button size="small" type="primary" disabled={busy || invalid || conflict || canonicalProduction(draft.value) === canonicalProduction(formal)} onClick={() => { const submitted = draftValue; void onSave({ ...draft.value, retain: draft.value.retain.filter((line: string) => line.trim()), exclude: draft.value.exclude.filter((line: string) => line.trim()) }).then(saved => { if (saved && latest.current === submitted) onDraftChange(undefined); }); }}>{t("director.crud.saveImageUse")}</Button>
    </div></details>;
}
