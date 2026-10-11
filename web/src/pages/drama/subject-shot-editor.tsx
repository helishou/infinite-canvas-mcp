import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Input, InputNumber, Select, Switch } from "antd";
import { Camera, Image as ImageIcon, Users, Volume2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { resolveSubjectPictureBindingIds, type ProductionOperation } from "@basketikun/canvas-agent/drama/production-contract";
import { records, readableText } from "./director-display";
import { backendMediaUrl } from "@/services/backend-api";
import { ReferenceNodeLink } from "./reference-node-link";
import { SmartImageNodePicker } from "./smart-image-node-picker";
import type { ImageNodeChoice } from "./smart-image-node-options";
import { readShotFormDraft, rebaseShotFormDraft, shotDraftChanged, shotDraftSourceChanged, shotFormChanges, shotFormValue, subjectDisplayName, type ShotFormValue } from "./subject-shot-draft";

type Keyframes = Extract<ProductionOperation, { type: "set_director_shot_keyframes" }>["keyframes"];
type Utterances = Extract<ProductionOperation, { type: "set_director_shot_utterances" }>["utterances"];
type Props = {
    shot: Record<string, any>; source: Record<string, any>;
    canvasNodes: Array<{ id: string; title?: string; type?: string; metadata?: Record<string, unknown> }>; canvasId: string; busy: boolean;
    draftValue?: string; onDraftChange: (value: string | undefined) => void;
    workbench?: Record<string, any>;
    assets?: Record<string, any>;
    onSave: (shotId: string, patch: Record<string, unknown>, keyframes?: Keyframes, utterances?: Utterances) => Promise<boolean>;
};

export function SubjectShotEditor({ shot, source, canvasNodes, canvasId, busy, draftValue, onDraftChange, onSave, workbench, assets = {} }: Props) {
    const { t } = useTranslation(), { message } = App.useApp();
    const id = String(shot.id), { draft, invalid } = readShotFormDraft(draftValue, shot, source), value = draft.value;
    const dirty = shotDraftChanged(draft), changedSource = dirty && shotDraftSourceChanged(draft, shot, source);
    const [section, setSection] = useState<"direction" | "subjects" | "anchors">("direction");
    const [subjectChoice, setSubjectChoice] = useState<string>();
    const [utteranceChoice, setUtteranceChoice] = useState<string>();
    const [keyframeNode, setKeyframeNode] = useState<ImageNodeChoice>();
    const [saving, setSaving] = useState(false);
    const latestDraft = useRef(draftValue); latestDraft.current = draftValue;
    const disabled = busy || saving || invalid;
    const subjects = records(source.subject_registry), facts = records(source.ledger?.facts);
    const smartNodes = canvasNodes.filter(node => node.type === "config" && node.metadata?.smart === true && (node.metadata?.generationMode || "image") === "image");
    const keyframeChoiceValid = Boolean(keyframeNode && (keyframeNode.projectId !== canvasId || smartNodes.some(node => node.id === keyframeNode.nodeId)) && !value.keyframes.some(frame => frame.sourceNode?.projectId === keyframeNode.projectId && frame.sourceNode?.nodeId === keyframeNode.nodeId));
    useEffect(() => { if (keyframeNode && !keyframeChoiceValid) setKeyframeNode(undefined); }, [keyframeNode, keyframeChoiceValid]);
    const fps = Number(source.fps_num || 24) / Number(source.fps_den || 1);
    const voiceMinimum = Math.max(1, ...(value.utterances || []).map(row => row.localEndFrame));
    const continuousVoice = records(shot.utterance_refs).some(ref => records(source.utterances).some(utterance => utterance.id === ref.utteranceId && utterance.end?.shotId !== shot.id));
    const update = (patch: Partial<ShotFormValue>) => {
        if (invalid) return;
        const next = { ...draft, value: { ...value, ...patch } };
        onDraftChange(!shotDraftChanged(next) && !shotDraftSourceChanged(next, shot) ? undefined : JSON.stringify(next));
    };
    const camera = (patch: Record<string, unknown>) => update({ camera: { ...value.camera, ...patch } });
    const usagePatch = (index: number, patch: Record<string, unknown>) => update({ subject_usages: value.subject_usages.map((item, n) => n === index ? { ...item, ...patch } : item) });
    const framePatch = (index: number, patch: Record<string, unknown>) => update({ keyframes: value.keyframes.map((item, n) => n === index ? { ...item, ...patch } : item) });
    const utteranceRows = value.utterances || [];
    const utterancePatch = (index: number, patch: Record<string, unknown>) => update({ utterances: utteranceRows.map((item, n) => n === index ? { ...item, ...patch } : item) });
    const addUtterance = () => {
        if (!utteranceChoice) return;
        update({ utterances: [...utteranceRows, { utteranceId: "", speakerSubjectId: utteranceChoice, text: "", delivery: "", voiceover: false, localStartFrame: 0, localEndFrame: Math.min(12, value.duration_frames) }] });
        setUtteranceChoice(undefined);
    };
    const addSubject = () => {
        if (!subjectChoice || value.subject_usages.some(item => item.subjectId === subjectChoice)) return;
        const subject = subjects.find(item => item.id === subjectChoice);
        update({ subject_usages: [...value.subject_usages, { subjectId: subjectChoice, presentation: "visible", pictureBindingIds: resolveSubjectPictureBindingIds(subject, { presentation: "visible", referencePurpose: ["identity"], stateRequirements: [] }).bindingIds, referencePurpose: ["identity"], continuityFactIds: [], stateRequirements: [] }] });
        setSubjectChoice(undefined);
    };
    const addKeyframe = () => {
        if (!keyframeNode || !keyframeChoiceValid) return;
        const keyframeId = `KF:${id}:${encodeURIComponent(keyframeNode.projectId)}:${encodeURIComponent(keyframeNode.nodeId)}`;
        update({ keyframes: [...value.keyframes, { id: keyframeId, assetId: keyframeNode.assetId || keyframeId, sourceNode: { projectId: keyframeNode.projectId, nodeId: keyframeNode.nodeId }, selection: { mode: "node_selection" }, anchor: "composition", subjectIds: value.subject_usages.filter(item => item.presentation === "visible").map(item => String(item.subjectId)), retain: ["构图", "人物调度"], exclude: ["身份变化", "未登记人物"], requiredForSubmission: false }] });
        setKeyframeNode(undefined);
    };
    const save = async () => {
        if (!Number.isInteger(value.duration_frames) || value.duration_frames < 1) return void message.error(t("director.workspace.durationFramesInvalid"));
        if (value.duration_frames < voiceMinimum) return void message.error(t("director.atomic.voiceDurationRequired", { frames: voiceMinimum }));
        if (continuousVoice && value.duration_frames !== Number(shot.duration_frames)) return void message.error(t("director.atomic.continuousVoiceDuration"));
        if (invalid || changedSource) return;
        const submittedDraft = draftValue;
        setSaving(true);
        try {
            const changes = shotFormChanges(draft);
            if (await onSave(id, changes.patch, changes.keyframes as Keyframes | undefined, changes.utterances as Utterances | undefined)) {
                if (latestDraft.current === submittedDraft) onDraftChange(undefined);
                message.success(t("director.atomic.savedAndCompiling"));
            }
        } finally { setSaving(false); }
    };
    return <section className="space-y-5" data-subject-shot-editor={id}>
        {invalid && <Alert type="warning" message={t("director.atomic.invalidDraft")} description={<details><summary>{t("director.atomic.reviewDraft")}</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">{draftValue}</pre><Button size="small" onClick={() => onDraftChange(undefined)}>{t("director.atomic.resetDraft")}</Button></details>} />}
        {changedSource && <Alert type="warning" message={t("director.atomic.sourceChanged")} description={<details><summary>{t("director.atomic.reviewCurrentSource")}</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(shotFormValue(shot, source), null, 2)}</pre><Button className="mt-2" size="small" onClick={() => onDraftChange(JSON.stringify(rebaseShotFormDraft(draft, shot)))}>{t("director.atomic.keepReviewedDraft")}</Button></details>} />}
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_120px_120px]">
            <label className="grid gap-1.5 text-xs text-muted-foreground"><span>{t("director.atomic.shotTitle")}</span><Input value={value.title} disabled={disabled} onChange={event => update({ title: event.target.value })} /></label>
            <label className="grid gap-1.5 text-xs text-muted-foreground"><span>{t("director.atomic.seconds")}</span><InputNumber className="w-full" min={0} step={1 / fps} precision={3} value={value.duration_frames / fps} disabled={disabled} onChange={seconds => update({ duration_frames: Math.round(Number(seconds || 0) * fps) })} /></label>
            <label className="grid gap-1.5 text-xs text-muted-foreground"><span>{t("director.workspace.durationFrames")}</span><InputNumber className="w-full" min={1} precision={0} value={value.duration_frames} disabled={disabled} onChange={frames => update({ duration_frames: Number(frames || 0) })} /></label>
        </div>
        <div className="flex gap-5 border-b border-border" role="tablist" aria-label={t("director.atomic.shotSections")}>{(["direction", "subjects", "anchors"] as const).map(key => <button type="button" key={key} role="tab" aria-selected={section === key} onClick={() => setSection(key)} className={`flex items-center gap-2 border-b-2 py-2 text-sm ${section === key ? "border-primary font-medium" : "border-transparent text-muted-foreground"}`}>{key === "direction" ? <Camera className="size-3.5" /> : key === "subjects" ? <Users className="size-3.5" /> : <ImageIcon className="size-3.5" />}{t("director.atomic.section." + key)}</button>)}</div>
        {section === "direction" && <div className="space-y-4">
            <label className="grid gap-2 text-sm"><span className="font-medium">{t("director.atomic.action")}</span><Input.TextArea value={value.visual} autoSize={{ minRows: 4, maxRows: 10 }} disabled={disabled} onChange={event => update({ visual: event.target.value })} /><span className="text-xs text-muted-foreground">{t("director.atomic.actionHint")}</span></label>
            <div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1.5 text-xs text-muted-foreground"><span>{t("director.atomic.framing")}</span><Select value={value.camera.framing || undefined} disabled={disabled} placeholder={t("director.atomic.chooseFraming")} options={["EWS", "WS", "FS", "MS", "MCU", "CU", "ECU"].map(key => ({ value: key, label: t("director.atomic.framingName." + key) }))} onChange={framing => camera({ framing })} /></label><label className="grid gap-1.5 text-xs text-muted-foreground"><span>{t("director.atomic.angle")}</span><Input value={String(value.camera.angle || "")} disabled={disabled} onChange={event => camera({ angle: event.target.value })} /></label></div>
            <label className="grid gap-1.5 text-xs text-muted-foreground"><span>{t("director.atomic.attention")}</span><Select mode="multiple" value={value.camera.attention_subject_ids || []} disabled={disabled} options={subjects.map(subject => ({ value: String(subject.id), label: subjectDisplayName(source, String(subject.id)) }))} onChange={attention_subject_ids => camera({ attention_subject_ids })} /></label>
            <label className="grid gap-1.5 text-xs text-muted-foreground"><span>{t("director.atomic.cameraPath")}</span><Input.TextArea value={String(value.camera.path || "")} autoSize={{ minRows: 2, maxRows: 5 }} disabled={disabled} onChange={event => camera({ path: event.target.value })} /></label>
            <label className="grid gap-1.5 text-xs text-muted-foreground"><span>{t("director.atomic.editorialReason")}</span><Input.TextArea value={String(value.camera.editorial_reason || "")} autoSize={{ minRows: 2, maxRows: 5 }} disabled={disabled} onChange={event => camera({ editorial_reason: event.target.value })} /></label>
            <section className="space-y-2 border-t border-border pt-4"><h4 className="flex items-center gap-2 text-sm font-medium"><Volume2 className="size-4" />{t("director.atomic.sound")}</h4><Input.TextArea value={typeof value.audio === "string" ? value.audio : readableText(value.audio)} autoSize={{ minRows: 2, maxRows: 5 }} disabled={disabled} onChange={event => update({ audio: value.audio && typeof value.audio === "object" && !Array.isArray(value.audio) ? { ...value.audio as Record<string, unknown>, description: event.target.value } : event.target.value })} />
                {utteranceRows.map((item, index) => <article key={item.utteranceId || `new:${index}`} className="space-y-2 rounded-lg border border-border p-3">
                    <div className="flex items-center gap-2">
                        <Select className="min-w-0 flex-1" value={item.speakerSubjectId || undefined} disabled={disabled} placeholder={t("director.atomic.dialogueSpeaker")} options={subjects.map(subject => ({ value: String(subject.id), label: subjectDisplayName(source, String(subject.id)) }))} onChange={speakerSubjectId => utterancePatch(index, { speakerSubjectId })} />
                        <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><Switch size="small" checked={item.voiceover} disabled={disabled} onChange={voiceover => utterancePatch(index, { voiceover })} />{t("director.atomic.offscreen")}</label>
                        <Button size="small" type="text" disabled={disabled} onClick={() => update({ utterances: utteranceRows.filter((_, n) => n !== index) })}>{t("common.remove")}</Button>
                    </div>
                    <Input.TextArea value={item.text} autoSize={{ minRows: 2, maxRows: 5 }} disabled={disabled} placeholder={t("director.atomic.dialogueText")} onChange={event => utterancePatch(index, { text: event.target.value })} />
                    <div className="grid grid-cols-3 gap-2">
                        <Input value={item.delivery} disabled={disabled} placeholder={t("director.atomic.dialogueDelivery")} onChange={event => utterancePatch(index, { delivery: event.target.value })} />
                        <InputNumber className="w-full" min={0} max={value.duration_frames - 1} precision={0} value={item.localStartFrame} disabled={disabled} placeholder={t("director.atomic.dialogueStart")} onChange={localStartFrame => utterancePatch(index, { localStartFrame: Number(localStartFrame || 0) })} />
                        <InputNumber className="w-full" min={1} max={value.duration_frames} precision={0} value={item.localEndFrame} disabled={disabled} placeholder={t("director.atomic.dialogueEnd")} onChange={localEndFrame => utterancePatch(index, { localEndFrame: Number(localEndFrame || 0) })} />
                    </div>
                </article>)}
                <div className="flex gap-2"><Select className="min-w-0 flex-1" value={utteranceChoice} disabled={disabled} placeholder={t("director.atomic.dialogueAdd")} options={subjects.filter(subject => !utteranceRows.some(item => item.speakerSubjectId === String(subject.id) && !item.text.trim() && !item.utteranceId)).map(subject => ({ value: String(subject.id), label: subjectDisplayName(source, String(subject.id)) }))} onChange={setUtteranceChoice} /><Button disabled={disabled || !utteranceChoice} onClick={addUtterance}>{t("director.atomic.dialogueAdd")}</Button></div>
                {utteranceRows.length > 0 && <p className="text-xs text-muted-foreground">{t("director.atomic.dialogueSourceHint")}</p>}
            </section>
        </div>}
        {section === "subjects" && <div className="space-y-4"><p className="text-xs text-muted-foreground">{t("director.atomic.subjectHint")}</p>{value.subject_usages.map((usage, index) => {
            const subject = subjects.find(item => item.id === usage.subjectId), ownFacts = facts.filter(fact => fact.object_kind === subject?.entityRef?.kind && fact.object_id === subject?.entityRef?.id);
            return <article key={usage.subjectId} className="space-y-3 rounded-lg border border-border p-4"><div className="flex items-center justify-between gap-3"><h4 className="text-sm font-medium">{subjectDisplayName(source, String(usage.subjectId))}</h4><Button size="small" type="text" disabled={disabled} onClick={() => update({ subject_usages: value.subject_usages.filter((_, n) => n !== index) })}>{t("common.remove")}</Button></div>
                <Select className="w-full" value={String(usage.presentation)} disabled={disabled} options={["visible", "offscreen_voice", "state_context"].map(key => ({ value: key, label: t("director.workspace.subjectPresentation." + key) }))} onChange={presentation => usagePatch(index, { presentation })} />
                <div className="grid grid-cols-2 gap-3"><label className="grid gap-1 text-xs text-muted-foreground"><span>{t("director.atomic.appearFrom")}</span><InputNumber className="w-full" min={0} max={value.duration_frames - 1} value={usage.localStartFrame} disabled={disabled} onChange={localStartFrame => usagePatch(index, { localStartFrame: localStartFrame ?? undefined })} /></label><label className="grid gap-1 text-xs text-muted-foreground"><span>{t("director.atomic.appearUntil")}</span><InputNumber className="w-full" min={1} max={value.duration_frames} value={usage.localEndFrame} disabled={disabled} onChange={localEndFrame => usagePatch(index, { localEndFrame: localEndFrame ?? undefined })} /></label></div>
                <label className="grid gap-1 text-xs text-muted-foreground"><span>{t("director.workspace.pictureBindingsForShot")}</span><Select mode="multiple" value={usage.pictureBindingIds || []} disabled={disabled} options={records(subject?.pictureBindings).map(binding => ({ value: String(binding.id), label: (binding.sourceNode?.projectId === canvasId ? canvasNodes.find(node => node.id === binding.sourceNode?.nodeId)?.title : undefined) || t("director.crud.boundImage") }))} onChange={pictureBindingIds => usagePatch(index, { pictureBindingIds })} /></label>
                {!usage.pictureBindingIds?.length && <p className="text-xs text-muted-foreground">{t("director.workspace.pictureBindingDefaultHint")}</p>}
                <label className="grid gap-1 text-xs text-muted-foreground"><span>{t("director.crud.provides")}</span><Select mode="multiple" value={usage.referencePurpose || []} disabled={disabled} options={[...new Set(["identity", "geometry", "material", "clothing", "composition", "pose", "prop", "style", ...(usage.referencePurpose || [])])].map(purpose => ({ value: purpose, label: t(`director.crud.purpose.${purpose}`, { defaultValue: t("director.crud.otherPurpose") }) }))} onChange={referencePurpose => usagePatch(index, { referencePurpose })} /></label>
                <label className="grid gap-1 text-xs text-muted-foreground"><span>{t("director.atomic.factSelection")}</span><Select mode="multiple" value={usage.continuityFactIds || []} disabled={disabled} options={ownFacts.map(fact => ({ value: String(fact.id), label: String(fact.display_name || fact.name || (/[\u4e00-\u9fff]/.test(fact.description || "") ? fact.description : t("director.workspace.continuity.factNumber", { count: facts.indexOf(fact) + 1 }))) }))} onChange={continuityFactIds => usagePatch(index, { continuityFactIds })} /></label>
            </article>;
        })}<div className="flex gap-2"><Select className="min-w-0 flex-1" value={subjectChoice} disabled={disabled} placeholder={t("director.workspace.chooseSubject")} options={subjects.filter(subject => !value.subject_usages.some(usage => usage.subjectId === subject.id)).map(subject => ({ value: String(subject.id), label: subjectDisplayName(source, String(subject.id)) }))} onChange={setSubjectChoice} /><Button disabled={disabled || !subjectChoice} onClick={addSubject}>{t("director.workspace.addSubject")}</Button></div></div>}
        {section === "anchors" && <div className="space-y-4"><p className="text-sm text-muted-foreground">{t("director.crud.frameWorkflow")}</p><ReferenceNodeLink sourceNode={{ projectId: canvasId }} label={t("director.crud.createImageOnCanvas")} />
          {value.keyframes.map((frame, index) => {
            const resolved = records(workbench?.keyframes).find(item => item.id === frame.id)?.resolved;
            return <article key={frame.id} className="space-y-3 rounded-lg border border-border p-4"><div className="flex items-start justify-between gap-3"><div className="flex min-w-0 gap-3">{resolved?.storageKey && <img className="h-24 w-32 shrink-0 rounded object-contain" src={backendMediaUrl(resolved.storageKey)} alt={t("director.crud.frameNumber", { number: index + 1 })} />}<div><h4 className="text-sm font-medium">{(frame.sourceNode?.projectId === canvasId ? canvasNodes.find(node => node.id === frame.sourceNode?.nodeId)?.title : undefined) || t("director.crud.frameNumber", { number: index + 1 })}</h4><ReferenceNodeLink sourceNode={frame.sourceNode} />{!resolved?.storageKey && <p className="mt-2 text-xs text-muted-foreground">{t("director.crud.previewAfterSave")}</p>}</div></div><Button size="small" type="text" disabled={disabled} onClick={() => update({ keyframes: value.keyframes.filter((_, n) => n !== index) })}>{t("director.crud.unbindFrame")}</Button></div>
              <label className="grid gap-1 text-xs"><span>{t("director.crud.replaceImage")}</span><SmartImageNodePicker canvasId={canvasId} canvasNodes={canvasNodes} assets={assets} assetPlan={records(source.asset_plan)} value={frame.sourceNode} disabled={disabled} onChange={choice => framePatch(index, { sourceNode: { projectId: choice.projectId, nodeId: choice.nodeId }, assetId: choice.assetId || frame.id, selection: { mode: "node_selection" } })} /></label>
              <label className="grid gap-1 text-xs"><span>{t("director.crud.framePosition")}</span><Select value={frame.anchor} disabled={disabled} options={["composition", "opening", "closing", "at_frame"].map(key => ({ value: key, label: t("director.atomic.anchor." + key) }))} onChange={anchor => framePatch(index, { anchor, localFrame: anchor === "at_frame" ? 0 : undefined })} /></label>
              {frame.anchor === "at_frame" && <InputNumber min={0} max={value.duration_frames - 1} value={frame.localFrame} disabled={disabled} onChange={localFrame => framePatch(index, { localFrame: localFrame ?? 0 })} />}
              <Select mode="multiple" value={frame.subjectIds || []} disabled={disabled} placeholder={t("director.crud.framePeople")} options={subjects.map(subject => ({ value: String(subject.id), label: subjectDisplayName(source, String(subject.id)) }))} onChange={subjectIds => framePatch(index, { subjectIds })} />
              {(["retain", "exclude"] as const).map(field => <label key={field} className="grid gap-1 text-xs"><span>{t("director.crud." + field)}</span><Input.TextArea value={(frame[field] || []).join("\n")} disabled={disabled} autoSize={{ minRows: 2, maxRows: 4 }} placeholder={t("director.crud.chineseLines")} onChange={event => framePatch(index, { [field]: event.target.value.split("\n") })} /></label>)}
              <label className="flex items-center justify-between text-xs text-muted-foreground"><span>{t("director.atomic.requiredAnchor")}</span><Switch size="small" checked={frame.requiredForSubmission === true} disabled={disabled} onChange={requiredForSubmission => framePatch(index, { requiredForSubmission })} /></label>
            </article>;
          })}<div className="flex gap-2"><SmartImageNodePicker canvasId={canvasId} canvasNodes={canvasNodes} assets={assets} assetPlan={records(source.asset_plan)} value={keyframeNode} disabled={disabled} placeholder={t("director.workspace.chooseKeyframeNode")} exclude={value.keyframes.map(frame => frame.sourceNode || {})} onUnavailable={() => setKeyframeNode(undefined)} onChange={setKeyframeNode} /><Button disabled={disabled || !keyframeChoiceValid} onClick={addKeyframe}>{t("director.crud.bindFrame")}</Button></div><p className="text-xs text-muted-foreground">{t("director.crud.saveBindingHint")}</p></div>}
        <footer className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-card py-3"><span className="text-xs text-muted-foreground">{t(dirty ? "director.atomic.draftKept" : "director.atomic.saved")}</span><Button type="primary" loading={saving} disabled={disabled || !dirty || changedSource} onClick={() => void save()}>{t("director.atomic.saveShot")}</Button></footer>
    </section>;
}
