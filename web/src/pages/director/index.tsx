import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Empty, Input, Modal, Skeleton } from "antd";
import { ArrowRight, Plus, RefreshCw, Search } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useBackendStore } from "@/stores/use-backend-store";
import { projectCover } from "@/pages/home/workbench-data";
import { WorkbenchMediaPreview } from "@/pages/home/workbench-media";
import { useProjectCoverResults, useStableProjectCovers } from "@/pages/home/use-workbench-data";
import { createBackendProject, fetchBackendProjects } from "@/services/backend-api";

type Project = { id: string; title: string; updatedAt: string };

export default function DirectorPage() {
    const { t, i18n } = useTranslation();
    const { message } = App.useApp();
    const navigate = useNavigate();
    const canvasProjects = useCanvasStore(state => state.projects);
    const folders = useCanvasStore(state => state.folders);
    const backendUrl = useBackendStore(state => state.url);
    const [visibleCount, setVisibleCount] = useState(12);
    const [projects, setProjects] = useState<Project[]>([]);
    const [query, setQuery] = useState("");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [reload, setReload] = useState(0);
    const [createOpen, setCreateOpen] = useState(false);
    const [name, setName] = useState("");
    const [creating, setCreating] = useState(false);
    const requestId = useRef("");
    const submittedName = useRef("");
    useEffect(() => {
        let active = true; setLoading(true); setError("");
        void fetchBackendProjects(true).then(result => {
            if (active) setProjects((result.projects || []).map(p => ({ id: String(p.id), title: String(p.title || p.id), updatedAt: String(p.updatedAt || "") })));
        }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); })
            .finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [reload]);
    const visible = useMemo(() => projects.filter(p => p.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
        .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)), [projects, query]);
    const displayed = visible.slice(0, visibleCount);
    const existingCover = (id: string) => { const project = canvasProjects.find(item => item.id === id); return project ? projectCover(project, [], folders.find(folder => folder.id === project.folderId)) : null; };
    const extraCover = useProjectCoverResults(displayed.filter(project => !existingCover(project.id)).map(project => [project.id, project.updatedAt]));
    const coverKey = (project: Project) => JSON.stringify([backendUrl, project.id, project.updatedAt]);
    const covers = useStableProjectCovers(displayed.map(project => ({ key: coverKey(project), media: existingCover(project.id) || extraCover(project.id, project.updatedAt) })));
    const begin = () => { requestId.current = crypto.randomUUID(); submittedName.current = ""; setName(""); setCreateOpen(true); };
    const create = async () => {
        if (creating || !name.trim()) return;
        setCreating(true);
        if (!submittedName.current) submittedName.current = name.trim();
        try {
            // Stable ID survives a lost response. Reopening the dialog is a new request.
            const result = await createBackendProject({ id: requestId.current, title: submittedName.current, nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, globalPrompt: "" });
            if (!result.project?.id) throw new Error(t("director.createFailed"));
            navigate(`/director/${encodeURIComponent(String(result.project.id))}`);
        } catch (cause) { message.error(cause instanceof Error ? cause.message : String(cause)); }
        finally { setCreating(false); }
    };
    return <section className="min-w-0" data-testid="director-home">
        <header className="mb-5 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">{t("landing.continueProduction")}</h2><p className="mt-1 text-xs text-muted-foreground">{t("landing.projectCount", { count: projects.length })}</p></div><div className="flex flex-wrap items-center gap-2"><Input className="!w-48 sm:!w-56" aria-label={t("director.search")} prefix={<Search className="size-4 text-muted-foreground" />} placeholder={t("director.search")} value={query} onChange={event => { setQuery(event.target.value); setVisibleCount(12); }} allowClear /><Button type="text" aria-label={t("director.refresh")} icon={<RefreshCw className="size-4" />} onClick={() => setReload(value => value + 1)} disabled={loading} /><Button icon={<Plus className="size-4" />} onClick={begin}>{t("landing.blankProduction")}</Button></div></header>
        {error ? <Alert type="error" showIcon message={t("director.loadFailed")} description={error} /> : loading ? <Skeleton active /> : !visible.length ? <Empty description={query ? t("director.noMatch") : t("director.empty")} /> : <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">{displayed.map(project => <article key={project.id} className="group min-w-0 overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-foreground/40">
            <Link to={`/director/${encodeURIComponent(project.id)}`} aria-label={t("landing.openProductionNamed", { name: project.title })} className="block text-foreground"><div className="aspect-[16/9] overflow-hidden bg-muted/30"><WorkbenchMediaPreview media={covers[coverKey(project)] || null} label={covers[coverKey(project)] ? project.title : t("landing.noPreview")} /></div><div className="p-4"><h3 className="line-clamp-2 min-h-6 text-base font-semibold">{project.title}</h3><p className="mt-2 text-xs text-muted-foreground">{Number.isFinite(Date.parse(project.updatedAt)) ? t("landing.updated", { date: new Date(project.updatedAt).toLocaleDateString(i18n.resolvedLanguage, { month: "short", day: "numeric" }) }) : t("director.ready")}</p></div></Link>
            <div className="border-t border-border px-4 py-3"><Link to={`/director/${encodeURIComponent(project.id)}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">{t("productionCanvas.enter")}<ArrowRight className="size-3.5" /></Link></div>
        </article>)}</div>}
        {visibleCount < visible.length && <div className="mt-6 text-center"><Button onClick={() => setVisibleCount(count => count + 12)}>{t("home.workbench.moreProjects")}</Button></div>}
        <Modal title={t("director.new")} open={createOpen} onCancel={() => { if (!creating) setCreateOpen(false); }} onOk={() => void create()} confirmLoading={creating} okButtonProps={{ disabled: !name.trim() }} okText={t("director.enter")}>
            <p className="mb-4 text-sm text-muted-foreground">{t("director.newHint")}</p>
            <Input aria-label={t("director.name")} placeholder={t("director.name")} value={name} disabled={creating || Boolean(submittedName.current)} onChange={e => setName(e.target.value)} onPressEnter={() => void create()} />
        </Modal>
    </section>;
}
