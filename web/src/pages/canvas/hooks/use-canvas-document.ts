import { useCallback, useRef, useState, type SetStateAction } from "react";
import { applyBackendCanvasDelta, detectCanvasConflicts, diffCanvasProject, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";

type EditableField = "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "globalPrompt";
type HistoryEntry = { before: CanvasProject; after: CanvasProject; at: number };
const EMPTY_NODES: CanvasProject["nodes"] = [];
const EMPTY_CONNECTIONS: CanvasProject["connections"] = [];
const EMPTY_SESSIONS: CanvasProject["chatSessions"] = [];

/** 页面直接订阅权威投影。只有此页面显式编辑才进入个人撤销，远端事件不入栈。 */
export function useCanvasDocument(projectId: string) {
    const project = useCanvasStore((state) => state.projects.find((item) => item.id === projectId));
    const history = useRef<{ projectId: string; past: HistoryEntry[]; future: HistoryEntry[] }>({ projectId, past: [], future: [] });
    const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
    const currentHistory = useCallback(() => {
        if (history.current.projectId !== projectId) history.current = { projectId, past: [], future: [] };
        return history.current;
    }, [projectId]);
    const refreshHistory = useCallback(() => {
        const state = currentHistory();
        setHistoryState({ canUndo: state.past.length > 0, canRedo: state.future.length > 0 });
    }, [currentHistory]);
    const edit = useCallback(<K extends EditableField>(field: K, action: SetStateAction<CanvasProject[K]>) => {
        const store = useCanvasStore.getState();
        const before = store.projects.find((item) => item.id === projectId);
        if (!before || before.summary) return;
        const value = typeof action === "function" ? (action as (value: CanvasProject[K]) => CanvasProject[K])(before[field]) : action;
        if (Object.is(before[field], value)) return;
        store.updateProject(projectId, { [field]: value });
        const after = useCanvasStore.getState().projects.find((item) => item.id === projectId)!;
        if (!diffCanvasProject(before, after).length) return;
        const state = currentHistory();
        const previous = state.past.at(-1);
        const at = Date.now();
        // 沿用原先 180ms 编辑分组与 50 步历史；远端更新会打断本地分组。
        if (previous?.after === before && at - previous.at < 180) { previous.after = after; previous.at = at; }
        else state.past = [...state.past.slice(-49), { before, after, at }];
        state.future = [];
        refreshHistory();
    }, [projectId, currentHistory, refreshHistory]);

    const applyHistory = useCallback((redo: boolean): string | undefined => {
        const state = currentHistory();
        const source = redo ? state.future : state.past;
        const entry = source.at(-1);
        const current = useCanvasStore.getState().projects.find((item) => item.id === projectId);
        if (!entry || !current) return;
        const base = redo ? entry.before : entry.after;
        const target = redo ? entry.after : entry.before;
        const operations = diffCanvasProject(base, target);
        const conflicts = detectCanvasConflicts(operations, current, base, { guardLayout: true });
        // 普通删除允许最后提交生效，但撤销新增不得删掉后来被他人编辑的实体。
        const unsafeDelete = operations.some((op) => {
            if (op.type === "delete_node") {
                const node = current.nodes.find((item) => item.id === op.id);
                return node && JSON.stringify(node) !== JSON.stringify(base.nodes.find((item) => item.id === op.id));
            }
            if (op.type === "delete_h3_segment") {
                const segment = (p: CanvasProject) => ((p.nodes.find((item) => item.id === op.nodeId)?.metadata as unknown as { segments?: Array<{ id: string }> } | undefined)?.segments)?.find((item) => item.id === op.segmentId);
                return segment(current) && JSON.stringify(segment(current)) !== JSON.stringify(segment(base));
            }
            return false;
        });
        if (conflicts.length || unsafeDelete) return "该操作涉及的内容已被其他协作者修改，未覆盖远端内容。";
        const next = applyBackendCanvasDelta(current, operations, Number(current.revision || 0));
        useCanvasStore.getState().updateProject(projectId, {
            nodes: next.nodes, connections: next.connections, chatSessions: next.chatSessions,
            activeChatId: next.activeChatId, backgroundMode: next.backgroundMode,
            showImageInfo: next.showImageInfo, globalPrompt: next.globalPrompt,
        });
        source.pop();
        (redo ? state.past : state.future).push(entry);
        refreshHistory();
    }, [currentHistory, projectId, refreshHistory]);

    return {
        nodes: project?.nodes || EMPTY_NODES, connections: project?.connections || EMPTY_CONNECTIONS,
        chatSessions: project?.chatSessions || EMPTY_SESSIONS, activeChatId: project?.activeChatId || null,
        backgroundMode: project?.backgroundMode || "lines", showImageInfo: project?.showImageInfo || false,
        globalPrompt: project?.globalPrompt || "",
        setNodes: useCallback((value: SetStateAction<CanvasProject["nodes"]>) => edit("nodes", value), [edit]),
        setConnections: useCallback((value: SetStateAction<CanvasProject["connections"]>) => edit("connections", value), [edit]),
        setChatSessions: useCallback((value: SetStateAction<CanvasProject["chatSessions"]>) => edit("chatSessions", value), [edit]),
        setActiveChatId: useCallback((value: SetStateAction<CanvasProject["activeChatId"]>) => edit("activeChatId", value), [edit]),
        setBackgroundMode: useCallback((value: SetStateAction<CanvasProject["backgroundMode"]>) => edit("backgroundMode", value), [edit]),
        setShowImageInfo: useCallback((value: SetStateAction<boolean>) => edit("showImageInfo", value), [edit]),
        setGlobalPrompt: useCallback((value: SetStateAction<string>) => edit("globalPrompt", value), [edit]),
        historyState: history.current.projectId === projectId ? historyState : { canUndo: false, canRedo: false },
        history, undo: useCallback(() => applyHistory(false), [applyHistory]), redo: useCallback(() => applyHistory(true), [applyHistory]),
    };
}
