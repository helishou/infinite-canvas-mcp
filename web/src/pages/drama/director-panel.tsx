import { useState } from "react";
import { Alert, Button, Input, Modal, Select, Switch, Tag } from "antd";
import { useTranslation } from "react-i18next";
import { canonicalProduction, directorModules, directorProductionSchema, type DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";

export function DirectorPanel({ director, busy, onSave, onPublish }: {
  director?: DirectorProduction; busy: boolean; onSave: (value: DirectorProduction) => Promise<unknown>; onPublish: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const shots = (Array.isArray(director?.source.shots) ? director.source.shots : []) as Array<Record<string, any>>;
  const segments = (Array.isArray(director?.source.segments) ? director.source.segments : []) as Array<Record<string, any>>;
  const regroup = async () => {
    if (!director || !selected.length) return;
    try {
      const indices = selected.map(id => shots.findIndex(s => s.id === id)).sort((a, b) => a - b);
      if (indices.some((n, i) => n < 0 || (i > 0 && n !== indices[i - 1] + 1))) throw new Error(t("drama.production.directorAdjacent"));
      const chosen = indices.map(i => shots[i]); const ids = chosen.map(s => s.id);
      const overlapping = segments.filter(s => s.shot_ids.some((id: string) => ids.includes(id)));
      if (overlapping.some(s => s.shot_ids.some((id: string) => !ids.includes(id)))) throw new Error(t("drama.production.directorWholeGroup"));
      const fps = Number(director.source.fps_num || 24) / Number(director.source.fps_den || 1);
      const seconds = (chosen[chosen.length - 1].end_frame - chosen[0].start_frame) / fps;
      if (seconds < 4 || seconds > 15) throw new Error(t("drama.production.directorDuration"));
      const next = structuredClone(director);
      const id = overlapping[0]?.id || `SEG_${crypto.randomUUID().replaceAll("-", "")}`;
      next.source.segments = [...segments.filter(s => !overlapping.includes(s)), { ...(overlapping[0] || {}), id, shot_ids: ids, start_frame: chosen[0].start_frame, end_frame: chosen[chosen.length - 1].end_frame, generation_clip_duration: seconds,
        execution_gate: "Rebind mode, references and sound after regrouping" }].sort((a, b) => a.start_frame - b.start_frame);
      const ordered = next.source.segments as Array<Record<string, any>>;
      next.boundaries = director.boundaries.filter(b => ordered.findIndex(s => s.id === b.to) === ordered.findIndex(s => s.id === b.from) + 1 && ordered.some(s => s.id === b.from));
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalProduction(next.source)));
      next.sourceHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      next.artifacts = next.artifacts.filter(a => a.kind !== "h3" || ordered.some(s => s.id === a.targetId)).map(a => ({ ...a, status: "stale" }));
      next.executionAuthorized = false;
      await onSave(next); setSelected([]); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <section className="space-y-4">
    <div className="flex flex-wrap items-center gap-3">
      <details><summary className="cursor-pointer text-sm text-muted-foreground">{t("director.advanced")}</summary><Button className="mt-2" onClick={() => { setText(JSON.stringify(director || {}, null, 2)); setError(""); }}>{t("drama.production.directorEdit")}</Button></details>
      <Button type="primary" disabled={busy || !director} onClick={onPublish}>{t("drama.production.directorPublish")}</Button>
      {director && <span className="text-sm text-muted-foreground">Acheng {director.engine.version} · {director.engine.commit.slice(0, 10)} · {director.engine.patchVersion}</span>}
    </div>
    {!director ? <Alert type="info" message={t("drama.production.directorEmpty")} /> : <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{directorModules.map(module => <article key={module} className="rounded-lg border border-border p-3">
        <strong>{module}</strong><Tag className="ml-2">{director.modules[module]?.status || "planned"}</Tag>
        {director.modules[module]?.unresolved.map((item, i) => <p key={i} className="mt-2 text-sm text-amber-600">{item}</p>)}
      </article>)}</div>
      {!!director.unresolved.length && <Alert type="warning" message={director.unresolved.join("；")} />}
      <p className="text-sm text-muted-foreground">{t("drama.production.directorExecution", { status: director.executionAuthorized ? t("drama.production.directorAuthorized") : t("drama.production.directorPromptsOnly") })}</p>
      <div className="space-y-2">{Object.entries(director.assets).map(([id, asset]) => <div key={id} className="flex flex-wrap gap-3 border-b border-border py-2 text-sm"><strong>{id}</strong><span>{asset.version}</span><Tag>{asset.status}</Tag><span className="break-all text-muted-foreground">{asset.nodeId}</span></div>)}</div>
      {!!shots.length && <div className="flex flex-wrap items-center gap-3">
        <Select mode="multiple" className="min-w-72 flex-1" value={selected} onChange={setSelected} placeholder={t("drama.production.directorSelectShots")} options={shots.map(s => ({ value: s.id, label: s.title || s.id }))} />
        <Button disabled={busy || !selected.length} onClick={() => void regroup()}>{t("drama.production.directorRegroup")}</Button>
      </div>}
      {error && text === null && <Alert type="error" message={error} />}
      {segments.map(segment => <div key={segment.id} className="rounded-lg border border-border p-3 text-sm"><strong>{segment.id}</strong> · {segment.shot_ids.join(" → ")} · {segment.generation_clip_duration}s</div>)}
      {director.boundaries.map(boundary => <div key={boundary.from} className="rounded-lg border border-border p-3 text-sm">
        <strong>{boundary.from} → {boundary.to}</strong>
        <div className="my-2 flex gap-4">{(["tailFrame", "motionContext"] as const).map(key => <label key={key} className="flex items-center gap-2">{t(`drama.production.${key}`)}<Switch checked={boundary[key]} disabled={busy} onChange={checked => {
          const next = structuredClone(director); next.boundaries.find(b => b.from === boundary.from)![key] = checked; next.executionAuthorized = false;
          void onSave(next).catch(cause => setError(String(cause)));
        }} /></label>)}</div><p>{boundary.reason}</p>
      </div>)}
      {director.artifacts.map(artifact => <details key={artifact.id} className="rounded-lg border border-border p-3">
        <summary className="cursor-pointer">{artifact.targetId} · {artifact.kind} · {artifact.status}</summary>
        <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm">{artifact.prompt}</pre>
      </details>)}
    </>}
    <Modal open={text !== null} width={900} title={t("drama.production.directorEdit")} onCancel={() => setText(null)} confirmLoading={busy} onOk={async () => {
      try { const value = directorProductionSchema.parse(JSON.parse(text || "{}")); await onSave(value); setText(null); }
      catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    }}>
      <p className="mb-3 text-sm text-muted-foreground">{t("drama.production.directorEditHint")}</p>
      {error && <Alert type="error" message={error} className="mb-3" />}
      <Input.TextArea rows={20} value={text || ""} onChange={event => setText(event.target.value)} />
    </Modal>
  </section>;
}
