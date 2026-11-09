import { useCallback, useRef, useState, type SetStateAction } from "react";
import { buildCanvasConflictBaseline, type CanvasConflictBaseline } from "@/lib/canvas/canvas-conflict-baseline";
import { applyBackendCanvasDelta, detectCanvasConflicts, diffCanvasProject, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";

type EditableField = "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo";
type CanvasOperation = Record<string, unknown>;

/** 撤销栈只记动作：一组正反 ops + 两份冲突判定所需的最小基线，不再持有两份完整 CanvasProject。 */
export type HistoryEntry = {
    /** 组起点 → 组终点，重做用 */
    forwardOps: CanvasOperation[];
    /** 组终点 → 组起点，撤销用 */
    inverseOps: CanvasOperation[];
    /** 撤销方向的冲突基线（组终点的作用域投影） */
    undoBase: CanvasConflictBaseline;
    /** 重做方向的冲突基线（组起点的作用域投影） */
    redoBase: CanvasConflictBaseline;
    at: number;
};

const EMPTY_NODES: CanvasProject["nodes"] = [];
const EMPTY_CONNECTIONS: CanvasProject["connections"] = [];
const EMPTY_SESSIONS: CanvasProject["chatSessions"] = [];

/** 冲突检测只读 base 里「对象是否存在」，只有 unsafeDelete 需要完整旧值做 JSON 比对。
 *  本步没有删除类 op、且两个方向的作用域 id 集合相同时，共用一份基线即可，
 *  撤销栈里每步就少一个 baseline 对象和两份数组。删除场景必须各自保留精确值。 */
function reuseBaseline(undoBase: CanvasConflictBaseline, redoBase: CanvasConflictBaseline, operations: CanvasOperation[]): CanvasConflictBaseline {
    if (operations.some((op) => op.type === "delete_node" || op.type === "delete_h3_segment")) return redoBase;
    const scope = (base: CanvasConflictBaseline) => [
        ...base.nodes.map((node) => `n:${String(node.id)}`),
        ...base.connections.map((connection) => `c:${String(connection.id)}`),
    ].sort().join("|");
    return scope(undoBase) === scope(redoBase) ? undoBase : redoBase;
}

/** 入栈时把一次编辑（或一整组 180ms 连续编辑）冻结成不可变 ops 与最小基线。
 *  undo / redo 现在是两个方向的 diff，没有完整快照就无法在回放时现算，所以这里一次算好。 */
export function createHistoryEntry(before: CanvasProject, after: CanvasProject, at: number, forwardOps = diffCanvasProject(before, after)): HistoryEntry {
    // 编辑入口已经算过一次 before → after 的差分，传入可省掉一次全图遍历。
    const inverseOps = diffCanvasProject(after, before);
    // 内存里的撤销栈不需要切断与 store 的引用：store 用不可变更新，旧节点对象
    // 不会被后续编辑改写；共享引用可避免把大 H3 节点的 metadata 深拷贝两份。
    const undoBase = buildCanvasConflictBaseline(after, inverseOps, { cloneValues: false });
    const redoBase = buildCanvasConflictBaseline(before, forwardOps, { cloneValues: false });
    return {
        forwardOps,
        inverseOps,
        undoBase,
        redoBase: reuseBaseline(undoBase, redoBase, [...forwardOps, ...inverseOps]),
        at,
    };
}

type SegmentHost = { nodes: Array<Record<string, unknown>> };
function findHistorySegment(host: SegmentHost, nodeId: unknown, segmentId: unknown) {
    const node = host.nodes.find((item) => item.id === nodeId);
    const segments = (node?.metadata as { segments?: Array<{ id: string }> } | undefined)?.segments;
    return segments?.find((item) => item.id === segmentId);
}

/** 撤销/重放前的安全判定，独立于 React 便于在真实并发场景回归。
 *  base 用作用域基线：detectCanvasConflicts 只按 op 作用域读它，比对语义与完整快照一致。 */
export function resolveHistoryOperations(current: CanvasProject, entry: HistoryEntry, redo: boolean): { operations?: CanvasOperation[]; error?: string } {
    const operations = redo ? entry.forwardOps : entry.inverseOps;
    const base = redo ? entry.redoBase : entry.undoBase;
    const conflicts = detectCanvasConflicts(operations, current, base, { guardLayout: true });
    // 普通删除允许最后提交生效，但撤销新增不得删掉后来被他人编辑的实体。
    const unsafeDelete = operations.some((op) => {
        if (op.type === "delete_node") {
            const node = current.nodes.find((item) => item.id === op.id);
            return node && JSON.stringify(node) !== JSON.stringify(base.nodes.find((item) => item.id === op.id));
        }
        if (op.type === "delete_h3_segment") {
            const currentSeg = findHistorySegment({ nodes: current.nodes as unknown as Array<Record<string, unknown>> }, op.nodeId, op.segmentId);
            return currentSeg && JSON.stringify(currentSeg) !== JSON.stringify(findHistorySegment(base, op.nodeId, op.segmentId));
        }
        return false;
    });
    if (conflicts.length || unsafeDelete) return { error: "该操作涉及的内容已被其他协作者修改，未覆盖远端内容。" };
    return { operations };
}

/** 页面直接订阅权威投影。只有此页面显式编辑才进入个人撤销，远端事件不入栈。 */
export function useCanvasDocument(projectId: string) {
    const project = useCanvasStore((state) => state.projects.find((item) => item.id === projectId));
    const history = useRef<{ projectId: string; past: HistoryEntry[]; future: HistoryEntry[] }>({ projectId, past: [], future: [] });
    // 180ms 分组只靠这两份引用判定，不进历史数组；历史自身不再钉住任何完整项目。
    // 远端事件替换 store 里的项目对象后引用自然不等，分组被打断。
    const activeGroupBefore = useRef<CanvasProject | null>(null);
    const lastEditAfter = useRef<CanvasProject | null>(null);
    const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
    const currentHistory = useCallback(() => {
        if (history.current.projectId !== projectId) {
            history.current = { projectId, past: [], future: [] };
            activeGroupBefore.current = null;
            lastEditAfter.current = null;
        }
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
        // 函数式 action（map/filter/concat）每次都返回新数组引用，绕过 Object.is；
        // 如果内容实际未变仍调 updateProject，会在 React 18 StrictMode dev 模式
        // 或 zustand 通知顺序中反复 setState，最终报 Maximum update depth exceeded。
        // 节点 / 连线 / 会话字段都是纯 JSON 数据，浅 JSON 比对即可。
        if (typeof action === "function" && JSON.stringify(before[field]) === JSON.stringify(value)) return;
        store.updateProject(projectId, { [field]: value });
        const after = useCanvasStore.getState().projects.find((item) => item.id === projectId)!;
        const deltaOps = diffCanvasProject(before, after);
        if (!deltaOps.length) return;
        const state = currentHistory();
        const previous = state.past.at(-1);
        const at = Date.now();
        // 沿用原先 180ms 编辑分组与 50 步历史；合并时以组内最早的 before 重算整组 diff，
        // 与旧的「只把 previous.after 换成最新 after」等价。
        const merging = Boolean(previous && lastEditAfter.current === before && activeGroupBefore.current && at - previous.at < 180);
        const groupBefore = merging ? activeGroupBefore.current! : before;
        const entry = merging ? createHistoryEntry(groupBefore, after, at) : createHistoryEntry(before, after, at, deltaOps);
        if (merging) state.past[state.past.length - 1] = entry;
        else state.past = [...state.past.slice(-49), entry];
        activeGroupBefore.current = groupBefore;
        lastEditAfter.current = after;
        state.future = [];
        refreshHistory();
    }, [projectId, currentHistory, refreshHistory]);

    const applyHistory = useCallback((redo: boolean): string | undefined => {
        const state = currentHistory();
        const source = redo ? state.future : state.past;
        const entry = source.at(-1);
        const current = useCanvasStore.getState().projects.find((item) => item.id === projectId);
        if (!entry || !current) return;
        const { operations, error } = resolveHistoryOperations(current, entry, redo);
        if (error || !operations) return error;
        const next = applyBackendCanvasDelta(current, operations, Number(current.revision || 0));
        useCanvasStore.getState().updateProject(projectId, {
            nodes: next.nodes, connections: next.connections, chatSessions: next.chatSessions,
            activeChatId: next.activeChatId, backgroundMode: next.backgroundMode,
            showImageInfo: next.showImageInfo,
        });
        source.pop();
        (redo ? state.past : state.future).push(entry);
        // 回放后项目对象已换新，分组链必须断掉，同时释放那两份被钉住的完整项目引用。
        activeGroupBefore.current = null;
        lastEditAfter.current = null;
        refreshHistory();
    }, [currentHistory, projectId, refreshHistory]);

    return {
        project,
        nodes: project?.nodes || EMPTY_NODES, connections: project?.connections || EMPTY_CONNECTIONS,
        chatSessions: project?.chatSessions || EMPTY_SESSIONS, activeChatId: project?.activeChatId || null,
        backgroundMode: project?.backgroundMode || "lines", showImageInfo: project?.showImageInfo || false,
        setNodes: useCallback((value: SetStateAction<CanvasProject["nodes"]>) => edit("nodes", value), [edit]),
        setConnections: useCallback((value: SetStateAction<CanvasProject["connections"]>) => edit("connections", value), [edit]),
        setChatSessions: useCallback((value: SetStateAction<CanvasProject["chatSessions"]>) => edit("chatSessions", value), [edit]),
        setActiveChatId: useCallback((value: SetStateAction<CanvasProject["activeChatId"]>) => edit("activeChatId", value), [edit]),
        setBackgroundMode: useCallback((value: SetStateAction<CanvasProject["backgroundMode"]>) => edit("backgroundMode", value), [edit]),
        setShowImageInfo: useCallback((value: SetStateAction<boolean>) => edit("showImageInfo", value), [edit]),
        historyState: history.current.projectId === projectId ? historyState : { canUndo: false, canRedo: false },
        history, undo: useCallback(() => applyHistory(false), [applyHistory]), redo: useCallback(() => applyHistory(true), [applyHistory]),
    };
}
