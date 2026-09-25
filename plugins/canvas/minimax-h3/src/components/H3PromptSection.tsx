import { getReact, useEffect, useMemo, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext, CanvasReferenceAsset, CanvasTextEditorHandle, CanvasTextReference } from "@infinite-canvas/plugin-sdk";
import type { ChangeEvent } from "react";
import { Button, Modal, Select, Switch } from "antd";
import type { H3Ref, H3ReferenceRetention, H3Segment, H3SubjectDefinition } from "../types";
import { H3Icon } from "./H3Icon";
import { StoryboardDialogueStrip } from "./StoryboardDialogueStrip";
import type { StoryboardSpeakerOption } from "./StoryboardDialogueStrip";
import { inferReferenceRole, refsForSegment, segmentRefsPatch } from "../services/h3-data";
import { segmentsFor } from "../hooks/useH3Segments";
import { persistPromptCandidate, promptJobs, setPromptJob } from "../services/h3-prompt-jobs";
import { buildStoryboardPromptSections, mergeSubjectDefinitions, storyboardPromptFingerprint, toSubjectDefinitions } from "../services/storyboard-prompt";
import { extractDialogues, stripDialogueSpeakers, injectDialogueSpeakers, parseSubjectSpeakerMap, collectSpeakerIds } from "../services/storyboard-dialogue";
import { h3ThemeVars } from "../h3-theme";
import type { StoryboardPromptReference } from "../services/storyboard-prompt";
import { assembleH3Prompt, readH3PromptSection } from "../../../../../canvas-agent/src/plugins/minimax-h3/prompt-sections";
import { formatShotTimestamp, isReferenceNameEcho, normalizeRef2vaSummary, stripDuplicateTransition, validatePromptReferences, validateShotTimeline, validateStoryboardShotDescriptions, visualReferenceTags } from "../../../../../canvas-agent/src/plugins/minimax-h3/prompt-rules";
import type { H3PromptSection, H3PromptSectionValues } from "../../../../../canvas-agent/src/plugins/minimax-h3/prompt-sections";
import baseReference from "../storyboard-assets/references/base-en.txt?raw";
import refReference from "../storyboard-assets/references/ref-en.txt?raw";

type Props = {
  ctx: CanvasNodeContext;
  selected?: H3Segment;
  imageRefs: H3Ref[];
  videoRefs: H3Ref[];
  audioRefs: H3Ref[];
  patchSelected: (patch: Partial<H3Segment>) => void;
  onOpenStoryboard: () => void;
};

type AutoGrowTextareaProps = {
  value: string;
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  ariaLabel: string;
};

function AutoGrowTextarea({ value, onChange, placeholder, ariaLabel }: AutoGrowTextareaProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);
  return <textarea
    ref={ref}
    className="nfh3-structured-textarea"
    value={value}
    onChange={onChange}
    placeholder={placeholder}
    aria-label={ariaLabel}
  />;
}

// 南风 H3 官方提示词骨架（nanfeng_prompt_nodes[_v10] web/h3_multiref.js insertPromptBlock 逐字核对）
const H3_OFFICIAL_BLOCK = [
  "subject_definitions:",
  "",
  "summary:",
  "",
  "retention_analysis:",
  "",
  "detailed_description:",
  "",
  "overall_soundscape:",
  "",
  "non_diegetic_music:",
  "N/A",
].join("\n");
const H3_SECTION_BLOCKS: Record<string, string> = {
  模板: H3_OFFICIAL_BLOCK,
  定义: "subject_definitions:\n",
  摘要: "summary:\n",
  保留: "retention_analysis:\n",
  分镜: "detailed_description:\n",
  声景: "overall_soundscape:\n",
  配乐: "non_diegetic_music:\nN/A",
};

const H3_VIDEO_BLOCK = [
  "integrated_multimodal_description:",
  "",
  "overall_soundscape:",
  "",
  "non_diegetic_music:",
  "N/A",
].join("\n");

const H3_PROMPT_MODE_CONFIG = {
  ref2va: {
    tools: H3_SECTION_BLOCKS,
    title: "Ref2VA 六段结构",
    fields: "subject_definitions → summary → retention_analysis → detailed_description → overall_soundscape → non_diegetic_music",
    refs: "可引用图片、视频和音频；主体 <Subject N> 与图片 <Picture N> 独立编号，视频使用 <Video N>，音频使用 <Audio N>。",
  },
  t2v: {
    tools: { 模板: H3_VIDEO_BLOCK, 综合描述: "integrated_multimodal_description:\n", 声景: "overall_soundscape:\n", 配乐: "non_diegetic_music:\nN/A" },
    title: "T2V 三段结构",
    fields: "integrated_multimodal_description → overall_soundscape → non_diegetic_music",
    refs: "文生视频不使用参考素材，也不插入图片、视频或音频引用标签。",
  },
  i2v: {
    tools: { 模板: H3_VIDEO_BLOCK, 综合描述: "integrated_multimodal_description:\n", 声景: "overall_soundscape:\n", 配乐: "non_diegetic_music:\nN/A" },
    title: "I2V 三段结构",
    fields: "integrated_multimodal_description → overall_soundscape → non_diegetic_music",
    refs: "仅允许引用 1 张首帧图片，使用 <Subject 1> / <Picture 1>。",
  },
  fl2v: {
    tools: { 模板: H3_VIDEO_BLOCK, 综合描述: "integrated_multimodal_description:\n", 声景: "overall_soundscape:\n", 配乐: "non_diegetic_music:\nN/A" },
    title: "FL2V 三段结构",
    fields: "integrated_multimodal_description → overall_soundscape → non_diegetic_music",
    refs: "允许引用 2 张图片：<Picture 1> 为首帧，<Picture 2> 为尾帧。",
  },
} as const;

type MentionItem = { ref: H3Ref; ordinal: number };
type StoryboardTransition = "continuous" | "cut" | "dissolve" | "fade_black";
type StoryboardShot = { id: string; description: string; switchTime: string; preciseCut?: boolean; transitionType: StoryboardTransition; pictureBindingId?: string; dialogueSpeakers?: string[] };
type StoryboardCompositeLayout = { rows: number; columns: number; panels: Array<{ bindingId: string; index: number; row: number; column: number; shotNumbers: number[] }> };
type PromptSection = H3PromptSection;

const STORYBOARD_TRANSITIONS: Array<{ value: StoryboardTransition; label: string; prompt: string }> = [
  { value: "continuous", label: "连续镜头（不切镜）", prompt: "continue the same uninterrupted shot; preserve camera movement, action, and spatial relationships without a cut or reset" },
  { value: "cut", label: "硬切", prompt: "hard cut from the preceding shot into this shot" },
  { value: "dissolve", label: "叠化", prompt: "cross-dissolve from the preceding shot into this shot" },
  { value: "fade_black", label: "淡出至黑场再淡入", prompt: "fade out from the preceding shot to black, then fade in to this shot" },
];
const STORYBOARD_RETENTION_OPTIONS: Array<{ value: H3ReferenceRetention; label: string }> = [
  { value: "fully_preserved", label: "完整保留" },
  { value: "partially_preserved", label: "部分保留" },
  { value: "attribute_transfer", label: "属性转移" },
  { value: "weak_reference", label: "弱参考" },
];
const isStoryboardRetention = (value: unknown): value is H3ReferenceRetention => STORYBOARD_RETENTION_OPTIONS.some((option) => option.value === value);

function storyboardPictureAsset(ref: H3Ref, assets: CanvasReferenceAsset[]) {
  return assets.find((asset) => asset.id === ref.assetId || Boolean(ref.storageKey && asset.storageKey === ref.storageKey) || Boolean(ref.url && asset.url === ref.url));
}

function storyboardPictureDescription(ref: H3Ref, assets: CanvasReferenceAsset[]) {
  const asset = storyboardPictureAsset(ref, assets);
  const summary = typeof asset?.analysis?.summary === "string" ? asset.analysis.summary.trim() : typeof ref.analysis?.summary === "string" ? ref.analysis.summary.trim() : "";
  const tags = visualReferenceTags([...(asset?.tags || []), ...(ref.tags || [])]).join(", ");
  const description = typeof ref.description === "string" ? ref.description.trim() : "";
  const clean = (value: string) => value
    .split(/\r?\n/u)[0]
    .replace(/\bep\d{1,3}[-_ ]s\d{1,3}[-_ ]\d{1,3}\b/giu, " ")
    .replace(/\bs\d{1,3}[-_ ]\d{1,3}\b/giu, " ")
    .replace(/\b(?:ep|episode)[-_ ]?\d+\b/giu, " ")
    .replace(/(?:storyboard|分镜图?|关键帧|参考图|图片|reference|frame|image)/giu, " ")
    .replace(/^(?:the\s+)?approved\s+/iu, "")
    .replace(/^(?:for|of|showing)\s+/iu, "")
    .replace(/[|·:：]+/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/^[\s,，.;。_-]+|[\s,，.;。_-]+$/gu, "");
  // 描述只取参考描述、视觉分析摘要与标签，禁止兜底到 asset.label / ref.name ——
  // 文件名（如「分镜图·seg07_v38.png」）对视频模型毫无语义，写进 prompt 只会污染。
  // 这三项本身只是素材名的回显时同样丢弃（历史数据把 label 写进过 analysis.summary）。
  const names = [asset?.label, ref.name];
  const details = [description, summary, tags].filter((value) => !isReferenceNameEcho(value, names));
  return details.map(clean).find((value) => value && !/^(?:the|a|an|for|of)$/iu.test(value))?.slice(0, 140) || "";
}

// 引用名若被外层流水线叠过多层「分镜图·」前缀，展示时收敛成一层，避免下拉框出现「分镜图·分镜图·…」。
function storyboardRefDisplayName(name: string) {
  return (name || "").replace(/^(?:分镜图\s*[·]\s*){2,}/u, "分镜图·");
}

const STORYBOARD_COMPOSITE_LAYOUTS: Record<number, { rows: number; columns: number }> = {
  2: { rows: 1, columns: 2 }, 3: { rows: 1, columns: 3 }, 4: { rows: 2, columns: 2 },
  5: { rows: 1, columns: 5 }, 6: { rows: 2, columns: 3 }, 7: { rows: 2, columns: 4 },
  8: { rows: 2, columns: 4 }, 9: { rows: 3, columns: 3 },
};

function storyboardCompositeLayout(enabled: boolean, shots: StoryboardShot[], refs: H3Ref[]): StoryboardCompositeLayout | null {
  if (!enabled) return null;
  const available = new Set(refs.filter(isStoryboardPictureRef).map((ref) => ref.bindingId).filter((id): id is string => Boolean(id)));
  const imageRefs = refs.filter((ref) => ref.type === "image");
  const shotUses = new Map<string, number[]>();
  shots.forEach((shot, index) => {
    const ids = [...new Set([
      ...(shot.pictureBindingId ? [shot.pictureBindingId] : []),
      ...pictureBindingIdsInDescription(shot.description, imageRefs),
    ])];
    ids.filter((id) => available.has(id)).forEach((id) => shotUses.set(id, [...(shotUses.get(id) || []), index + 1]));
  });
  const bindingIds = [...shotUses.keys()];
  const layout = STORYBOARD_COMPOSITE_LAYOUTS[bindingIds.length];
  if (bindingIds.length < 2 || !layout) return null;
  return {
    ...layout,
    panels: bindingIds.map((bindingId, index) => ({ bindingId, index: index + 1, row: Math.floor(index / layout.columns) + 1, column: index % layout.columns + 1, shotNumbers: [...new Set(shotUses.get(bindingId) || [])] })),
  };
}

function storyboardFrameCue(shot: StoryboardShot, refs: H3Ref[], assets: CanvasReferenceAsset[], composite: StoryboardCompositeLayout | null) {
  if (!shot.pictureBindingId) return "";
  const pictureRefs = refs.filter((item) => item.type === "image");
  const ref = pictureRefs.find((item) => item.bindingId === shot.pictureBindingId);
  const description = ref ? storyboardPictureDescription(ref, assets) : "";
  const pictureOrdinal = pictureRefs.findIndex((item) => item.bindingId === shot.pictureBindingId) + 1;
  const frame = `the approved ${description || "storyboard frame"} from <Picture ${pictureOrdinal}>`;
  const panel = composite?.panels.find((item) => item.bindingId === shot.pictureBindingId);
  const position = panel ? ` In the composite storyboard image, this is Panel ${panel.index} (row ${panel.row}, column ${panel.column}), shared by ${panel.shotNumbers.map((number) => `[Shot ${number}]`).join(", ")}.` : "";
  return `Use ${frame} as the target composition reference for this shot.${position}`;
}

function isStoryboardPictureRef(ref: H3Ref) {
  return ref.type === "image" && ref.enabled !== false && inferReferenceRole(ref) === "storyboard";
}

function referenceTagForBindingId(bindingId: string, refs: H3Ref[]) {
  const ref = refs.find((item) => item.bindingId === bindingId);
  if (!ref) return "";
  const ordinal = refs.filter((item) => item.type === ref.type).findIndex((item) => item.bindingId === bindingId) + 1;
  if (ordinal < 1) return "";
  const kind = ref.type === "image" ? "Picture" : ref.type === "video" ? "Video" : "Audio";
  return `<${kind} ${ordinal}>`;
}

function normalizeLegacyReferenceTokens(text: string, refs: H3Ref[]) {
  return text.replace(/\{\{\s*ref:\s*([^{}]+?)\s*\}\}/gu, (marker, rawId: string) => referenceTagForBindingId(rawId.trim(), refs) || marker);
}

function pictureBindingIdsInDescription(description: string, imageRefs: H3Ref[]) {
  const isStoryboardRef = (ref?: H3Ref) => Boolean(ref) && inferReferenceRole(ref!) === "storyboard";
  return [...new Set([
    ...Array.from(description.matchAll(/<Picture\s+(\d+)>/giu), (match) => {
      const ref = imageRefs[Number(match[1]) - 1];
      return ref && isStoryboardRef(ref) ? ref.bindingId : undefined;
    }),
    ...Array.from(description.matchAll(/\{\{\s*ref:\s*([^{}]+?)\s*\}\}/gu), (match) => {
      const ref = imageRefs.find((item) => item.bindingId === match[1].trim());
      return ref && isStoryboardRef(ref) ? ref.bindingId : undefined;
    }),
  ].filter((id): id is string => Boolean(id)))];
}

function storyboardGenerationContext(ctx: CanvasNodeContext, segment: H3Segment, fields: { openingDescription: string; summary: string; soundscape: string; music: string }, shots: StoryboardShot[], referenceCatalog: CanvasReferenceAsset[], retentionLevels: Record<string, H3ReferenceRetention> = {}, subjectOverrides?: H3SubjectDefinition[] | null) {
  const originalRefs = refsForSegment(segment).map((ref) => ref.bindingId && retentionLevels[ref.bindingId] ? { ...ref, retentionLevel: retentionLevels[ref.bindingId] } : ref);
  const composite = storyboardCompositeLayout(segment.storyboardCompositeEnabled === true, shots, originalRefs);
  const compositeSourceIds = new Set(composite?.panels.map((panel) => panel.bindingId) || []);
  const representativeBindingId = composite?.panels[0]?.bindingId;
  const compositeSubjects = [...new Set(originalRefs.filter((ref) => compositeSourceIds.has(ref.bindingId || "")).flatMap((ref) => [ref.subjectId, ref.groupId, ...(ref.storyboardSubjectIds || [])]).filter((id): id is string => Boolean(id)))];
  const refs = composite ? originalRefs.flatMap((ref) => {
    if (!compositeSourceIds.has(ref.bindingId || "")) return [ref];
    return ref.bindingId === representativeBindingId ? [{ ...ref, name: "合成分镜图", storyboardSubjectIds: compositeSubjects }] : [];
  }) : originalRefs;
  const counters: Record<H3Ref["type"], number> = { image: 0, video: 0, audio: 0 };
  const groups = segment.h3CharacterGroups || {};
  const groupFor = (id: string) => Object.entries(groups).find(([groupId, group]) => groupId === id || group.id === id || group.subjectId === id || group.characterNodeId === id)?.[1];
  const imageReferences = originalRefs.filter((ref) => ref.type === "image");
  const shotReferenceIds = new Set(shots.flatMap((shot) => [
    ...(shot.pictureBindingId ? [shot.pictureBindingId] : []),
    ...pictureBindingIdsInDescription(shot.description, imageReferences),
  ]));
  const isPictureAnchor = (ref: H3Ref, role: string) => ref.type === "image" && (
    ref.usage === "first_frame" || ref.usage === "last_frame" ||
    role === "storyboard" || (role === "keyframe" && Boolean(ref.bindingId && shotReferenceIds.has(ref.bindingId)))
  );
  const subjects = new Map<string, { id: string; name: string; englishName?: string; aliases: Set<string>; shotMarkers: Set<string>; profile: string; outfits: Set<string>; pictures: string[]; role?: string }>();
  const subjectKeyByName = new Map<string, string>();
  const canonicalSubjectId = (name: string, subjectId: string) => {
    const key = name.trim().toLocaleLowerCase();
    if (!key) return subjectId;
    const existing = subjectKeyByName.get(key);
    if (existing) return existing;
    subjectKeyByName.set(key, subjectId);
    return subjectId;
  };
  const referenceManifest = refs.map((ref): StoryboardPromptReference => {
    const ordinal = ++counters[ref.type];
    const tag = ref.type === "image" ? `<Picture ${ordinal}>` : ref.type === "video" ? `<Video ${ordinal}>` : `<Audio ${ordinal}>`;
    const sourceNode = ref.nodeId ? ctx.getNode(ref.nodeId) : undefined;
    const sourceCharacterId = sourceNode?.type === "character" ? sourceNode.id : undefined;
    const asset = storyboardPictureAsset(ref, referenceCatalog);
    const role = inferReferenceRole(ref);
    const declaredSubjectId = ref.subjectId || asset?.subjectId || "";
    const sourceGroup = groupFor(ref.groupId || declaredSubjectId);
    const sourceMetadata = (sourceNode?.metadata || {}) as Record<string, unknown>;
    const referenceDescription = ref.type === "image" && !(composite && ref.bindingId === representativeBindingId)
      ? storyboardPictureDescription(ref, referenceCatalog)
      : ref.type === "image" ? ""
      : String(asset?.analysis?.summary || ref.analysis?.summary || sourceGroup?.voice?.description || sourceMetadata.characterVoiceDescription || "").trim();
    const audioSubjectId = sourceGroup?.subjectId || sourceGroup?.characterNodeId || declaredSubjectId || sourceCharacterId || undefined;
    const audioSubjectName = sourceGroup?.characterName || String(sourceMetadata.characterName || sourceNode?.title || "");
    const mappedIds = ref.type === "image" ? [...new Set([declaredSubjectId, ref.groupId, ...(ref.storyboardSubjectIds || [])].filter((id): id is string => Boolean(id)))] : [];
    const ids = mappedIds.length ? mappedIds : ref.type === "image" && sourceCharacterId ? [sourceCharacterId] : ref.type === "image" && !isPictureAnchor(ref, role) && ref.bindingId ? [ref.bindingId] : [];
    const subjectIds = new Set<string>();
    for (const id of ids) {
      const group = groupFor(id) || Object.values(groups).find((item) => item.subjectId === id || item.characterNodeId === id);
      const characterNode = group?.characterNodeId ? ctx.getNode(group.characterNodeId) : id === sourceCharacterId ? sourceNode : ctx.getNode(id);
      const metadata = (characterNode?.metadata || {}) as Record<string, unknown>;
      const isCharacter = Boolean(group || characterNode?.type === "character" || role === "character_identity" || role === "character_turnaround");
      const roleFallbackName: Record<string, string> = { scene: "Scene", prop: "Prop", style: "Style", palette: "Palette", blocking: "Blocking", storyboard: "Storyboard" };
      const name = group?.characterName || String(metadata.characterName || characterNode?.title || (isCharacter ? ref.name : roleFallbackName[role] || "Reference"));
      const subjectId = canonicalSubjectId(name, group?.subjectId || group?.characterNodeId || id);
      const englishName = typeof metadata.characterEnglishName === "string" ? metadata.characterEnglishName.trim() : "";
      const profile = [
        typeof metadata.characterDescription === "string" ? metadata.characterDescription.trim() : "",
        role === "storyboard" && isPictureAnchor(ref, role) ? "" : referenceDescription,
      ].filter((value, index, all) => value && all.indexOf(value) === index).join("; ");
      const entry = subjects.get(subjectId) || { id: subjectId, name, englishName: englishName || undefined, aliases: new Set<string>(), shotMarkers: new Set<string>(), profile, outfits: new Set<string>(), pictures: [], role };
      [id, group?.id, group?.subjectId, group?.characterNodeId, group?.characterName, characterNode?.id, characterNode?.title, metadata.characterName, englishName]
        .forEach((alias) => { if (typeof alias === "string" && alias.trim()) entry.aliases.add(alias.trim()); });
      if (ref.bindingId) subjectIds.add(subjectId);
      if (ref.bindingId && ref.type === "image") entry.shotMarkers.add(ref.bindingId);
      if (group && ref.outfitId) {
        const outfit = group.outfits.find((item) => item.id === ref.outfitId);
        const characterImages = Array.isArray(metadata.characterImages) ? metadata.characterImages as Array<Record<string, unknown>> : [];
        const image = characterImages.find((item) => String(item.outfit || item.name || "") === outfit?.name);
        const outfitDescription = typeof image?.outfitDescription === "string" ? image.outfitDescription.trim() : "";
        if (outfitDescription) entry.outfits.add(outfitDescription);
      }
      const pictureMarker = tag;
      // Storyboard frames are concrete shot anchors, not reusable subject identity.
      if (!entry.pictures.includes(pictureMarker) && ref.type === "image" && role !== "storyboard") entry.pictures.push(pictureMarker);
      if (!entry.profile && profile) entry.profile = profile;
      if (entry.role === "storyboard" && role !== "storyboard") entry.role = role;
      if (entry.name === entry.id && name !== subjectId) entry.name = name;
      if (!entry.englishName && englishName) entry.englishName = englishName;
      subjects.set(subjectId, entry);
    }
    return {
      tag,
      bindingId: ref.bindingId || "",
      type: ref.type,
      label: ref.name || `未命名${ref.type === "audio" ? "音频" : ref.type === "video" ? "视频" : "图片"}参考`,
      role,
      description: ref.type === "audio"
        ? String(sourceGroup?.voice?.description || sourceMetadata.characterVoiceDescription || asset?.analysis?.summary || ref.analysis?.summary || "").trim()
        : referenceDescription,
      subjectId: ref.type === "audio" ? audioSubjectId : undefined,
      subjectIds: [...subjectIds],
      subjectName: ref.type === "audio" ? audioSubjectName : undefined,
      usage: ref.usage || "reference",
      retentionLevel: ref.retentionLevel,
      ...(composite && ref.bindingId === representativeBindingId ? { compositePanels: composite.panels.map(({ index, row, column, shotNumbers }) => ({ index, row, column, shotNumbers })) } : {}),
      shotNumbers: [],
    };
  });
  const speakerBySubject = new Map<string, string>();
  const voiceReferences = referenceManifest.filter((reference) => reference.type === "audio" && reference.role === "character_voice" && reference.subjectId);
  const explicitSpeakerId = (subjectId: string) => {
    const subject = subjects.get(subjectId);
    if (!subject) return "";
    const subjectOrdinal = [...subjects.keys()].indexOf(subjectId) + 1;
    const aliases = [`<Subject ${subjectOrdinal}>`, subject.name, subject.englishName || "", ...subject.aliases].filter(Boolean);
    const text = shots.map((shot) => shot.description).join("\n");
    for (const alias of aliases) {
      let offset = 0;
      while (offset < text.length) {
        const index = text.toLocaleLowerCase().indexOf(alias.toLocaleLowerCase(), offset);
        if (index < 0) break;
        const near = text.slice(Math.max(0, index - 24), index + alias.length + 32);
        const match = near.match(/[（(]\s*(S\d+)\s*[)）]/iu);
        if (match) return match[1].toUpperCase();
        offset = index + alias.length;
      }
    }
    return "";
  };
  for (const reference of voiceReferences) {
    if (!reference.subjectId || speakerBySubject.has(reference.subjectId)) continue;
    const speakerId = explicitSpeakerId(reference.subjectId);
    if (speakerId) speakerBySubject.set(reference.subjectId, speakerId);
  }
  const usedSpeakerIds = new Set(speakerBySubject.values());
  let nextSpeakerNumber = 1;
  for (const reference of voiceReferences) {
    if (!reference.subjectId || speakerBySubject.has(reference.subjectId)) continue;
    while (usedSpeakerIds.has(`S${nextSpeakerNumber}`)) nextSpeakerNumber += 1;
    const speakerId = `S${nextSpeakerNumber++}`;
    speakerBySubject.set(reference.subjectId, speakerId);
    usedSpeakerIds.add(speakerId);
  }
  const referencesWithSpeakers = referenceManifest.map((reference) => ({
    ...reference,
    speakerId: reference.type === "audio" && reference.role === "character_voice" && reference.subjectId
      ? speakerBySubject.get(reference.subjectId)
      : undefined,
  }));
  const subjectManifest = mergeSubjectDefinitions([...subjects.values()].map((subject) => ({
    id: subject.id,
    name: subject.name,
    englishName: subject.englishName,
    aliases: [...subject.aliases],
    shotMarkers: [...subject.shotMarkers],
    profile: subject.profile,
    outfits: [...subject.outfits],
    pictures: subject.pictures,
    role: subject.role,
  })), subjectOverrides);
  validatePromptReferences([fields.summary, fields.openingDescription, ...shots.map((shot) => shot.description), fields.soundscape, fields.music].join("\n"), originalRefs, subjectManifest.length);
  const normalizedShots = shots.map((shot) => ({
    description: normalizeLegacyReferenceTokens(shot.description.trim(), originalRefs),
    switchTime: shot.preciseCut === false ? "" : shot.switchTime.trim(),
    transitionType: shot.transitionType || "cut",
    pictureBindingId: shot.pictureBindingId && compositeSourceIds.has(shot.pictureBindingId) ? representativeBindingId || shot.pictureBindingId : shot.pictureBindingId || "",
    pictureDescription: shot.pictureBindingId ? storyboardPictureDescription(refs.find((ref) => ref.bindingId === shot.pictureBindingId) || { name: "", url: "", type: "image", bindingId: shot.pictureBindingId }, referenceCatalog) : "",
    referenceIds: [...new Set([
      ...pictureBindingIdsInDescription(shot.description, imageReferences),
      ...(shot.pictureBindingId ? [shot.pictureBindingId] : []),
    ].map((id) => compositeSourceIds.has(id) ? representativeBindingId || id : id))],
  }));
  const finalReferences = referencesWithSpeakers.map((reference) => ({
    ...reference,
    shotNumbers: normalizedShots.flatMap((shot, index) => shot.referenceIds.includes(reference.bindingId) ? [index + 1] : []),
  }));
  const summary = normalizeRef2vaSummary(fields.summary, {
    hasStoryboardFrames: finalReferences.some((reference) => reference.type === "image" && reference.role === "storyboard" && reference.shotNumbers.length > 0),
    hasReferenceImages: finalReferences.some((reference) => reference.type === "image"),
    hasAudioReference: finalReferences.some((reference) => reference.type === "audio"),
  });
  const content = {
    version: 12,
    storyboardComposite: { enabled: segment.storyboardCompositeEnabled === true, ...(composite ? { rows: composite.rows, columns: composite.columns, panels: composite.panels, sourceIdentity: originalRefs.filter((ref) => compositeSourceIds.has(ref.bindingId || "")).map((ref) => ({ bindingId: ref.bindingId, assetId: ref.assetId, storageKey: ref.storageKey || "", url: ref.storageKey ? "" : ref.url || "" })) } : {}) },
    summary,
    openingDescription: fields.openingDescription.trim(),
    shots: normalizedShots,
    overallSoundscape: fields.soundscape.trim(),
    nonDiegeticMusic: fields.music.trim(),
    references: finalReferences,
    referenceIdentity: originalRefs.map((ref) => ({ type: ref.type, bindingId: ref.bindingId || "", assetId: ref.assetId || "", sourceNodeId: ref.nodeId || "", storageKey: ref.storageKey || "", url: ref.storageKey ? "" : ref.url || "", name: ref.name || "", role: inferReferenceRole(ref), subjectId: ref.subjectId || "", groupId: ref.groupId || "", outfitId: ref.outfitId || "", storyboardSubjectIds: ref.storyboardSubjectIds || [], tags: ref.tags || [], usage: ref.usage || "reference", retentionLevel: ref.retentionLevel || "fully_preserved" })),
    subjects: subjectManifest,
  };
  return { content, summary, subjects: subjectManifest, shots: normalizedShots, references: finalReferences };
}

function readPromptSection(prompt: string, section: PromptSection) {
  return readH3PromptSection(prompt, section);
}


// 分镜图 cue 的三种历史句式：前两种是插件/旧版编译产物，第三种是 MCP 编译产物（带一整段 After the keyframe 尾巴）。
const STORYBOARD_CUE_PATTERN = /^Use the approved .+? from <Picture\s+(\d+)> as (?:the visual anchor|the target composition reference|the shot-entry keyframe and composition anchor) for this shot\.(?:\s*After the keyframe, keep the camera setup and spatial relationship stable while allowing natural performance\.)?\s*/iu;

function parseStoryboardDescription(description: string, imageRefs: H3Ref[], allRefs = imageRefs) {
  const normalizedDescription = normalizeLegacyReferenceTokens(description, allRefs);
  const markers = [...normalizedDescription.matchAll(/\[Shot\s+(\d+)\](?:\s+At\s+(\d{1,2}:\d{2}(?:\.\d{1,3})?)[,，]?)?/giu)];
  if (!markers.length) return {
    openingDescription: normalizedDescription.trim(),
    shots: [{ id: crypto.randomUUID(), description: "", switchTime: "", transitionType: "cut" as const }],
  };
  return {
    openingDescription: normalizedDescription.slice(0, markers[0].index!).trim(),
    shots: markers.map((marker, index) => {
      const start = marker.index! + marker[0].length;
      const end = markers[index + 1]?.index ?? normalizedDescription.length;
      let body = normalizedDescription.slice(start, end).trim();
      let transitionType: StoryboardTransition = "cut";
      let switchTime = marker[2] || "";
      const boundaryTime = body.match(/^(\d{1,2}:\d{2}(?:\.\d{1,3})?)\s*[:：]\s*/u);
      if (boundaryTime) {
        switchTime ||= boundaryTime[1];
        body = body.slice(boundaryTime[0].length);
      }
      const legacyCodeFor = (value: string): StoryboardTransition => {
        if (/continuous|no cut|uninterrupted shot/iu.test(value)) return "continuous";
        if (/cross[- ]dissolve/iu.test(value)) return "dissolve";
        if (/fade/iu.test(value)) return "fade_black";
        return "cut";
      };
      const generatedTransition = body.match(/^The shot transitions to the approved .+? from <Picture\s+(\d+)> using a (hard cut|cross-dissolve|fade|wipe|match cut)\.\s*/iu);
      if (generatedTransition) transitionType = legacyCodeFor(generatedTransition[2]);
      if (index > 0) {
        const transition = generatedTransition ? null : body.match(/^\[Transition:\s*([^\]]+)\]\s*/iu);
        const legacyTransitions: Array<{ pattern: RegExp; value: StoryboardTransition }> = [
          { pattern: /^(?:the camera|the shot) cuts to\s*/iu, value: "cut" },
          { pattern: /^the shot (?:transitions|changes|switches) to\s*/iu, value: "cut" },
          { pattern: /^(?:the (?:shot|image) )?cross[- ]dissolves? to\s*/iu, value: "dissolve" },
          { pattern: /^(?:the (?:shot|image) )?fades? (?:to|into)\s*/iu, value: "fade_black" },
          { pattern: /^the shot hard-cuts(?:\s+to\s+|[.,]\s*)/iu, value: "cut" },
          { pattern: /^the shot cross-dissolves(?:\s+to\s+|[.,]\s*)/iu, value: "dissolve" },
          { pattern: /^the shot fades out to black, then fades in[.,]?\s*/iu, value: "fade_black" },
          { pattern: /^the shot continues[.,]?\s*/iu, value: "continuous" },
        ];
        if (transition) {
          transitionType = legacyCodeFor(transition[1]);
          body = body.slice(transition[0].length);
        } else if (!generatedTransition) {
          const legacyTransition = legacyTransitions.find((option) => option.pattern.test(body));
          if (legacyTransition) {
            transitionType = legacyTransition.value;
            body = body.replace(legacyTransition.pattern, "");
          } else if (/不切镜|不中断|无切镜|保持连续镜头|延续上一镜头|接续上一镜头/u.test(body.slice(0, 180))) {
            transitionType = "continuous";
            body = body.replace(/^(?:不切镜|不中断|无切镜|保持连续镜头)[，,、\s]*/u, "");
          } else if (/^(?:连续镜头|同一镜头)/u.test(body)) {
            transitionType = "continuous";
          } else if (body.slice(0, 180).search(/(?:画面)?硬切(?:进入|至|到|切入)?/u) >= 0) {
            transitionType = "cut";
            body = body.replace(/((?:画面)?硬切(?:进入|至|到|切入)?)/u, "");
          } else if (/^(?:叠化|交叉叠化)/u.test(body)) {
            transitionType = "dissolve";
            body = body.replace(/^(?:叠化|交叉叠化)[至到，,\s]*/u, "");
          } else if (/^(?:淡出至黑场再淡入|淡出到黑场再淡入)/u.test(body)) {
            transitionType = "fade_black";
            body = body.replace(/^(?:淡出至黑场再淡入|淡出到黑场再淡入)[，,、\s]*/u, "");
          }
        }
      }
      let pictureBindingId: string | undefined;
      const pictureCue = body.match(STORYBOARD_CUE_PATTERN);
      if (generatedTransition) {
        pictureBindingId = imageRefs[Number(generatedTransition[1]) - 1]?.bindingId;
        body = body.slice(generatedTransition[0].length);
      } else if (pictureCue) {
        pictureBindingId = imageRefs[Number(pictureCue[1]) - 1]?.bindingId;
        body = body.slice(pictureCue[0].length);
      } else {
        const legacyPicture = body.match(/^<Picture\s+(\d+)>\s*/iu);
        const legacyRef = legacyPicture ? imageRefs[Number(legacyPicture[1]) - 1] : undefined;
        if (legacyPicture && legacyRef && isStoryboardPictureRef(legacyRef) && legacyRef.bindingId) {
          pictureBindingId = legacyRef.bindingId;
          body = body.slice(legacyPicture[0].length);
        }
      }
      // 自愈：切镜自然句与分镜图 cue 是编译期注入的结构化句，不该滞留在可编辑正文里。
      // 旧版解析器曾把它们泄进正文（一次载入+保存即成对复制进来），每次编译还会再叠一层；
      // 这里循环剥掉所有残余副本，载入即修复。
      for (;;) {
        const residualCue = body.match(STORYBOARD_CUE_PATTERN);
        if (residualCue) {
          if (!pictureBindingId) pictureBindingId = imageRefs[Number(residualCue[1]) - 1]?.bindingId;
          body = body.slice(residualCue[0].length);
          continue;
        }
        const compositePanelCue = body.match(/^(?:In the composite storyboard image, this is Panel \d+ \(row \d+, column \d+\), shared by (?:\[Shot \d+\](?:, )?)+\.|This shot uses composite storyboard Panel \d+ \(row \d+, column \d+\)\.)\s*/iu);
        if (compositePanelCue) {
          body = body.slice(compositePanelCue[0].length);
          continue;
        }
        const withoutTransition = stripDuplicateTransition(body, transitionType);
        if (withoutTransition !== body) {
          body = withoutTransition;
          continue;
        }
        break;
      }
      return {
        id: crypto.randomUUID(),
        description: stripDialogueSpeakers(body),
        switchTime: index > 0 ? switchTime : "",
        preciseCut: index > 0 && Boolean(switchTime),
        transitionType,
        pictureBindingId,
        dialogueSpeakers: extractDialogues(body).map((dialogue) => dialogue.speaker || ""),
      };
    }),
  };
}

export function alignStoryboardShotsToReferences(shots: StoryboardShot[], imageRefs: H3Ref[]) {
  const pictures = imageRefs.filter((ref) => isStoryboardPictureRef(ref) && ref.bindingId);
  if (!pictures.length) return { shots, changed: false };

  const pictureIds = new Set(pictures.map((ref) => ref.bindingId!));
  const bound = new Map<string, StoryboardShot>();
  const ordered: StoryboardShot[] = [];
  const unbound: StoryboardShot[] = [];
  let changed = false;
  for (const shot of shots) {
    const id = shot.pictureBindingId;
    if (id && pictureIds.has(id) && !bound.has(id)) {
      // 分镜轨是镜头顺序的权威来源。不要因为参考图槽位仍保持旧顺序，
      // 把轨道交换后的已绑定镜头重新排回去。
      bound.set(id, shot);
      ordered.push(shot);
    } else {
      if (id) changed = true;
      unbound.push(id ? { ...shot, pictureBindingId: undefined } : shot);
    }
  }

  let unboundIndex = 0;
  for (const ref of pictures) {
    const id = ref.bindingId!;
    if (bound.has(id)) continue;
    const shot = unbound[unboundIndex++];
    changed = true;
    const next = shot || { id: crypto.randomUUID(), description: "", switchTime: "", transitionType: "cut" as const };
    const nextBound = { ...next, pictureBindingId: id };
    bound.set(id, nextBound);
    ordered.push(nextBound);
  }

  const aligned = [...ordered, ...unbound.slice(unboundIndex)];
  if (aligned.some((shot, index) => shots[index]?.id !== shot.id)) changed = true;
  return { shots: aligned, changed };
}

// 官方 H3 切镜写法：用自然句而非 [Transition:] 方括号标签。
const SHOT_TRANSITION_LEADIN: Record<StoryboardTransition, string> = {
  continuous: "the shot continues",
  cut: "the shot hard-cuts",
  dissolve: "the shot cross-dissolves",
  fade_black: "the shot fades out to black, then fades in",
};

function serializeStoryboardShots(shots: StoryboardShot[], imageRefs: H3Ref[], referenceCatalog: CanvasReferenceAsset[], compositeEnabled: boolean) {
  const composite = storyboardCompositeLayout(compositeEnabled, shots, imageRefs);
  return shots.map((shot, index) => {
    const timestamp = index > 0 && shot.preciseCut !== false ? formatShotTimestamp(shot.switchTime) : "";
    const transition = timestamp ? ` At ${timestamp},` : "";
    const lead = index > 0 ? SHOT_TRANSITION_LEADIN[shot.transitionType] || SHOT_TRANSITION_LEADIN.cut : "";
    const transitionClause = lead ? ` ${lead}.` : "";
    const picture = storyboardFrameCue(shot, imageRefs, referenceCatalog, composite);
    const normalizedDescription = normalizeLegacyReferenceTokens(index ? stripDuplicateTransition(shot.description, shot.transitionType) : shot.description.trim(), imageRefs);
    const compiledDescription = injectDialogueSpeakers(normalizedDescription, shot.dialogueSpeakers || []);
    const extraPanels = composite ? pictureBindingIdsInDescription(normalizedDescription, imageRefs)
      .filter((id) => id !== shot.pictureBindingId).map((id) => composite.panels.find((panel) => panel.bindingId === id)).filter(Boolean)
      .map((panel) => `This shot uses composite storyboard Panel ${panel!.index} (row ${panel!.row}, column ${panel!.column}).`).join(" ") : "";
    return `[Shot ${index + 1}]${transition}${transitionClause}${picture ? ` ${picture}` : ""}${extraPanels ? ` ${extraPanels}` : ""}${compiledDescription ? ` ${compiledDescription}` : ""}`;
  }).join("\n");
}

function serializeStoryboardDescription(openingDescription: string, shots: StoryboardShot[], imageRefs: H3Ref[], referenceCatalog: CanvasReferenceAsset[], compositeEnabled: boolean) {
  return [openingDescription.trim(), serializeStoryboardShots(shots, imageRefs, referenceCatalog, compositeEnabled)].filter(Boolean).join("\n\n");
}

/**
 * 实体定义驱动的 <Subject N> 引用块。
 * 与 characterEditorReference 的差别：主体不要求是角色节点——道具/场景等主观体同样成立，
 * 没有角色节点时用实体名与预览图兜底，避免渲染成「人物未找到」。
 */
function subjectDefinitionEditorReference(ctx: CanvasNodeContext, segment: H3Segment | undefined, definition: H3SubjectDefinition, subjectOrdinal: number, fallbackRef?: H3Ref): CanvasTextReference {
  const groups = segment?.h3CharacterGroups || {};
  const group = groups[definition.id] || Object.values(groups).find((item) => item.characterNodeId === definition.id || item.subjectId === definition.id);
  const node = ctx.getNode(group?.characterNodeId || definition.id);
  const metadata = node?.metadata || {};
  const images = Array.isArray(metadata.characterImages) ? metadata.characterImages as Array<{ url?: unknown }> : [];
  const primaryIndex = Number(metadata.characterPrimaryIndex || 0);
  const primaryImage = images[primaryIndex] || images[0];
  const fallbackOutfit = group?.outfits.find((outfit) => outfit.enabled) || group?.outfits[0];
  const name = definition.name?.trim() || group?.characterName || node?.title || fallbackRef?.name || definition.id;
  const previewUrl = typeof primaryImage?.url === "string" ? primaryImage.url : fallbackOutfit?.url || (fallbackRef?.type === "image" ? fallbackRef.url : undefined);
  const isCharacter = Boolean(group) || node?.type === "character" || definition.role === "character_identity" || definition.role === "character_turnaround";
  const kindLabel = isCharacter ? "人物" : definition.role === "prop" ? "道具" : definition.role === "scene" ? "场景" : "实体";
  // kind: "character" 让说话人名册只收角色；非角色实体用 image/其他 kind，仍可正常解析 <Subject N>。
  return {
    label: `${kindLabel} · ${name}`,
    displayLabel: `${kindLabel} · ${name}`,
    title: `${kindLabel} · ${name}`,
    kind: isCharacter ? "character" : "image",
    previewUrl,
    insert: `<Subject ${subjectOrdinal}>`,
    tokens: [`<Subject ${subjectOrdinal}>`],
  };
}

function characterEditorReference(ctx: CanvasNodeContext, segment: H3Segment | undefined, subjectId: string, subjectOrdinal: number, fallbackRef?: H3Ref): CanvasTextReference {
  const groups = segment?.h3CharacterGroups || {};
  const group = groups[subjectId] || Object.values(groups).find((item) => item.characterNodeId === subjectId || item.subjectId === subjectId);
  const node = ctx.getNode(group?.characterNodeId || subjectId);
  const metadata = node?.metadata || {};
  const images = Array.isArray(metadata.characterImages) ? metadata.characterImages as Array<{ url?: unknown }> : [];
  const primaryIndex = Number(metadata.characterPrimaryIndex || 0);
  const primaryImage = images[primaryIndex] || images[0];
  const fallbackOutfit = group?.outfits.find((outfit) => outfit.enabled) || group?.outfits[0];
  const name = group?.characterName || node?.title || fallbackRef?.name || subjectId;
  const previewUrl = typeof primaryImage?.url === "string" ? primaryImage.url : fallbackOutfit?.url || (fallbackRef?.type === "image" ? fallbackRef.url : undefined);
  return {
    label: `人物 · ${name}`,
    displayLabel: `人物 · ${name}`,
    title: `人物节点 · ${name}`,
    kind: "character",
    previewUrl,
    insert: `<Subject ${subjectOrdinal}>`,
    tokens: [`<Subject ${subjectOrdinal}>`],
  };
}

export function H3PromptSection({
  ctx,
  selected,
  imageRefs,
  videoRefs,
  audioRefs,
  patchSelected,
  onOpenStoryboard,
}: Props) {
  const editorRef = useRef<CanvasTextEditorHandle | null>(null);
  const textTarget = useMemo(() => ({ nodeId: ctx.node.id, segmentId: selected?.id, field: "prompt" as const }), [ctx.node.id, selected?.id]);
  const textDocument = useMemo(() => ctx.textDocument(textTarget), [ctx.projectId, ctx.node.id, selected?.id]);
  const textStatus = getReact().useSyncExternalStore(textDocument.subscribe, textDocument.getSnapshot);
  const suggestions = useMemo(() => ctx.textSuggestions(textTarget), [ctx.projectId, ctx.node.id, selected?.id]);
  const suggestionState = getReact().useSyncExternalStore(suggestions.subscribe, suggestions.getSnapshot);
  const prompt = textStatus.ready ? textStatus.text : String(selected?.prompt || "");
  const TextEditor = ctx.TextEditor;
  const mode = String(selected?.mode || selected?.taskMode || "ref2va");
  const promptMode = mode in H3_PROMPT_MODE_CONFIG ? mode as keyof typeof H3_PROMPT_MODE_CONFIG : "ref2va";
  const modeConfig = H3_PROMPT_MODE_CONFIG[promptMode];
  const toolBlocks = modeConfig.tools as Record<string, string>;
  const storyboardSection = promptMode === "ref2va" ? "detailed_description" : "integrated_multimodal_description";
  const [storyboardMode, setStoryboardMode] = useState(false);
  const [storyboardShots, setStoryboardShots] = useState<StoryboardShot[]>([]);
  const [storyboardOpeningDescription, setStoryboardOpeningDescription] = useState("");
  const [storyboardSummary, setStoryboardSummary] = useState("");
  const [storyboardRetentionLevels, setStoryboardRetentionLevels] = useState<Record<string, H3ReferenceRetention>>({});
  const [storyboardSoundscape, setStoryboardSoundscape] = useState("");
  const [storyboardMusic, setStoryboardMusic] = useState("N/A");
  const [storyboardDirty, setStoryboardDirty] = useState(false);
  const [storyboardSaving, setStoryboardSaving] = useState(false);
  const [storyboardCompleting, setStoryboardCompleting] = useState(false);
  const [storyboardPromptGenerating, setStoryboardPromptGenerating] = useState(false);
  const [storyboardError, setStoryboardError] = useState<string | null>(null);
  // 实体定义：打开分镜编辑时按当前 Clip 引用规则生成默认值，用户可手动增删改。
  const [subjectDefinitions, setSubjectDefinitions] = useState<H3SubjectDefinition[]>([]);
  const storyboardShotsRef = useRef<StoryboardShot[]>([]);
  storyboardShotsRef.current = storyboardShots;
  const storyboardCompositeEnabledRef = useRef(selected?.storyboardCompositeEnabled === true);
  storyboardCompositeEnabledRef.current = selected?.storyboardCompositeEnabled === true;
  const storyboardOpeningDescriptionRef = useRef(storyboardOpeningDescription);
  storyboardOpeningDescriptionRef.current = storyboardOpeningDescription;
  const storyboardSummaryRef = useRef(storyboardSummary);
  storyboardSummaryRef.current = storyboardSummary;
  const storyboardRetentionLevelsRef = useRef<Record<string, H3ReferenceRetention>>({});
  storyboardRetentionLevelsRef.current = storyboardRetentionLevels;
  const storyboardSoundscapeRef = useRef(storyboardSoundscape);
  storyboardSoundscapeRef.current = storyboardSoundscape;
  const storyboardMusicRef = useRef(storyboardMusic);
  storyboardMusicRef.current = storyboardMusic;
  const storyboardBasePromptRef = useRef(prompt);
  const storyboardDirtyRef = useRef(false);
  const storyboardVersionRef = useRef(0);
  const storyboardSaveQueueRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const storyboardPromptGenerationRef = useRef(false);
  const subjectDefinitionsRef = useRef<H3SubjectDefinition[]>([]);
  subjectDefinitionsRef.current = subjectDefinitions;
  const [helpOpen, setHelpOpen] = useState(false);
  const [referenceCatalog, setReferenceCatalog] = useState<CanvasReferenceAsset[]>([]);
  useEffect(() => {
    let cancelled = false;
    void ctx.references.list().then((assets) => {
      if (!cancelled) setReferenceCatalog(assets);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [ctx.references, ctx.projectId, selected?.referenceBindings]);
  const enhancement = selected ? promptJobs(ctx)[selected.id] : undefined;
  const enhancing = enhancement?.status === "running";
  useEffect(() => {
    if (!selected || enhancement?.status !== "suggestion") return;
    const saved = suggestionState.items.find((item) => item.id === enhancement.requestId);
    if (saved && saved.status !== "pending") setPromptJob(ctx, selected.id, { ...enhancement, status: "done", error: undefined });
  }, [selected?.id, enhancement, suggestionState.items]);
  // 翻译态：缓存最近一次翻译结果（按 prompt 内容做 key），切换时优先复用，prompt 变化自动失效
  type Translation = { segmentId: string; prompt: string; text: string };
  const [translation, setTranslation] = useState<Translation | null>(null);
  const [translating, setTranslating] = useState(false);
  const [isTranslated, setIsTranslated] = useState(false);
  const [translateError, setTranslateError] = useState<string | null>(null);
  const [copiedError, setCopiedError] = useState(false);
  // 用来在异步翻译返回时校验 prompt 是否已被用户改掉，避免显示错配的中文
  const promptRef = useRef({ prompt, segmentId: selected?.id });
  promptRef.current = { prompt, segmentId: selected?.id };
  const loadStoryboardPrompt = (sourcePrompt: string) => {
    const summary = promptMode === "ref2va" ? readPromptSection(sourcePrompt, "summary") : "";
    const { openingDescription, shots: parsedShots } = parseStoryboardDescription(readPromptSection(sourcePrompt, storyboardSection), imageRefs, [...imageRefs, ...videoRefs, ...audioRefs]);
    const aligned = alignStoryboardShotsToReferences(parsedShots, imageRefs);
    const shots = aligned.shots;
    const soundscape = readPromptSection(sourcePrompt, "overall_soundscape");
    const music = readPromptSection(sourcePrompt, "non_diegetic_music") || "N/A";
    const retentionLevels = Object.fromEntries(imageRefs.filter((ref) => isStoryboardPictureRef(ref) && ref.bindingId).map((ref) => [ref.bindingId!, isStoryboardRetention(ref.retentionLevel) ? ref.retentionLevel : "fully_preserved"]));
    storyboardShotsRef.current = shots;
    storyboardOpeningDescriptionRef.current = openingDescription;
    storyboardSummaryRef.current = summary;
    storyboardRetentionLevelsRef.current = retentionLevels;
    storyboardSoundscapeRef.current = soundscape;
    storyboardMusicRef.current = music;
    setStoryboardShots(shots);
    setStoryboardOpeningDescription(openingDescription);
    setStoryboardSummary(summary);
    setStoryboardRetentionLevels(retentionLevels);
    setStoryboardSoundscape(soundscape);
    setStoryboardMusic(music);
    return aligned.changed;
  };
  const storyboardReferenceSignature = imageRefs
    .filter(isStoryboardPictureRef)
    .map((ref) => ref.bindingId || `${ref.name}:${ref.url}`)
    .join("\u0000");
  useEffect(() => {
    storyboardDirtyRef.current = false;
    storyboardBasePromptRef.current = prompt;
    storyboardVersionRef.current += 1;
    setStoryboardMode(false);
    setStoryboardDirty(false);
    setStoryboardError(null);
    loadStoryboardPrompt(prompt);
  }, [selected?.id, storyboardSection, promptMode, mode]);
  useEffect(() => {
    if (!storyboardMode || storyboardDirtyRef.current) return;
    storyboardBasePromptRef.current = prompt;
    const needsBindingSave = loadStoryboardPrompt(prompt);
    storyboardDirtyRef.current = needsBindingSave;
    setStoryboardDirty(needsBindingSave);
  }, [prompt, storyboardMode, storyboardSection, storyboardReferenceSignature]);

  const persistStoryboardSnapshot = async (
    shots: StoryboardShot[],
    fields: { openingDescription: string; summary: string; soundscape: string; music: string },
    version: number,
    compositeEnabled: boolean,
  ) => {
    if (!selected || !textStatus.ready || textStatus.blocked) {
      setStoryboardError("提示词尚未同步，分镜修改暂时无法保存。");
      return false;
    }
    setStoryboardSaving(true);
    setStoryboardError(null);
    try {
      await textDocument.flush();
      const snapshot = textDocument.getSnapshot();
      if (!snapshot.ready || snapshot.blocked) {
        setStoryboardError(snapshot.error || "提示词尚未同步，分镜修改暂时无法保存。");
        return false;
      }
      const latestPrompt = snapshot.text;
      const basePrompt = storyboardBasePromptRef.current;
      const editedSections: PromptSection[] = promptMode === "ref2va"
        ? ["summary", storyboardSection, "overall_soundscape", "non_diegetic_music"]
        : [storyboardSection, "overall_soundscape", "non_diegetic_music"];
      if (latestPrompt !== basePrompt && editedSections.some((section) => readPromptSection(latestPrompt, section) !== readPromptSection(basePrompt, section))) {
        setStoryboardError("结构化字段在其他位置也被修改。请重新载入最新提示词后再编辑，避免覆盖他人的修改。");
        return false;
      }
      const currentRefs = selected ? refsForSegment(selected) : [];
      const summary = normalizeRef2vaSummary(fields.summary, {
        hasStoryboardFrames: currentRefs.some((ref) => isStoryboardPictureRef(ref) && Boolean(ref.bindingId && shots.some((shot) => shot.pictureBindingId === ref.bindingId))),
        hasReferenceImages: currentRefs.some((ref) => ref.type === "image"),
        hasAudioReference: currentRefs.some((ref) => ref.type === "audio"),
      });
      const sections: H3PromptSectionValues = {
        ...(promptMode === "ref2va" ? {
          subject_definitions: readPromptSection(latestPrompt, "subject_definitions"),
          summary,
          retention_analysis: readPromptSection(latestPrompt, "retention_analysis"),
        } : {}),
        overall_soundscape: fields.soundscape,
        non_diegetic_music: fields.music,
      };
      sections[storyboardSection] = serializeStoryboardDescription(fields.openingDescription, shots, imageRefs, referenceCatalog, compositeEnabled);
      const nextPrompt = assembleH3Prompt(promptMode, sections);
      if (nextPrompt === latestPrompt) {
        storyboardBasePromptRef.current = latestPrompt;
        if (version === storyboardVersionRef.current) {
          storyboardDirtyRef.current = false;
          setStoryboardDirty(false);
        }
        return true;
      }
      const replaced = await ctx.replaceText(textTarget, textDocument.getDocumentId(), latestPrompt, nextPrompt);
      if (!replaced) {
        setStoryboardError("提示词保存时发生并发修改，请重新载入最新提示词后再编辑。");
        return false;
      }
      storyboardBasePromptRef.current = nextPrompt;
      if (version === storyboardVersionRef.current) {
        storyboardDirtyRef.current = false;
        setStoryboardDirty(false);
      }
      return true;
    } catch (error) {
      setStoryboardError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setStoryboardSaving(false);
    }
  };
  const saveStoryboard = (shots = storyboardShotsRef.current) => {
    const version = storyboardVersionRef.current;
    const fields = { openingDescription: storyboardOpeningDescriptionRef.current, summary: storyboardSummaryRef.current, soundscape: storyboardSoundscapeRef.current, music: storyboardMusicRef.current };
    const compositeEnabled = storyboardCompositeEnabledRef.current;
    const save = storyboardSaveQueueRef.current.catch(() => false).then(() => persistStoryboardSnapshot(shots, fields, version, compositeEnabled));
    storyboardSaveQueueRef.current = save;
    return save;
  };
  const updateStoryboardShots = (update: (shots: StoryboardShot[]) => StoryboardShot[]) => {
    const nextShots = update(storyboardShotsRef.current);
    storyboardShotsRef.current = nextShots;
    setStoryboardShots(nextShots);
    storyboardVersionRef.current += 1;
    storyboardDirtyRef.current = true;
    setStoryboardDirty(true);
    setStoryboardError(null);
    return nextShots;
  };
  const updateStoryboardRetention = (bindingId: string, retentionLevel: H3ReferenceRetention) => {
    const next = { ...storyboardRetentionLevelsRef.current, [bindingId]: retentionLevel };
    storyboardRetentionLevelsRef.current = next;
    setStoryboardRetentionLevels(next);
    storyboardVersionRef.current += 1;
    storyboardDirtyRef.current = true;
    setStoryboardDirty(true);
    setStoryboardError(null);
  };
  const persistStoryboardReferenceRetentions = (shots: StoryboardShot[]) => {
    const bindingIds = new Set(shots.map((shot) => shot.pictureBindingId).filter((id): id is string => Boolean(id)));
    if (!selected || !bindingIds.size) return true;
    const metadata = ctx.getNode(ctx.node.id)?.metadata || ctx.node.metadata || {};
    const segment = segmentsFor(metadata).find((item) => item.id === selected.id);
    if (!segment) {
      setStoryboardError("当前 Clip 已不存在，无法保存分镜图引用程度。");
      return false;
    }
    const refs = refsForSegment(segment);
    let changed = false;
    const nextRefs = refs.map((ref) => {
      if (!ref.bindingId || !bindingIds.has(ref.bindingId) || !isStoryboardPictureRef(ref)) return ref;
      const retentionLevel = storyboardRetentionLevelsRef.current[ref.bindingId] || (isStoryboardRetention(ref.retentionLevel) ? ref.retentionLevel : "fully_preserved");
      if (ref.retentionLevel === retentionLevel) return ref;
      changed = true;
      return { ...ref, retentionLevel };
    });
    if (changed) patchSelected(segmentRefsPatch(nextRefs));
    return true;
  };
  /** 实体定义编辑：写回 state 并把清单持久化到当前 Clip（方案 A：随 Clip 走）。 */
  const commitSubjectDefinitions = (next: H3SubjectDefinition[]) => {
    subjectDefinitionsRef.current = next;
    setSubjectDefinitions(next);
    storyboardVersionRef.current += 1;
    storyboardDirtyRef.current = true;
    setStoryboardDirty(true);
    setStoryboardError(null);
    patchSelected({ subjectDefinitions: next });
  };
  const updateSubjectDefinition = (index: number, patch: Partial<H3SubjectDefinition>) => {
    commitSubjectDefinitions(subjectDefinitionsRef.current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  };
  const removeSubjectDefinition = (index: number) => {
    commitSubjectDefinitions(subjectDefinitionsRef.current.filter((_, itemIndex) => itemIndex !== index));
  };
  const addSubjectDefinition = () => {
    commitSubjectDefinitions([...subjectDefinitionsRef.current, {
      id: `subject-${crypto.randomUUID()}`,
      name: "",
      profile: "",
      pictures: [],
      outfits: [],
    }]);
  };
  const resetSubjectDefinitions = () => {
    commitSubjectDefinitions(defaultSubjectDefinitions());
  };
  const updateStoryboardTextField = (field: "openingDescription" | "summary" | "soundscape" | "music", value: string) => {
    if (field === "openingDescription") { storyboardOpeningDescriptionRef.current = value; setStoryboardOpeningDescription(value); }
    if (field === "summary") { storyboardSummaryRef.current = value; setStoryboardSummary(value); }
    if (field === "soundscape") { storyboardSoundscapeRef.current = value; setStoryboardSoundscape(value); }
    if (field === "music") { storyboardMusicRef.current = value; setStoryboardMusic(value); }
    storyboardVersionRef.current += 1;
    storyboardDirtyRef.current = true;
    setStoryboardDirty(true);
    setStoryboardError(null);
  };
  const reloadStoryboard = () => {
    const latestPrompt = textDocument.getSnapshot().text;
    storyboardBasePromptRef.current = latestPrompt;
    const needsBindingSave = loadStoryboardPrompt(latestPrompt);
    storyboardDirtyRef.current = needsBindingSave;
    storyboardVersionRef.current += 1;
    setStoryboardDirty(needsBindingSave);
    setStoryboardError(null);
  };
  const models = ctx.ai.listModels("text");
  const promptModel = String(
    ctx.node.metadata?.minimaxLlmModel ||
      ctx.node.metadata?.llmModel ||
      ctx.ai.defaultModel("text") ||
      models[0]?.value ||
      "",
  );

  // 按 type 分组的序号（与 H3 工作台的 refsForSegment 语义一致：图片/视频/音频各自从 1 起）
  const mentionItems = useMemo<MentionItem[]>(
    () => [
      ...imageRefs.map((ref, index) => ({ ref, ordinal: index + 1 })),
      ...videoRefs.map((ref, index) => ({ ref, ordinal: index + 1 })),
      ...audioRefs.map((ref, index) => ({ ref, ordinal: index + 1 })),
    ],
    [imageRefs, videoRefs, audioRefs],
  );
  const storyboardPictureOptions = imageRefs.flatMap((ref, index) => isStoryboardPictureRef(ref) && ref.bindingId
    ? [{
      ref,
      value: ref.bindingId,
      label: <span className="nfh3-storyboard-picture-option">
        {ref.url ? <img src={ref.url} alt="" /> : null}
        <span>{`<Picture ${index + 1}> · ${storyboardRefDisplayName(ref.name) || "未命名分镜图"}`}</span>
      </span>,
    }]
    : []);

  // 实体定义的视觉来源池：当前 Clip 的非分镜图片引用（道具/场景/角色等）。
  // 分镜图只用于逐镜「绑定分镜图」，不再作为实体视觉身份候选，避免污染 Subject 定义。
  // 值用 `<Picture N>` 与本字段的存储格式一致；缩略图即图片本身，不显示编号。
  const subjectPicturePool = imageRefs.flatMap((ref, index) => (ref.url || ref.storageKey) && !isStoryboardPictureRef(ref)
    ? [{
      ref,
      value: `<Picture ${index + 1}>`,
      label: <span className="nfh3-storyboard-picture-option">
        {ref.url ? <img src={ref.url} alt="" /> : null}
        <span>{storyboardRefDisplayName(ref.name) || "未命名参考"}</span>
      </span>,
    }]
    : []);

  const ensureStoryboardPromptSections = async () => {
    if (promptMode !== "ref2va" || !selected?.id) return true;
    if (storyboardPromptGenerationRef.current) return false;
    storyboardPromptGenerationRef.current = true;
    setStoryboardPromptGenerating(true);
    setStoryboardError(null);
    const segmentId = selected.id;
    const version = storyboardVersionRef.current;
    const shots = storyboardShotsRef.current.map((shot) => ({ ...shot }));
    const fields = {
      openingDescription: storyboardOpeningDescriptionRef.current,
      summary: storyboardSummaryRef.current,
      soundscape: storyboardSoundscapeRef.current,
      music: storyboardMusicRef.current,
    };
    const target = { nodeId: ctx.node.id, segmentId, field: "prompt" as const };
    const document = ctx.textDocument(target);
    try {
      await document.flush();
      const before = document.getSnapshot();
      if (!before.ready || before.blocked) throw new Error(before.error || "提示词尚未同步，无法生成主体定义和保留分析。");
      const liveMetadata = ctx.getNode(ctx.node.id)?.metadata || ctx.node.metadata || {};
      const segment = segmentsFor(liveMetadata).find((item) => item.id === segmentId);
      if (!segment) throw new Error("当前 Clip 已不存在，无法生成提示词。");
      validateStoryboardShotDescriptions(shots);
      validateShotTimeline(shots, Number(segment.duration));
      const generation = storyboardGenerationContext(ctx, segment, fields, shots, referenceCatalog, storyboardRetentionLevelsRef.current, segment.subjectDefinitions);
      const normalizedSummary = generation.summary;
      const expectedDescription = serializeStoryboardDescription(fields.openingDescription, shots, imageRefs, referenceCatalog, segment.storyboardCompositeEnabled === true);
      if (
        readPromptSection(before.text, "summary") !== normalizedSummary ||
        readPromptSection(before.text, storyboardSection) !== expectedDescription ||
        readPromptSection(before.text, "overall_soundscape") !== fields.soundscape.trim() ||
        readPromptSection(before.text, "non_diegetic_music") !== fields.music.trim()
      ) throw new Error("分镜字段尚未保存到提示词，请重试完成。");

      const fingerprint = await storyboardPromptFingerprint(generation.content);
      const subjectBefore = readPromptSection(before.text, "subject_definitions");
      const retentionBefore = readPromptSection(before.text, "retention_analysis");
      const generated = buildStoryboardPromptSections(generation.subjects, generation.references, generation.shots);
      const generatedSections: H3PromptSectionValues = {
        subject_definitions: generated.subjectDefinitions,
        summary: normalizedSummary,
        retention_analysis: generated.retentionAnalysis,
        detailed_description: expectedDescription,
        overall_soundscape: fields.soundscape,
        non_diegetic_music: fields.music,
      };
      const generatedPrompt = assembleH3Prompt(promptMode, generatedSections);
      const cacheMatchesPrompt = subjectBefore === generated.subjectDefinitions && retentionBefore === generated.retentionAnalysis && before.text === generatedPrompt;
      if (segment.storyboardPromptCache?.version === 12 && segment.storyboardPromptCache.fingerprint === fingerprint && cacheMatchesPrompt) return true;

      await document.flush();
      const latest = document.getSnapshot();
      if (!latest.ready || latest.blocked) throw new Error(latest.error || "提示词同步失败，未应用生成结果。");
      if (version !== storyboardVersionRef.current) throw new Error("分镜在生成过程中又有修改，请确认最新内容后重试。");
      const latestMetadata = ctx.getNode(ctx.node.id)?.metadata || ctx.node.metadata || {};
      const latestSelectedId = String(latestMetadata.selectedSegmentId || segmentId);
      if (latestSelectedId !== segmentId) throw new Error("当前 Clip 已切换，未将生成结果写入其他 Clip。");
      const latestSegment = segmentsFor(latestMetadata).find((item) => item.id === segmentId);
      if (!latestSegment) throw new Error("当前 Clip 已不存在，未应用生成结果。");
      const latestGeneration = storyboardGenerationContext(ctx, latestSegment, fields, shots, referenceCatalog, storyboardRetentionLevelsRef.current, latestSegment.subjectDefinitions);
      if (await storyboardPromptFingerprint(latestGeneration.content) !== fingerprint) throw new Error("分镜引用或人物资料在生成过程中发生变化，请确认后重试。");
      if (
        readPromptSection(latest.text, "summary") !== normalizedSummary ||
        readPromptSection(latest.text, storyboardSection) !== expectedDescription ||
        readPromptSection(latest.text, "overall_soundscape") !== fields.soundscape.trim() ||
        readPromptSection(latest.text, "non_diegetic_music") !== fields.music.trim() ||
        readPromptSection(latest.text, "subject_definitions") !== subjectBefore ||
        readPromptSection(latest.text, "retention_analysis") !== retentionBefore
      ) throw new Error("提示词在生成过程中被其他位置修改，未覆盖已有内容；请重新确认分镜后重试。");

      const nextPrompt = generatedPrompt;
      if (nextPrompt !== latest.text && !await ctx.replaceText(target, document.getDocumentId(), latest.text, nextPrompt)) {
        throw new Error("生成结果写入时发生并发修改，请重试。");
      }
      const currentMetadata = ctx.getNode(ctx.node.id)?.metadata || ctx.node.metadata || {};
      const currentSegments = segmentsFor(currentMetadata);
      if (!currentSegments.some((item) => item.id === segmentId)) throw new Error("提示词已更新，但 Clip 状态发生变化，未保存生成缓存。");
      const storyboardPromptCache = { version: 12 as const, fingerprint, ...generated };
      ctx.updateMetadata({ segments: currentSegments.map((item) => item.id === segmentId ? { ...item, storyboardPromptCache } : item) });
      storyboardBasePromptRef.current = nextPrompt;
      return true;
    } catch (error) {
      setStoryboardError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      storyboardPromptGenerationRef.current = false;
      setStoryboardPromptGenerating(false);
    }
  };

  useEffect(() => {
    if (!selected) return;
    const savedDefinitions = selected.subjectDefinitions;
    setSubjectDefinitions(savedDefinitions?.length ? savedDefinitions : defaultSubjectDefinitions());
  }, [selected?.id, selected?.subjectDefinitions, imageRefs, referenceCatalog, ctx.node.id]);
  const openStoryboard = () => {
    if (mode !== "ref2va") return;
    const needsBindingSave = loadStoryboardPrompt(prompt);
    storyboardBasePromptRef.current = prompt;
    storyboardDirtyRef.current = needsBindingSave;
    setStoryboardDirty(needsBindingSave);
    setStoryboardError(null);
    setIsTranslated(false);
    // 实体定义：优先用 Clip 上已保存的用户版本；没有则按当前 Clip 引用规则生成一份默认值。
    const savedDefinitions = selected?.subjectDefinitions;
    setSubjectDefinitions(savedDefinitions?.length ? savedDefinitions : defaultSubjectDefinitions());
    setStoryboardMode(true);
  };
  /** 按当前 Clip 引用规则生成一份默认实体定义（打开表单时的初值 / 「重置为规则生成」）。 */
  const defaultSubjectDefinitions = (): H3SubjectDefinition[] => {
    const segment = selected;
    if (!segment) return [];
    const generation = storyboardGenerationContext(ctx, segment, {
      openingDescription: storyboardOpeningDescriptionRef.current,
      summary: storyboardSummaryRef.current,
      soundscape: storyboardSoundscapeRef.current,
      music: storyboardMusicRef.current,
    }, storyboardShotsRef.current, referenceCatalog, storyboardRetentionLevelsRef.current);
    return toSubjectDefinitions(generation.subjects);
  };
  const cancelStoryboard = () => {
    if (storyboardCompleting || storyboardSaving || storyboardPromptGenerating) return;
    storyboardVersionRef.current += 1;
    storyboardDirtyRef.current = false;
    setStoryboardDirty(false);
    setStoryboardError(null);
    setStoryboardMode(false);
  };
  const completeStoryboard = async () => {
    if (!storyboardMode || mode !== "ref2va" || storyboardCompleting) return;
    setStoryboardCompleting(true);
    try {
      validateStoryboardShotDescriptions(storyboardShotsRef.current);
      validateShotTimeline(storyboardShotsRef.current, selected?.duration);
      const refs = selected ? refsForSegment(selected) : [];
      validatePromptReferences([storyboardSummaryRef.current, storyboardOpeningDescriptionRef.current, ...storyboardShotsRef.current.map((shot) => shot.description), storyboardSoundscapeRef.current, storyboardMusicRef.current].join("\n"), refs);
      for (const [index, shot] of storyboardShotsRef.current.entries()) {
        if (shot.pictureBindingId && !refs.some((ref) => ref.bindingId === shot.pictureBindingId && isStoryboardPictureRef(ref) && (ref.url || ref.storageKey))) {
          throw new Error(`分镜 ${index + 1} 绑定的分镜图已失效，请重新选择。`);
        }
      }
      const expected = serializeStoryboardDescription(storyboardOpeningDescriptionRef.current, storyboardShotsRef.current, imageRefs, referenceCatalog, storyboardCompositeEnabledRef.current);
      if ((storyboardDirtyRef.current || readPromptSection(prompt, storyboardSection) !== expected) && !await saveStoryboard()) return;
      if (!persistStoryboardReferenceRetentions(storyboardShotsRef.current)) return;
      if (!await ensureStoryboardPromptSections()) return;
      storyboardDirtyRef.current = false;
      setStoryboardDirty(false);
      setStoryboardMode(false);
    } catch (error) {
      setStoryboardError(error instanceof Error ? error.message : String(error));
    } finally {
      setStoryboardCompleting(false);
    }
  };
  useEffect(() => { setIsTranslated(false); }, [selected?.id, prompt]);

  const enhancePrompt = async () => {
    console.log("zengqiangtishici ")
    if (!textStatus.ready || textStatus.blocked || !prompt.trim() || enhancing) return;
    const targetSegmentId = selected?.id;
    const promptAtCall = prompt;
    if (!targetSegmentId || promptJobs(ctx)[targetSegmentId]?.status === "running") return;
    const requestId = crypto.randomUUID();
    const job = { requestId, base: promptAtCall, documentId: textDocument.getDocumentId() };
    setPromptJob(ctx, targetSegmentId, { ...job, status: "running" });
    try {
      const model = String(
        ctx.node.metadata?.minimaxLlmModel ||
          ctx.node.metadata?.llmModel ||
          ctx.ai.defaultModel("text") ||
          "",
      );
      const normalizedMode = mode === "t2v" ? "t2va" : mode === "i2v" ? "i2va" : mode === "fl2v" ? "fl2va" : "ref2va";
      const target = segmentsFor(ctx.getNode(ctx.node.id)?.metadata || ctx.node.metadata || {}).find((segment) => segment.id === targetSegmentId) || selected;
      const references = target ? refsForSegment(target) : [];
      const missingAddress = references.filter((ref) => !ref.url && !ref.storageKey);
      if (missingAddress.length) {
        const names = missingAddress.map((ref) => ref.name || "未命名参考").join("、");
        setPromptJob(ctx, targetSegmentId, { ...job, status: "error", error: `参考图缺少可读取地址：${names}` });
        return;
      }
      const ordinals = { image: 0, video: 0, audio: 0 };
      const characterGroups = target?.h3CharacterGroups || {};
      const subjectOrdinals = new Map<string, number>();
      let nextSubjectOrdinal = 1;
      const manifest = references.map((ref) => {
        const ordinal = ++ordinals[ref.type];
        const group = ref.groupId ? characterGroups[ref.groupId] : Object.values(characterGroups).find((item) => item.subjectId === ref.subjectId || item.characterNodeId === ref.subjectId);
        const subjectKey = group ? `character:${group.subjectId || group.characterNodeId || group.id}` : ref.subjectId ? `subject:${ref.subjectId}` : "";
        let subjectSource = "";
        if (ref.type === "image" && ref.role !== "storyboard" && subjectKey && (group || ref.role?.startsWith("character_"))) {
          if (!subjectOrdinals.has(subjectKey)) subjectOrdinals.set(subjectKey, nextSubjectOrdinal++);
          subjectSource = `; maps to <Subject ${subjectOrdinals.get(subjectKey)}> (cite this Picture in that definition)`;
        }
        const subjects = (ref.storyboardSubjectIds || []).map((id) => {
          const node = ctx.getNode(id);
          return node?.type === "character" ? String(node.metadata?.characterName || node.title || id) : "";
        }).filter(Boolean);
        const role = `; role: ${ref.role || "other"}`;
        const cast = ref.role === "storyboard" && subjects.length ? `; storyboard characters: ${subjects.join(", ")}` : "";
        return `${ref.type === "image" ? "Picture" : ref.type === "video" ? "Video" : "Audio"} ${ordinal}: ${ref.name || "unnamed reference"}${role}${cast}${subjectSource}`;
      }).join("\n") || "None";
      // ---- 分镜图参考过渡：多张参考图按顺序排列成连续姿势帧，把段尾设计成过渡到下一张分镜姿势 ----
      const storyboardMode = ctx.node.metadata?.promptEnhanceStoryboard === true;
      const storyboardOrder = new Map((target?.storyboardShots || []).map((shot, index) => [shot.referenceBindingId || "", index]));
      const storyboardImageRefs = references
        .filter((ref) => ref.type === "image" && isStoryboardPictureRef(ref))
        .sort((left, right) => (storyboardOrder.get(left.bindingId || "") ?? Number.MAX_SAFE_INTEGER) - (storyboardOrder.get(right.bindingId || "") ?? Number.MAX_SAFE_INTEGER));
      const hasExplicitHardCut = /(?:\b(?:hard[- ]cut|the\s+(?:shot|camera)\s+cuts?\s+to)\b|\[Transition:\s*cut\]|硬切)/iu.test(promptAtCall);
      let transitionPlan = "";
      let transitionInstruction = "";
      if (storyboardMode && storyboardImageRefs.length >= 2) {
        if (!hasExplicitHardCut) transitionPlan = await analyzeStoryboardTransitions(ctx, storyboardImageRefs, model);
        const lastOrd = storyboardImageRefs.length;
        transitionInstruction = [
          `只有标记为 storyboard 的参考图才是本段分镜帧序列（图1为起始姿势，图${lastOrd}为目标姿势）；角色转面图、人物身份图和风格参考图不是过渡帧。`,
          hasExplicitHardCut
            ? `严格保留用户已经写明的切镜边界；需要 hard cut 的位置保持 hard cut，不要把切镜改写成跨镜连续运动。`
            : `从图1的姿势出发，依次经过每一对相邻分镜帧（图k→图k+1）的连续动作，最终收尾于图${lastOrd}的姿势；不得瞬移或重置。`,
          `末句必须明确落到图${lastOrd}的目标姿势（例如图1站立、图2蹲下，则末句写“此人缓缓蹲下成蹲姿”）。`,
          transitionPlan ? `按下面的「过渡计划」落实每段肢体、重心、朝向的具体变化。` : `没有生成跨镜过渡计划时，只依据各镜自己的分镜图和正文描述。`,
        ].join("\n");
      }
      const structure = normalizedMode === "ref2va"
        ? "Use exactly the six sections in this order: subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music. Use <Subject N>, <Picture N>, <Video N>, and <Audio N> consistently."
        : "Use exactly the three sections in this order: integrated_multimodal_description, overall_soundscape, non_diegetic_music.";
      const alignment = normalizedMode === "i2va"
        ? "Start with the official I2VA instruction aligning Picture 1 to 0.00 seconds."
        : normalizedMode === "fl2va"
          ? "Start with the official FL2VA instruction aligning Picture 1 to 0.00 seconds and Picture 2 to the final timestamp."
          : normalizedMode === "t2va"
            ? "Do not introduce reference labels or image-alignment instructions."
            : "Treat references as Ref2VA assets; do not force them to be the first frame unless the user explicitly requests it.";
      const officialReference = normalizedMode === "ref2va" ? refReference : baseReference;
      const systemParts = [
        "You are the official MiniMax H3 video prompt writer.",
        "Follow the embedded official H3 prompt-writing reference exactly; it is the format authority.",
        "Subject numbers are independent of Picture numbers. Character mappings in the reference manifest are authoritative: use each mapped <Subject N> exactly and cite its source <Picture N> in subject_definitions. Never number a Subject by counting preceding Pictures.",
        officialReference,
        `The selected mode is ${normalizedMode.toUpperCase()} and the selected clip duration is ${Number(selected?.duration || 5).toFixed(2)} seconds.`,
        structure,
        alignment,
        "Rewrite the user intent into one production-ready prompt. Preserve characters, actions, dialogue, visible text, reference numbering, and hard constraints; never invent facts.",
        "Make every requested visual detail explicit: composition, subject appearance, pose, gaze, action phases, camera type/amplitude/speed, lighting, materials, continuity, environment, and sound.",
        "Use the exact official field names, section order, reference tags, timestamp conventions, dialogue tags, and language rules. Preserve each <Subject N>, <Picture N>, <Video N>, and <Audio N> tag exactly; do not renumber them.",
        "Assign a stable speaker id (S1, S2, …) to every subject who speaks or delivers dialogue in detailed_description, in order of first appearance; write it immediately after the subject reference, e.g. '<Subject 1> (S1) says:'. Every spoken line must carry its speaker id — never drop it.",
        "Keep exact user dialogue and visible text unchanged. Do not repeat dialogue in overall_soundscape or non_diegetic_music.",
        "Return only the final prompt, without Markdown fences, explanations, or prefaces.",
      ];
      if (transitionInstruction) systemParts.push(`Storyboard image reference transition instruction:\n${transitionInstruction}`);
      const system = systemParts.join("\n\n");
      const userPromptParts = [
        promptAtCall.trim(),
        String(ctx.node.metadata?.globalPrompt || "").trim(),
        `Reference manifest (fixed numbering; do not reorder):\n${manifest}`,
      ];
      if (transitionPlan) userPromptParts.push(`Transition plan (fixed image order; do not reorder):\n${transitionPlan}`);
      const userPrompt = userPromptParts.filter(Boolean).join("\n\n");
      const refPayload = references.map((ref) => ({ url: ref.url, name: ref.name, storageKey: ref.storageKey, mimeType: ref.mimeType }));
      const result = await ctx.ai.generateText(userPrompt, {
        model,
        system,
        references: refPayload,
        log: { taskMode: "增强提示词", nodeId: ctx.node.id, segmentId: targetSegmentId, references: refPayload },
      });
      // 模型未返回内容时（如 Ollama 空响应），requestImageQuestion 现在返回空串，
      // 这里不能把 prompt 覆写成占位符/空串——保留用户原文，并给出明确失败提示。
      const enhanced = result.text.trim();
      if (enhanced) {
        setPromptJob(ctx, targetSegmentId, { ...job, text: enhanced, status: "suggestion" });
        // 先保存候选，再尝试条件采用；切 Clip 不改变此闭包捕获的目标。
        await persistPromptCandidate(suggestions, job, enhanced);
        setPromptJob(ctx, targetSegmentId, { ...job, status: "done" });
      } else {
        setPromptJob(ctx, targetSegmentId, { ...job, status: "error", error: "模型未返回内容，增强被跳过（请检查文本模型配置或重试）" });
      }
    } catch (error) {
      const candidate = promptJobs(ctx)[targetSegmentId];
      setPromptJob(ctx, targetSegmentId, { ...job, text: candidate?.text, status: candidate?.text ? "suggestion" : "error", error: error instanceof Error ? error.message : String(error) });
    }
  };

  // 翻译 system prompt：只翻自然语言，保留南风官方结构标记、引用标签和数值
  const TRANSLATION_SYSTEM_PROMPT = [
    "You are a translator for H3 video prompts. Translate the following to Simplified Chinese.",
    "Rules:",
    "- Keep section headers ending with ':' (e.g., subject_definitions:, summary:) exactly as in the original; they are official structure markers.",
    "- Keep reference tags like <Subject 1>, <Picture 1>, <Video 1>, <Audio 1> exactly as in the original.",
    "- Keep timestamps, numerical values, and proper nouns unchanged.",
    "- Translate all other natural language to natural Simplified Chinese.",
    "- Preserve line breaks, indentation, and overall structure.",
    "- Return only the translated prompt. No explanations, no Markdown fences, no preamble.",
  ].join("\n");

  const handleTranslateToggle = async () => {
    if (isTranslated) {
      setIsTranslated(false);
      return;
    }
    if (!prompt.trim()) return;
    // 缓存命中：直接切到中文态
    if (translation && translation.segmentId === selected?.id && translation.prompt === prompt) {
      setIsTranslated(true);
      return;
    }
    const promptAtCall = prompt;
    const segmentIdAtCall = selected?.id || "";
    setTranslating(true);
    setTranslateError(null);
    try {
      const model = String(
        ctx.node.metadata?.minimaxLlmModel ||
          ctx.node.metadata?.llmModel ||
          ctx.ai.defaultModel("text") ||
          "",
      );
      const result = await ctx.ai.generateText(promptAtCall.trim(), {
        model,
        system: TRANSLATION_SYSTEM_PROMPT,
        log: { taskMode: "翻译", nodeId: ctx.node.id, segmentId: segmentIdAtCall },
      });
      const text = result.text.trim();
      if (text) {
        setTranslation({ segmentId: segmentIdAtCall, prompt: promptAtCall, text });
        // 异步期间 prompt 可能已被用户改掉，只在没变时才切到中文态
        if (promptRef.current.prompt === promptAtCall && promptRef.current.segmentId === segmentIdAtCall) setIsTranslated(true);
      } else {
        setTranslateError("翻译模型未返回内容，请检查文本模型配置或重试");
      }
    } catch (error) {
      setTranslateError(error instanceof Error ? error.message : String(error));
    } finally {
      setTranslating(false);
    }
  };

  const insertAtCursor = (text: string) => editorRef.current?.insert(text, { prefixNewline: true });

  const editorReferences = useMemo(() => {
    if (promptMode === "t2v") return [];
    const references: CanvasTextReference[] = [];
    const groups = Object.entries(selected?.h3CharacterGroups || {});
    const assetForRef = (ref: H3Ref) => referenceCatalog.find((asset) => asset.id === ref.assetId || Boolean(ref.storageKey && asset.storageKey === ref.storageKey) || Boolean(ref.url && asset.url === ref.url));
    const subjectIdForRef = (ref: H3Ref) => ref.subjectId || assetForRef(ref)?.subjectId;
    const subjects = new Map<string, Set<string>>();
    const addSubject = (id?: string) => {
      if (!id) return;
      const group = groups.find(([groupId, item]) => groupId === id || item.characterNodeId === id || item.subjectId === id);
      const canonicalId = group?.[0] || id;
      const aliases = subjects.get(canonicalId) || new Set([canonicalId]);
      aliases.add(id);
      if (group?.[1].characterNodeId) aliases.add(group[1].characterNodeId);
      if (group?.[1].subjectId) aliases.add(group[1].subjectId);
      subjects.set(canonicalId, aliases);
    };
    const definedSubjects = subjectDefinitions.length ? subjectDefinitions : null;
    mentionItems.filter(({ ref }) => ref.type === "image").forEach(({ ref }) => {
      addSubject(subjectIdForRef(ref));
      addSubject(ref.groupId);
      ref.storyboardSubjectIds?.forEach(addSubject);
    });
    const subjectOrdinalById = new Map<string, number>();
    if (definedSubjects) {
      // 实体定义是权威编号：<Subject N> 的 N 即定义顺序。
      definedSubjects.forEach((definition, index) => {
        subjectOrdinalById.set(definition.id, index + 1);
        subjects.get(definition.id)?.forEach((id) => subjectOrdinalById.set(id, index + 1));
      });
    }
    [...subjects].forEach(([subjectId, aliases], index) => {
      if (subjectOrdinalById.has(subjectId)) return;
      aliases.forEach((id) => { if (!subjectOrdinalById.has(id)) subjectOrdinalById.set(id, index + 1); });
      subjectOrdinalById.set(subjectId, index + 1);
    });
    if (definedSubjects) {
      const pictureRefFor = (definition: H3SubjectDefinition) => {
        const tags = definition.pictures || [];
        return mentionItems.find(({ ref }) => ref.type === "image" && (
          ref.subjectId === definition.id || ref.groupId === definition.id ||
          (ref.storyboardSubjectIds || []).includes(definition.id) ||
          tags.some((tag) => {
            const match = /^<Picture\s+(\d+)>$/iu.exec(tag);
            return match ? mentionItems[Number(match[1]) - 1]?.ref === ref : false;
          })
        ))?.ref;
      };
      definedSubjects.forEach((definition, index) => {
        references.push(subjectDefinitionEditorReference(ctx, selected, definition, index + 1, pictureRefFor(definition)));
      });
    } else {
      subjects.forEach((aliases, subjectId) => {
        const fallbackRef = mentionItems.find(({ ref }) => ref.type === "image" && (aliases.has(ref.groupId || "") || aliases.has(subjectIdForRef(ref) || "") || ref.storyboardSubjectIds?.some((id) => aliases.has(id))))?.ref;
        const subjectOrdinal = subjectOrdinalById.get(subjectId) || 1;
        references.push(characterEditorReference(ctx, selected, subjectId, subjectOrdinal, fallbackRef));
      });
    }
    mentionItems.forEach((item) => {
      const group = item.ref.groupId ? selected?.h3CharacterGroups?.[item.ref.groupId] : undefined;
      const isOutfit = Boolean(group && item.ref.outfitId);
      const label = isOutfit ? `服装 · ${item.ref.name}` : item.ref.type === "image" ? `图片${item.ordinal}` : item.ref.type === "video" ? `视频${item.ordinal}` : `音频${item.ordinal}`;
      const subjectId = item.ref.groupId || item.ref.subjectId || assetForRef(item.ref)?.subjectId;
      const subjectOrdinal = subjectId ? subjectOrdinalById.get(subjectId) : undefined;
      const referenceTag = item.ref.type === "image" ? `<Picture ${item.ordinal}>` : item.ref.type === "video" ? `<Video ${item.ordinal}>` : `<Audio ${item.ordinal}>`;
      const subjectTag = item.ref.type === "image" && subjectOrdinal ? `<Subject ${subjectOrdinal}>` : undefined;
      const legacyReferenceTag = item.ref.bindingId ? `{{ref:${item.ref.bindingId}}}` : "";
      references.push({
        label,
        displayLabel: isOutfit ? label : item.ref.name || label,
        title: isOutfit ? `${group?.characterName || "角色"} · 服装参考` : item.ref.name,
        kind: item.ref.type,
        previewUrl: item.ref.url,
        insert: subjectTag ? `${subjectTag} is the visual content referenced from ${referenceTag}` : referenceTag,
        tokens: [referenceTag, legacyReferenceTag].filter(Boolean),
      });
    });
    return references;
  }, [ctx, mentionItems, promptMode, referenceCatalog, selected, subjectDefinitions]);
  const unresolvedReferenceMarkers = useMemo(() => {
    if (!textStatus.ready) return [];
    const knownTokens = new Set(editorReferences.flatMap((reference) => reference.tokens || []).map((token) => token.toLocaleLowerCase()));
    return [...prompt.matchAll(/<(?:Subject|Picture|Video|Audio)\s+\d+>/giu)].map((match) => match[0]).filter((token) => !knownTokens.has(token.toLocaleLowerCase()));
  }, [editorReferences, prompt, textStatus.ready]);
  const characterReferences = useMemo(() => editorReferences.filter((reference) => reference.kind === "character"), [editorReferences]);
  // 台词说话人名册：角色引用按 <Subject N> 序号顺序排列；已确立的 (Sx) 从提示词文本解析回来，
  // 未确立的按序补号，保证下拉/徽标显示「Sx · 角色名」。
  const speakerRoster = useMemo<StoryboardSpeakerOption[]>(() => {
    const subjectToSpeaker = parseSubjectSpeakerMap(prompt);
    const used = new Set(subjectToSpeaker.values());
    let next = 1;
    const roster: StoryboardSpeakerOption[] = characterReferences.map((reference, index) => {
      const name = (reference.displayLabel || reference.label || "").replace(/^人物\s*·\s*/, "") || undefined;
      const ordinal = String(index + 1);
      let id = subjectToSpeaker.get(ordinal);
      if (!id) {
        while (used.has(`S${next}`)) next += 1;
        id = `S${next++}`;
        used.add(id);
      }
      return { id, name, previewUrl: reference.previewUrl };
    });
    // 文本里出现但没对应到角色的说话人编号（如纯音色主体），也补进名册
    for (const id of collectSpeakerIds(prompt)) {
      if (!used.has(id) && !roster.some((option) => option.id === id)) roster.push({ id });
    }
    return roster;
  }, [characterReferences, prompt]);
  // 分镜编辑各文本框的引用列表：覆盖当前 Clip 的**全部**图片引用。
  // <Picture N> 的 N 一律取 imageRefs 里的真实序号，保证与 prompt 文本、外层编辑器完全一致；
  // 若按 role 过滤（只放分镜图/角色），场景、道具、风格等引用就会在分镜编辑里显示「未找到」。
  // pictureBindingIdsInDescription 已加护栏：反查时只认 role==="storyboard"，
  // 所以这里放全量不会把 scene/prop 误算成分镜图，composite/track/retention 判定不受影响。
  const storyboardEditorReferences = useMemo(() => {
    const roleLabel = (role: string) => role === "storyboard" ? "分镜图" : role === "character_turnaround" || role === "character_identity" ? "人物"
      : role === "prop" ? "道具" : role === "scene" ? "场景" : role === "style" || role === "palette" ? "风格" : "参考图";
    return [
      ...imageRefs.flatMap((ref, index) => {
        if (!ref.url && !ref.storageKey) return [];
        const role = inferReferenceRole(ref);
        const pictureTag = `<Picture ${index + 1}>`;
        const refName = storyboardRefDisplayName(ref.name) || "未命名参考";
        return [{
          label: `${roleLabel(role)} · ${refName}`,
          displayLabel: `${roleLabel(role)} · ${refName}`,
          title: refName,
          kind: "image",
          previewUrl: ref.url,
          insert: pictureTag,
          tokens: ref.bindingId ? [pictureTag, `{{ref:${ref.bindingId}}}`] : [pictureTag],
        }];
      }),
      ...editorReferences.filter((reference) => reference.kind === "audio" || reference.kind === "video"),
      ...characterReferences,
    ];
  }, [characterReferences, editorReferences, imageRefs]);

  const boundStoryboardImageCount = new Set(storyboardShots.flatMap((shot) => [
    ...(shot.pictureBindingId ? [shot.pictureBindingId] : []),
    ...pictureBindingIdsInDescription(shot.description, imageRefs),
  ]).filter((id) => imageRefs.some((ref) => isStoryboardPictureRef(ref) && ref.bindingId === id))).size;

  return (
    <section className="minimax-prompt-field minimax-prompt-field--mention">
      <span key="prompt-header" className="nfh3-prompt-header">
        <span className="nfh3-prompt-header-main">
          <H3Icon key="prompt-icon" name="prompt" /> <span key="prompt-label">Prompt</span>{" "}
          {!storyboardMode ? <>
            <button
              key="enhance"
              type="button"
              disabled={enhancing || !prompt.trim()}
              onClick={() => void enhancePrompt()}
              title={!prompt.trim() ? "请先输入提示词" : "调用当前文本模型增强提示词"}
            >
              {enhancing ? "增强中…" : "增强提示词"}
            </button>
            <label
              key="storyboard-toggle"
              style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 22, marginLeft: 6, opacity: imageRefs.length >= 2 ? 1 : 0.45, cursor: imageRefs.length >= 2 ? "pointer" : "not-allowed" }}
            >
              <input
                type="checkbox"
                disabled={imageRefs.length < 2}
                checked={ctx.node.metadata?.promptEnhanceStoryboard === true}
                onChange={(event) => ctx.updateMetadata({ promptEnhanceStoryboard: event.target.checked })}
                title={imageRefs.length < 2 ? "分镜图过渡需要至少 2 张图片参考" : "开启后按分镜图顺序把段尾设计成过渡到下一张分镜姿势"}
              />
              分镜图过渡
            </label>
          </> : null}
        </span>
        {mode === "ref2va" ? <button type="button" className="nfh3-prompt-view-toggle" title="打开结构化分镜提示词编辑器" onClick={openStoryboard}>
          {storyboardSaving ? "保存中…" : "分镜编辑"}
        </button> : null}
      </span>
      {!storyboardMode ? <div key="prompt-modes" className="minimax-prompt-modes">
        <span className="minimax-prompt-mode-tools">
        {Object.keys(toolBlocks).map((label) => (
          <button
            type="button"
            key={label}
            onClick={() => insertAtCursor(toolBlocks[label])}
          >
            {label}
          </button>
        ))}
        </span>
        <button
          type="button"
          className="minimax-prompt-help"
          title="提示词结构说明"
          aria-expanded={helpOpen}
          onClick={() => setHelpOpen((open) => !open)}
        >
          说明
        </button>
      </div> : null}
      {!storyboardMode && helpOpen ? <div key="prompt-help" className="minimax-prompt-help-panel" role="note">
        <b>{modeConfig.title}</b>
        <span>字段：{modeConfig.fields}</span>
        <span>{modeConfig.refs}</span>
      </div> : null}
      {!storyboardMode ? <small key="prompt-syntax" className="minimax-prompt-syntax">
        <code key="subject">&lt;Subject N&gt; 指认主体（独立编号）</code>{" "}
        <code key="picture">&lt;Picture P&gt; 指认第 P 张参考图</code>{" "}
        <code key="video">&lt;Video V&gt; 指认第 V 段参考视频</code>{" "}
        <code key="audio">&lt;Audio A&gt; 指认第 A 段参考音频</code>
        {enhancement?.error ? (
          <span
            key="enhance-error"
            role="alert"
            title="点击复制错误信息到剪贴板"
            onClick={() => {
              const text = `增强失败：${enhancement.error}`;
              const fallback = () => {
                const ta = document.createElement("textarea");
                ta.value = text;
                ta.style.position = "fixed";
                ta.style.opacity = "0";
                document.body.appendChild(ta);
                ta.select();
                try { document.execCommand("copy"); } catch { /* ignore */ }
                document.body.removeChild(ta);
              };
              if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(text).catch(fallback);
              } else {
                fallback();
              }
              setCopiedError(true);
              window.setTimeout(() => setCopiedError(false), 1500);
            }}
            style={{ cursor: "pointer", userSelect: "none" }}
          >
            {copiedError ? "已复制到剪贴板" : `增强失败：${enhancement.error}`}
          </span>
        ) : null}
      </small> : null}
      {!storyboardMode && (suggestionState.error || suggestionState.pending) ? <div role="status" className="minimax-prompt-help-panel">
        {suggestionState.error || "候选正在保存"}{suggestionState.pending ? "；未确认结果已保留为本地草稿" : ""}
        <button type="button" onClick={() => void suggestions.refresh(true).catch(() => {})}>重新同步候选</button>
      </div> : null}
      {!storyboardMode ? suggestionState.items.filter((item) => item.status === "pending").map((item) => (
        <details key={item.id} className="minimax-prompt-help-panel">
          <summary>{item.documentId !== textDocument.getDocumentId() ? "旧文本对象的强化候选（只读保留）" : "待确认的强化候选（仅对应此 Clip）"}</summary>
          <textarea value={item.text} readOnly aria-label="待确认的强化提示词" />
          <button type="button" disabled={!textStatus.ready || textStatus.blocked || item.documentId !== textDocument.getDocumentId() || !item.revision}
            onClick={() => void suggestions.apply(item.id, textDocument.getDocumentId(), prompt).catch(() => {})}>用此结果替换当前显示的原文</button>
          <button type="button" disabled={!item.revision} onClick={() => void suggestions.dismiss(item.id).catch(() => {})}>保留原文并忽略此候选</button>
        </details>
      )) : null}
      {!storyboardMode && enhancement?.text && enhancement.status === "suggestion" && !suggestionState.items.some((item) => item.id === enhancement.requestId) ? <details className="minimax-prompt-help-panel">
        <summary>候选尚未存入草稿，请先复制保留</summary>
        <textarea value={enhancement.text} readOnly aria-label="未保存的强化提示词" />
      </details> : null}
      {!storyboardMode ? <div key="prompt-actions" className="nfh3-prompt-actions">
        <Select
          className="minimax-prompt-model"
          size="medium"
          value={promptModel || undefined}
          placeholder="提示词增强模型"
          options={models.map((model) => ({
            value: model.value,
            label: model.label,
          }))}
          onChange={(value) => ctx.updateMetadata({ minimaxLlmModel: value })}
        />
        <button
          type="button"
          className={`minimax-aux-storyboard${String(ctx.node.metadata?.smartStoryboardStatus || "") === "error" ? " is-error" : ""}`}
          onClick={onOpenStoryboard}
          disabled={String(ctx.node.metadata?.smartStoryboardStatus || "") === "loading"}
          title={String(ctx.node.metadata?.smartStoryboardStatus || "") === "error" ? String(ctx.node.metadata?.smartStoryboardError || "") : undefined}
        >
          {String(ctx.node.metadata?.smartStoryboardStatus || "") === "loading" ? "智能分镜生成中…" : String(ctx.node.metadata?.smartStoryboardStatus || "") === "error" ? "分镜失败·点击重试" : "智能分镜"}
        </button>
      </div> : null}
      {!storyboardMode ? <div key="prompt-options" className="nfh3-prompt-options">
        <label>
          <span>恒定触发词</span>
          <input
            value={String(selected?.constantTriggerWord || "")}
            onChange={(event) =>
              patchSelected({ constantTriggerWord: event.target.value })
            }
            placeholder="可选，置于每段提示词前"
          />
        </label>
        <span className="nfh3-prompt-ref-hint">
          {mode === "ref2va"
            ? "输入 @ 选择引用素材；插入后显示为缩略图块"
            : mode === "t2v"
              ? "当前模式无需引用素材"
              : "输入 @ 选择图片引用；插入后显示为缩略图块"}
        </span>
      </div> : null}
      {unresolvedReferenceMarkers.length ? <div className="minimax-prompt-reference-error" role="alert">
        发现 {unresolvedReferenceMarkers.length} 处未匹配的人物或素材引用（见红色标记）。点击红色标记可从当前 Clip 引用中重新选择，也可以删除。
      </div> : null}
      <div key="prompt-textarea-wrap" className={`minimax-prompt-translate-wrap${!isTranslated && selected ? " has-line-map" : ""}`}>
        {isTranslated && translation && translation.segmentId === selected?.id && translation.prompt === prompt
          ? <textarea readOnly value={translation.text} aria-label="中文翻译（只读）" />
          : selected ? <TextEditor key={selected.id} projectId={ctx.projectId} target={textTarget} editorRef={editorRef} references={editorReferences} chips speakers={speakerRoster} dialogue lineMap placeholder="请输入提示词" className="minimax-collaborative-prompt minimax-prompt-line-map-enabled" style={{ minHeight: 160, height: 240, fontSize: 29 }} /> : null}
        <button
          key="prompt-translate"
          type="button"
          onClick={() => void handleTranslateToggle()}
          disabled={translating || (!isTranslated && !prompt.trim())}
          className={`minimax-prompt-translate${isTranslated ? " is-translated" : ""}`}
          aria-label={isTranslated ? "切换回原提示词" : translating ? "正在翻译" : "查看中文翻译"}
          title={isTranslated ? "切换回原提示词" : translating ? "正在翻译…" : !prompt.trim() ? "请先输入提示词" : "查看中文翻译"}
        >
          {translating ? "…" : isTranslated ? "EN" : "译"}
        </button>
        {translateError ? <div key="prompt-translate-error" className="minimax-prompt-translate-error" role="alert">翻译失败：{translateError}</div> : null}
      </div>
      <Modal
        className="nfh3-storyboard-modal"
        title="分镜提示词编辑"
        open={storyboardMode && mode === "ref2va"}
        onCancel={cancelStoryboard}
        closable={!storyboardCompleting && !storyboardSaving && !storyboardPromptGenerating}
        width="min(1000px, calc(100vw - 32px))"
        centered
        styles={{ body: { height: "min(78vh, 860px)", minHeight: 0, display: "flex", flexDirection: "column", overflow: "auto", fontSize: 14 } }}
        footer={<Button type="primary" loading={storyboardCompleting || storyboardPromptGenerating} onClick={() => void completeStoryboard()}>{storyboardPromptGenerating ? "整理提示词…" : "完成"}</Button>}
        destroyOnHidden
      >
        <div className="nfh3-storyboard-editor" style={h3ThemeVars(ctx.theme)}>
          <div className="nfh3-storyboard-toolbar">
            <span>{storyboardPromptGenerating ? "正在按规则整理主体定义与保留分析…" : storyboardDirty ? "修改待保存" : "结构化提示词已同步"}{storyboardSaving ? " · 保存中…" : ""}</span>
            <label className="nfh3-storyboard-composite-toggle" title={boundStoryboardImageCount < 2 ? "至少需要两张绑定到镜头的分镜图" : "将已绑定到镜头的分镜图按格位合成一张参考图提交"}>
              <span>合并提交分镜图</span>
              <Switch
                size="small"
                checked={selected?.storyboardCompositeEnabled === true}
                disabled={boundStoryboardImageCount < 2}
                onChange={(checked) => {
                  storyboardCompositeEnabledRef.current = checked;
                  patchSelected({ storyboardCompositeEnabled: checked });
                  storyboardVersionRef.current += 1;
                  storyboardDirtyRef.current = true;
                  setStoryboardDirty(true);
                  setStoryboardError(null);
                  void saveStoryboard();
                }}
              />
            </label>
            <span className="nfh3-storyboard-composite-hint">{boundStoryboardImageCount < 2 ? "绑定至少两张分镜图后可用" : "未绑定到镜头的分镜图仍单独提交"}</span>
            <button type="button" onClick={() => {
              updateStoryboardShots((shots) => [...shots, { id: crypto.randomUUID(), description: "", switchTime: "", preciseCut: false, transitionType: "cut" }]);
            }}>添加分镜</button>
          </div>
          <div className="nfh3-storyboard-fields">
            {promptMode === "ref2va" ? <details className="nfh3-storyboard-detail nfh3-subject-definitions" open>
              <summary>
                实体定义（{subjectDefinitions.length}）
                <span className="nfh3-subject-actions">
                  <button type="button" onClick={() => addSubjectDefinition()}>添加实体</button>
                  <button type="button" onClick={() => resetSubjectDefinitions()}>重置为规则生成</button>
                </span>
              </summary>
              <div className="nfh3-storyboard-detail-body">
                <div className="nfh3-subject-hint">打开表单时已按当前 Clip 引用自动填写。Subject 不一定只能是角色——道具、场景等主体同样在此定义，编号即 &lt;Subject N&gt; 的 N。</div>
                {subjectDefinitions.length ? subjectDefinitions.map((definition, index) => (
                  <section className="nfh3-subject-row" key={definition.id || index}>
                    <div className="nfh3-subject-primary">
                      <span className="nfh3-subject-ordinal">{`<Subject ${index + 1}>`}</span>
                      <label className="nfh3-subject-field">
                        <span>主体名称</span>
                        <input
                          className="nfh3-subject-name"
                          value={definition.name}
                          placeholder="角色 / 道具 / 场景"
                          onChange={(event) => updateSubjectDefinition(index, { name: event.target.value })}
                          aria-label={`实体 ${index + 1} 名称`}
                        />
                      </label>
                      <button type="button" className="nfh3-subject-remove" onClick={() => removeSubjectDefinition(index)} aria-label={`删除实体 ${index + 1}`}>删除</button>
                    </div>
                    <label className="nfh3-subject-field nfh3-subject-profile-field">
                      <span>视觉特征描述 <em>可选</em></span>
                      <input
                        className="nfh3-subject-profile"
                        value={definition.profile || ""}
                        placeholder="留空时使用规则生成的描述"
                        onChange={(event) => updateSubjectDefinition(index, { profile: event.target.value })}
                        aria-label={`实体 ${index + 1} 描述`}
                      />
                    </label>
                    <label className="nfh3-subject-field nfh3-subject-sources-field">
                      <span>视觉来源 <em>可多选</em></span>
                      <Select
                        className="nfh3-subject-pictures"
                        popupClassName="nfh3-subject-pictures-popup"
                        mode="multiple"
                        value={definition.pictures?.length ? definition.pictures : []}
                        options={[
                          ...subjectPicturePool.map(({ value, label }) => ({ value, label })),
                          ...(definition.pictures || []).filter((tag) => !subjectPicturePool.some((option) => option.value === tag))
                            .map((tag) => ({ value: tag, label: <span className="nfh3-storyboard-picture-option"><span>{`${tag}（已移除的参考）`}</span></span> })),
                        ]}
                        labelRender={({ value }) => {
                          const option = subjectPicturePool.find((item) => item.value === value);
                          const url = option?.ref.url;
                          return <span className="nfh3-subject-picture-chip" title={option?.ref.name || String(value)}>
                            {url ? <img src={url} alt="" /> : null}
                          </span>;
                        }}
                        optionRender={(option) => <>{option.label}</>}
                        onChange={(value) => updateSubjectDefinition(index, { pictures: (value as string[]).map(String) })}
                        placeholder="选择角色、场景或道具参考"
                        aria-label={`实体 ${index + 1} 视觉来源`}
                        style={{ width: "100%" }}
                      />
                    </label>
                  </section>
                )) : <div className="nfh3-subject-hint">当前 Clip 未解析出实体。可点「重置为规则生成」或「添加实体」。</div>}
              </div>
            </details> : null}
            {promptMode === "ref2va" ? <details className="nfh3-storyboard-detail" open>
              <summary>summary</summary>
              <div className="nfh3-storyboard-detail-body">
                <AutoGrowTextarea
                  value={storyboardSummary}
                  onChange={(event) => updateStoryboardTextField("summary", event.target.value)}
                  placeholder="填写本段剧情摘要"
                  ariaLabel="summary"
                />
              </div>
            </details> : null}
            <details className="nfh3-storyboard-detail" open>
              <summary>{storyboardSection}</summary>
              <div className="nfh3-storyboard-detail-body">
                <div className="nfh3-storyboard-opening nfh3-storyboard-detail">
                  <div className="nfh3-storyboard-static-summary">开头总体描述（非分镜）</div>
                  <div className="nfh3-storyboard-detail-body">
                    <TextEditor
                      key={`${selected?.id}:storyboard-opening`}
                      projectId={ctx.projectId}
                      target={textTarget}
                      standalone
                      autoHeight
                      value={storyboardOpeningDescription}
                      onChange={(description) => updateStoryboardTextField("openingDescription", description)}
                      references={storyboardEditorReferences}
                      speakers={speakerRoster}
                      dialogue
                      chips
                      placeholder="填写全段统一的风格、时代、环境、画面和连续性要求，不写具体镜头动作"
                      className="minimax-collaborative-prompt nfh3-shot-editor nfh3-opening-editor"
                      style={{ minHeight: 80, height: "auto", fontSize: 15 }}
                    />
                  </div>
                </div>
            <div className="nfh3-storyboard-list">
              {storyboardShots.map((shot, index) => <details className="nfh3-storyboard-item nfh3-storyboard-detail" key={shot.id} open>
                <summary>
                  <strong>分镜 {index + 1}</strong>
                  <button type="button" disabled={storyboardShots.length <= 1} onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    updateStoryboardShots((shots) => shots.filter((item) => item.id !== shot.id));
                  }}>删除</button>
                </summary>
                <div className="nfh3-storyboard-detail-body">
                  <div className="nfh3-storyboard-picture-binding">
                  <label htmlFor={`h3-shot-picture-${selected?.id}-${shot.id}`}>绑定分镜图</label>
                  <Select
                    id={`h3-shot-picture-${selected?.id}-${shot.id}`}
                    size="small"
                    value={shot.pictureBindingId}
                    allowClear
                    placeholder={storyboardPictureOptions.length ? "选择当前 Clip 引用的分镜图" : "请先在 Refs 中添加分镜图"}
                    options={[
                      ...storyboardPictureOptions.map(({ value, label }) => ({ value, label })),
                      ...(shot.pictureBindingId && !storyboardPictureOptions.some((option) => option.value === shot.pictureBindingId)
                        ? [{ value: shot.pictureBindingId, label: "已移除的分镜图（待重新绑定）" }]
                        : []),
                    ]}
                    onChange={(value) => {
                      updateStoryboardShots((shots) => shots.map((item) => item.id === shot.id ? { ...item, pictureBindingId: typeof value === "string" ? value : undefined } : item));
                    }}
                    aria-label={`为分镜 ${index + 1} 绑定分镜图`}
                    style={{ width: "min(440px, 100%)" }}
                  />
                  {(() => {
                    const picture = storyboardPictureOptions.find((option) => option.value === shot.pictureBindingId)?.ref;
                    return <>
                      {shot.pictureBindingId ? <>
                        <label htmlFor={`h3-shot-retention-${selected?.id}-${shot.id}`}>引用程度</label>
                        <Select
                          id={`h3-shot-retention-${selected?.id}-${shot.id}`}
                          value={storyboardRetentionLevels[shot.pictureBindingId] || (isStoryboardRetention(picture?.retentionLevel) ? picture.retentionLevel : "fully_preserved")}
                          options={STORYBOARD_RETENTION_OPTIONS.map(({ value, label }) => ({ value, label: `${label}（${value}）` }))}
                          disabled={!picture}
                          onChange={(value) => updateStoryboardRetention(shot.pictureBindingId!, value as H3ReferenceRetention)}
                          aria-label={`分镜 ${index + 1} 的引用程度`}
                          style={{ width: "min(260px, 100%)" }}
                        />
                      </> : null}
                    </>;
                  })()}
                </div>
                <span className="nfh3-storyboard-field-label">分镜描述</span>
                <TextEditor
                  key={`${selected?.id}:${shot.id}`}
                  projectId={ctx.projectId}
                  target={textTarget}
                  standalone
                  autoHeight
                  value={shot.description}
                  onChange={(description) => updateStoryboardShots((shots) => shots.map((item) => item.id === shot.id ? { ...item, description } : item))}
                  references={storyboardEditorReferences}
                  chips
                  speakers={speakerRoster}
                  dialogue
                  placeholder="描述这个分镜，输入 @ 选择当前 Clip 引用的分镜图或人物"
                  className="minimax-collaborative-prompt nfh3-shot-editor"
                  style={{ minHeight: 92, height: "auto", fontSize: 15 }}
                />
                <StoryboardDialogueStrip
                  description={shot.description}
                  dialogueSpeakers={shot.dialogueSpeakers}
                  speakers={speakerRoster}
                  onBind={(dialogueIndex, speaker) => updateStoryboardShots((shots) => shots.map((item) => {
                    if (item.id !== shot.id) return item;
                    const speakers = [...(item.dialogueSpeakers || [])];
                    speakers[dialogueIndex] = speaker || "";
                    return { ...item, dialogueSpeakers: speakers };
                  }))}
                />
                {index < storyboardShots.length - 1 ? <div className="nfh3-storyboard-transition">
                  <label className="nfh3-storyboard-precise-cut">
                    <Switch
                      size="small"
                      checked={storyboardShots[index + 1].preciseCut === true || (storyboardShots[index + 1].preciseCut !== false && Boolean(storyboardShots[index + 1].switchTime))}
                      onChange={(checked) => updateStoryboardShots((shots) => shots.map((item, itemIndex) => itemIndex === index + 1 ? { ...item, preciseCut: checked, switchTime: checked ? item.switchTime : "" } : item))}
                      aria-label={`精准切换到分镜 ${index + 2}`}
                    />
                    <span>精准切镜</span>
                  </label>
                  {storyboardShots[index + 1].preciseCut === true || (storyboardShots[index + 1].preciseCut !== false && Boolean(storyboardShots[index + 1].switchTime)) ? <>
                    <label htmlFor={`h3-shot-time-${selected?.id}-${shot.id}`}>切换时间 · 到分镜 {index + 2}</label>
                    <input
                      id={`h3-shot-time-${selected?.id}-${shot.id}`}
                      value={storyboardShots[index + 1].switchTime}
                      onChange={(event) => updateStoryboardShots((shots) => shots.map((item, itemIndex) => itemIndex === index + 1 ? { ...item, switchTime: event.target.value } : item))}
                      placeholder="例如 00:03.000"
                      aria-label={`切换到分镜 ${index + 2} 的时间`}
                    />
                  </> : null}
                  <label htmlFor={`h3-shot-transition-${selected?.id}-${shot.id}`}>切换方式</label>
                  <Select
                    id={`h3-shot-transition-${selected?.id}-${shot.id}`}
                    size="small"
                    value={storyboardShots[index + 1].transitionType || "cut"}
                    options={STORYBOARD_TRANSITIONS.map(({ value, label }) => ({ value, label }))}
                    onChange={(value) => {
                      updateStoryboardShots((shots) => shots.map((item, itemIndex) => itemIndex === index + 1 ? { ...item, transitionType: value as StoryboardTransition } : item));
                    }}
                    aria-label={`切换到分镜 ${index + 2} 的方式`}
                    style={{ width: 150 }}
                  />
                </div> : null}
                </div>
              </details>)}
            </div>
              </div>
            </details>
            <details className="nfh3-storyboard-detail" open>
              <summary>overall_soundscape</summary>
              <div className="nfh3-storyboard-detail-body">
                <AutoGrowTextarea
                  value={storyboardSoundscape}
                  onChange={(event) => updateStoryboardTextField("soundscape", event.target.value)}
                  placeholder="填写环境声与音效"
                  ariaLabel="overall_soundscape"
                />
              </div>
            </details>
            <details className="nfh3-storyboard-detail" open>
              <summary>non_diegetic_music</summary>
              <div className="nfh3-storyboard-detail-body">
                <AutoGrowTextarea
                  value={storyboardMusic}
                  onChange={(event) => updateStoryboardTextField("music", event.target.value)}
                  placeholder="N/A"
                  ariaLabel="non_diegetic_music"
                />
              </div>
            </details>
          </div>
          {storyboardError ? <div className="nfh3-storyboard-error" role="alert">
            <span>{storyboardError}</span>
            <button type="button" disabled={storyboardCompleting || storyboardPromptGenerating || storyboardSaving} onClick={() => void completeStoryboard()}>重试</button>
            <button type="button" onClick={reloadStoryboard}>载入最新提示词</button>
          </div> : null}
          <small className="nfh3-storyboard-hint">只有点击「完成」才会保存修改；关闭弹框会丢弃未提交内容。完成时按人物节点资料、当前引用和分镜标记，规则生成主体、图片/音频引用定义及保留分析，不调用大模型；输入未变化时复用 SHA-256 缓存。开头总体描述写在 [Shot 1] 之前。</small>
        </div>
      </Modal>
    </section>
  );
}

// 分镜图参考过渡分析：只对连续相邻的 storyboard 分镜帧提取「姿势如何连续过渡」的可执行动作，
// 供增强提示词把段尾落到下一张分镜姿势（如站→蹲，末句写「此人蹲了下来」）。
async function analyzeStoryboardTransitions(
  ctx: CanvasNodeContext,
  refs: H3Ref[],
  model: string,
): Promise<string> {
  const lines: string[] = [];
  for (let k = 0; k < refs.length - 1; k++) {
    const from = refs[k];
    const to = refs[k + 1];
    const fromOrd = k + 1;
    const toOrd = k + 2;
    try {
      const res = await ctx.ai.generateText(
        `下面是连续分镜姿势序列中的两张 storyboard 分镜帧：图${fromOrd}（起始姿势）与图${toOrd}（目标姿势）。只提取从图${fromOrd}到图${toOrd}的连续过渡动作：主体肢体如何运动、重心如何转移、身体朝向/视线/姿态如何变化，用若干可执行的自然语言短句描述这段过渡（不重复身份、服装、外观，只写动作与姿态变化）。只返回过渡动作正文，不要追问、不要写英文模板。`,
        {
          model,
          system: "你是 H3 分镜姿势过渡分析器。严格按图序对比两张关键帧，只输出从前者到后者的连续动作描述，不编造图中未出现的变化。",
          references: [
            { url: from.url, name: from.name },
            { url: to.url, name: to.name },
          ],
        },
      );
      const text = res.text.trim();
      if (text) lines.push(`图${fromOrd}→图${toOrd}：${text}`);
    } catch {
      lines.push(`图${fromOrd}→图${toOrd}：（过渡分析失败，请人工核对姿势变化）`);
    }
  }
  return lines.join("\n\n");
}
