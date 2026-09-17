import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { App, Button, Dropdown, Select } from "antd";
import { Download, FileUp, Folder, FolderInput, FolderPlus, Plus } from "lucide-react";
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
import { hasAgentUrlBootstrap } from "@/lib/agent/agent-url-bootstrap";
import { uploadBackendMedia } from "@/services/backend-api";
import { useBackendStore } from "@/stores/use-backend-store";
import { cn } from "@/lib/utils";

const UNFILED_FOLDER = "__unfiled__";

export default function CanvasPage() {
    const exportCanvasProjects = useExportCanvas();
    const { message } = App.useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const inputRef = useRef<HTMLInputElement>(null);
    const autoOpenRef = useRef(false);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const projects = useCanvasStore((state) => state.projects);
    const folders = useCanvasStore((state) => state.folders);
    const createProject = useCanvasStore((state) => state.createProject);
    const importProject = useCanvasStore((state) => state.importProject);
    const createFolder = useCanvasStore((state) => state.createFolder);
    const renameFolder = useCanvasStore((state) => state.renameFolder);
    const deleteFolder = useCanvasStore((state) => state.deleteFolder);
    const moveProjectsToFolder = useCanvasStore((state) => state.moveProjectsToFolder);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const [folderFilter, setFolderFilter] = useState<string | null>(null);

    const mode = searchParams.get("mode");
    const agentMode = mode === "new" || mode === "recent" || mode === "choose";
    const agentQuery = agentMode ? `?${searchParams.toString()}` : "";
    const visibleProjects = useMemo(() => {
        if (folderFilter === null) return projects;
        if (folderFilter === UNFILED_FOLDER) return projects.filter((project) => !project.folderId);
        return projects.filter((project) => project.folderId === folderFilter);
    }, [folderFilter, projects]);
    const folderCounts = (folderId: string | null) => folderId === null
        ? projects.filter((project) => !project.folderId).length
        : projects.filter((project) => project.folderId === folderId).length;
    const createAndSelectFolder = () => setFolderFilter(createFolder());
    const renameFolderFromPrompt = (id: string, name: string) => {
        const next = window.prompt(t("canvas.folder.rename"), name);
        if (next?.trim()) renameFolder(id, next);
    };
    const removeFolder = (id: string) => {
        if (!window.confirm(t("canvas.folder.deleteDescription"))) return;
        deleteFolder(id);
        if (folderFilter === id) setFolderFilter(null);
    };
    const moveSelectedToFolder = (folderId: string | null) => moveProjectsToFolder(selectedIds, folderId);
    const enterProject = (id: string) => {
        const agentHash = hasAgentUrlBootstrap(window.location.hash) ? window.location.hash : "";
        navigate(`/canvas/${id}${agentQuery}${agentHash}`, { replace: Boolean(agentHash) });
    };
    const createAndEnter = () => enterProject(createProject(t("canvas.defaultTitle", { count: projects.length + 1 })));
    const importCanvas = async (file?: File) => {
        if (!file) return;
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
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    useEffect(() => {
        if (!hydrated || autoOpenRef.current || (mode !== "new" && mode !== "recent")) return;
        autoOpenRef.current = true;
        const recentProject = projects.find((project) => (project.summary?.nodeCount ?? project.nodes.length) > 0) || projects[0];
        enterProject(mode === "new" ? createProject(t("canvas.defaultTitle", { count: projects.length + 1 })) : recentProject?.id || createProject(t("canvas.defaultTitle", { count: projects.length + 1 })));
    }, [createProject, hydrated, mode, projects, t]);

    if (hydrated && (mode === "new" || mode === "recent")) return <main className="flex h-full items-center justify-center bg-background text-sm text-stone-500">{t("canvas.opening")}</main>;

    return (
        <main className="h-full overflow-hidden bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto flex h-full w-full max-w-7xl">
                <aside className="hidden w-60 shrink-0 flex-col border-r border-stone-200 px-4 py-8 dark:border-stone-800 md:flex">
                    <div className="mb-2 flex items-center justify-between px-2">
                        <span className="text-xs font-medium text-stone-400">{t("canvas.folder.title")}</span>
                        <button type="button" className="rounded p-1 text-stone-400 transition hover:bg-stone-100 hover:text-stone-800 dark:hover:bg-stone-900 dark:hover:text-stone-200" onClick={createAndSelectFolder} aria-label={t("canvas.folder.newFolder")}>
                            <FolderPlus className="size-4" />
                        </button>
                    </div>
                    <div className="space-y-1">
                        <button type="button" className={cn("flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-stone-100 dark:hover:bg-stone-900", folderFilter === null && "bg-stone-100 font-medium dark:bg-stone-900")} onClick={() => setFolderFilter(null)}>
                            <span>{t("canvas.folder.all")}</span><span className="text-xs text-stone-400">{projects.length}</span>
                        </button>
                        <button type="button" className={cn("flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-stone-100 dark:hover:bg-stone-900", folderFilter === UNFILED_FOLDER && "bg-stone-100 font-medium dark:bg-stone-900")} onClick={() => setFolderFilter(UNFILED_FOLDER)}>
                            <span>{t("canvas.folder.unfiled")}</span><span className="text-xs text-stone-400">{folderCounts(null)}</span>
                        </button>
                    </div>
                    <div className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto">
                        {folders.map((folder) => (
                            <div key={folder.id} className={cn("group flex items-center gap-1 rounded-md px-2 py-1 transition-colors hover:bg-stone-100 dark:hover:bg-stone-900", folderFilter === folder.id && "bg-stone-100 dark:bg-stone-900")}>
                                <button type="button" className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left text-sm" onClick={() => setFolderFilter(folder.id)}>
                                    <Folder className="size-4 shrink-0 text-stone-400" />
                                    <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                                    <span className="text-xs text-stone-400">{folderCounts(folder.id)}</span>
                                </button>
                                <Dropdown trigger={["click"]} menu={{ items: [
                                    { key: "rename", label: t("canvas.folder.renameAction"), onClick: () => renameFolderFromPrompt(folder.id, folder.name) },
                                    { key: "delete", label: t("canvas.folder.deleteAction"), danger: true, onClick: () => removeFolder(folder.id) },
                                ] }}>
                                    <button type="button" className="rounded px-1 text-stone-400 opacity-0 transition hover:text-stone-800 group-hover:opacity-100 dark:hover:text-stone-200" onClick={(event) => event.stopPropagation()}>···</button>
                                </Dropdown>
                            </div>
                        ))}
                    </div>
                    <button type="button" className="mt-3 flex items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-stone-500 transition hover:bg-stone-100 hover:text-stone-800 dark:hover:bg-stone-900 dark:hover:text-stone-200" onClick={createAndSelectFolder}>
                        <FolderPlus className="size-4" />{t("canvas.folder.newFolder")}
                    </button>
                </aside>

                <div className="min-w-0 flex-1 overflow-y-auto">
                    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
                        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 pb-6 dark:border-stone-800">
                            <div>
                                <p className="text-xs text-stone-500">{t("canvas.library")}</p>
                                <h1 className="mt-3 text-3xl font-semibold">{t("canvas.title")}</h1>
                                <Select className="mt-3 w-52 md:hidden" value={folderFilter ?? "__all__"} options={[{ value: "__all__", label: t("canvas.folder.all") }, { value: UNFILED_FOLDER, label: t("canvas.folder.unfiled") }, ...folders.map((folder) => ({ value: folder.id, label: folder.name }))]} onChange={(value) => setFolderFilter(value === "__all__" ? null : value)} />
                            </div>
                            <div className="flex flex-wrap items-center justify-end gap-2">
                                {selectedIds.length ? (
                                    <>
                                        <Button disabled={!hydrated} icon={<Download className="size-4" />} onClick={() => void exportCanvasProjects(projects.filter((project) => selectedIds.includes(project.id)), `${t("canvas.title")}-${selectedIds.length}`)}>
                                            {t("canvas.exportSelected")}
                                        </Button>
                                        {folders.length ? (
                                            <Dropdown trigger={["click"]} menu={{ items: [
                                                { key: "root", label: t("canvas.folder.moveRoot"), onClick: () => moveSelectedToFolder(null) },
                                                ...folders.map((folder) => ({ key: folder.id, label: folder.name, onClick: () => moveSelectedToFolder(folder.id) })),
                                            ] }}>
                                                <Button disabled={!hydrated} icon={<FolderInput className="size-4" />}>{t("canvas.folder.move")}</Button>
                                            </Dropdown>
                                        ) : null}
                                        <Button disabled={!hydrated} onClick={() => setDeleteIds(selectedIds)}>{t("canvas.deleteSelected")}</Button>
                                    </>
                                ) : null}
                                <CanvasDraftsButton />
                                <Button disabled={!hydrated} icon={<FileUp className="size-4" />} onClick={() => inputRef.current?.click()}>{t("canvas.import")}</Button>
                                <Button disabled={!hydrated} type="primary" icon={<Plus className="size-4" />} onClick={createAndEnter}>{t("canvas.create")}</Button>
                            </div>
                        </header>

                        {!hydrated ? (
                            <section className="flex min-h-[360px] items-center justify-center border-y border-stone-200 text-sm text-stone-500 dark:border-stone-800">{t("canvas.loading")}</section>
                        ) : visibleProjects.length ? (
                            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                                {visibleProjects.map((project) => <CanvasProjectCard key={project.id} project={project} />)}
                            </div>
                        ) : (
                            <section className="flex min-h-[360px] flex-col items-center justify-center border-y border-stone-200 text-center dark:border-stone-800">
                                <h2 className="text-xl font-medium">{t("canvas.empty")}</h2>
                                <p className="mt-3 text-sm text-stone-500">{t("canvas.emptyDescription")}</p>
                                <Button type="primary" className="mt-6" icon={<Plus className="size-4" />} onClick={createAndEnter}>{t("canvas.create")}</Button>
                            </section>
                        )}
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
