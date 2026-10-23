import { useEffect, useRef } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Alert, App, Button, Input } from "antd";
import { Download, FileUp, LayoutGrid, Plus, Search } from "lucide-react";
import { useTranslation } from "react-i18next";

import { readZip } from "@/lib/zip";
import { setMediaBlob } from "@/services/file-storage";
import { setImageBlob } from "@/services/image-storage";
import { CanvasDeleteProjectsDialog } from "@/components/canvas/canvas-delete-projects-dialog";
import { CanvasProjectCard } from "@/components/canvas/canvas-project-card";
import { CanvasDraftsButton } from "@/components/canvas/canvas-drafts-button";
import type { CanvasExportFile } from "@/types/canvas-export";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { useExportCanvas } from "@/hooks/use-export-canvas";
import { acquireCanvasTransfer, releaseCanvasTransfer, useCanvasTransfer } from "@/lib/canvas/canvas-transfer";
import { uploadBackendMedia } from "@/services/backend-api";
import { useBackendStore } from "@/stores/use-backend-store";
import { cn } from "@/lib/utils";
import DramaPage from "@/pages/drama";
import { canvasProjectDestination, matchesProjectQuery, ordinaryCanvasProjects, projectDirectoryType, updateProjectDirectoryLocation } from "./directory-data";
import { useDramaDirectory } from "./use-drama-directory";

export default function ProjectsPage() {
    const { exportCanvasProjects, exporting } = useExportCanvas();
    const transfer = useCanvasTransfer();
    const { message } = App.useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const location = useLocation();
    const [searchParams] = useSearchParams();
    const directoryType = projectDirectoryType(location.pathname, searchParams);
    const searchQuery = searchParams.get("q") || "";
    const showCanvases = directoryType !== "drama";
    const changeSearch = (q: string) => navigate(updateProjectDirectoryLocation(location, { q }), { replace: true });
    const inputRef = useRef<HTMLInputElement>(null);
    const autoOpenRef = useRef(false);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const projects = useCanvasStore((state) => state.projects);
    const folders = useCanvasStore((state) => state.folders);
    const createProject = useCanvasStore((state) => state.createProject);
    const importProject = useCanvasStore((state) => state.importProject);
    const storedSelectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const removeSelectedIds = useCanvasUiStore((state) => state.removeSelectedProjectIds);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const backendConnected = useBackendStore((state) => state.connected);

    const mode = searchParams.get("mode");
    const agentMode = mode === "new" || mode === "recent" || mode === "choose";
    const agentQuery = agentMode ? `?${searchParams.toString()}` : "";
    const { episodesByDrama, ownershipReady, ownershipLoading, ownershipError, refresh } = useDramaDirectory();
    const ordinaryProjects = ordinaryCanvasProjects(projects, folders, episodesByDrama);
    const selectedIds = ownershipLoading ? [] : storedSelectedIds.filter((id) => ordinaryProjects.some((project) => project.id === id));
    const visibleProjects = ordinaryProjects.filter(project => matchesProjectQuery(project.title, searchQuery));
    const hiddenSelectedCount = selectedIds.filter((id) => !visibleProjects.some((project) => project.id === id)).length;
    const enterProject = (id: string) => {
        const destination = canvasProjectDestination(id, "canvas", agentQuery, location.hash);
        navigate(destination.to, { replace: destination.replace });
    };
    const createAndEnter = () => enterProject(createProject(t("canvas.defaultTitle", { count: projects.length + 1 })));
    const importCanvas = async (file?: File) => {
        if (!file) return;
        if (!acquireCanvasTransfer("import")) {
            message.info(t("canvas.transferBusy"));
            if (inputRef.current) inputRef.current.value = "";
            return;
        }
        try {
            const zip = await readZip(file);
            const projectFile = zip.get("projects.json");
            if (!projectFile) throw new Error("missing projects.json");
            const data = JSON.parse(await projectFile.text()) as CanvasExportFile;
            if (data.app !== "infinite-canvas" || ![3, 4].includes(Number(data.version)) || !Array.isArray(data.projects)) throw new Error("不支持的画布导出包");
            const entries = data.projects.flatMap((project) => project.files.map((item) => ({ project, item, blob: zip.get(item.path) })));
            if (entries.some((entry) => !entry.blob)) throw new Error("导出包缺少媒体文件");
            for (const entry of entries) {
                const blob = entry.blob!;
                const typedBlob = blob.type ? blob : blob.slice(0, blob.size, entry.item.mimeType);
                if (entry.item.sha256 && await sha256(typedBlob) !== entry.item.sha256) throw new Error(`媒体校验失败：${entry.item.storageKey}`);
            }
            const backendConnected = useBackendStore.getState().connected;
            for (const entry of entries) {
                const typedBlob = entry.blob!.type ? entry.blob! : entry.blob!.slice(0, entry.blob!.size, entry.item.mimeType);
                if (backendConnected) await uploadBackendMedia({ name: entry.item.path.split("/").pop() || "media.bin", blob: typedBlob, storageKey: entry.item.storageKey, mimeType: entry.item.mimeType, category: "library" });
                await (entry.item.storageKey.startsWith("image:") ? setImageBlob(entry.item.storageKey, typedBlob) : setMediaBlob(entry.item.storageKey, typedBlob));
            }
            if (Array.isArray(data.folders) && data.folders.length) {
                const currentFolders = useCanvasStore.getState().folders;
                const foldersById = new Map(currentFolders.map((folder) => [folder.id, folder]));
                data.folders.forEach((folder) => foldersById.set(folder.id, folder));
                useCanvasStore.getState().replaceFolders([...foldersById.values()]);
            }
            data.projects.forEach((item) => importProject({ ...item.project, logs: item.logs || [] } as Partial<CanvasProject> & { logs: Array<Record<string, unknown>> }));
            message.success(t("canvas.imported", { count: data.projects.length }));
        } catch {
            message.error(t("canvas.importFailed"));
        } finally {
            releaseCanvasTransfer("import");
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    useEffect(() => {
        if (!showCanvases || !hydrated || ownershipLoading || autoOpenRef.current || (mode !== "new" && mode !== "recent")) return;
        autoOpenRef.current = true;
        const recentProject = ordinaryProjects.find((project) => (project.summary?.nodeCount ?? project.nodes.length) > 0) || ordinaryProjects[0];
        enterProject(mode === "new" ? createProject(t("canvas.defaultTitle", { count: projects.length + 1 })) : recentProject?.id || createProject(t("canvas.defaultTitle", { count: projects.length + 1 })));
    }, [createProject, hydrated, mode, ordinaryProjects, ownershipLoading, projects.length, showCanvases, t]);

    if (showCanvases && hydrated && !ownershipLoading && (mode === "new" || mode === "recent")) return <main className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground">{t("canvas.opening")}</main>;

    return (
        <main className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground" data-testid="project-directory">
            <header className="shrink-0 border-b border-border px-4 py-5 sm:px-6 lg:px-8">
                <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4">
                    <div>
                        <h1 className="text-2xl font-medium tracking-tight">{t("projects.title")}</h1>
                        <p className="mt-1 text-sm text-muted-foreground">{t("projects.description")}</p>
                    </div>
                    <Input className="!w-full sm:!w-80" allowClear prefix={<Search className="size-4 text-muted-foreground" />} aria-label={t("projects.search")} placeholder={t("projects.search")} value={searchQuery} onChange={event => changeSearch(event.target.value)} />
                </div>
            </header>
            <div className="flex min-h-0 w-full flex-1">
                <div className="min-w-0 flex-1 overflow-y-auto">
                    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
                        {directoryType !== "canvas" && <DramaPage searchQuery={searchQuery} compactEmpty={directoryType === "all"} />}
                        {showCanvases && <>
                        <header className="flex flex-wrap items-center justify-between gap-5 border-b border-border pb-6">
                            <div>
                                <h2 className="flex items-center gap-2 text-lg font-medium tracking-tight">{t("projects.canvas")}<span className="text-xs font-normal text-muted-foreground" data-testid="canvas-directory-count">{!hydrated || !ownershipReady ? "—" : visibleProjects.length}</span></h2>
                                <p className="mt-1 text-xs text-muted-foreground">{t("projects.canvasDescription")}</p>
                            </div>
                            <div className="flex flex-wrap items-center justify-end gap-2">
                                <CanvasDraftsButton />
                                <Button loading={transfer === "import"} disabled={!hydrated || transfer !== null} icon={<FileUp className="size-4" />} onClick={() => inputRef.current?.click()}>{t("canvas.import")}</Button>
                                <Button disabled={!hydrated} type="primary" icon={<Plus className="size-4" />} onClick={createAndEnter}>{t("canvas.create")}</Button>
                            </div>
                        </header>

                        {selectedIds.length ? (
                            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
                                <span className="mr-2 text-xs text-muted-foreground">{t("assets.selectedCount", { count: selectedIds.length })}</span>
                                {hiddenSelectedCount > 0 && <span role="status" className="text-xs text-amber-700 dark:text-amber-300">{t("projects.hiddenSelection", { count: hiddenSelectedCount })}</span>}
                                <Button size="small" type="text" onClick={() => removeSelectedIds(selectedIds)}>{t("projects.clearSelection")}</Button>
                                <Button loading={exporting} disabled={!hydrated || transfer !== null} icon={<Download className="size-4" />} onClick={() => void exportCanvasProjects(ordinaryProjects.filter((project) => selectedIds.includes(project.id)), `${t("canvas.title")}-${selectedIds.length}`)}>
                                    {t("canvas.exportSelected")}
                                </Button>
                                <Button disabled={!hydrated} onClick={() => setDeleteIds(selectedIds)}>{t("canvas.deleteSelected")}</Button>
                            </div>
                        ) : null}

                        {hydrated && !ownershipReady && (!backendConnected || ownershipError) && <Alert type="warning" showIcon title={t("projects.ownershipUnavailable")} description={t("projects.ownershipDescription")} action={backendConnected ? <Button onClick={refresh}>{t("director.refresh")}</Button> : undefined} />}
                        {!hydrated || ownershipLoading ? (
                            <section className="flex min-h-[360px] items-center justify-center rounded-xl border border-border bg-card/50 text-sm text-muted-foreground">{t("canvas.loading")}</section>
                        ) : visibleProjects.length ? (
                            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                                {visibleProjects.map((project) => <CanvasProjectCard key={project.id} project={project} />)}
                            </div>
                        ) : (
                            <section className="flex min-h-[360px] flex-col items-center justify-center rounded-xl border border-border bg-card/50 px-6 text-center">
                                <LayoutGrid className="mb-5 size-9 stroke-[1.2] text-primary" aria-hidden="true" />
                                <h2 className="text-xl font-medium">{searchQuery ? t("projects.noMatches") : t("canvas.empty")}</h2>
                                <p className="mt-3 text-sm text-muted-foreground">{searchQuery ? t("projects.trySearch") : t("canvas.emptyDescription")}</p>
                                <Button type="primary" className="mt-6" icon={<Plus className="size-4" />} onClick={createAndEnter}>{t("canvas.create")}</Button>
                            </section>
                        )}
                        </>}
                    </div>
                </div>
            </div>

            <input ref={inputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importCanvas(event.target.files?.[0])} />
            <CanvasDeleteProjectsDialog />
        </main>
    );
}

async function sha256(blob: Blob) {
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
