import { FileText, Group, Image as ImageIcon, Music2, Settings2, User, Video } from "lucide-react";

import i18n from "@/i18n";

import { NODE_SPECS } from "@/constant/canvas";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import { getPluginRuntime } from "@/lib/canvas/plugin-runtime";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { CanvasNodeDefinition, CanvasNodeResource } from "@/types/canvas-plugin";
import { h3SystemDefinition } from "../../../../../plugins/canvas/minimax-h3/src/system";
import "../../../../../plugins/canvas/minimax-h3/src/styles/h3.css";

// Extensible metadata for built-in nodes, reusing NODE_SPECS for size and initial metadata.
// Rendering remains in canvas-node's internal renderer, so no Content component is provided.
function builtinResource(node: CanvasNodeData): CanvasNodeResource | null | CanvasNodeResource[] {
    if (node.type === CanvasNodeType.Image && node.metadata?.content) return { kind: "image", url: node.metadata.content };
    if (node.type === CanvasNodeType.Video && node.metadata?.content) return { kind: "video", url: node.metadata.content };
    if (node.type === CanvasNodeType.Audio && node.metadata?.content) return { kind: "audio", url: node.metadata.content };
    if (node.type === CanvasNodeType.Text && (node.metadata?.content || node.metadata?.prompt)) return { kind: "text", text: node.metadata.content || node.metadata.prompt };
    if (node.type === CanvasNodeType.Character) {
        // 角色节点被拖到下游 ref 槽时，展开为每张参考图一个 image 资源
        const images = node.metadata?.characterImages || [];
        return images
            .filter((image) => image.url)
            .map((image) => ({ kind: "image", url: image.url, storageKey: image.storageKey, text: image.outfit || image.name }));
    }
    return null;
}

const iconClass = "size-5";

const BUILTIN_DEFINITIONS: CanvasNodeDefinition[] = ([
    { type: CanvasNodeType.Text, title: i18n.t("assets.kinds.text"), icon: <FileText className={iconClass} />, minimapColor: undefined, resource: builtinResource },
    { type: CanvasNodeType.Image, title: i18n.t("assets.kinds.image"), icon: <ImageIcon className={iconClass} />, minimapColor: "#10b981", keepAspectRatio: (node: CanvasNodeData) => !node.metadata?.freeResize, resource: builtinResource },
    { type: CanvasNodeType.Video, title: i18n.t("assets.kinds.video"), icon: <Video className={iconClass} />, minimapColor: "#f97316", keepAspectRatio: () => true, resource: builtinResource },
    { type: CanvasNodeType.Audio, title: i18n.t("assets.kinds.audio"), icon: <Music2 className={iconClass} />, minimapColor: "#a855f7", resource: builtinResource },
    { type: CanvasNodeType.Config, title: i18n.t("canvas.configNode.title"), icon: <Settings2 className={iconClass} />, minimapColor: "#60a5fa", hasSourceHandle: false },
    { type: CanvasNodeType.Group, title: i18n.t("canvas.node.group"), icon: <Group className={iconClass} />, minimapColor: "#94a3b8" },
    { type: CanvasNodeType.Character, title: i18n.t("assets.kinds.character"), icon: <User className={iconClass} />, minimapColor: "#f43f5e", resource: builtinResource },
    h3SystemDefinition as unknown as CanvasNodeDefinition,
] as Array<Partial<CanvasNodeDefinition> & { type: string }>).map((def) => {
    const spec = NODE_SPECS[def.type as CanvasNodeType];
    return (spec ? { ...def, title: spec.title, defaultSize: { width: spec.width, height: spec.height }, defaultMetadata: spec.metadata } : def) as CanvasNodeDefinition;
});

let registered = false;
export function registerBuiltinNodes() {
    if (registered) return;
    registered = true;
    // H3 still imports the SDK's React hook bridge. Initialize the host runtime
    // before React renders the system node, just as the plugin loader does.
    getPluginRuntime();
    registerNodeDefinitions(BUILTIN_DEFINITIONS, "builtin");
}
