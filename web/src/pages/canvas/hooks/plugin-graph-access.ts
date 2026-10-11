import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";
import type { CanvasGraphIndex } from "@/lib/canvas/canvas-graph-index";

type Snapshot = { nodes: CanvasNodeData[]; connections: CanvasConnection[] };

/** Keep plugin snapshot ownership and connection-array order while sharing the canvas index. */
export function createPluginGraphAccess(
    readProject: () => Snapshot | undefined,
    readLive: () => Snapshot,
    selectIndex: (nodes: CanvasNodeData[], connections: CanvasConnection[]) => CanvasGraphIndex,
) {
    const liveIndex = () => {
        const { nodes, connections } = readLive();
        return selectIndex(nodes, connections);
    };
    return {
        getNode: (id: string) => {
            const project = readProject();
            return project ? selectIndex(project.nodes, project.connections).nodeById.get(id) || null : null;
        },
        getNodes: () => readProject()?.nodes || [],
        getConnections: () => readProject()?.connections || [],
        getUpstream: (nodeId: string) => {
            const index = liveIndex();
            // A self-loop appears twice in connectionsByNodeId. The old filter returned it once.
            const links = new Set(index.connectionsByNodeId.get(nodeId) || []);
            return [...links].filter((link) => link.toNodeId === nodeId).map((link) => index.nodeById.get(link.fromNodeId)!);
        },
        getDownstream: (nodeId: string) => [...(liveIndex().outgoingByNodeId.get(nodeId) || [])],
    };
}
