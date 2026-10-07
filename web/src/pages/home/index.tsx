import { useMemo, useState } from "react";
import { Alert, App, Button, Empty, Input, Modal, Progress, Segmented, Skeleton, Tag, Tooltip } from "antd";
import { ArrowRight, Bookmark, BookmarkCheck, Clapperboard, ImagePlus, LayoutGrid, List, ListChecks, Plus, RefreshCw, Search, Workflow, Sparkles, Eye } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { cn } from "@/lib/utils";
import { collectOutputs, projectCover, taskDestination, type WorkbenchOutput } from "./workbench-data";
import { WorkbenchMediaPreview } from "./workbench-media";
import { useProjectCoverResults, useStableProjectCovers, useWorkbenchData } from "./use-workbench-data";

type ProjectFilter = "all" | "canvas" | "drama" | "pinned";
const surface = "rounded-xl border border-border bg-card";

export default function IndexPage() {
    const { t, i18n } = useTranslation();
    const { message } = App.useApp();
    const navigate = useNavigate();
    const projects = useCanvasStore((s) => s.projects);
    const folders = useCanvasStore((s) => s.folders);
    const hydrated = useCanvasStore((s) => s.hydrated);
    const createProject = useCanvasStore((s) => s.createProject);
    const data = useWorkbenchData();
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<ProjectFilter>("all");
    const [view, setView] = useState<"grid" | "list">(() => {
        try {
            return localStorage.getItem("home-project-view") === "list" ? "list" : "grid";
        } catch {
            return "grid";
        }
    });
    const [visibleCount, setVisibleCount] = useState(12);
    const [previewProject, setPreviewProject] = useState<CanvasProject | null>(null);
    const [previewOutput, setPreviewOutput] = useState<WorkbenchOutput | null>(null);
    const [tasksOpen, setTasksOpen] = useState(false);
    const [outputsOpen, setOutputsOpen] = useState(false);
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState("");
    const outputs = useMemo(() => collectOutputs(data.logs), [data.logs]);
    const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
    const folderFor = (p: CanvasProject) => folderById.get(data.episodeFolders[p.id] || p.folderId || "");
    const isDrama = (p: CanvasProject) => Boolean(data.episodeFolders[p.id] || folderFor(p)?.isDrama);
    const sharedDramaCanvasIds = new Set(folders.filter((f) => f.isDrama).map((f) => f.sharedAssetCanvasId));
    const sorted = [...projects].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const ordinaryProjects = sorted.filter((p) => !isDrama(p) && !sharedDramaCanvasIds.has(p.id));
    const entries = [
        ...ordinaryProjects.map((project) => ({ kind: "canvas" as const, id: project.id, title: project.title, updatedAt: project.updatedAt, project })),
        ...folders.filter((folder) => folder.isDrama).map((folder) => ({ kind: "drama" as const, id: folder.id, title: folder.name, updatedAt: folder.updatedAt || folder.createdAt, folder })),
    ].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const filtered = entries.filter((entry) => entry.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) && (filter === "all" || (filter === "pinned" ? entry.kind === "canvas" && data.settings[`homePinnedProject:${entry.id}`] : entry.kind === filter)));
    const latest = sorted[0];
    const projectIds = new Set(projects.map((p) => p.id));
    const date = (value: string) => (Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(i18n.resolvedLanguage, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
    const stats = (project: CanvasProject) => t("canvas.project.stats", {
        nodes: project.summary?.nodeCount ?? project.nodes.length,
        connections: project.summary?.connectionCount ?? project.connections.length,
    });
    const openProject = (id: string) => navigate(`/canvas/${encodeURIComponent(id)}`);
    const visibleProjects = (data.dramaReady ? filtered.slice(0, visibleCount) : []).flatMap((entry) => entry.kind === "canvas" ? [entry.project] : []);
    const coverProjects = latest && !visibleProjects.some((p) => p.id === latest.id) ? [latest, ...visibleProjects] : visibleProjects;
    const extraCover = useProjectCoverResults(coverProjects.filter((p) => !projectCover(p, outputs, folderFor(p))).map((p) => [p.id, p.updatedAt]));
    const coverKey = (p: CanvasProject) => JSON.stringify([data.backendUrl, p.id, p.updatedAt]);
    const stableCovers = useStableProjectCovers(coverProjects.map((p) => ({ key: coverKey(p), media: projectCover(p, outputs, folderFor(p)) || extraCover(p.id, p.updatedAt) })));
    const cover = (p: CanvasProject) => stableCovers[coverKey(p)] || null;
    const outputTitle = (o: WorkbenchOutput) => projects.find((p) => p.id === o.log.projectId)?.title || o.log.model || t("home.workbench.result");
    const pin = (id: string) => void data.togglePin(id).catch((error) => message.error(error instanceof Error ? error.message : t("home.workbench.saveFailed")));
    const create = () => {
        if (!hydrated || !data.connected || !name.trim()) return;
        const id = createProject(name.trim());
        setCreating(false);
        openProject(id);
    };
    const outputCard = (o: WorkbenchOutput) => (
        <button key={o.id} type="button" className="group min-w-0 cursor-pointer text-left" onClick={() => setPreviewOutput(o)} aria-label={t("home.workbench.previewNamed", { name: outputTitle(o) })}>
            <div className="h-28 overflow-hidden rounded-lg border border-border bg-muted transition-colors group-hover:border-foreground/40">
                <WorkbenchMediaPreview media={o} label={t(`home.workbench.${o.kind}`)} />
            </div>
            <p className="mt-2 truncate text-xs font-medium">{outputTitle(o)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
                {t(`home.workbench.${o.kind}`)} · {date(o.log.createdAt)}
            </p>
        </button>
    );

    return (
        <main className="min-h-full bg-background text-foreground" data-testid="home-workbench">
            <div className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8">
                <section className="mb-6 grid gap-4 sm:grid-cols-2" aria-label={t("productionCanvas.entryTitle")}>
                    {[{ path: "/production", title: "dramaEntry", description: "dramaEntryHint", icon: Clapperboard }, { path: "/canvas", title: "canvasEntry", description: "canvasEntryHint", icon: LayoutGrid }].map(({ path, title, description, icon: Icon }) => <Link key={path} to={path} className="flex items-start gap-4 rounded-xl border border-border bg-card p-5 text-foreground hover:border-foreground/40"><Icon className="mt-1 size-6 shrink-0" /><div className="flex-1"><h2 className="text-lg font-semibold">{t(`productionCanvas.${title}`)}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{t(`productionCanvas.${description}`)}</p></div><ArrowRight className="mt-1 size-4 shrink-0" /></Link>)}
                </section>
                <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
                    <div>
                        <h1 className="text-2xl font-semibold tracking-tight">{t("productionCanvas.entryTitle")}</h1>
                        <p className="mt-1.5 text-sm text-muted-foreground">{t("landing.canvasSubtitle")}</p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button icon={<ListChecks className="size-4" />} onClick={() => setTasksOpen(true)}>
                            {t("home.workbench.tasks")}
                        </Button>
                        <Button
                            type="primary"
                            disabled={!hydrated || !data.connected}
                            icon={<Plus className="size-4" />}
                            onClick={() => {
                                setName(t("canvas.defaultTitle", { count: projects.length + 1 }));
                                setCreating(true);
                            }}
                        >
                            {t("canvas.create")}
                        </Button>
                    </div>
                </div>
                {!data.connected && (
                    <Alert
                        className="mb-5"
                        type="warning"
                        showIcon
                        title={t("home.workbench.offline")}
                        action={
                            <Button size="small" onClick={() => navigate("/config")}>
                                {t("home.workbench.settings")}
                            </Button>
                        }
                    />
                )}
                {(data.errors.length > 0 || data.dramaError) && (
                    <Alert
                        className="mb-5"
                        type="warning"
                        showIcon
                        title={t("home.workbench.loadFailed", { sections: [...data.errors.map((key) => t(`home.workbench.section_${key}`)), ...(data.dramaError ? [t("home.workbench.drama")] : [])].join(" / ") })}
                        action={
                            <Button size="small" loading={data.loading} onClick={data.refresh}>
                                {t("home.workbench.retry")}
                            </Button>
                        }
                    />
                )}
                <section className="mb-8" aria-label={t("home.workbench.continue")} data-testid="home-resume">
                    <div className={cn(surface, "flex min-h-60 min-w-0 overflow-hidden")}>
                        {!hydrated ? <div className="w-full p-5"><Skeleton active paragraph={{rows:3}} /></div> : latest ? <>
                            <button type="button" className="relative w-2/5 shrink-0 overflow-hidden bg-muted/30" onClick={() => openProject(latest.id)} aria-label={t("landing.openCanvasNamed",{name:latest.title})}><div className="absolute inset-0"><WorkbenchMediaPreview media={cover(latest)} label={cover(latest) ? latest.title : t("landing.noPreview")} /></div></button>
                            <div className="flex min-w-0 flex-1 flex-col items-start justify-center gap-3 p-5 sm:p-6"><span className="text-xs text-muted-foreground">{t("home.workbench.lastEdited")}</span><h2 className="line-clamp-3 text-xl font-semibold leading-snug">{latest.title}</h2><p className="text-xs text-muted-foreground">{date(latest.updatedAt)}</p><Button icon={<ArrowRight className="size-4" />} iconPlacement="end" onClick={() => openProject(latest.id)}>{t("home.workbench.continue")}</Button><div className="h-4">{isDrama(latest) && <Link to={`/production?dramaId=${encodeURIComponent(folderFor(latest)?.id || "")}`} className="text-xs text-muted-foreground hover:text-foreground">{t("productionCanvas.backDrama")}<ArrowRight className="ml-1 inline size-3" /></Link>}</div></div>
                        </> : <div className="flex flex-col items-start justify-center p-6"><Workflow className="mb-4 size-8 text-muted-foreground" /><h2 className="text-lg font-medium">{t("home.workbench.firstProject")}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{t("home.workbench.firstProjectHint")}</p></div>}
                    </div>
                </section>
                <section aria-label={t("home.workbench.recentProjects")}>
                    <div className="mb-4 flex flex-wrap items-center gap-3">
                        <h2 className="mr-1 text-lg font-semibold">{t("home.workbench.projects")}</h2>
                        <Segmented
                            value={filter}
                            options={["all", "canvas", "drama", "pinned"].map((value) => ({ value, label: t(`home.workbench.${value}`) }))}
                            onChange={(value) => {
                                setFilter(value as ProjectFilter);
                                setVisibleCount(12);
                            }}
                        />
                        <Input
                            className="!w-full sm:!ml-auto sm:!w-52"
                            allowClear
                            prefix={<Search className="mr-1 size-4 text-muted-foreground" />}
                            placeholder={t("home.workbench.search")}
                            aria-label={t("home.workbench.search")}
                            value={query}
                            onChange={(event) => {
                                setQuery(event.target.value);
                                setVisibleCount(12);
                            }}
                        />
                        <div className="flex gap-1">
                            {(["grid", "list"] as const).map((mode) => (
                                <Tooltip key={mode} title={t(`home.workbench.${mode}`)}>
                                    <Button
                                        aria-label={t(`home.workbench.${mode}`)}
                                        aria-pressed={view === mode}
                                        type={view === mode ? "default" : "text"}
                                        icon={mode === "grid" ? <LayoutGrid className="size-4" /> : <List className="size-4" />}
                                        onClick={() => {
                                            setView(mode);
                                            try {
                                                localStorage.setItem("home-project-view", mode);
                                            } catch {
                                                /* optional view preference */
                                            }
                                        }}
                                    />
                                </Tooltip>
                            ))}
                        </div>
                    </div>
                    {!hydrated || (!data.dramaReady && !data.dramaError) ? (
                        <div aria-busy="true" data-testid="home-projects-loading" className={cn(view === "grid" ? "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" : "flex flex-col gap-2")}>
                            {Array.from({ length: 3 }, (_, index) => <div key={index} className={cn(surface, "overflow-hidden", view === "list" && "flex items-center")}>
                                <div className={cn("shrink-0 animate-pulse bg-muted", view === "grid" ? "aspect-[16/9] w-full" : "h-24 w-24 sm:w-36")} />
                                <div className="flex-1 p-3.5"><Skeleton active title={{ width: "60%" }} paragraph={{ rows: 2 }} /></div>
                            </div>)}
                        </div>
                    ) : !data.dramaReady ? (
                        <div className={cn(surface, "py-10")}><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("home.workbench.loadFailed", { sections: t("home.workbench.drama") })} /></div>
                    ) : !filtered.length ? (
                        <div className={cn(surface, "py-10")}>
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t(query || filter !== "all" ? "home.workbench.noMatches" : "home.workbench.noProjects")} />
                        </div>
                    ) : (
                        <div className={cn(view === "grid" ? "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" : "flex flex-col gap-2")}>
                            {filtered.slice(0, visibleCount).map((entry) => {
                                if (entry.kind === "drama") {
                                    const folder = entry.folder;
                                    return (
                                        <Link key={`drama:${folder.id}`} to={`/production?dramaId=${encodeURIComponent(folder.id)}`} className={cn(surface, "group overflow-hidden text-foreground transition-colors hover:border-foreground/30", view === "list" && "flex items-center")}>
                                            <div className={cn("relative shrink-0 overflow-hidden bg-muted", view === "grid" ? "aspect-[16/9] w-full" : "h-24 w-24 sm:w-36")}>
                                                <WorkbenchMediaPreview media={folder.coverStorageKey ? { kind: "image", storageKey: folder.coverStorageKey } : null} label={folder.name} />
                                                {view === "grid" && <span className="absolute left-3 top-3 rounded bg-background/95 px-2 py-1 text-[11px]">{t("home.workbench.drama")}</span>}
                                            </div>
                                            <div className="min-w-0 flex-1 p-3.5">
                                                <h3 className="line-clamp-2 text-base font-semibold" title={folder.name}>{folder.name}</h3>
                                                <p className="mt-1.5 truncate text-xs text-muted-foreground">{t("home.workbench.drama")}</p>
                                                <p className="mt-1 text-xs text-muted-foreground">{date(entry.updatedAt)}</p>
                                            </div>
                                        </Link>
                                    );
                                }
                                const p = entry.project;
                                const pinned = Boolean(data.settings[`homePinnedProject:${p.id}`]);
                                return (
                                    <article key={p.id} className={cn(surface, "group overflow-hidden transition-colors hover:border-foreground/30", view === "list" && "flex flex-wrap items-center")}>
                                        <button
                                            type="button"
                                            className={cn("relative block shrink-0 cursor-pointer overflow-hidden bg-muted", view === "grid" ? "aspect-[16/9] w-full" : "h-24 w-24 sm:w-36")}
                                            onClick={() => openProject(p.id)}
                                            aria-label={t("landing.openCanvasNamed", { name: p.title })}
                                        >
                                            <WorkbenchMediaPreview media={cover(p)} label={cover(p) ? p.title : t("landing.noPreview")} />
                                            {view === "grid" && <span className="absolute left-3 top-3 rounded bg-background/95 px-2 py-1 text-[11px] text-foreground">{t("home.workbench.canvas")}</span>}
                                        </button>
                                        <div className="flex min-w-0 flex-1 items-center gap-2 p-3.5">
                                            <button type="button" className="min-w-0 flex-1 cursor-pointer text-left" onClick={() => openProject(p.id)}>
                                                <h3 className="line-clamp-2 text-base font-semibold" title={p.title}>
                                                    {p.title}
                                                </h3>
                                                <p className="mt-1.5 truncate text-xs text-muted-foreground">{folderFor(p)?.name || t("home.workbench.canvas")}</p>
                                                <p className="mt-1 text-xs text-muted-foreground">{date(p.updatedAt)}</p>
                                            </button>
                                            <Tooltip title={t(pinned ? "home.workbench.unpin" : "home.workbench.pin")}>
                                                <Button
                                                    type="text"
                                                    size="small"
                                                    aria-pressed={pinned}
                                                    aria-label={t(pinned ? "home.workbench.unpin" : "home.workbench.pin")}
                                                    disabled={!data.connected || !data.settingsReady || data.pinning}
                                                    icon={pinned ? <BookmarkCheck className="size-4" /> : <Bookmark className="size-4 text-muted-foreground" />}
                                                    onClick={() => pin(p.id)}
                                                />
                                            </Tooltip>
                                        </div>
                                        <div className={cn("flex items-center justify-between gap-2 border-t border-border px-3.5 py-2.5", view === "list" && "w-full")}>{isDrama(p) && <Link className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground" to={`/production?dramaId=${encodeURIComponent(folderFor(p)?.id || "")}`}>{t("productionCanvas.backDrama")}<ArrowRight className="size-3" /></Link>}<Button type="text" size="small" icon={<Eye className="size-3.5" />} aria-label={t("home.workbench.previewNamed", { name: p.title })} onClick={() => setPreviewProject(p)}>{t("landing.preview")}</Button></div>
                                    </article>
                                );
                            })}
                        </div>
                    )}
                    <div className="mt-4 flex items-center justify-between gap-3">
                        <Button type="text" onClick={() => navigate("/canvas")}>
                            {t("home.workbench.manageProjects")}
                            <ArrowRight className="size-3.5" />
                        </Button>
                        {visibleCount < filtered.length && <Button onClick={() => setVisibleCount((count) => count + 12)}>{t("home.workbench.moreProjects")}</Button>}
                    </div>
                </section>
                <section className="mt-6 border-t border-border pt-6" aria-label={t("home.workbench.recentOutputs")}>
                    <div className="mb-4 flex items-center justify-between gap-3">
                        <h2 className="text-base font-semibold">{t("home.workbench.recentOutputs")}</h2>
                        <Button type="text" onClick={() => setOutputsOpen(true)}>
                            {t("home.workbench.viewResults")}
                            <ArrowRight className="size-3.5" />
                        </Button>
                    </div>
                    {data.loading && !data.logs.length ? (
                        <Skeleton active paragraph={{ rows: 2 }} />
                    ) : outputs.length ? (
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">{outputs.slice(0, 6).map(outputCard)}</div>
                    ) : (
                        <div className="rounded-lg border border-dashed border-border py-7 text-center text-sm text-muted-foreground">{t(data.connected ? "home.workbench.noOutputs" : "home.workbench.offlineOutputs")}</div>
                    )}
                </section>
            </div>
            <Modal open={creating} title={t("canvas.create")} onCancel={() => setCreating(false)} onOk={create} okText={t("home.workbench.createOpen")} okButtonProps={{ disabled: !name.trim() || !data.connected }} destroyOnHidden>
                <label className="mb-2 block text-sm" htmlFor="home-project-name">
                    {t("home.workbench.projectName")}
                </label>
                <Input id="home-project-name" value={name} onChange={(e) => setName(e.target.value)} onPressEnter={create} autoFocus />
            </Modal>
            <Modal
                open={Boolean(previewProject)}
                title={previewProject?.title}
                onCancel={() => setPreviewProject(null)}
                footer={
                    previewProject ? (
                        <Button type="primary" onClick={() => openProject(previewProject.id)}>
                            {t("home.workbench.continue")}
                            <ArrowRight className="size-4" />
                        </Button>
                    ) : null
                }
                width={800}
                destroyOnHidden
            >
                {previewProject && (
                    <>
                        <div className="h-[min(50vh,420px)] overflow-hidden rounded-lg bg-muted">
                            <WorkbenchMediaPreview media={cover(previewProject)} label={stats(previewProject)} controls />
                        </div>
                        <p className="mt-3 text-sm text-muted-foreground">
                            {stats(previewProject)} · {date(previewProject.updatedAt)}
                        </p>
                    </>
                )}
            </Modal>
            <Modal
                open={outputsOpen}
                title={t("home.workbench.recentOutputs")}
                onCancel={() => setOutputsOpen(false)}
                footer={
                    data.hasMore ? (
                        <Button loading={data.loading} onClick={data.loadMore}>
                            {t("home.workbench.moreResults")}
                        </Button>
                    ) : null
                }
                width={960}
                destroyOnHidden
            >
                <div className="max-h-[65vh] overflow-y-auto">{outputs.length ? <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">{outputs.map(outputCard)}</div> : <Empty description={t("home.workbench.noOutputs")} />}</div>
            </Modal>
            <Modal
                open={Boolean(previewOutput)}
                title={previewOutput ? outputTitle(previewOutput) : ""}
                onCancel={() => setPreviewOutput(null)}
                footer={
                    previewOutput && projectIds.has(previewOutput.log.projectId) ? (
                        <Button onClick={() => openProject(previewOutput.log.projectId)}>
                            {t("home.workbench.sourceProject")}
                            <ArrowRight className="size-4" />
                        </Button>
                    ) : null
                }
                width={900}
                destroyOnHidden
            >
                {previewOutput && (
                    <>
                        <div className="flex h-[min(55vh,480px)] items-center justify-center overflow-hidden rounded-lg bg-muted">
                            <WorkbenchMediaPreview media={previewOutput} label={outputTitle(previewOutput)} controls />
                        </div>
                        <p className="mt-3 text-xs text-muted-foreground">
                            {previewOutput.log.model} · {date(previewOutput.log.createdAt)}
                        </p>
                        {previewOutput.log.prompt && <p className="mt-3 max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-sm">{previewOutput.log.prompt}</p>}
                    </>
                )}
            </Modal>
            <Modal
                open={tasksOpen}
                title={t("home.workbench.recentTasks")}
                onCancel={() => setTasksOpen(false)}
                footer={
                    <Button loading={data.loading} icon={<RefreshCw className="size-4" />} onClick={data.refresh}>
                        {t("home.workbench.refresh")}
                    </Button>
                }
                width={720}
                destroyOnHidden
            >
                <div className="max-h-[65vh] overflow-y-auto">
                    {!data.connected ? (
                        <Empty description={t("home.workbench.offline")} />
                    ) : data.tasks.length ? (
                        data.tasks.map((task) => {
                            const destination = taskDestination(task, projectIds);
                            return (
                                <div key={task.id} className="border-b border-border py-4 last:border-0">
                                    <div className="flex flex-wrap items-start gap-2">
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-sm font-medium">{projects.find((p) => p.id === task.projectId)?.title || task.model || task.kind || t("home.workbench.task")}</p>
                                            <p className="mt-1 text-xs text-muted-foreground">
                                                {task.model} · {date(task.updatedAt || task.createdAt || "")}
                                            </p>
                                        </div>
                                        <Tag color={task.status === "failed" ? "error" : task.status === "running" ? "processing" : task.status === "succeeded" ? "success" : "default"}>{t(`home.workbench.status_${task.status}`)}</Tag>
                                        {destination && (
                                            <Button size="small" onClick={() => navigate(destination)}>
                                                {t("home.workbench.openSource")}
                                            </Button>
                                        )}
                                    </div>
                                    {task.status === "running" && <Progress className="!mt-2" percent={Math.min(100, Math.max(0, Math.round((Number(task.progress) || 0) * 100)))} size="small" />}
                                    {task.error && <p className="mt-2 whitespace-pre-wrap break-words text-xs text-destructive">{task.error}</p>}
                                </div>
                            );
                        })
                    ) : (
                        <Empty description={t("home.workbench.noTasks")} />
                    )}
                </div>
            </Modal>
        </main>
    );
}
