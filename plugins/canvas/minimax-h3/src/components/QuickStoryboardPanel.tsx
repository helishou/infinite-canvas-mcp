import { useEffect, useMemo, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { Button, Modal, Switch } from "antd";
import type { H3Ref, H3Segment } from "../types";
import { refsForSegment, refsForSubmission, withSegmentRefs } from "../services/h3-data";
import { h3ThemeVars } from "../h3-theme";

type Frame = { id: string; url: string; storageKey?: string; name: string; sourceTime: number; fingerprint?: string };
type CaptureRequest = { nodeId: string; url: string; name?: string; duration?: number };

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

async function captureFrames(ctx: CanvasNodeContext, url: string, count: number, name: string, scopeId: string, existingFingerprints: Set<string>): Promise<Frame[]> {
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
  const frames: Frame[] = [];
  try {
    for (let index = 0; index < count; index++) {
      const sourceTime = duration * (index + 0.5) / count;
      await new Promise<void>((resolve, reject) => {
        video.onseeked = () => resolve();
        video.onerror = () => reject(new Error(`第 ${index + 1} 帧读取失败`));
        video.currentTime = sourceTime;
      });
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
      if (existingFingerprints.has(fingerprint)) continue;
      existingFingerprints.add(fingerprint);
      const id = `quick-storyboard-${scopeId}-${fingerprint.slice(0, 24)}`;
      const uploaded = await ctx.uploadImage(blob);
      await ctx.references.upsert({ id, label, mediaType: "image", role: "storyboard", url: uploaded.url, storageKey: uploaded.storageKey, mimeType: uploaded.mimeType, tags: ["quick-storyboard", `quick-storyboard:${scopeId}`, `sha256:${fingerprint}`] });
      frames.push({ id, url: uploaded.url, storageKey: uploaded.storageKey, name: label, sourceTime, fingerprint });
    }
  } finally {
    video.removeAttribute("src");
    video.load();
  }
  return frames;
}

async function composeStoryboard(ctx: CanvasNodeContext, frames: Frame[]) {
  const images = await Promise.all(frames.map((frame) => imageFromUrl(frame.url)));
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
    const scale = Math.max(width / image.width, height / image.height);
    const drawWidth = image.width * scale;
    const drawHeight = image.height * scale;
    context.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
    context.fillStyle = "rgba(0,0,0,.72)";
    context.fillRect(x + 12, y + 12, 105, 38);
    context.fillStyle = "white";
    context.font = "bold 24px sans-serif";
    context.fillText(`Shot ${index + 1}`, x + 22, y + 40);
  });
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
  if (!blob) throw new Error("分镜宫格导出失败");
  return ctx.uploadImage(blob);
}

export function QuickStoryboardPanel({ ctx, selected, patchSelected }: { ctx: CanvasNodeContext; selected?: H3Segment; patchSelected: (patch: Partial<H3Segment>) => void }) {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [drafts, setDrafts] = useState<Frame[]>([]);
  const [arranged, setArranged] = useState<Frame[]>([]);
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
  const captureFingerprintsRef = useRef(new Set<string>());

  useEffect(() => {
    const resolveFrames = (items: H3Segment["quickStoryboardDrafts"]) => (items || []).flatMap((item) => {
      const ref = allKnownRefs.find((entry) => entry.bindingId === item.bindingId);
      return ref ? [{ id: item.bindingId, url: ref.storageKey ? ctx.mediaUrl(ref.storageKey) : ref.url, storageKey: ref.storageKey, name: item.name, sourceTime: Number(item.sourceTime || 0), fingerprint: item.fingerprint || ref.tags?.find((tag) => tag.startsWith("sha256:"))?.slice(7) }] : [];
    });
    setDrafts(resolveFrames(selected?.quickStoryboardDrafts));
    setArranged(resolveFrames(selected?.quickStoryboardArrangement));
    const collage = allKnownRefs.find((ref) => ref.name === "快速分镜宫格" && ref.role === "storyboard");
    setCollagePreview(collage ? collage.storageKey ? ctx.mediaUrl(collage.storageKey) : collage.url : "");
  }, [selected, allKnownRefs]);

  useEffect(() => {
    let active = true;
    void ctx.references.list().then((assets) => {
      if (!active) return;
      const quickAssets = assets.filter((asset) => asset.tags?.includes("quick-storyboard") && asset.mediaType === "image");
      const scopeId = `${ctx.node.id}:${selected?.id || ""}`;
      for (const asset of quickAssets) {
        if (!asset.tags?.includes(`quick-storyboard:${scopeId}`)) continue;
        const fingerprint = asset.tags.find((tag) => tag.startsWith("sha256:"))?.slice(7);
        if (fingerprint) captureFingerprintsRef.current.add(fingerprint);
      }
      setCatalogRefs(quickAssets.map((asset) => ({
        url: asset.url || (asset.storageKey ? ctx.mediaUrl(asset.storageKey) : ""), storageKey: asset.storageKey, type: "image", name: asset.label,
        mimeType: asset.mimeType, role: "storyboard", bindingId: asset.id, assetId: asset.id, tags: asset.tags,
      })).filter((ref) => ref.url));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [ctx.projectId, ctx.references]);

  useEffect(() => {
    const listener = (event: Event) => {
      const request = (event as CustomEvent<CaptureRequest>).detail;
      if (!selected?.id || request?.nodeId !== ctx.node.id) return;
      setOpen(true);
      setEnabled(true);
      patchSelected({ quickStoryboardEnabled: true });
      setBusy(true);
      setError("");
      const scopeId = `${ctx.node.id}:${selected.id}`;
      const fingerprints = captureFingerprintsRef.current;
      for (const frame of [...draftsRef.current, ...arrangedRef.current]) if (frame.fingerprint) fingerprints.add(frame.fingerprint);
      for (const ref of catalogRefs) {
        if (!ref.tags?.includes(`quick-storyboard:${scopeId}`)) continue;
        const fingerprint = ref.tags.find((tag) => tag.startsWith("sha256:"))?.slice(7);
        if (fingerprint) fingerprints.add(fingerprint);
      }
      void captureFrames(ctx, request.url, Math.max(1, selected.storyboardShots?.length || 4), request.name || "视频", scopeId, fingerprints).then((frames) => {
        if (!frames.length) { setError("截取帧已在草稿区，未重复添加。"); return; }
        const next = [...draftsRef.current, ...frames];
        draftsRef.current = next;
        setDrafts(next);
        void ctx.references.list().then((assets) => setCatalogRefs(assets.filter((asset) => asset.tags?.includes("quick-storyboard") && asset.mediaType === "image").map((asset) => ({
          url: asset.url || (asset.storageKey ? ctx.mediaUrl(asset.storageKey) : ""), storageKey: asset.storageKey, type: "image" as const, name: asset.label,
          mimeType: asset.mimeType, role: "storyboard" as const, bindingId: asset.id, assetId: asset.id, tags: asset.tags,
        })).filter((ref) => ref.url))).catch(() => undefined);
        patchSelected({ quickStoryboardDrafts: next.map(({ id, name, sourceTime, fingerprint }) => ({ bindingId: id, name, sourceTime, fingerprint })) });
      }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false));
    };
    window.addEventListener("minimax-h3-quick-storyboard-capture", listener);
    return () => window.removeEventListener("minimax-h3-quick-storyboard-capture", listener);
  }, [ctx.node.id, ctx.projectId, ctx.references, selected?.id, selected?.storyboardShots?.length, catalogRefs]);

  const saveArranged = async (next: Frame[]) => {
    if (busy) return;
    setArranged(next);
    if (!selected || !next.length) return;
    const draftIds = new Set(next.map((frame) => frame.id));
    const remainingDrafts = drafts.filter((frame) => !draftIds.has(frame.id));
    patchSelected({
      quickStoryboardDrafts: remainingDrafts.map(({ id, name, sourceTime, fingerprint }) => ({ bindingId: id, name, sourceTime, fingerprint })),
      quickStoryboardArrangement: next.map(({ id, name, sourceTime, fingerprint }) => ({ bindingId: id, name, sourceTime, fingerprint })),
    });
    setBusy(true);
    setError("");
    try {
      const uploadedCollage = await composeStoryboard(ctx, next);
      const collage = uploadedCollage.storageKey ? ctx.mediaUrl(uploadedCollage.storageKey) : uploadedCollage.url;
      setCollagePreview(collage);
      const existing = refs.find((ref) => ref.name === "快速分镜宫格" && ref.role === "storyboard");
      const bindingId = existing?.bindingId || `quick-storyboard-${selected.id}`;
      await ctx.references.upsert({ id: bindingId, label: "快速分镜宫格", mediaType: "image", role: "storyboard", url: uploadedCollage.url, storageKey: uploadedCollage.storageKey, mimeType: uploadedCollage.mimeType, tags: ["quick-storyboard"] });
      const collageRef: H3Ref = { url: uploadedCollage.url, storageKey: uploadedCollage.storageKey, type: "image", name: "快速分镜宫格", mimeType: uploadedCollage.mimeType, role: "storyboard", bindingId, assetId: bindingId, description: `快速分镜宫格，共 ${next.length} 格，按从上到下、从左到右阅读` };
      const withoutOld = refs.filter((ref) => ref.bindingId !== bindingId && !(ref.name === "快速分镜宫格" && ref.role === "storyboard"));
      const updatedSegment = withSegmentRefs(selected, [...withoutOld, collageRef]);
      const collagePictureNumber = refsForSubmission(updatedSegment).filter((ref) => ref.type === "image").findIndex((ref) => ref.bindingId === bindingId) + 1;
      patchSelected({ ...updatedSegment, quickStoryboardEnabled: true });
      const count = next.length;
      const arrangement = `Quick storyboard order: It contains exactly ${count} storyboard panels arranged ${count <= 3 ? "vertically from top to bottom" : "in reading order from top to bottom and left to right"}: ${next.map((_, index) => `Shot ${index + 1}`).join(", ")}. Each panel guides only its corresponding shot's composition, camera angle, framing, character blocking and action. Use Picture ${Math.max(1, collagePictureNumber)} to guide the shot sequence. Do not reproduce the storyboard panels as a collage.`;
      const target = { nodeId: ctx.node.id, segmentId: selected.id, field: "prompt" as const };
      const document = ctx.textDocument(target);
      await document.flush();
      const snapshot = document.getSnapshot();
      if (snapshot.ready && !snapshot.blocked) {
        const previousInstruction = /\n?\n?Quick storyboard order:[\s\S]*?Do not reproduce the storyboard panels as a collage\./;
        const basePrompt = snapshot.text.replace(previousInstruction, "").trim();
        const replaced = await ctx.replaceText(target, document.getDocumentId(), snapshot.text, `${basePrompt}\n\n${arrangement}`);
        if (!replaced) throw new Error("提示词在插入分镜顺序时发生并发修改，请重新生成宫格并插入。");
      } else throw new Error(snapshot.error || "当前提示词尚未同步，分镜宫格已保存但提示词没有插入。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
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
    const frame = (from === "draft" ? draftsRef.current : arrangedRef.current).find((item) => item.id === frameId);
    if (!frame) return;
    if (target === from) {
      if (target === "arranged" && targetIndex !== undefined) {
        const current = arrangedRef.current;
        const next = current.filter((item) => item.id !== frame.id);
        const insertAt = Math.max(0, Math.min(targetIndex, next.length));
        next.splice(insertAt, 0, frame);
        arrangedRef.current = next;
        void saveArranged(next);
      }
      draggingRef.current = null;
      setDragging(null);
      return;
    }
    if (from === "draft") {
      const remainingDrafts = draftsRef.current.filter((item) => item.id !== frame.id);
      draftsRef.current = remainingDrafts;
      setDrafts(remainingDrafts);
      if (target === "arranged") {
        const next = [...arrangedRef.current];
        next.splice(targetIndex === undefined ? next.length : Math.max(0, Math.min(targetIndex, next.length)), 0, frame);
        arrangedRef.current = next;
        void saveArranged(next);
      } else patchSelected({ quickStoryboardDrafts: remainingDrafts.map(({ id, name, sourceTime, fingerprint }) => ({ bindingId: id, name, sourceTime, fingerprint })) });
    } else {
      const next = arrangedRef.current.filter((item) => item.id !== frame.id);
      arrangedRef.current = next;
      setArranged(next);
      const nextDrafts = [...draftsRef.current];
      nextDrafts.splice(targetIndex === undefined ? nextDrafts.length : Math.max(0, Math.min(targetIndex, nextDrafts.length)), 0, frame);
      draftsRef.current = nextDrafts;
      setDrafts(nextDrafts);
      patchSelected({ quickStoryboardArrangement: next.map(({ id, name, sourceTime, fingerprint }) => ({ bindingId: id, name, sourceTime, fingerprint })), quickStoryboardDrafts: nextDrafts.map(({ id, name, sourceTime, fingerprint }) => ({ bindingId: id, name, sourceTime, fingerprint })) });
    }
    draggingRef.current = null;
    setDragging(null);
  };

  return <>
    <Button size="small" onClick={() => setOpen(true)}>快速分镜</Button>
    <Modal
      title="快速分镜"
      open={open}
      onCancel={() => setOpen(false)}
      footer={null}
      width="min(1080px, calc(100vw - 40px))"
      destroyOnHidden={false}
    >
      <div data-canvas-no-zoom style={h3ThemeVars(ctx.theme)}><section className="minimax-quick-storyboard">
        <div className="minimax-quick-storyboard-head"><div><b>快速分镜工作区</b><small>从视频提取帧，拖入排列区并调整顺序；生成的宫格会随 Clip 一起提交。</small></div><label><span>启用</span><Switch checked={enabled || selected?.quickStoryboardEnabled === true} onChange={(value) => { setEnabled(value); patchSelected({ quickStoryboardEnabled: value }); }} /></label></div>
        {enabled || selected?.quickStoryboardEnabled === true ? <>
          <div className="minimax-quick-storyboard-columns">
            {(["draft", "arranged"] as const).map((zone) => {
              const items = zone === "draft" ? drafts : arranged;
              return <div key={zone} className={`minimax-quick-storyboard-zone${zone === "arranged" ? " is-arranged" : ""}${dropZone === zone ? " is-drop-target" : ""}`} onDragEnter={() => setDropZone(zone)} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropZone(zone); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropZone(null); }} onDrop={(event) => drop(event, zone)}>
                <div className="minimax-quick-storyboard-zone-head"><b>{zone === "draft" ? "草稿区" : "排列区"}</b><span>{items.length} 帧</span></div>
                <div className="minimax-quick-storyboard-items">{items.map((frame, index) => <div key={frame.id} className={dragging?.frame.id === frame.id ? "is-dragging" : ""} draggable={!busy} onDragStart={(event) => { const value = { frame, from: zone }; draggingRef.current = value; setDragging(value); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-h3-quick-storyboard", JSON.stringify({ from: zone, id: frame.id })); }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => drop(event, zone, index)} onDragEnd={() => { draggingRef.current = null; setDragging(null); }} title={`${frame.name} · ${frame.sourceTime.toFixed(1)} 秒`}><span className="minimax-quick-storyboard-shot">{zone === "arranged" ? `Shot ${index + 1}` : `帧 ${index + 1}`}</span><img draggable={false} src={frame.url} alt={frame.name} /><span className="minimax-quick-storyboard-caption">{frame.name}</span></div>)}</div>
                {!items.length ? <div className="minimax-quick-storyboard-empty">{zone === "draft" ? "在视频预览或 Output 上右键，提取全部分镜帧" : "从草稿区拖入分镜帧，在这里组合并排序"}</div> : null}
              </div>;
            })}
          </div>
          {arranged.length ? <div className="minimax-quick-storyboard-preview"><div><b>宫格预览</b><span>{arranged.length} 格 · 按排列顺序阅读</span></div>{collagePreview ? <img src={collagePreview} alt="当前排列生成的分镜宫格" /> : <div className="minimax-quick-storyboard-preview-empty">拖动或排序分镜帧后自动生成预览</div>}</div> : null}
          <div className="minimax-quick-storyboard-footer"><small>{busy ? "正在提取或拼接分镜…" : error ? " " : "拖动排列区内的卡片可调整 Shot 顺序"}{error ? <span role="alert">{error}</span> : null}</small>{arranged.length ? <Button type="primary" size="middle" loading={busy} disabled={arranged.length < 1} onClick={() => void saveArranged(arranged)}>生成宫格并插入提示词</Button> : null}</div>
        </> : null}
      </section></div>
    </Modal>
  </>;
}
