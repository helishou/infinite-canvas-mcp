import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, App, Button, Cascader, Input, InputNumber, Select, Switch } from "antd";
import { Camera, History, Image as ImageIcon, Users, Volume2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { resolveSubjectPictureBindingIds, type ProductionOperation } from "@basketikun/canvas-agent/drama/production-contract";
import { keyframeSubjectSelectionFromPaths, setShotOutfitBindingIds, setShotPictureBindingIds, setShotPictureBindingMode, shotPictureBindingMode, syncKeyframeSubjectsToShotUsages } from "./subject-picture-selection";
import { records, readableText } from "./director-display";
import { backendMediaUrl } from "@/services/backend-api";
import { canvasNodeImage } from "@/lib/canvas/canvas-image-renderability";
import { ReferenceNodeLink } from "./reference-node-link";
import { SmartImageNodePicker } from "./smart-image-node-picker";
import type { ImageNodeChoice } from "./smart-image-node-options";
import { normalizeUtteranceVoiceovers, readShotFormDraft, rebaseShotFormDraft, shotDraftChanged, shotDraftSourceChanged, shotFormChanges, shotFormValue, speakerOnCamera, subjectDisplayName, type ShotFormValue, type ShotUtteranceValue } from "./subject-shot-draft";
import { AudioDesignEditor } from "./audio-design-editor";

type Keyframes = Extract<ProductionOperation, { type: "set_director_shot_keyframes" }>["keyframes"];
type Utterances = Extract<ProductionOperation, { type: "set_director_shot_utterances" }>["utterances"];
type Props = {
    shot: Record<string, any>; source: Record<string, any>;
    canvasNodes: Array<{ id: string; title?: string; type?: string; metadata?: Record<string, unknown> }>; canvasId: string; busy: boolean;
    draftValue?: string; onDraftChange: (value: string | undefined) => void;
    workbench?: Record<string, any>;
    assets?: Record<string, any>; preview?: ReactNode;
    onSave: (shotId: string, patch: Record<string, unknown>, keyframes?: Keyframes, utterances?: Utterances) => Promise<boolean>;
};

export function SubjectShotEditor({ shot, source, canvasNodes, canvasId, busy, draftValue, onDraftChange, onSave, workbench, assets = {}, preview }: Props) {
    const { t } = useTranslation(), { message } = App.useApp();
    const id = String(shot.id), { draft, invalid } = readShotFormDraft(draftValue, shot, source), value = draft.value;
    const dirty = shotDraftChanged(draft), changedSource = dirty && shotDraftSourceChanged(draft, shot, source);
    const sectionControl: { current: "direction" | "sound" | "subjects" | "anchors"; select: (key: "direction" | "sound" | "subjects" | "anchors") => void } | undefined = workbench && typeof (workbench as Record<string, any>).__sectionControl === "object" ? (workbench as Record<string, any>).__sectionControl : undefined;
    const [section, setSection] = useState<"direction" | "sound" | "subjects" | "anchors">(sectionControl?.current || "direction");
    // 「参考与连续性」从右上角独立按钮收编为页签：工作台把 detailView 开关挂到 workbench.__contextControl，选中时表单体隐藏、上下文侧栏显示。
    const contextControl: { active: boolean; enter: () => void; exit: () => void } | undefined = workbench && typeof (workbench as Record<string, any>).__contextControl === "object" ? (workbench as Record<string, any>).__contextControl : undefined;
    const [subjectChoice, setSubjectChoice] = useState<string>();
    const [utteranceChoice, setUtteranceChoice] = useState<string>();
    const [keyframeNode, setKeyframeNode] = useState<ImageNodeChoice>();
    const [compositionNode, setCompositionNode] = useState<ImageNodeChoice>();
    const [saving, setSaving] = useState(false);
    const latestDraft = useRef(draftValue); latestDraft.current = draftValue;
    const disabled = busy || saving || invalid;
    const subjects = records(source.subject_registry);
    const smartNodes = canvasNodes.filter(node => node.type === "config" && node.metadata?.smart === true && (node.metadata?.generationMode || "image") === "image");
    const keyframeChoiceValid = Boolean(keyframeNode && (keyframeNode.projectId !== canvasId || smartNodes.some(node => node.id === keyframeNode.nodeId)) && !value.keyframes.some(frame => frame.sourceNode?.projectId === keyframeNode.projectId && frame.sourceNode?.nodeId === keyframeNode.nodeId));
    const compositionChoiceValid = Boolean(compositionNode && (compositionNode.projectId !== canvasId || smartNodes.some(node => node.id === compositionNode.nodeId)) && !value.reference_requirements.some(reference => reference.sourceNode?.projectId === compositionNode.projectId && reference.sourceNode?.nodeId === compositionNode.nodeId));
    useEffect(() => { if (keyframeNode && !keyframeChoiceValid) setKeyframeNode(undefined); }, [keyframeNode, keyframeChoiceValid]);
    useEffect(() => { if (compositionNode && !compositionChoiceValid) setCompositionNode(undefined); }, [compositionNode, compositionChoiceValid]);
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
    const referencePatch = (index: number, patch: Record<string, unknown>) => update({ reference_requirements: value.reference_requirements.map((item, n) => n === index ? { ...item, ...patch } : item) });
    const utteranceRows = value.utterances || [];
    // 画外与否从出场方式推导（显示实时跟随主体页签的修改）；未登记主体用法的旧稿尊重存量标志。
    const usageTracked = value.subject_usages.length > 0;
    const voiceoverOf = (item: ShotUtteranceValue) => usageTracked ? !speakerOnCamera(value.subject_usages, item.speakerSubjectId) : item.voiceover;
    const utterancePatch = (index: number, patch: Record<string, unknown>) => update({ utterances: utteranceRows.map((item, n) => n === index ? { ...item, ...patch } : item) });
    const addUtterance = () => {
        if (!utteranceChoice) return;
        update({ utterances: [...utteranceRows, { utteranceId: "", speakerSubjectId: utteranceChoice, text: "", delivery: "", voiceover: !speakerOnCamera(value.subject_usages, utteranceChoice), localStartFrame: 0, localEndFrame: Math.min(12, value.duration_frames) }] });
        setUtteranceChoice(undefined);
    };
    const addSubject = () => {
        if (!subjectChoice || value.subject_usages.some(item => item.subjectId === subjectChoice)) return;
        const subject = subjects.find(item => item.id === subjectChoice);
        update({ subject_usages: [...value.subject_usages, { subjectId: subjectChoice, presentation: "visible", pictureBindingIds: [], pictureBindingMode: "default", referencePurpose: ["identity"], continuityFactIds: [], stateRequirements: [] }] });
        setSubjectChoice(undefined);
    };
    const addKeyframe = () => {
        if (!keyframeNode || !keyframeChoiceValid) return;
        const keyframeId = `KF:${id}:${encodeURIComponent(keyframeNode.projectId)}:${encodeURIComponent(keyframeNode.nodeId)}`;
        update({ keyframes: [...value.keyframes, { id: keyframeId, assetId: keyframeNode.assetId || keyframeId, sourceNode: { projectId: keyframeNode.projectId, nodeId: keyframeNode.nodeId }, selection: { mode: "node_selection" }, anchor: "opening", subjectIds: value.subject_usages.filter(item => item.presentation === "visible").map(item => String(item.subjectId)), retain: ["关键帧中的构图", "人物调度"], exclude: ["身份变化", "未登记人物"], requiredForSubmission: true }] });
        setKeyframeNode(undefined);
    };
    const addCompositionReference = () => {
        if (!compositionNode || !compositionChoiceValid) return;
        const referenceId = `CR:${id}:${encodeURIComponent(compositionNode.projectId)}:${encodeURIComponent(compositionNode.nodeId)}`;
        const assetId = String(compositionNode.assetId || referenceId);
        const asset = records(source.asset_plan).find(item => String(item.asset_id || item.id || "") === assetId);
        const version = String(asset?.version || assets[assetId]?.version || `node:${compositionNode.nodeId}`);
        update({ reference_requirements: [...value.reference_requirements, {
            id: referenceId, asset_id: assetId, asset_version: version, purpose: "构图参考",
            sourceNode: { projectId: compositionNode.projectId, nodeId: compositionNode.nodeId }, selection: { mode: "node_selection" },
            retain: ["构图", "机位", "主体空间关系"], exclude: ["未登记人物", "身份变化"], requiredForSubmission: true,
        }] });
        setCompositionNode(undefined);
    };
    const outfitBindingLabel = (subject: Record<string, any>, binding: Record<string, any>) => {
        const node = canvasNodes.find(item => item.id === binding.sourceNode?.nodeId);
        const asset = assets?.[String(binding.assetId || binding.id)];
        const usageWorkbench = records(workbench?.subjectUsages).find(item => String(item.subjectId) === String(subject.id));
        const resolvedBinding = records(usageWorkbench?.pictureBindings).find(item => String(item.id) === String(binding.id));
        const resultId = String(binding.selection?.resultId || "");
        const images = records(node?.metadata?.characterImages);
        const image = images.find(item => {
            const key = String(item.storageKey || item.url || item.name || "");
            return [key, String(item.storageKey || ""), `${node?.id}:character-image:${key}`].includes(resultId)
                || Boolean(resolvedBinding?.resolved?.storageKey && item.storageKey === resolvedBinding.resolved.storageKey);
        }) || (binding.selection?.mode === "node_selection" ? images[Number(node?.metadata?.characterPrimaryIndex || 0)] : undefined);
        const label = image?.outfit || image?.outfitDescription || image?.name || asset?.title || asset?.label || binding.id;
        return [label, node?.title].map(value => String(value || "").trim()).filter(Boolean).join(" · ");
    };
    const save = async () => {
        if (!Number.isInteger(value.duration_frames) || value.duration_frames < 1) return void message.error(t("director.workspace.durationFramesInvalid"));
        if (value.duration_frames < voiceMinimum) return void message.error(t("director.atomic.voiceDurationRequired", { frames: voiceMinimum }));
        if (continuousVoice && value.duration_frames !== Number(shot.duration_frames)) return void message.error(t("director.atomic.continuousVoiceDuration"));
        if (invalid || changedSource) return;
        const submittedDraft = draftValue;
        setSaving(true);
        try {
            const changes = shotFormChanges({ ...draft, value: normalizeUtteranceVoiceovers(structuredClone(draft.value)) });
            const legacyCompositionFrames = records(shot.keyframes).some(frame => frame.anchor === "composition");
            if (legacyCompositionFrames) {
                changes.keyframes = draft.value.keyframes as Keyframes;
                changes.patch.reference_requirements = draft.value.reference_requirements;
            }
            if (changes.keyframes !== undefined) {
                changes.patch.subject_usages = syncKeyframeSubjectsToShotUsages(draft.value.subject_usages, draft.value.keyframes, subjects);
            }
            // 提交前滤掉编辑期保留的空白拟音槽位（空串不进源稿契约），只影响即将发出的补丁。
            if (changes.patch.audio && typeof changes.patch.audio === "object" && Array.isArray((changes.patch.audio as Record<string, unknown>).foley)) changes.patch.audio = { ...(changes.patch.audio as Record<string, unknown>), foley: records((changes.patch.audio as Record<string, unknown>).foley).map(String).filter(text => text.trim()) };
            if (await onSave(id, changes.patch, changes.keyframes as Keyframes | undefined, changes.utterances as Utterances | undefined)) {
                if (latestDraft.current === submittedDraft) onDraftChange(undefined);
                message.success(t("director.atomic.savedAndCompiling"));
            }
        } finally { setSaving(false); }
    };
    return <section className="space-y-5" data-subject-shot-editor={id}>
        {invalid && <Alert type="warning" message={t("director.atomic.invalidDraft")} description={<details><summary>{t("director.atomic.reviewDraft")}</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">{draftValue}</pre><Button size="small" onClick={() => onDraftChange(undefined)}>{t("director.atomic.resetDraft")}</Button></details>} />}
        {changedSource && <Alert type="warning" message={t("director.atomic.sourceChanged")} description={<details><summary>{t("director.atomic.reviewCurrentSource")}</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(shotFormValue(shot, source), null, 2)}</pre><Button className="mt-2" size="small" onClick={() => onDraftChange(JSON.stringify(rebaseShotFormDraft(draft, shot)))}>{t("director.atomic.keepReviewedDraft")}</Button></details>} />}
        <div className="shot-editor-heading">
        <div className="flex gap-5 border-b border-border" role="tablist" aria-label={t("director.atomic.shotSections")}>{([["direction", Camera], ["sound", Volume2], ["subjects", Users], ["anchors", ImageIcon]] as const).map(([key, Icon]) => <button type="button" key={key} role="tab" aria-selected={section === key && !contextControl?.active} onClick={() => { if (contextControl?.active) contextControl.exit(); setSection(key); sectionControl?.select(key); }} className={`flex items-center gap-2 border-b-2 py-2 text-sm ${section === key && !contextControl?.active ? "border-primary font-medium" : "border-transparent text-muted-foreground"}`}><Icon className="size-3.5" />{t("director.atomic.section." + key)}</button>)}{contextControl && <button type="button" role="tab" aria-selected={contextControl.active} onClick={contextControl.enter} className={`flex items-center gap-2 border-b-2 py-2 text-sm ${contextControl.active ? "border-primary font-medium" : "border-transparent text-muted-foreground"}`}><History className="size-3.5" />{t("director.atomic.contextTab")}</button>}</div>
        </div><div className="shot-editor-scroll" data-shot-editor-scroll hidden={Boolean(contextControl?.active)}>
        {section === "direction" && <div className="shot-editor-form-grid">
            <div className="shot-editor-fields shot-editor-span-all grid gap-3 sm:grid-cols-[minmax(0,1fr)_120px]">
                <label className="grid gap-1.5 text-xs text-muted-foreground"><span>{t("director.atomic.shotTitle")}</span><Input value={value.title} disabled={disabled} onChange={event => update({ title: event.target.value })} /></label>
                <label className="grid gap-1.5 text-xs text-muted-foreground"><span>{t("director.atomic.seconds")}</span><InputNumber className="w-full" min={0} step={1 / fps} precision={3} value={value.duration_frames / fps} disabled={disabled} onChange={seconds => update({ duration_frames: Math.round(Number(seconds || 0) * fps) })} /></label>
            </div>
            <label className="shot-editor-span-all grid gap-2 text-sm"><span className="font-medium">{t("director.atomic.action")}</span><Input.TextArea value={value.visual} autoSize={{ minRows: 4, maxRows: 10 }} disabled={disabled} onChange={event => update({ visual: event.target.value })} /><span className="text-xs text-muted-foreground">{t("director.atomic.actionHint")}</span></label>
            <label className="grid gap-1.5 text-xs text-muted-foreground"><span>{t("director.atomic.framing")}</span><Select value={value.camera.framing || undefined} disabled={disabled} placeholder={t("director.atomic.chooseFraming")} options={["EWS", "WS", "FS", "MS", "MCU", "CU", "ECU"].map(key => ({ value: key, label: t("director.atomic.framingName." + key) }))} onChange={framing => camera({ framing })} /></label>
            <label className="grid gap-1.5 text-xs text-muted-foreground"><span>{t("director.atomic.angle")}</span><Input value={String(value.camera.angle || "")} disabled={disabled} onChange={event => camera({ angle: event.target.value })} /></label>
            <label className="grid gap-1.5 text-xs text-muted-foreground"><span>{t("director.atomic.cameraPath")}</span><Input.TextArea value={String(value.camera.path || "")} autoSize={{ minRows: 2, maxRows: 5 }} disabled={disabled} onChange={event => camera({ path: event.target.value })} /></label>
            <label className="grid gap-1.5 text-xs text-muted-foreground"><span>{t("director.atomic.editorialReason")}</span><Input.TextArea value={String(value.camera.editorial_reason || "")} autoSize={{ minRows: 2, maxRows: 5 }} disabled={disabled} onChange={event => camera({ editorial_reason: event.target.value })} /></label>
            <details className="shot-advanced-settings shot-editor-span-all"><summary>{t("director.atomic.moreCameraSettings")}<span>{t("director.atomic.exactFrameSummary", { frames: value.duration_frames })}</span></summary><div className="shot-editor-form-grid pt-3">
            <div className="grid gap-1.5 text-xs text-muted-foreground">
                <span>{t("director.atomic.attention")}</span>
                <Select className="w-full" aria-label={t("director.atomic.attention")} mode="multiple" value={value.camera.attention_subject_ids || []} disabled={disabled} options={subjects.map(subject => ({ value: String(subject.id), label: subjectDisplayName(source, String(subject.id)) }))} onChange={attention_subject_ids => camera({ attention_subject_ids })} />
                <Button size="small" type="text" disabled={disabled} onClick={() => {
                    const visibleSubjectIds = value.subject_usages
                        .filter(item => item.presentation === "visible")
                        .map(item => String(item.subjectId));
                    camera({ attention_subject_ids: [...new Set([...(value.camera.attention_subject_ids || []), ...visibleSubjectIds])] });
                }}>{t("director.atomic.addOnCameraSubjects")}</Button>
            </div>
            </div></details>
        </div>}
        {section === "sound" && <div className="shot-editor-form-grid">
            <section className="shot-editor-span-all space-y-2"><h4 className="flex items-center gap-2 text-sm font-medium"><Volume2 className="size-4" />{t("director.atomic.sound")}</h4><Input.TextArea value={typeof value.audio === "string" ? value.audio : readableText(value.audio)} autoSize={{ minRows: 2, maxRows: 5 }} disabled={disabled} onChange={event => update({ audio: value.audio && typeof value.audio === "object" && !Array.isArray(value.audio) ? { ...value.audio as Record<string, unknown>, description: event.target.value } : event.target.value })} />
            {/* A 类补齐：结构化声音字段（逐条 foley / 低频约束）原先只能靠上面的自由文本带过，跟随整表单草稿一起保存。 */}
            {value.audio != null && typeof value.audio === "object" && !Array.isArray(value.audio) ? <AudioDesignEditor key={id} value={value.audio} disabled={disabled} onChange={nextAudio => update({ audio: nextAudio })} /> : null}
            </section>
            {utteranceRows.map((item, index) => <article key={item.utteranceId || `new:${index}`} className="space-y-2 rounded-lg border border-border p-3">
                    <div className="flex items-center gap-2">
                        <Select className="min-w-0 flex-1" value={item.speakerSubjectId || undefined} disabled={disabled} placeholder={t("director.atomic.dialogueSpeaker")} options={subjects.map(subject => ({ value: String(subject.id), label: subjectDisplayName(source, String(subject.id)) }))} onChange={speakerSubjectId => utterancePatch(index, { speakerSubjectId })} />
                        <label className="flex shrink-0 cursor-help items-center gap-1 text-xs text-muted-foreground" title={t("director.atomic.offscreenDerived")}><Switch size="small" checked={voiceoverOf(item)} disabled />{t("director.atomic.offscreen")}</label>
                        <Button size="small" type="text" disabled={disabled} onClick={() => update({ utterances: utteranceRows.filter((_, n) => n !== index) })}>{t("common.remove")}</Button>
                    </div>
                    <Input.TextArea value={item.text} autoSize={{ minRows: 2, maxRows: 5 }} disabled={disabled} placeholder={t("director.atomic.dialogueText")} onChange={event => utterancePatch(index, { text: event.target.value })} />
                    <div className="shot-editor-pair grid grid-cols-3 gap-2">
                        <Input value={item.delivery} disabled={disabled} placeholder={t("director.atomic.dialogueDelivery")} onChange={event => utterancePatch(index, { delivery: event.target.value })} />
                        <InputNumber className="w-full" min={0} max={value.duration_frames - 1} precision={0} value={item.localStartFrame} disabled={disabled} placeholder={t("director.atomic.dialogueStart")} onChange={localStartFrame => utterancePatch(index, { localStartFrame: Number(localStartFrame || 0) })} />
                        <InputNumber className="w-full" min={1} max={value.duration_frames} precision={0} value={item.localEndFrame} disabled={disabled} placeholder={t("director.atomic.dialogueEnd")} onChange={localEndFrame => utterancePatch(index, { localEndFrame: Number(localEndFrame || 0) })} />
                    </div>
                </article>)}
                <div className="shot-editor-span-all flex gap-2"><Select className="min-w-0 flex-1" value={utteranceChoice} disabled={disabled} placeholder={t("director.atomic.dialogueAdd")} options={subjects.filter(subject => !utteranceRows.some(item => item.speakerSubjectId === String(subject.id) && !item.text.trim() && !item.utteranceId)).map(subject => ({ value: String(subject.id), label: subjectDisplayName(source, String(subject.id)) }))} onChange={setUtteranceChoice} /><Button disabled={disabled || !utteranceChoice} onClick={addUtterance}>{t("director.atomic.dialogueAdd")}</Button></div>
                {utteranceRows.length > 0 && <p className="shot-editor-span-all text-xs text-muted-foreground">{t("director.atomic.dialogueSourceHint")}</p>}
        </div>}
        {section === "subjects" && <div className="shot-editor-form-grid"><p className="shot-editor-span-all text-xs text-muted-foreground">{t("director.atomic.subjectHint")}</p>{value.subject_usages.map((usage, index) => {
            const subject = subjects.find(item => item.id === usage.subjectId);
            const outfitBindings = records(subject?.pictureBindings).filter(binding => Array.isArray(binding.provides) && binding.provides.map(String).includes("clothing"));
            const selectedOutfits = resolveSubjectPictureBindingIds(subject, usage).bindingIds.filter(bindingId => outfitBindings.some(binding => String(binding.id) === bindingId));
            return <article key={usage.subjectId} className="space-y-3 rounded-lg border border-border p-4"><div className="flex items-center justify-between gap-3"><h4 className="text-sm font-medium">{subjectDisplayName(source, String(usage.subjectId))}</h4><Button size="small" type="text" disabled={disabled} onClick={() => update({ subject_usages: value.subject_usages.filter((_, n) => n !== index) })}>{t("common.remove")}</Button></div>
                <Select className="w-full" value={String(usage.presentation)} disabled={disabled} options={["visible", "offscreen_voice", "state_context"].map(key => ({ value: key, label: t("director.workspace.subjectPresentation." + key) }))} onChange={presentation => usagePatch(index, { presentation })} />
                <label className="grid gap-1 text-xs text-muted-foreground"><span>{t("director.atomic.shotOutfits")}</span><Select mode="multiple" value={selectedOutfits} disabled={disabled || usage.presentation !== "visible" || !outfitBindings.length} placeholder={outfitBindings.length ? t("director.atomic.chooseShotOutfits") : t("director.atomic.noShotOutfits")} options={outfitBindings.map(binding => ({ value: String(binding.id), label: outfitBindingLabel(subject!, binding) }))} onChange={pictureBindingIds => usagePatch(index, setShotOutfitBindingIds(subject, usage, pictureBindingIds))} /></label>
                <div className="shot-editor-pair grid grid-cols-2 gap-3"><label className="grid gap-1 text-xs text-muted-foreground"><span>{t("director.atomic.appearFrom")}</span><InputNumber className="w-full" min={0} max={value.duration_frames - 1} value={usage.localStartFrame} disabled={disabled} onChange={localStartFrame => usagePatch(index, { localStartFrame: localStartFrame ?? undefined })} /></label><label className="grid gap-1 text-xs text-muted-foreground"><span>{t("director.atomic.appearUntil")}</span><InputNumber className="w-full" min={1} max={value.duration_frames} value={usage.localEndFrame} disabled={disabled} onChange={localEndFrame => usagePatch(index, { localEndFrame: localEndFrame ?? undefined })} /></label></div>
                <label className="grid gap-1 text-xs text-muted-foreground"><span>{t("director.workspace.pictureBindingMode")}</span><Select value={shotPictureBindingMode(usage)} disabled={disabled} options={["default", "explicit"].map(mode => ({ value: mode, label: t(`director.workspace.pictureBindingMode${mode === "default" ? "Default" : "Explicit"}`) }))} onChange={mode => usagePatch(index, setShotPictureBindingMode(subject, usage, mode as "default" | "explicit"))} /></label>
                <label className="grid gap-1 text-xs text-muted-foreground"><span>{t("director.workspace.pictureBindingsForShot")}</span><Select mode="multiple" value={resolveSubjectPictureBindingIds(subject, usage).bindingIds} disabled={disabled || shotPictureBindingMode(usage) === "default"} options={records(subject?.pictureBindings).map(binding => { const isClothing = outfitBindings.some(item => String(item.id) === String(binding.id)); return { value: String(binding.id), label: ((binding.sourceNode?.projectId === canvasId ? canvasNodes.find(node => node.id === binding.sourceNode?.nodeId)?.title : undefined) || t("director.crud.boundImage")) + (isClothing ? ` · ${t("director.atomic.clothingManagedByOutfits")}` : ""), disabled: isClothing }; })} onChange={pictureBindingIds => { const retainedClothes = resolveSubjectPictureBindingIds(subject, usage).bindingIds.filter(id => outfitBindings.some(binding => String(binding.id) === id)); usagePatch(index, setShotPictureBindingIds(usage, [...new Set([...pictureBindingIds, ...retainedClothes])])); }} /></label>
                {shotPictureBindingMode(usage) === "default" ? <p className="text-xs text-muted-foreground">{t("director.workspace.pictureBindingDefaultHint")}</p> : !resolveSubjectPictureBindingIds(subject, usage).bindingIds.length && <p className="text-xs text-muted-foreground">{t("director.workspace.pictureBindingExplicitEmptyHint")}</p>}
                <label className="grid gap-1 text-xs text-muted-foreground"><span>{t("director.crud.provides")}</span><Select mode="multiple" value={usage.referencePurpose || []} disabled={disabled} options={[...new Set(["identity", "geometry", "material", "clothing", "composition", "pose", "prop", "style", ...(usage.referencePurpose || [])])].map(purpose => ({ value: purpose, label: t(`director.crud.purpose.${purpose}`, { defaultValue: t("director.crud.otherPurpose") }) }))} onChange={referencePurpose => usagePatch(index, { referencePurpose })} /></label>
            </article>;
        })}<div className="shot-editor-span-all flex gap-2"><Select className="min-w-0 flex-1" value={subjectChoice} disabled={disabled} placeholder={t("director.workspace.chooseSubject")} options={subjects.filter(subject => !value.subject_usages.some(usage => usage.subjectId === subject.id)).map(subject => ({ value: String(subject.id), label: subjectDisplayName(source, String(subject.id)) }))} onChange={setSubjectChoice} /><Button disabled={disabled || !subjectChoice} onClick={addSubject}>{t("director.workspace.addSubject")}</Button></div></div>}
        {section === "anchors" && <div className="shot-editor-form-grid"><div className="shot-editor-span-all space-y-3">{preview}<p className="text-sm text-muted-foreground">{t("director.crud.frameWorkflow")}</p><ReferenceNodeLink sourceNode={{ projectId: canvasId }} label={t("director.crud.createImageOnCanvas")} /></div>
          <div className="shot-editor-span-all space-y-3"><h3 className="text-sm font-medium">{t("director.crud.temporalKeyframes")}</h3><p className="text-xs text-muted-foreground">{t("director.crud.temporalKeyframesHint")}</p></div>
          {value.keyframes.map((frame, index) => {
            const resolved = records(workbench?.keyframes).find(item => item.id === frame.id)?.resolved;
            const frameSubjectIds: string[] = (frame.subjectIds || []).map(String);
            const outfitOptions = subjects.map(subject => {
                const subjectId = String(subject.id);
                const outfits = records(subject.pictureBindings).filter(binding => Array.isArray(binding.provides) && binding.provides.map(String).includes("clothing"));
                const children = [{ value: "__default__", label: t("director.atomic.keyframeDefaultOutfit") }, ...outfits.map(binding => ({ value: String(binding.id), label: outfitBindingLabel(subject, binding) }))];
                return { value: subjectId, label: subjectDisplayName(source, subjectId), children };
            });
            const outfitValues: string[][] = frameSubjectIds.flatMap((subjectId): string[][] => {
                const selected = frame.subjectPictureBindingIds?.[subjectId];
                return selected?.length ? selected.map((bindingId: string) => [subjectId, String(bindingId)]) : [[subjectId, "__default__"]];
            });
            return <article key={frame.id} className="shot-editor-span-all shot-editor-form-grid rounded-lg border border-border p-4"><div className="shot-editor-span-all flex items-start justify-between gap-3"><div className="flex min-w-0 gap-3">{resolved?.storageKey && <img className="h-24 w-32 shrink-0 rounded object-contain" src={backendMediaUrl(resolved.storageKey)} alt={t("director.crud.frameNumber", { number: index + 1 })} />}<div><h4 className="text-sm font-medium">{(frame.sourceNode?.projectId === canvasId ? canvasNodes.find(node => node.id === frame.sourceNode?.nodeId)?.title : undefined) || t("director.crud.frameNumber", { number: index + 1 })}</h4><ReferenceNodeLink sourceNode={frame.sourceNode} />{!resolved?.storageKey && <p className="mt-2 text-xs text-muted-foreground">{t("director.crud.previewAfterSave")}</p>}</div></div><Button size="small" type="text" disabled={disabled} onClick={() => update({ keyframes: value.keyframes.filter((_, n) => n !== index) })}>{t("director.crud.unbindFrame")}</Button></div>
              <label className="grid gap-1 text-xs"><span>{t("director.crud.replaceImage")}</span><SmartImageNodePicker canvasId={canvasId} canvasNodes={canvasNodes} assets={assets} assetPlan={records(source.asset_plan)} value={frame.sourceNode} disabled={disabled} onChange={choice => framePatch(index, { sourceNode: { projectId: choice.projectId, nodeId: choice.nodeId }, assetId: choice.assetId || frame.id, selection: { mode: "node_selection" } })} /></label>
              <label className="grid gap-1 text-xs"><span>{t("director.crud.framePosition")}</span><Select value={frame.anchor} disabled={disabled} options={["opening", "closing", "at_frame"].map(key => ({ value: key, label: t("director.atomic.anchor." + key) }))} onChange={anchor => framePatch(index, { anchor, localFrame: anchor === "at_frame" ? 0 : undefined })} /></label>
              {frame.anchor === "at_frame" && <InputNumber min={0} max={value.duration_frames - 1} value={frame.localFrame} disabled={disabled} onChange={localFrame => framePatch(index, { localFrame: localFrame ?? 0 })} />}
              <div className="shot-editor-span-all w-full min-w-0" style={{ gridColumn: "1 / -1" }}>
                <Cascader className="w-full min-w-0" multiple showCheckedStrategy={Cascader.SHOW_CHILD} value={outfitValues} disabled={disabled} placeholder={t("director.atomic.keyframeSubjectsAndOutfits")} options={outfitOptions} displayRender={labels => labels.slice(0, 2).join(" · ")} onChange={paths => {
                    framePatch(index, keyframeSubjectSelectionFromPaths(paths as Array<Array<string | number>>));
                }} />
              </div>
              {(["retain", "exclude"] as const).map(field => <label key={field} className="grid gap-1 text-xs"><span>{t("director.crud." + field)}</span><Input.TextArea value={(frame[field] || []).join("\n")} disabled={disabled} autoSize={{ minRows: 2, maxRows: 4 }} placeholder={t("director.crud.chineseLines")} onChange={event => framePatch(index, { [field]: event.target.value.split("\n") })} /></label>)}
              <label className="shot-editor-span-all flex items-center justify-between text-xs text-muted-foreground"><span>{t("director.atomic.requiredAnchor")}</span><Switch size="small" checked={frame.requiredForSubmission === true} disabled={disabled} onChange={requiredForSubmission => framePatch(index, { requiredForSubmission })} /></label>
            </article>;
          })}<div className="shot-editor-span-all flex gap-2"><SmartImageNodePicker canvasId={canvasId} canvasNodes={canvasNodes} assets={assets} assetPlan={records(source.asset_plan)} value={keyframeNode} disabled={disabled} placeholder={t("director.workspace.chooseKeyframeNode")} exclude={value.keyframes.map(frame => frame.sourceNode || {})} onUnavailable={() => setKeyframeNode(undefined)} onChange={setKeyframeNode} /><Button disabled={disabled || !keyframeChoiceValid} onClick={addKeyframe}>{t("director.crud.bindFrame")}</Button></div><p className="shot-editor-span-all text-xs text-muted-foreground">{t("director.crud.saveBindingHint")}</p>
          <div className="shot-editor-span-all mt-3 space-y-3"><h3 className="text-sm font-medium">{t("director.crud.compositionReferences")}</h3><p className="text-xs text-muted-foreground">{t("director.crud.compositionReferencesHint")}</p>
            {value.reference_requirements.map((reference, index) => {
                const resolved = records(workbench?.references).find(item => item.id === reference.id)?.resolved;
                const sourceNode = reference.sourceNode?.projectId === canvasId ? canvasNodes.find(node => node.id === reference.sourceNode?.nodeId) : undefined;
                const nodeTitle = sourceNode?.title;
                const storageKey = resolved?.storageKey || (sourceNode ? canvasNodeImage(sourceNode as any)?.storageKey : undefined);
                return <article key={reference.id} className="grid gap-3 rounded-lg border border-border p-4 md:grid-cols-2">
                    <div className="flex min-w-0 items-center gap-3 md:col-span-2">{storageKey && <img className="h-20 w-28 shrink-0 rounded object-contain" src={backendMediaUrl(storageKey)} alt={t("director.crud.compositionReferenceImage")} />}<div className="min-w-0"><h4 className="truncate text-sm font-medium">{nodeTitle || reference.asset_id}</h4><ReferenceNodeLink sourceNode={reference.sourceNode} /></div><Button className="ml-auto" size="small" type="text" disabled={disabled} onClick={() => update({ reference_requirements: value.reference_requirements.filter((_, n) => n !== index) })}>{t("director.crud.unbindFrame")}</Button></div>
                    <label className="grid gap-1 text-xs"><span>{t("director.crud.replaceImage")}</span><SmartImageNodePicker canvasId={canvasId} canvasNodes={canvasNodes} assets={assets} assetPlan={records(source.asset_plan)} value={reference.sourceNode} disabled={disabled} onChange={choice => {
                        const assetId = String(choice.assetId || reference.id), asset = records(source.asset_plan).find(item => String(item.asset_id || item.id || "") === assetId);
                        referencePatch(index, { asset_id: assetId, asset_version: String(asset?.version || assets[assetId]?.version || `node:${choice.nodeId}`), sourceNode: { projectId: choice.projectId, nodeId: choice.nodeId }, selection: { mode: "node_selection" } });
                    }} /></label>
                    <label className="grid gap-1 text-xs"><span>{t("director.crud.retain")}</span><Input.TextArea value={(reference.retain || []).join("\n")} disabled={disabled} autoSize={{ minRows: 2, maxRows: 4 }} placeholder={t("director.crud.chineseLines")} onChange={event => referencePatch(index, { retain: event.target.value.split("\n") })} /></label>
                    <label className="grid gap-1 text-xs"><span>{t("director.crud.exclude")}</span><Input.TextArea value={(reference.exclude || []).join("\n")} disabled={disabled} autoSize={{ minRows: 2, maxRows: 4 }} placeholder={t("director.crud.chineseLines")} onChange={event => referencePatch(index, { exclude: event.target.value.split("\n") })} /></label>
                    <label className="md:col-span-2 flex items-center justify-between text-xs text-muted-foreground"><span>{t("director.atomic.requiredAnchor")}</span><Switch size="small" checked={reference.requiredForSubmission === true} disabled={disabled} onChange={requiredForSubmission => referencePatch(index, { requiredForSubmission })} /></label>
                </article>;
            })}
            <div className="flex gap-2"><SmartImageNodePicker canvasId={canvasId} canvasNodes={canvasNodes} assets={assets} assetPlan={records(source.asset_plan)} value={compositionNode} disabled={disabled} placeholder={t("director.crud.chooseCompositionReference")} exclude={value.reference_requirements.map(reference => reference.sourceNode || {})} onUnavailable={() => setCompositionNode(undefined)} onChange={setCompositionNode} /><Button disabled={disabled || !compositionChoiceValid} onClick={addCompositionReference}>{t("director.crud.addCompositionReference")}</Button></div>
          </div>
        </div>}
        </div>
        <footer className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-card py-3" hidden={Boolean(contextControl?.active)}><span className="text-xs text-muted-foreground">{t(dirty ? "director.atomic.draftKept" : "director.atomic.saved")}</span><Button type="primary" loading={saving} disabled={disabled || !dirty || changedSource} onClick={() => void save()}>{t("director.atomic.saveShot")}</Button></footer>
    </section>;
}
