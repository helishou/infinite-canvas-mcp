import { useEffect, useState, type ReactNode } from "react";
import { App, Button, Checkbox, Dropdown, Input, InputNumber, Modal, Select } from "antd";
import { Copy, Plus, Scissors, Trash2, ArrowUp, ArrowDown, Combine } from "lucide-react";
import { useTranslation } from "react-i18next";
import { nanoid } from "nanoid";
import { resolveSubjectPictureBindingIds, type ProductionOperation } from "@basketikun/canvas-agent/drama/production-contract";
import { readableText, records } from "./director-display";
import { subjectDisplayName } from "./subject-shot-draft";

type Row = Record<string, any>;
export type ShotOperation = Extract<ProductionOperation, { type: "edit_director_shot" }>;
export function ShotOperations({ source, shot, busy, onEdit, onSelect, contextMenu = false, children }: { source: Row; shot?: Row; busy?: boolean; onEdit: (op: ShotOperation) => Promise<boolean>; onSelect: (id: string) => void; contextMenu?: boolean; children?: ReactNode }) {
    const { t } = useTranslation(), { message } = App.useApp();
    const [mode, setMode] = useState<"insert" | "split" | "merge">();
    const [title, setTitle] = useState(""), [visual, setVisual] = useState(""), [firstVisual, setFirstVisual] = useState("");
    const [frames, setFrames] = useState(1), [offsets, setOffsets] = useState<Record<string, number>>({});
    const [framing, setFraming] = useState("CU"), [attention, setAttention] = useState<string[]>([]), [visible, setVisible] = useState<string[]>([]);
    const [cameraId, setCameraId] = useState<string>(), [reaction, setReaction] = useState(false), [saving, setSaving] = useState(false);
    const [visibleChanged, setVisibleChanged] = useState(false), [reason, setReason] = useState("");
    const [sceneId, setSceneId] = useState<string>(), [timelineId, setTimelineId] = useState<string>();
    const [mergedAudio, setMergedAudio] = useState<string>();
    const [createdId, setCreatedId] = useState(""), [mergeTargetId, setMergeTargetId] = useState<string>();
    const shots = records(source.shots), subjects = records(source.subject_registry), group = records(source.segments).find(group => group.shot_ids?.includes(shot?.id));
    const members = shots.filter(row => group?.shot_ids?.includes(row.id)), index = members.findIndex(row => row.id === shot?.id), previous = members[index - 1], next = members[index + 1];
    const fps = Number(source.fps_num || 24) / Number(source.fps_den || 1);
    useEffect(() => {
        if ((mode === "insert" || mode === "split") && createdId && shots.some(shot => shot.id === createdId)) { setMode(undefined); onSelect(createdId); }
    }, [mode, createdId, source.shots, onSelect]);
    const crossing = mode === "split" ? records(shot?.utterance_refs).filter(ref => ref.localStartFrame < frames && ref.localEndFrame > frames) : [];
    const run = async (op: ShotOperation, selected?: string) => {
        setSaving(true);
        try { if (await onEdit(op)) { setMode(undefined); if (selected) onSelect(selected); } } finally { setSaving(false); }
    };
    const open = (action: typeof mode) => {
        setMode(action); setCreatedId(`SHOT_${nanoid()}`); setMergeTargetId(next?.id); setTitle(action === "insert" ? "" : `${shot?.title || ""} · ${t("director.shotCrud.secondPart")}`);
        setVisual(action === "merge" ? `[0–${shot?.duration_frames}帧] ${shot?.visual || ""}\n[${shot?.duration_frames}–${Number(shot?.duration_frames) + Number(next?.duration_frames)}帧] ${next?.visual || ""}` : ""); setFirstVisual(String(shot?.visual || "")); setMergedAudio(undefined);
        setFrames(action === "insert" ? Math.round(4 * fps) : Math.max(1, Math.floor(Number(shot?.duration_frames || 2) / 2)));
        setOffsets({}); setFraming(shot?.camera?.framing || "CU"); setAttention(shot?.camera?.attention_subject_ids || []);
        setVisible(records(shot?.subject_usages).filter(usage => usage.presentation === "visible").map(usage => usage.subjectId)); setVisibleChanged(false); setReaction(false); setCameraId(shot?.id);
        setReason(shot?.camera?.editorial_reason || ""); setSceneId(records(source.scene_registry)[0]?.id); setTimelineId(records(source.ledger?.timelines)[0]?.id);
    };
    const submit = async () => {
        if (mode === "merge") {
            if (!next || next.id !== mergeTargetId) return message.error(t("director.shotCrud.targetChanged"));
            return run({ type: "edit_director_shot", action: "merge", shotId: shot!.id, targetShotId: mergeTargetId, cameraShotId: cameraId, firstShotPatch: { visual, ...(mergedAudio !== undefined ? { audio: mergedAudio } : {}) } }, shot!.id);
        }
        if (!title.trim() || !visual.trim() || !reason.trim()) return message.error(t("director.shotCrud.requiredDesign"));
        const id = createdId;
        const usages = subjects.filter(subject => visible.includes(subject.id)).map(subject => {
            const original = records(shot?.subject_usages).find(usage => usage.subjectId === subject.id);
            const usage = { subjectId: subject.id, presentation: "visible", pictureBindingIds: resolveSubjectPictureBindingIds(subject, { presentation: "visible", referencePurpose: ["identity"], stateRequirements: [] }).bindingIds, referencePurpose: ["identity"], continuityFactIds: [], stateRequirements: [] };
            const value: Row = { ...(original || usage), presentation: "visible" }; delete value.localStartFrame; delete value.localEndFrame; return value;
        });
        const design = { title: title.trim(), visual: visual.trim(), camera: { ...(shot?.camera || {}), framing, attention_subject_ids: attention, editorial_reason: reason.trim() }, ...(mode === "insert" || visibleChanged ? { subject_usages: usages } : {}) };
        if (mode === "split") return run({ type: "edit_director_shot", action: "split", shotId: shot!.id, newShotId: id, splitFrame: frames, textOffsets: offsets, reaction, firstShotPatch: { visual: firstVisual }, shot: design }, id);
        const timeline = shot?.timeline_id || timelineId;
        const scene = shot?.scene_id || sceneId;
        if (!timeline || !scene) return message.error(t("director.shotCrud.missingScene"));
        return run({ type: "edit_director_shot", action: "insert", ...(shot ? { shotId: shot.id } : { segment: { id: `CLIP_${nanoid()}`, mode: "Ref2VA" } }), shot: { ...design, id, scene_id: scene, timeline_id: timeline, duration_frames: frames, keyframes: [], utterance_refs: [], audio: {} } }, id);
    };
    const menu = { items: shot ? [
            { key: "copy", label: t("director.shotCrud.copy"), icon: <Copy className="size-3.5" />, onClick: () => { const id = `SHOT_${nanoid()}`; void run({ type: "edit_director_shot", action: "duplicate", shotId: shot.id, newShotId: id }, id); } },
            { key: "split", label: t("director.shotCrud.split"), icon: <Scissors className="size-3.5" />, disabled: shot.duration_frames < 2, onClick: () => open("split") },
            { key: "merge", label: t("director.shotCrud.mergeNext"), icon: <Combine className="size-3.5" />, disabled: !next, onClick: () => open("merge") },
            { key: "up", label: t("director.shotCrud.up"), icon: <ArrowUp className="size-3.5" />, disabled: !previous, onClick: () => void run({ type: "edit_director_shot", action: "move", shotId: shot.id, targetShotId: previous.id, position: "before" }) },
            { key: "down", label: t("director.shotCrud.down"), icon: <ArrowDown className="size-3.5" />, disabled: !next, onClick: () => void run({ type: "edit_director_shot", action: "move", shotId: shot.id, targetShotId: next.id, position: "after" }) },
            { type: "divider" as const }, { key: "delete", label: t(members.length === 1 ? "director.shotCrud.deleteSingleClip" : "director.shotCrud.delete"), icon: <Trash2 className="size-3.5" />, onClick: () => {
                void run({ type: "edit_director_shot", action: "delete", shotId: shot.id }, previous?.id || next?.id);
            } },
        ] : [] };
    return <>
        {contextMenu && shot ? <Dropdown trigger={["contextMenu"]} disabled={busy || saving} menu={menu}>{children}</Dropdown> : !contextMenu ? <div className="flex flex-wrap items-center gap-2" data-shot-operations>
            <Button size="small" icon={<Plus className="size-3.5" />} disabled={busy || saving} onClick={() => open("insert")}>{t("director.shotCrud.add")}</Button>
        </div> : children}
        <Modal open={Boolean(mode)} title={t(`director.shotCrud.${mode === "insert" ? "add" : mode === "split" ? "split" : "mergeNext"}`)} onCancel={() => setMode(undefined)} onOk={() => void submit()} okText={t("director.shotCrud.save")} cancelText={t("common.cancel")} confirmLoading={saving} okButtonProps={{ disabled: busy }} width={720}>
            <div className="space-y-4">
                <p className="text-xs text-muted-foreground">{t(mode === "split" ? "director.shotCrud.splitHint" : mode === "merge" ? "director.shotCrud.mergeHint" : "director.shotCrud.insertHint")}</p>
                {mode !== "merge" && <><label className="grid gap-1 text-xs"><span>{t("director.atomic.shotTitle")}</span><Input value={title} onChange={event => setTitle(event.target.value)} /></label><label className="grid gap-1 text-xs"><span>{t(mode === "split" ? "director.shotCrud.cutFrame" : "director.workspace.durationFrames")}</span><InputNumber min={1} max={mode === "split" ? shot?.duration_frames - 1 : undefined} precision={0} value={frames} onChange={value => { setFrames(Number(value || 1)); setOffsets({}); }} /></label><p className="text-xs text-muted-foreground">{(frames / fps).toFixed(3)}s</p></>}
                {!shot && <div className="grid gap-3 sm:grid-cols-2"><Select aria-label={t("director.shotCrud.scene")} value={sceneId} onChange={setSceneId} options={records(source.scene_registry).map(row => ({ value: row.id, label: row.name || row.id }))} /><Select aria-label={t("director.shotCrud.timeline")} value={timelineId} onChange={setTimelineId} options={records(source.ledger?.timelines).map(row => ({ value: row.id, label: row.name || row.description || row.id }))} /></div>}
                {mode === "split" && <label className="grid gap-1 text-xs"><span>{t("director.shotCrud.firstAction")}</span><Input.TextArea value={firstVisual} onChange={event => setFirstVisual(event.target.value)} autoSize={{ minRows: 2, maxRows: 5 }} /></label>}
                <label className="grid gap-1 text-xs"><span>{t(mode === "split" ? "director.shotCrud.secondAction" : "director.atomic.action")}</span><Input.TextArea value={visual} onChange={event => setVisual(event.target.value)} autoSize={{ minRows: 3, maxRows: 6 }} /></label>
                {mode === "merge" && <label className="grid gap-1 text-xs"><span>{t("director.atomic.sound")}</span><Input.TextArea value={mergedAudio ?? `${readableText(shot?.audio)}\n${readableText(next?.audio)}`} onChange={event => setMergedAudio(event.target.value)} autoSize={{ minRows: 2, maxRows: 4 }} /></label>}
                {mode === "merge" ? <Select className="w-full" aria-label={t("director.shotCrud.chooseCamera")} value={cameraId} onChange={setCameraId} options={[shot, next].filter(Boolean).map(row => ({ value: row!.id, label: `${row!.title} · ${row!.camera?.framing || ""}` }))} /> : <div className="grid gap-3 sm:grid-cols-2"><Select aria-label={t("director.atomic.framing")} value={framing} onChange={setFraming} options={["EWS", "WS", "FS", "MS", "MCU", "CU", "ECU"].map(value => ({ value, label: t(`director.atomic.framingName.${value}`) }))} /><Select mode="multiple" aria-label={t("director.atomic.attention")} value={attention} onChange={setAttention} options={subjects.map(subject => ({ value: subject.id, label: subjectDisplayName(source, subject.id) }))} /><label className="grid gap-1 text-xs sm:col-span-2"><span>{t("director.shotCrud.visibleSubjects")}</span><Select mode="multiple" value={visible} onChange={value => { setVisible(value); setVisibleChanged(true); }} options={subjects.map(subject => ({ value: subject.id, label: subjectDisplayName(source, subject.id) }))} /></label><label className="grid gap-1 text-xs sm:col-span-2"><span>{t("director.atomic.editorialReason")}</span><Input.TextArea value={reason} onChange={event => setReason(event.target.value)} autoSize={{ minRows: 2, maxRows: 4 }} /></label></div>}
                {mode === "split" && crossing.map(ref => { const utterance = records(source.utterances).find(row => row.id === ref.utteranceId), text = Array.from(String(utterance?.text || "")); return <label key={ref.utteranceId} className="grid gap-2 border-t border-border pt-3 text-xs"><span>{t("director.shotCrud.dialogueCut")} · {utterance?.text}</span><Select allowClear placeholder={t("director.shotCrud.autoTextCut")} value={offsets[ref.utteranceId]} onChange={value => setOffsets(old => ({ ...old, [ref.utteranceId]: value }))} options={Array.from({ length: Math.max(0, ref.textEnd - ref.textStart - 1) }, (_, index) => { const value = ref.textStart + index + 1; return { value, label: `${text.slice(ref.textStart, value).join("")} ｜ ${text.slice(value, ref.textEnd).join("")}` }; })} /></label>; })}
                {mode === "split" && <Checkbox checked={reaction} onChange={event => {
                    setReaction(event.target.checked);
                    if (event.target.checked) {
                        const speakers = new Set(records(source.utterances).filter(utterance => records(shot?.utterance_refs).some(ref => ref.utteranceId === utterance.id && ref.localEndFrame > frames)).map(utterance => utterance.speakerSubjectId));
                        const listeners = visible.filter(id => !speakers.has(id) && ["character", "animal"].includes(subjects.find(subject => subject.id === id)?.kind));
                        setAttention(listeners);
                        if (listeners.length) setReason(t("director.shotCrud.reactionReason", { subject: listeners.map(id => subjectDisplayName(source, id)).join("、") }));
                    }
                }}>{t("director.shotCrud.reaction")}</Checkbox>}
            </div>
        </Modal>
    </>;
}
