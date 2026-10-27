import { Button, Input, InputNumber, Switch } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

type Data = Record<string, any>;
type Props = { value?: Data | null; disabled: boolean; durationFrames: number; fps?: number; onChange: (value: Data) => void };

const asObject = (value: unknown): Data => value && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
const asRows = (value: unknown): Data[] => Array.isArray(value) ? value.map(asObject) : [];
const asStrings = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : [];

export function PerformanceDesignEditor({ value, disabled, durationFrames, fps = 24, onChange }: Props) {
    const { t } = useTranslation();
    const data = asObject(value);
    const acting = asObject(data.acting_design);
    const knownRoot = new Set(["version", "strategy", "dominant_track", "source_beat_id", "beat_id", "beat_ids", "source_anchor", "selected_phase", "visibility_result", "visibility_evidence", "continuity_in", "continuity_out", "tracks", "events", "exclusion_controls", "acting_design", "exclusions"]);
    const knownActing = new Set(["version", "mode", "character_id", "objective", "tactic", "trigger", "subtext", "personality_signature", "action_units", "motion_arc", "speech_delivery", "cut_behavior", "continuity_in", "continuity_out", "exclusions"]);
    const patch = (key: string, next: unknown) => onChange({ ...data, [key]: next });
    const patchActing = (key: string, next: unknown) => patch("acting_design", { ...acting, [key]: next });
    const field = (key: string, owner: Data, set: (value: unknown) => void, area = false) => <label key={key} className="grid min-w-0 gap-1 text-xs text-muted-foreground">
        <span>{t(`director.studio.performanceEditor.fields.${key}`, { defaultValue: key })}</span>
        {area ? <Input.TextArea value={String(owner[key] ?? "")} autoSize={{ minRows: 2, maxRows: 6 }} disabled={disabled} onChange={event => set(event.target.value)} />
            : <Input value={String(owner[key] ?? "")} disabled={disabled} onChange={event => set(event.target.value)} />}
    </label>;
    const textList = (titleKey: string, key: string, owner: Data, set: (value: unknown) => void) => {
        const rows = asStrings(owner[key]);
        return <section className="shot-editor-span-all space-y-2" key={key}>
            <div className="flex items-center justify-between gap-2"><h5 className="m-0 text-xs font-medium">{t(`director.studio.performanceEditor.fields.${titleKey}`, { defaultValue: titleKey })}</h5><Button size="small" disabled={disabled} onClick={() => set([...rows, ""])}>{t("director.studio.performanceEditor.add")}</Button></div>
            {rows.map((item, index) => <div className="flex gap-2" key={`${key}:${index}`}><Input.TextArea value={item} autoSize={{ minRows: 1, maxRows: 4 }} disabled={disabled} onChange={event => set(rows.map((row, n) => n === index ? event.target.value : row))} /><Button size="small" type="text" disabled={disabled} onClick={() => set(rows.filter((_, n) => n !== index))}>{t("common.remove")}</Button></div>)}
        </section>;
    };
    const editRows = (key: string, owner: Data, set: (value: unknown) => void, kind: "event" | "action" | "cut") => {
        const rows = asRows(owner[key]);
        const fields = kind === "event" ? ["phase", "cue"] : kind === "action" ? ["cause", "action", "gaze", "face", "follow_through", "speech_anchor", "delivery", "prop", "camera", "sound"] : ["type", "entry_state", "exit_state"];
        return <section className="shot-editor-span-all space-y-2" key={key}>
            <div className="flex items-center justify-between gap-2"><h5 className="m-0 text-xs font-medium">{t(`director.studio.performanceEditor.fields.${key}`, { defaultValue: key })}</h5><Button size="small" disabled={disabled} onClick={() => set([...rows, kind === "event" ? { phase: "", start: 0, end: 1, cue: "" } : kind === "action" ? { start: 0, end: 1 } : { at: 0, type: "", audio_carries: false, action_carries: false, entry_state: "", exit_state: "" }])}>{t("director.studio.performanceEditor.add")}</Button></div>
            {rows.map((row, index) => <article key={`${key}:${index}`} className="space-y-2 rounded-md border border-border p-3">
                <div className="flex items-center justify-between"><span className="text-xs font-medium">{t("director.studio.performanceEditor.item", { number: index + 1 })}</span><Button size="small" type="text" disabled={disabled} onClick={() => set(rows.filter((_, n) => n !== index))}>{t("common.remove")}</Button></div>
                {kind === "event" || kind === "action" ? <div className="grid grid-cols-2 gap-2">{(["start", "end"] as const).map(frameKey => <label key={frameKey} className="grid gap-1 text-xs text-muted-foreground"><span>{t(`director.studio.performanceEditor.fields.${frameKey}`)}</span><InputNumber className="w-full" min={0} max={durationFrames / fps} step={1 / fps} precision={3} value={Number(row[frameKey] ?? 0) / fps} disabled={disabled} onChange={seconds => set(rows.map((entry, n) => n === index ? { ...entry, [frameKey]: Math.round(Number(seconds ?? 0) * fps) } : entry))} /></label>)}</div>
                    : <label className="grid gap-1 text-xs text-muted-foreground"><span>{t("director.studio.performanceEditor.fields.at")}</span><InputNumber className="w-full" min={0} max={durationFrames / fps} step={1 / fps} precision={3} value={Number(row.at ?? 0) / fps} disabled={disabled} onChange={seconds => set(rows.map((entry, n) => n === index ? { ...entry, at: Math.round(Number(seconds ?? 0) * fps) } : entry))} /></label>}
                <div className="grid gap-2 sm:grid-cols-2">{fields.map(name => kind === "cut" && ["audio_carries", "action_carries"].includes(name)
                    ? <label key={name} className="flex items-center gap-2 text-xs text-muted-foreground"><Switch size="small" checked={Boolean(row[name])} disabled={disabled} onChange={checked => set(rows.map((entry, n) => n === index ? { ...entry, [name]: checked } : entry))} />{t(`director.studio.performanceEditor.fields.${name}`)}</label>
                    : field(name, row, next => set(rows.map((entry, n) => n === index ? { ...entry, [name]: next } : entry)), true))}</div>
            </article>)}
        </section>;
    };
    const tracks = asObject(data.tracks);
    const trackRows = Object.entries(tracks);
    const setTrack = (oldName: string, newName: string, next: Data) => {
        const updated: Data = {};
        for (const [name, track] of trackRows) updated[name === oldName ? newName : name] = name === oldName ? next : track;
        patch("tracks", updated);
    };
    const arc = asObject(acting.motion_arc), delivery = asObject(acting.speech_delivery), anchor = asObject(data.source_anchor);
    const anchorExtra = Object.fromEntries(Object.entries(anchor).filter(([key]) => !["block_id", "evidence"].includes(key)));
    const structuredRows = (key: "pauses" | "emphasis") => {
        const rows = asRows(delivery[key]);
        const fields = key === "pauses" ? ["after_text"] : ["text", "delivery"];
        const save = (next: Data[]) => patchActing("speech_delivery", { ...delivery, [key]: next });
        return <section key={key} className="grid gap-2 text-xs text-muted-foreground"><div className="flex items-center justify-between gap-2"><span>{t(`director.studio.performanceEditor.fields.${key}`)}</span><Button size="small" disabled={disabled} onClick={() => save([...rows, key === "pauses" ? { after_text: "", duration_ms: 0 } : { text: "", delivery: "" }])}>{t("director.studio.performanceEditor.add")}</Button></div>
            {rows.map((row, index) => <div key={`${key}:${index}`} className="flex items-start gap-2 rounded border border-border p-2"><div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">{fields.map(name => field(name, row, next => save(rows.map((item, n) => n === index ? { ...item, [name]: next } : item)), true))}{key === "pauses" && <label className="grid gap-1"><span>{t("director.studio.performanceEditor.fields.duration_ms")}</span><InputNumber className="w-full" min={0} precision={0} value={Number(row.duration_ms ?? 0)} disabled={disabled} onChange={duration_ms => save(rows.map((item, n) => n === index ? { ...item, duration_ms: duration_ms ?? 0 } : item))} /></label>}</div><Button size="small" type="text" disabled={disabled} onClick={() => save(rows.filter((_, n) => n !== index))}>{t("common.remove")}</Button></div>)}
        </section>;
    };
    const other = Object.fromEntries(Object.entries(data).filter(([key]) => !knownRoot.has(key)));
    const otherActing = Object.fromEntries(Object.entries(acting).filter(([key]) => !knownActing.has(key)));
    const jsonOther = JSON.stringify({ ...(Object.keys(other).length ? { performance: other } : {}), ...(Object.keys(otherActing).length ? { acting_design: otherActing } : {}), ...(Object.keys(anchorExtra).length ? { source_anchor: anchorExtra } : {}) }, null, 2);
    const [otherDraft, setOtherDraft] = useState(jsonOther);
    useEffect(() => setOtherDraft(jsonOther), [jsonOther]);
    const setOther = (raw: string) => {
        setOtherDraft(raw);
        try {
            const parsed = asObject(JSON.parse(raw));
            const extraRoot = asObject(parsed.performance), extraActing = asObject(parsed.acting_design);
            const extraAnchor = asObject(parsed.source_anchor);
            const anchorBase = asObject(data.source_anchor);
            onChange({ ...Object.fromEntries(Object.entries(data).filter(([key]) => knownRoot.has(key))), ...extraRoot,
                ...(data.source_anchor !== undefined || Object.keys(extraAnchor).length ? { source_anchor: { ...Object.fromEntries(Object.entries(anchorBase).filter(([key]) => ["block_id", "evidence"].includes(key))), ...extraAnchor } } : {}),
                ...(data.acting_design !== undefined || Object.keys(extraActing).length ? { acting_design: { ...Object.fromEntries(Object.entries(acting).filter(([key]) => knownActing.has(key))), ...extraActing } } : {}) });
        } catch { /* Keep the in-progress JSON in the textarea until it parses. */ }
    };

    return <section className="shot-editor-span-all space-y-4 rounded-lg border border-border p-4" data-shot-performance-editor>
        <div><h4 className="m-0 text-sm font-medium">{t("director.studio.performancePayload")}</h4><p className="mb-0 mt-1 text-xs text-muted-foreground">{t("director.studio.performanceEditor.hint")}</p></div>
        <section className="shot-editor-form-grid rounded-md bg-muted/30 p-3"><h5 className="shot-editor-span-all m-0 text-xs font-semibold">{t("director.studio.performanceEditor.source")}</h5>
            {(["version", "strategy", "dominant_track", "source_beat_id", "beat_id", "selected_phase", "visibility_result"] as const).map(key => field(key, data, next => patch(key, next)))}
            {textList("beat_ids", "beat_ids", data, next => patch("beat_ids", next))}
            {typeof data.source_anchor !== "string" && field("block_id", anchor, next => patch("source_anchor", { ...anchor, block_id: next }))}
            {field("evidence", anchor, next => patch("source_anchor", typeof data.source_anchor === "string" ? next : { ...anchor, evidence: next }), true)}
            {field("visibility_evidence", data, next => patch("visibility_evidence", next), true)}
            {field("continuity_in", data, next => patch("continuity_in", next), true)}{field("continuity_out", data, next => patch("continuity_out", next), true)}
            {editRows("events", data, next => patch("events", next), "event")}
            {textList("exclusion_controls", "exclusion_controls", data, next => patch("exclusion_controls", next))}
            {textList("exclusions", "exclusions", data, next => patch("exclusions", next))}
        </section>
        <section className="shot-editor-form-grid rounded-md bg-muted/30 p-3"><h5 className="shot-editor-span-all m-0 text-xs font-semibold">{t("director.studio.performanceEditor.tracks")}</h5>
            {trackRows.map(([name, raw]) => { const track = asObject(raw); return <article key={name} className="shot-editor-span-all space-y-2 rounded-md border border-border p-3">
                <div className="flex items-center justify-between gap-2"><Input aria-label={t("director.studio.performanceEditor.trackName")} value={name} disabled={disabled} onChange={event => setTrack(name, event.target.value, track)} /><Button size="small" type="text" disabled={disabled} onClick={() => patch("tracks", Object.fromEntries(trackRows.filter(([trackName]) => trackName !== name)))}>{t("common.remove")}</Button></div>
                <div className="grid grid-cols-2 gap-2">{(["start", "end"] as const).map(frameKey => <label key={frameKey} className="grid gap-1 text-xs text-muted-foreground"><span>{t(`director.studio.performanceEditor.fields.${frameKey}`)}</span><InputNumber className="w-full" min={0} max={durationFrames / fps} step={1 / fps} precision={3} value={track[frameKey] == null ? null : Number(track[frameKey]) / fps} disabled={disabled} onChange={seconds => setTrack(name, name, { ...track, [frameKey]: seconds == null ? undefined : Math.round(Number(seconds) * fps) })} /></label>)}</div>
                {field("cue", track, next => setTrack(name, name, { ...track, cue: next }), true)}{field("visibility", track, next => setTrack(name, name, { ...track, visibility: next }), true)}
            </article>; })}
            <Button className="shot-editor-span-all justify-self-start" disabled={disabled} onClick={() => { let index = trackRows.length + 1, name = `track_${index}`; while (Object.prototype.hasOwnProperty.call(tracks, name)) name = `track_${++index}`; patch("tracks", { ...tracks, [name]: { start: 0, end: 1, cue: "", visibility: "" } }); }}>{t("director.studio.performanceEditor.addTrack")}</Button>
        </section>
        <section className="shot-editor-form-grid rounded-md bg-muted/30 p-3"><h5 className="shot-editor-span-all m-0 text-xs font-semibold">{t("director.studio.performanceEditor.acting")}</h5>
            {(["version", "mode", "character_id", "objective", "tactic", "trigger", "subtext", "personality_signature", "continuity_in", "continuity_out"] as const).map(key => field(key, acting, next => patchActing(key, next), !["version", "mode", "character_id"].includes(key)))}
            {editRows("action_units", acting, next => patchActing("action_units", next), "action")}
            <section className="shot-editor-span-all space-y-2"><h5 className="m-0 text-xs font-medium">{t("director.studio.performanceEditor.motionArc")}</h5><div className="grid gap-2 sm:grid-cols-2">{(["anticipation", "accent", "follow_through", "settle"] as const).map(key => field(key, arc, next => patchActing("motion_arc", { ...arc, [key]: next }), true))}</div></section>
            <section className="shot-editor-span-all space-y-2"><h5 className="m-0 text-xs font-medium">{t("director.studio.performanceEditor.speechDelivery")}</h5><div className="grid gap-2 sm:grid-cols-2">{(["voice_timbre", "pace", "pitch", "volume"] as const).map(key => field(key, delivery, next => patchActing("speech_delivery", { ...delivery, [key]: next }), true))}
                {structuredRows("pauses")}{structuredRows("emphasis")}</div></section>
            {editRows("cut_behavior", acting, next => patchActing("cut_behavior", next), "cut")}
            {textList("acting_exclusions", "exclusions", acting, next => patchActing("exclusions", next))}
        </section>
        <details className="rounded-md border border-border p-3"><summary className="cursor-pointer text-xs font-medium">{t("director.studio.performanceEditor.otherFields")}</summary><p className="mt-2 text-xs text-muted-foreground">{t("director.studio.performanceEditor.otherFieldsHint")}</p><Input.TextArea value={otherDraft} autoSize={{ minRows: 3, maxRows: 12 }} disabled={disabled} onChange={event => setOther(event.target.value)} /></details>
    </section>;
}
