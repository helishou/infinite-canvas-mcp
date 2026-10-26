import { useEffect, useMemo, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { Button, Modal, Switch, message } from "antd";
import type { H3Ref, H3Segment } from "../types";
import { refsForSegment, withSegmentRefs } from "../services/h3-data";
import { addStoryboardShot, alignStoryboardReferenceOrder, insertStoryboardShotAfter, storyboardTrackItems } from "../services/h3-storyboard-track";
import { h3ThemeVars } from "../h3-theme";

type Frame = { id: string; url: string; storageKey?: string; name: string; sourceTime: number; fingerprint?: string };
type CaptureRequest = { nodeId: string; url: string; name?: string; duration?: number; count?: number; times?: number[] };
type SingleFrameRequest = { nodeId: string; blob: Blob; sourceTime: number; name?: string; position?: "first" | "last" | "current" };

function imageFromUrl(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("分镜帧图片读取失败"));
    image.src = url;
  });
}

async function fingerprintBlob(blob: Blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function captureFrames(ctx: CanvasNodeContext, url: string, count: number, name: string, scopeId: string, existingFingerprints: Set<string>, existingAssets: Map<string, H3Ref>, inFlightFingerprints: Set<string>, requestedTimes?: number[]): Promise<Frame[]> {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.preload = "auto";
  video.src = url;
  video.load();
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("视频无法读取，可能受跨域限制"));
  });
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  if (!duration) throw new Error("视频时长无效");
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) await new Promise<void>((resolve, reject) => {
    video.addEventListener("loadeddata", () => resolve(), { once: true });
    video.addEventListener("error", () => reject(new Error("视频首帧无法解码")), { once: true });
  });
  const frameTimes = requestedTimes?.length
    ? requestedTimes.map((time) => Math.max(0, Math.min(duration - 0.001, Number(time) || 0)))
    : Array.from({ length: count }, (_, index) => duration * (index + 0.5) / count);
  const frames: Frame[] = [];
  try {
    for (let index = 0; index < frameTimes.length; index++) {
      const sourceTime = frameTimes[index];
      if (Math.abs(Number(video.currentTime || 0) - sourceTime) > 0.001 || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        await new Promise<void>((resolve, reject) => {
          video.onseeked = () => resolve();
          video.onerror = () => reject(new Error(`第 ${index + 1} 帧读取失败`));
          video.currentTime = sourceTime;
        });
      }
      const scale = Math.min(1, 720 / video.videoWidth);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法创建分镜帧画布");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const label = `${name} · 分镜 ${index + 1}`;
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
      if (!blob) throw new Error(`第 ${index + 1} 帧导出失败`);
      const fingerprint = await fingerprintBlob(blob);
      if (existingFingerprints.has(fingerprint) || inFlightFingerprints.has(fingerprint)) continue;
      existingFingerprints.add(fingerprint);
      const id = `quick-storyboard-${scopeId}-${fingerprint.slice(0, 24)}`;
      const existing = existingAssets.get(fingerprint);
      if (existing) {
        frames.push({ id: existing.bindingId || id, url: existing.storageKey ? ctx.mediaUrl(existing.storageKey) : existing.url, storageKey: existing.storageKey, name: label, sourceTime, fingerprint });
        continue;
      }
      inFlightFingerprints.add(fingerprint);
      try {
      const uploaded = await ctx.uploadImage(blob);
      await ctx.references.upsert({ id, label, mediaType: "image", role: "storyboard", url: uploaded.url, storageKey: uploaded.storageKey, mimeType: uploaded.mimeType, tags: ["quick-storyboard", `quick-storyboard:${scopeId}`, `sha256:${fingerprint}`] });
      frames.push({ id, url: uploaded.url, storageKey: uploaded.storageKey, name: label, sourceTime, fingerprint });
      } finally { inFlightFingerprints.delete(fingerprint); }
    }
  } finally {
    video.removeAttribute("src");
    video.load();
  }
  return frames;
}

async function composeStoryboardPreview(frames: Array<Frame | null>) {
  const images = await Promise.all(frames.map((frame) => frame ? imageFromUrl(frame.url) : Promise.resolve(null)));
  const columns = frames.length > 3 ? 2 : 1;
  const rows = Math.ceil(frames.length / columns);
  const width = 960;
  const height = Math.round(width * 9 / 16);
  const canvas = document.createElement("canvas");
  canvas.width = width * columns;
  canvas.height = height * rows;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法拼接分镜宫格");
  context.fillStyle = "#111";
  context.fillRect(0, 0, canvas.width, canvas.height);
  images.forEach((image, index) => {
    const x = (index % columns) * width;
    const y = Math.floor(index / columns) * height;
    if (image) {
      const scale = Math.max(width / image.width, height / image.height);
      const drawWidth = image.width * scale;
      const drawHeight = image.height * scale;
      context.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
    }
    context.fillStyle = "rgba(0,0,0,.72)";
    context.fillRect(x + 12, y + 12, 105, 38);
    context.fillStyle = "white";
    context.font = "bold 24px sans-serif";
    context.fillText(`Shot ${index + 1}`, x + 22, y + 40);
  });
  return canvas.toDataURL("image/jpeg", 0.88);
}

export function QuickStoryboardPanel({ ctx, selected, patchSelected }: { ctx: CanvasNodeContext; selected?: H3Segment; patchSelected: (patch: Partial<H3Segment>) => void }) {
  const [open, setOpen] = useState(false);
  const [compositeEnabled, setCompositeEnabled] = useState(false);
  const [drafts, setDrafts] = useState<Frame[]>([]);
  const [arranged, setArranged] = useState<Frame[]>([]);
  const [slots, setSlots] = useState<Array<Frame | null>>([]);
  const [catalogRefs, setCatalogRefs] = useState<H3Ref[]>([]);
  const [collagePreview, setCollagePreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dropZone, setDropZone] = useState<"draft" | "arranged" | null>(null);
  const [dragging, setDragging] = useState<{ frame: Frame; from: "draft" | "arranged" } | null>(null);
  const draggingRef = useRef<{ frame: Frame; from: "draft" | "arranged" } | null>(null);
  const refs = useMemo(() => selected ? refsForSegment(selected) : [], [selected]);
  const allKnownRefs = useMemo(() => [...refs, ...catalogRefs], [refs, catalogRefs]);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const arrangedRef = useRef(arranged);
  arrangedRef.current = arranged;
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const inFlightFingerprintsRef = useRef(new Set<string>());
  const composeRevisionRef = useRef(0);
  const writingTrackRef = useRef(false);
  const quickStoryboardMode = String(selected?.mode || selected?.taskMode || "ref2va").toLowerCase();
  const requireRef2va = () => {
    if (quickStoryboardMode === "ref2va") return true;
    message.error("快速分镜只支持 Ref2VA，请先将当前 Clip 切换为 Ref2VA。");
    return false;
  };
  const openQuickStoryboard = () => {
    if (!requireRef2va()) return;
    setError("");
    setOpen(true);
  };

  useEffect(() => {
    const trackItems = selected ? storyboardTrackItems(selected) : [];
    const formalTrackFrames = trackItems.flatMap((item) => item.ref?.bindingId ? [{
      id: item.ref.bindingId, url: item.ref.storageKey ? ctx.mediaUrl(item.ref.storageKey) : item.ref.url,
      storageKey: item.ref.storageKey, name: item.ref.name || `Shot ${trackItems.indexOf(item) + 1}`, sourceTime: 0,
    }] : []);
    const usedBindingIds = new Set(formalTrackFrames.map((frame) => frame.id));
    const scopeTag = selected?.id ? `quick-storyboard:${ctx.node.id}:${selected.id}` : "";
    const dismissedTag = selected?.id ? `quick-storyboard-dismissed:${ctx.node.id}:${selected.id}` : "";
    const catalogDrafts = catalogRefs.filter((ref) => scopeTag && ref.tags?.includes(scopeTag) && !ref.tags?.includes(dismissedTag) && ref.bindingId && !usedBindingIds.has(ref.bindingId)).map((ref) => ({
      id: ref.bindingId!, url: ref.storageKey ? ctx.mediaUrl(ref.storageKey) : ref.url, storageKey: ref.storageKey,
      name: ref.name || `分镜帧 ${ref.bindingId}`, sourceTime: 0, fingerprint: ref.tags?.find((tag) => tag.startsWith("sha256:"))?.slice(7),
    }));
    const framesById = new Map([...catalogDrafts, ...formalTrackFrames].map((frame) => [frame.id, frame]));
    setDrafts(catalogDrafts);
    setArranged(formalTrackFrames);
    const nextSlots = trackItems.map(item => item.ref?.bindingId ? framesById.get(item.ref.bindingId) || null : null);
    slotsRef.current = nextSlots;
    setSlots(nextSlots);
    setCollagePreview("");
  }, [selected, allKnownRefs]);

  useEffect(() => {
    setCompositeEnabled(selected?.storyboardCompositeEnabled === true);
  }, [selected?.id, selected?.storyboardCompositeEnabled]);

  useEffect(() => {
    let active = true;
    void ctx.references.list().then((assets) => {
      if (!active) return;
      const quickAssets = assets.filter((asset) => asset.tags?.includes("quick-storyboard") && asset.mediaType === "image");
      setCatalogRefs(quickAssets.map((asset) => ({
        url: asset.url || (asset.storageKey ? ctx.mediaUrl(asset.storageKey) : ""), storageKey: asset.storageKey, type: "image" as const, name: asset.label,
        mimeType: asset.mimeType, role: "storyboard" as const, bindingId: asset.id, assetId: asset.id, tags: asset.tags,
      })).filter((ref) => ref.url));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [ctx.projectId, ctx.references]);

  useEffect(() => {
    const listener = (event: Event) => {
      const request = (event as CustomEvent<CaptureRequest>).detail;
      if (!selected?.id || request?.nodeId !== ctx.node.id) return;
      if (!requireRef2va()) return;
      setOpen(true);
      setBusy(true);
      setError("");
      const scopeId = `${ctx.node.id}:${selected.id}`;
      const dismissedTag = `quick-storyboard-dismissed:${scopeId}`;
      const fingerprints = new Set([...draftsRef.current, ...arrangedRef.current, ...slotsRef.current.filter((frame): frame is Frame => Boolean(frame))].map((frame) => frame.fingerprint).filter((value): value is string => Boolean(value)));
      const existingAssets = new Map<string, H3Ref>();
      for (const ref of catalogRefs) {
        if (!ref.tags?.includes(`quick-storyboard:${scopeId}`) || ref.tags.includes(dismissedTag)) continue;
        const fingerprint = ref.tags.find((tag) => tag.startsWith("sha256:"))?.slice(7);
        if (!fingerprint) continue;
        existingAssets.set(fingerprint, ref);
      }
      void captureFrames(ctx, request.url, Math.max(1, request.times?.length || request.count || selected.storyboardShots?.length || 4), request.name || "视频", scopeId, fingerprints, existingAssets, inFlightFingerprintsRef.current, request.times).then((frames) => {
        if (!frames.length) { setError("本次没有新增帧；已存在或正在添加的帧不会重复导入。"); return; }
        const next = [...draftsRef.current, ...frames];
        draftsRef.current = next;
        setDrafts(next);
        void ctx.references.list().then((assets) => setCatalogRefs(assets.filter((asset) => asset.tags?.includes("quick-storyboard") && asset.mediaType === "image").map((asset) => ({
          url: asset.url || (asset.storageKey ? ctx.mediaUrl(asset.storageKey) : ""), storageKey: asset.storageKey, type: "image" as const, name: asset.label,
          mimeType: asset.mimeType, role: "storyboard" as const, bindingId: asset.id, assetId: asset.id, tags: asset.tags,
        })).filter((ref) => ref.url))).catch(() => undefined);
      }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false));
    };
    const addSingleFrame = (event: Event) => {
      const request = (event as CustomEvent<SingleFrameRequest>).detail;
      if (!selected?.id || request?.nodeId !== ctx.node.id) return;
      if (!requireRef2va()) return;
      setOpen(true);
      setBusy(true);
      setError("");
      void (async () => {
        const fingerprint = await fingerprintBlob(request.blob);
        const boardFingerprints = new Set([...draftsRef.current, ...arrangedRef.current, ...slotsRef.current.filter((frame): frame is Frame => Boolean(frame))].map((frame) => frame.fingerprint).filter((value): value is string => Boolean(value)));
        if (boardFingerprints.has(fingerprint)) {
          setError("这帧已经在草稿区或排列区，没有重复添加。");
          return;
        }
        if (inFlightFingerprintsRef.current.has(fingerprint)) {
          setError("这帧正在导入，完成后会出现在草稿区。");
          return;
        }
        const scopeId = `${ctx.node.id}:${selected.id}`;
        const catalogMatch = catalogRefs.find((ref) => ref.tags?.includes(`quick-storyboard:${scopeId}`)
          && !ref.tags.includes(`quick-storyboard-dismissed:${scopeId}`)
          && ref.tags.some((tag) => tag === `sha256:${fingerprint}`));
        const sourceTime = Math.max(0, Number(request.sourceTime || 0));
        const frameLabel = request.position === "first" ? "首帧" : request.position === "last" ? "尾帧" : "当前帧";
        const label = `${request.name || "视频"} · ${frameLabel} ${sourceTime.toFixed(1)}s`;
        let frame: Frame;
        if (catalogMatch) {
          frame = { id: catalogMatch.bindingId || `quick-storyboard-${scopeId}-${fingerprint.slice(0, 24)}`, url: catalogMatch.storageKey ? ctx.mediaUrl(catalogMatch.storageKey) : catalogMatch.url, storageKey: catalogMatch.storageKey, name: label, sourceTime, fingerprint };
        } else {
          inFlightFingerprintsRef.current.add(fingerprint);
          try {
            const id = `quick-storyboard-${scopeId}-${fingerprint.slice(0, 24)}`;
            const uploaded = await ctx.uploadImage(request.blob);
            await ctx.references.upsert({ id, label, mediaType: "image", role: "storyboard", url: uploaded.url, storageKey: uploaded.storageKey, mimeType: uploaded.mimeType, tags: ["quick-storyboard", `quick-storyboard:${scopeId}`, `sha256:${fingerprint}`] });
            frame = { id, url: uploaded.url, storageKey: uploaded.storageKey, name: label, sourceTime, fingerprint };
          } finally { inFlightFingerprintsRef.current.delete(fingerprint); }
        }
        const next = [...draftsRef.current, frame];
        draftsRef.current = next;
        setDrafts(next);
        void ctx.references.list().then((assets) => setCatalogRefs(assets.filter((asset) => asset.tags?.includes("quick-storyboard") && asset.mediaType === "image").map((asset) => ({
          url: asset.url || (asset.storageKey ? ctx.mediaUrl(asset.storageKey) : ""), storageKey: asset.storageKey, type: "image" as const, name: asset.label,
          mimeType: asset.mimeType, role: "storyboard" as const, bindingId: asset.id, assetId: asset.id, tags: asset.tags,
        })).filter((ref) => ref.url))).catch(() => undefined);
      })().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false));
    };
    window.addEventListener("minimax-h3-quick-storyboard-capture", listener);
    window.addEventListener("minimax-h3-quick-storyboard-add-frame", addSingleFrame);
    return () => {
      window.removeEventListener("minimax-h3-quick-storyboard-capture", listener);
      window.removeEventListener("minimax-h3-quick-storyboard-add-frame", addSingleFrame);
    };
  }, [ctx.node.id, ctx.projectId, ctx.references, selected?.id, selected?.mode, selected?.taskMode, selected?.storyboardShots?.length, catalogRefs]);

  const updateArrangement = async (nextSlots: Array<Frame | null>, baseSegment = selected, extraPatch: Partial<H3Segment> = {}, nextDrafts = draftsRef.current) => {
    const next = nextSlots.filter((frame): frame is Frame => Boolean(frame));
    if (!baseSegment || busy || writingTrackRef.current) return false;
    const trackItems = storyboardTrackItems(baseSegment);
    const assignedIds = new Set(nextSlots.flatMap((frame) => frame ? [frame.id] : []));
    const previousStoryboardIds = new Set(trackItems.flatMap((item) => item.ref?.bindingId ? [item.ref.bindingId] : []));
    const refs = refsForSegment(baseSegment).map((ref) => previousStoryboardIds.has(ref.bindingId || "") && !assignedIds.has(ref.bindingId || "")
      ? { ...ref, role: "other" as const } : ref);
    const nextRefs = [...refs];
    const storyboardShots = trackItems.map((item, index) => {
      const frame = nextSlots[index];
      if (!frame) return { id: item.id, duration: item.duration };
      const ref: H3Ref = {
        url: frame.url, ...(frame.storageKey ? { storageKey: frame.storageKey } : {}), type: "image", name: frame.name,
        role: "storyboard", bindingId: frame.id, assetId: frame.id, ...(frame.fingerprint ? { tags: [`sha256:${frame.fingerprint}`, "quick-storyboard"] } : { tags: ["quick-storyboard"] }),
      };
      const existing = nextRefs.findIndex((entry) => entry.bindingId === frame.id);
      if (existing >= 0) nextRefs[existing] = { ...nextRefs[existing], ...ref };
      else nextRefs.push(ref);
      return { id: item.id, duration: item.duration, referenceBindingId: frame.id };
    });
    const updated = alignStoryboardReferenceOrder(withSegmentRefs({
      ...baseSegment,
      storyboardModeEnabled: true,
      storyboardShots,
    }, nextRefs));
    const updatedSegment = {
      ...updated,
      ...extraPatch,
    };
    const isFormalClip = Boolean(updatedSegment.productionClipProjection?.targetId);
    writingTrackRef.current = true;
    setBusy(true);
    try {
      if (isFormalClip) {
        if (!ctx.production?.replaceStoryboardTrack) throw new Error("当前制作台未接收分镜修改；轨道与关键帧均未写入。");
        const result = await ctx.production.replaceStoryboardTrack({ nodeId: ctx.node.id, segmentId: baseSegment.id, segment: updatedSegment as Record<string, unknown> });
        if (!result.sourceSaved) throw new Error("制作台未保存分镜 Shot 和关键帧；轨道未更新。");
      } else patchSelected(updatedSegment);
      draftsRef.current = nextDrafts;
      setDrafts(nextDrafts);
      setSlots(nextSlots);
      slotsRef.current = nextSlots;
      setArranged(next);
      arrangedRef.current = next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally { writingTrackRef.current = false; setBusy(false); }
    setError("");
    const revision = ++composeRevisionRef.current;
    if (!next.length) { setCollagePreview(""); return true; }
    void composeStoryboardPreview(nextSlots).then((preview) => {
      if (revision !== composeRevisionRef.current) return;
      setCollagePreview(preview);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    return true;
  };

  const removeDraftFrame = (frameId: string) => {
    if (busy) return;
    const nextDrafts = draftsRef.current.filter((frame) => frame.id !== frameId);
    const scopeTag = selected ? `quick-storyboard-dismissed:${ctx.node.id}:${selected.id}` : "";
    const asset = catalogRefs.find(ref => ref.bindingId === frameId);
    if (asset && scopeTag) void ctx.references.upsert({
      id: frameId, label: asset.name, mediaType: "image", role: "storyboard", url: asset.url,
      storageKey: asset.storageKey, mimeType: asset.mimeType, tags: [...(asset.tags || []), scopeTag],
    }).then(() => ctx.references.list()).then(assets => setCatalogRefs(assets.filter(item => item.tags?.includes("quick-storyboard") && item.mediaType === "image").map(item => ({
      url: item.url || (item.storageKey ? ctx.mediaUrl(item.storageKey) : ""), storageKey: item.storageKey, type: "image" as const, name: item.label,
      mimeType: item.mimeType, role: "storyboard" as const, bindingId: item.id, assetId: item.id, tags: item.tags,
    })).filter(ref => ref.url))).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  const toggleComposite = (value: boolean) => {
    if (!selected || busy) return;
    if (value && slotsRef.current.filter(Boolean).length < 2) {
      setError("至少需要两张已放入分镜轨的图片才能合并宫格。");
      return;
    }
    if (value && !requireRef2va()) return;
    setCompositeEnabled(value);
    setError("");
    // Use H3's canonical composite setting; the montage is compiled from this same track.
    const recoveredSlots = slotsRef.current.map((frame, index) => frame || arrangedRef.current[index] || null);
    if (value && recoveredSlots.filter(Boolean).length >= 2) {
      // Older saves can retain the selected arrangement while their track binding was
      // cleared by a production projection. Re-apply those exact images to the Shots.
      updateArrangement(recoveredSlots, selected, { storyboardCompositeEnabled: value });
    } else {
      patchSelected({ storyboardCompositeEnabled: value });
    }
  };

  const drop = (event: React.DragEvent<HTMLDivElement>, target: "draft" | "arranged", targetIndex?: number) => {
    event.preventDefault();
    event.stopPropagation();
    setDropZone(null);
    if (busy) return;
    const transfer = event.dataTransfer.getData("application/x-h3-quick-storyboard");
    let payload: { from?: "draft" | "arranged"; id?: string } = {};
    try { payload = transfer ? JSON.parse(transfer) as typeof payload : {}; } catch { /* use the active drag snapshot */ }
    const from = payload.from || draggingRef.current?.from;
    const frameId = payload.id || draggingRef.current?.frame.id;
    if (!from || !frameId) return;
    const frame = (from === "draft" ? draftsRef.current : slotsRef.current.filter((item): item is Frame => Boolean(item))).find((item) => item.id === frameId);
    if (!frame) return;
    let nextSlots = [...slotsRef.current];
    let nextDrafts = draftsRef.current;
    if (target === "arranged") {
      let destinationIndex = targetIndex;
      let arrangementSegment = selected;
      if (destinationIndex === undefined) {
        if (!selected) return;
        const items = storyboardTrackItems(selected);
        arrangementSegment = items.length
          ? insertStoryboardShotAfter(selected, items[items.length - 1].id)
          : addStoryboardShot(selected);
        const nextItems = storyboardTrackItems(arrangementSegment);
        if (nextItems.length <= items.length) {
          setError("最后一个 Shot 时长不足，无法再拆出分镜格。");
          return;
        }
        nextSlots = [...nextSlots, null];
        destinationIndex = nextSlots.length - 1;
      }
      if (destinationIndex < 0 || destinationIndex >= nextSlots.length) return;
      const occupiedAt = nextSlots.findIndex((item) => item?.id === frame.id);
      if (from === "draft" && occupiedAt >= 0 && occupiedAt !== destinationIndex) return;
      const destination = nextSlots[destinationIndex];
      if (from === "arranged") {
        if (occupiedAt < 0 || occupiedAt === destinationIndex) return;
        nextSlots[occupiedAt] = destination || null;
      } else {
        nextDrafts = draftsRef.current.filter((item) => item.id !== frame.id);
        if (destination && !nextDrafts.some((item) => item.id === destination.id)) nextDrafts.push(destination);
      }
      nextSlots[destinationIndex] = frame;
      void updateArrangement(nextSlots, arrangementSegment, {}, nextDrafts);
    } else if (from === "arranged") {
      const occupiedAt = nextSlots.findIndex((item) => item?.id === frame.id);
      if (occupiedAt >= 0) {
        nextSlots[occupiedAt] = null;
        nextDrafts = draftsRef.current.some((item) => item.id === frame.id) ? draftsRef.current : [...draftsRef.current, frame];
        void updateArrangement(nextSlots, selected, {}, nextDrafts);
      }
    }
    draggingRef.current = null;
    setDragging(null);
  };

  return <>
    <Button size="small" className="minimax-quick-storyboard-trigger" aria-pressed={compositeEnabled} onClick={openQuickStoryboard}>快速分镜</Button>
    <Modal
      title="快速分镜"
      open={open}
      onCancel={() => setOpen(false)}
      footer={null}
      width="min(1080px, calc(100vw - 40px))"
      destroyOnHidden={false}
    >
      <div data-canvas-no-zoom style={h3ThemeVars(ctx.theme)}><section className="minimax-quick-storyboard">
        <div className="minimax-quick-storyboard-head"><div><b>快速分镜工作区</b><small>分镜图始终保留在 H3 分镜轨并同步制作台；关闭宫格时按单张图提交。</small></div><label><span>合并提交分镜图</span><Switch checked={compositeEnabled} disabled={busy || slots.filter(Boolean).length < 2 && !compositeEnabled} onChange={toggleComposite} /></label></div>
        <>
          <div className="minimax-quick-storyboard-columns">
            <div className={`minimax-quick-storyboard-zone${dropZone === "draft" ? " is-drop-target" : ""}`} onDragEnter={() => setDropZone("draft")} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropZone("draft"); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropZone(null); }} onDrop={(event) => drop(event, "draft")}>
              <div className="minimax-quick-storyboard-zone-head"><b>草稿区</b><span>{drafts.length} 帧</span></div>
              <div className="minimax-quick-storyboard-items">{drafts.map((frame, index) => <div key={frame.id} className={dragging?.frame.id === frame.id ? "is-dragging" : ""} draggable={!busy} onDragStart={(event) => { const value = { frame, from: "draft" as const }; draggingRef.current = value; setDragging(value); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-h3-quick-storyboard", JSON.stringify({ from: "draft", id: frame.id })); }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDragEnd={() => { draggingRef.current = null; setDragging(null); }} title={`${frame.name} · ${frame.sourceTime.toFixed(1)} 秒`}><span className="minimax-quick-storyboard-shot">帧 {index + 1}</span><img draggable={false} src={frame.url} alt={frame.name} /><span className="minimax-quick-storyboard-caption">{frame.name}</span><button type="button" disabled={busy} className="minimax-quick-storyboard-remove" aria-label={`删除${frame.name}`} title="从草稿区删除" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.preventDefault(); event.stopPropagation(); removeDraftFrame(frame.id); }}>×</button></div>)}</div>
              {!drafts.length ? <div className="minimax-quick-storyboard-empty">在视频预览或 Output 上右键，提取分镜帧</div> : null}
            </div>
            <div className={`minimax-quick-storyboard-zone is-arranged${dropZone === "arranged" ? " is-drop-target" : ""}`} onDragEnter={() => setDropZone("arranged")} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropZone("arranged"); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropZone(null); }} onDrop={(event) => drop(event, "arranged")}>
              <div className="minimax-quick-storyboard-zone-head"><b>排列区 · 分镜轨</b><span>{slots.length} 格</span></div>
              <div className="minimax-quick-storyboard-items">{slots.map((frame, index) => <div key={storyboardTrackItems(selected!)[index]?.id || index} className={`${dragging?.frame.id === frame?.id ? "is-dragging" : ""}${frame ? "" : " is-empty"}`} draggable={Boolean(frame) && !busy} onDragStart={(event) => { if (!frame) return; const value = { frame, from: "arranged" as const }; draggingRef.current = value; setDragging(value); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-h3-quick-storyboard", JSON.stringify({ from: "arranged", id: frame.id })); }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => drop(event, "arranged", index)} onDragEnd={() => { draggingRef.current = null; setDragging(null); }} title={frame ? `${frame.name} · ${frame.sourceTime.toFixed(1)} 秒` : `Shot ${index + 1} · 拖入分镜帧`}>
                <span className="minimax-quick-storyboard-shot">Shot {index + 1}</span>{frame ? <><img draggable={false} src={frame.url} alt={frame.name} /><span className="minimax-quick-storyboard-caption">{frame.name}</span></> : <span className="minimax-quick-storyboard-slot-empty">拖入帧</span>}
              </div>)}</div>
              {!slots.length ? <div className="minimax-quick-storyboard-empty">当前 Clip 尚无分镜，请先在分镜轨添加分镜</div> : null}
            </div>
          </div>
          {slots.some(Boolean) ? <div className="minimax-quick-storyboard-preview"><div><b>宫格预览</b><span>{slots.length} 格 · {compositeEnabled ? "合并提交" : "预览，生成时仍按轨道单图提交"}</span></div>{collagePreview ? <img src={collagePreview} alt="当前排列生成的分镜宫格" /> : <div className="minimax-quick-storyboard-preview-empty">拖动分镜帧后生成预览</div>}</div> : null}
          <div className="minimax-quick-storyboard-footer"><small>{busy ? "正在更新宫格…" : error ? " " : "拖放和顺序调整会同步至 H3 分镜轨及制作台"}{error ? <span role="alert">{error}</span> : null}</small></div>
        </>
      </section></div>
    </Modal>
  </>;
}
