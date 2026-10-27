import { useCallback, useEffect, useMemo, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import i18n from "@/i18n";
import { useAgentStore } from "@/stores/use-agent-store";
import { planCanvasAgentOperations, type CanvasAgentOp, type CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { flushCanvasSyncNow, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import type { CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import type { CanvasConnection, CanvasNodeData, ContextMenuState } from "@/types/canvas";

type GenerateNodeRef = MutableRefObject<((nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => Promise<void>) | null>;

type AgentBridgeParams = {
    projectId: string;
    title: string | undefined;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    selectedNodeIds: Set<string>;
    nodesRef: MutableRefObject<CanvasNodeData[]>;
    connectionsRef: MutableRefObject<CanvasConnection[]>;
    selectedNodeIdsRef: MutableRefObject<Set<string>>;
    generateNodeRef: GenerateNodeRef;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
    setSelectedConnectionId: Dispatch<SetStateAction<string | null>>;
    setContextMenu: Dispatch<SetStateAction<ContextMenuState | null>>;
};

/**
 * Bridge between the canvas and local Agent: publish the current snapshot and apply/undo capabilities
 * to the Agent store for the local Codex panel. All members except applyAgentOps are internal.
 */
export function useAgentBridge(params: AgentBridgeParams) {
    const { projectId, title, nodes, connections, selectedNodeIds, nodesRef, connectionsRef, selectedNodeIdsRef, generateNodeRef, setNodes, setConnections, setSelectedNodeIds, setSelectedConnectionId, setContextMenu } =
        params;
    const setAgentCanvasContext = useAgentStore((state) => state.setCanvasContext);
    const [agentUndoSnapshot, setAgentUndoSnapshot] = useState<CanvasAgentSnapshot | null>(null);
    const projectTitle = title || i18n.t("canvas.project.untitled");

    const agentSnapshot = useMemo<CanvasAgentSnapshot>(() => ({ projectId, title: projectTitle, nodes, connections, selectedNodeIds: Array.from(selectedNodeIds) }), [connections, projectTitle, nodes, projectId, selectedNodeIds]);
    const applyAgentOps = useCallback(
        (ops?: CanvasAgentOp[]) => {
            const safeOps = Array.isArray(ops) ? ops.filter((op) => op?.type) : [];
            const before = { projectId, title: projectTitle, nodes: nodesRef.current, connections: connectionsRef.current, selectedNodeIds: Array.from(selectedNodeIdsRef.current) };
            const generationOps = safeOps.filter((op): op is Extract<CanvasAgentOp, { type: "run_generation" }> => op.type === "run_generation" && Boolean(op.nodeId));
            const promptPersistenceOps = generationOps.flatMap((op) => {
                const prompt = op.prompt?.trim();
                if (!prompt) return [];
                const alreadyPersisted = safeOps.some((candidate) => candidate.type === "update_node" && candidate.id === op.nodeId
                    && candidate.metadata?.composerContent === prompt && candidate.metadata?.prompt === prompt);
                return alreadyPersisted ? [] : [{ type: "update_node" as const, id: op.nodeId, metadata: { composerContent: prompt, prompt } }];
            });
            const referenceOps = generationOps.flatMap((op) => {
                const referenceNodeIds = [...new Set(op.referenceNodeIds || [])];
                if (!referenceNodeIds.length) return [];
                const nodeIds = new Set(before.nodes.map((node) => node.id));
                if (!nodeIds.has(op.nodeId)) throw new Error(`找不到生成节点：${op.nodeId}`);
                const missing = referenceNodeIds.filter((id) => !nodeIds.has(id));
                if (missing.length) throw new Error(`找不到参考节点：${missing.join(",")}`);
                const oldIds = before.connections
                    .filter((connection) => connection.toNodeId === op.nodeId)
                    .filter((connection) => before.nodes.find((node) => node.id === connection.fromNodeId)?.type !== "text")
                    .map((connection) => connection.id);
                return [
                    ...(oldIds.length ? [{ type: "delete_connections" as const, ids: oldIds }] : []),
                    ...referenceNodeIds.map((fromNodeId, order) => ({ type: "connect_nodes" as const, fromNodeId, toNodeId: op.nodeId, role: "reference", order })),
                ];
            });
            // 意图 → 显式后端 op；提交后本地按同一份 op 回放，不再用整图快照求差分。
            const plan = planCanvasAgentOperations(before, [...safeOps.filter((op) => op.type !== "run_generation"), ...promptPersistenceOps, ...referenceOps]);
            setAgentUndoSnapshot(before);
            const next = plan.operations.length ? useCanvasStore.getState().applyCanvasOperations(projectId, plan.operations) : null;
            const nodes = next?.nodes ?? nodesRef.current;
            const connections = next?.connections ?? connectionsRef.current;
            const selected = plan.selectedNodeIds.filter((id) => nodes.some((node) => node.id === id));
            nodesRef.current = nodes;
            connectionsRef.current = connections;
            selectedNodeIdsRef.current = new Set(selected);
            setSelectedNodeIds(new Set(selected));
            setSelectedConnectionId(null);
            setContextMenu(null);
            if (generationOps.length) {
                const uniqueGenerationOps = [...new Map(generationOps.map((op) => [op.nodeId, op])).values()];
                void flushCanvasSyncNow().then(() => {
                    uniqueGenerationOps.forEach((op) => {
                        const target = nodesRef.current.find((node) => node.id === op.nodeId);
                        const prompt = op.prompt?.trim() ? op.prompt : (target?.metadata?.composerContent ?? target?.metadata?.prompt ?? "");
                        void generateNodeRef.current?.(op.nodeId, op.mode || target?.metadata?.generationMode || "image", prompt);
                    });
                });
            }
            return { ...before, nodes, connections, selectedNodeIds: selected, viewport: undefined };
        },
        [projectTitle, projectId, setSelectedConnectionId, setContextMenu, setSelectedNodeIds],
    );
    const undoAgentOps = useCallback(() => {
        if (!agentUndoSnapshot) return null;
        nodesRef.current = agentUndoSnapshot.nodes;
        connectionsRef.current = agentUndoSnapshot.connections;
        selectedNodeIdsRef.current = new Set(agentUndoSnapshot.selectedNodeIds);
        setNodes(agentUndoSnapshot.nodes);
        setConnections(agentUndoSnapshot.connections);
        setSelectedNodeIds(new Set(agentUndoSnapshot.selectedNodeIds));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setAgentUndoSnapshot(null);
        return { ...agentUndoSnapshot, projectId, title: projectTitle, viewport: undefined };
    }, [agentUndoSnapshot, projectTitle, projectId]);

    useEffect(() => {
        setAgentCanvasContext({ snapshot: agentSnapshot, applyOps: applyAgentOps, undoOps: undoAgentOps, canUndo: Boolean(agentUndoSnapshot) });
        return () => setAgentCanvasContext(null);
    }, [agentSnapshot, applyAgentOps, agentUndoSnapshot, setAgentCanvasContext, undoAgentOps]);

    return { applyAgentOps };
}
