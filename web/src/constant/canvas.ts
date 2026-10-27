import { canvasNodeDefaultSize } from "@basketikun/canvas-agent/canvas/node-sizes";

import i18n from "@/i18n";
import { CanvasNodeType } from "@/types/canvas";
import type { CanvasNodeMetadata } from "@/types/canvas";
import { getNodeSpec as getRegistryNodeSpec } from "@/lib/canvas/node-registry";

type CanvasNodeSpec = {
    width: number;
    height: number;
    title: string;
    metadata?: CanvasNodeMetadata;
};

// 尺寸只有共享规格一个来源：浏览器、Backend 与 MCP 创建同类型节点必须得到同一个大小。
// 本文件只补本地化标题与初始 metadata。
export const NODE_DEFAULT_SIZE = {
    [CanvasNodeType.Image]: { ...canvasNodeDefaultSize(CanvasNodeType.Image), get title() { return i18n.t("canvas.nodeTypes.image"); } },
    [CanvasNodeType.Text]: { ...canvasNodeDefaultSize(CanvasNodeType.Text), get title() { return i18n.t("canvas.nodeTypes.text"); } },
    [CanvasNodeType.Config]: { ...canvasNodeDefaultSize(CanvasNodeType.Config), get title() { return i18n.t("canvas.nodeTypes.config"); } },
    [CanvasNodeType.Video]: { ...canvasNodeDefaultSize(CanvasNodeType.Video), get title() { return i18n.t("canvas.nodeTypes.video"); } },
    [CanvasNodeType.Audio]: { ...canvasNodeDefaultSize(CanvasNodeType.Audio), get title() { return i18n.t("canvas.nodeTypes.audio"); } },
    [CanvasNodeType.Loop]: { ...canvasNodeDefaultSize(CanvasNodeType.Loop), get title() { return i18n.t("canvas.nodeTypes.loop"); } },
    [CanvasNodeType.Group]: { ...canvasNodeDefaultSize(CanvasNodeType.Group), get title() { return i18n.t("canvas.nodeTypes.group"); } },
    [CanvasNodeType.Character]: { ...canvasNodeDefaultSize(CanvasNodeType.Character), get title() { return i18n.t("canvas.nodeTypes.character"); } },
    [CanvasNodeType.Scene]: { ...canvasNodeDefaultSize(CanvasNodeType.Scene), get title() { return i18n.t("canvas.nodeTypes.scene"); } },
    [CanvasNodeType.Prop]: { ...canvasNodeDefaultSize(CanvasNodeType.Prop), get title() { return i18n.t("canvas.nodeTypes.prop"); } },
} satisfies Record<CanvasNodeType, { width: number; height: number; title: string }>;

function nodeSpec(type: CanvasNodeType, metadata: CanvasNodeMetadata): CanvasNodeSpec {
    return {
        width: NODE_DEFAULT_SIZE[type].width,
        height: NODE_DEFAULT_SIZE[type].height,
        get title() { return NODE_DEFAULT_SIZE[type].title; },
        metadata,
    };
}

export const NODE_SPECS = {
    [CanvasNodeType.Image]: nodeSpec(CanvasNodeType.Image, { content: "", status: "idle" }),
    [CanvasNodeType.Text]: nodeSpec(CanvasNodeType.Text, { content: "", status: "idle", fontSize: 14 }),
    [CanvasNodeType.Config]: nodeSpec(CanvasNodeType.Config, { content: "", status: "idle", generationMode: "image", smart: true }),
    [CanvasNodeType.Video]: nodeSpec(CanvasNodeType.Video, { content: "", status: "idle" }),
    [CanvasNodeType.Audio]: nodeSpec(CanvasNodeType.Audio, { content: "", status: "idle" }),
    [CanvasNodeType.Loop]: nodeSpec(CanvasNodeType.Loop, { status: "idle", generationMode: "image", loopMode: "serial", loopMediaMode: "auto", loopPromptEnabled: false, loopImageEnabled: false, loopVideoEnabled: false, loopStart: 1, loopImageBatchSize: 1, loopVideoBatchSize: 1, loopAudioBatchSize: 1, loopPrompt: "" }),
    [CanvasNodeType.Group]: nodeSpec(CanvasNodeType.Group, { status: "idle" }),
    [CanvasNodeType.Character]: nodeSpec(CanvasNodeType.Character, { status: "idle", characterImages: [], characterPrimaryIndex: 0 }),
    [CanvasNodeType.Scene]: nodeSpec(CanvasNodeType.Scene, { status: "idle" }),
    [CanvasNodeType.Prop]: nodeSpec(CanvasNodeType.Prop, { status: "idle" }),
} satisfies Record<CanvasNodeType, CanvasNodeSpec>;

// Return built-in specs directly and resolve plugin types from the registry.
export function getNodeSpec(type: string) {
    if ((Object.values(CanvasNodeType) as string[]).includes(type)) return NODE_SPECS[type as CanvasNodeType];
    const spec = getRegistryNodeSpec(type);
    return { width: spec.width, height: spec.height, title: spec.title, metadata: spec.metadata };
}
