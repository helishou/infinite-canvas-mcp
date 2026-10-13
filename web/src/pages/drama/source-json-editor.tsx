import { useState } from "react";
import { Alert, Button, Input } from "antd";
import { Check, Pencil, X } from "lucide-react";
import { useTranslation } from "react-i18next";

type JsonOrder = { fieldOrder?: string[]; nestedFieldOrder?: Record<string, string[]> };
function orderJson(value: unknown, parentKey: string, rootOrder: string[] | undefined, nested: Record<string, string[]> | undefined): unknown {
    if (Array.isArray(value)) return value.map(item => orderJson(item, parentKey, rootOrder, nested));
    if (!value || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    const order = parentKey === "$root" ? rootOrder : nested?.[parentKey];
    const keys = Object.keys(object);
    const orderedKeys = order ? [...order.filter(key => Object.hasOwn(object, key)), ...keys.filter(key => !order.includes(key))] : keys;
    return Object.fromEntries(orderedKeys.map(key => [key, orderJson(object[key], key, rootOrder, nested)]));
}

export function SourceJsonEditor({ title, hint, value, disabled, onSave, fieldOrder, nestedFieldOrder }: {
    title: string;
    hint?: string;
    value: unknown;
    disabled: boolean;
    onSave: (next: Record<string, unknown>) => Promise<boolean | void> | boolean | void;
} & JsonOrder) {
    const { t } = useTranslation();
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState("");
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);
    const begin = () => {
        const object = value && typeof value === "object" && !Array.isArray(value) ? value : {};
        setDraft(JSON.stringify(orderJson(object, "$root", fieldOrder, nestedFieldOrder), null, 2));
        setError("");
        setEditing(true);
    };
    const save = async () => {
        let parsed: unknown;
        try { parsed = JSON.parse(draft); }
        catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return; }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            setError(t("director.workspace.sourceJsonObjectRequired"));
            return;
        }
        setSaving(true);
        try {
            const result = await onSave(parsed as Record<string, unknown>);
            if (result === false) { setError(t("director.workspace.sourceJsonSaveFailed")); return; }
            setEditing(false);
            setError("");
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        finally { setSaving(false); }
    };
    return <section className="space-y-2 rounded-lg border border-border p-3" data-source-json-editor>
        <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-xs font-medium">{title}</strong>{editing ? <span className="flex gap-1"><Button size="small" type="primary" icon={<Check className="size-3.5" />} loading={saving} disabled={disabled || saving} onClick={() => void save()}>{t("common.save")}</Button><Button size="small" icon={<X className="size-3.5" />} disabled={saving} onClick={() => { setEditing(false); setError(""); }}>{t("common.cancel")}</Button></span> : <Button size="small" type="text" icon={<Pencil className="size-3.5" />} disabled={disabled} onClick={begin}>{t("director.workspace.editStructuredData")}</Button>}</div>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        {editing ? <Input.TextArea aria-label={title} value={draft} autoSize={{ minRows: 8, maxRows: 28 }} disabled={disabled || saving} spellCheck={false} className="font-mono text-xs" onChange={event => { setDraft(event.target.value); setError(""); }} /> : <pre className="max-h-40 overflow-auto rounded bg-muted/30 p-2 text-[11px] leading-5 text-muted-foreground">{JSON.stringify(orderJson(value ?? {}, "$root", fieldOrder, nestedFieldOrder), null, 2)}</pre>}
        {error && <Alert type="error" showIcon message={error} />}
    </section>;
}
