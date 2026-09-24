// HTML 节点:沙箱 iframe 渲染 HTML,{{input}} 会替换为上游文本节点内容。
// 交互:预览态 iframe 默认 pointer-events:none —— 鼠标事件穿透到宿主节点体,
// 因此点节点任意位置都能拖动,无需在节点上加任何标题栏/按钮。
// 「编辑/预览」与「交互」开关都放在节点外的悬浮工具条(toolbar 扩展点)；编辑态仅存当前窗口视图。
import { definePlugin, useMemo, useSyncExternalStore } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContentProps, CanvasNodeContext } from "@infinite-canvas/plugin-sdk";

function HtmlEditor({ ctx }: { ctx: CanvasNodeContentProps["ctx"] }) {
    const TextEditor = ctx.TextEditor;
    return (
        <div data-canvas-no-zoom style={{ height: "100%", width: "100%", overflow: "hidden", borderRadius: 16, background: ctx.theme.node.fill }}>
            <TextEditor
                projectId={ctx.projectId}
                target={{ nodeId: ctx.node.id, field: "content" }}
                autoFocus
                placeholder="<div>Hello, {{input}}</div>"
                onEscape={() => ctx.view.update({ editing: false })}
                style={{ height: "100%", width: "100%", boxSizing: "border-box", padding: 16, fontFamily: "monospace", fontSize: 12, lineHeight: "20px", color: ctx.theme.node.text }}
            />
        </div>
    );
}

function HtmlContent({ ctx }: CanvasNodeContentProps) {
    const value = ctx.node.metadata?.content || "";
    const editing = useSyncExternalStore(ctx.view.subscribe, () => Boolean(ctx.view.getSnapshot().editing));
    const upstreamText = useMemo(
        () =>
            ctx
                .getUpstream()
                .map((node) => node.metadata?.content)
                .filter(Boolean)
                .join("\n"),
        [ctx],
    );
    const html = value.replace(/\{\{\s*input\s*\}\}/g, upstreamText);

    if (editing) {
        return <HtmlEditor ctx={ctx} />;
    }

    if (!value) {
        return (
            <div style={{ height: "100%", width: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, color: ctx.theme.node.placeholder }}>
                <span style={{ fontSize: 26 }}>{"</>"}</span>
                <span style={{ fontSize: 13 }}>选中节点,点上方工具条的 ✎ 编辑 HTML</span>
            </div>
        );
    }

    // 预览态:iframe 的鼠标交互由宿主「交互 ⇄ 移动」开关统一控制(见 interactionToggle),
    // 这里无需再手动做 pointer-events 穿透。data-canvas-no-zoom 保证交互时滚动作用于页面而非缩放画布。
    return (
        <div data-canvas-no-zoom style={{ position: "relative", height: "100%", width: "100%" }}>
            <iframe
                title="html-preview"
                sandbox="allow-scripts allow-forms"
                srcDoc={html}
                style={{ height: "100%", width: "100%", border: 0, borderRadius: 16, background: "#fff", display: "block" }}
            />
        </div>
    );
}

const isEditing = (ctx: CanvasNodeContext) => Boolean(ctx.view.getSnapshot().editing);

export default definePlugin({
    id: "html",
    name: "HTML 节点",
    version: "1.2.0",
    description: "沙箱 iframe 渲染 HTML,支持 {{input}} 注入上游文本",
    nodes: [
        {
            type: "html:render",
            title: "HTML",
            icon: "🌐",
            description: "沙箱渲染 HTML",
            defaultSize: { width: 420, height: 320 },
            defaultMetadata: { content: "" },
            minimapColor: "#ec4899",
            hidePanel: true, // 纯展示型节点:点击/新建不弹出下方生图面板
            // 宿主统一提供「交互 ⇄ 移动」开关;编辑态强制可交互(编辑器始终可操作)并隐藏该开关
            interactionToggle: true,
            forceInteractive: (_node, view) => Boolean(view.editing),
            Content: HtmlContent,
            // 仅保留「编辑/预览」开关;交互/移动 由宿主自动注入
            toolbar: (ctx) => {
                const editing = isEditing(ctx);
                return [
                    {
                        id: "html-toggle-edit",
                        title: editing ? "预览渲染结果" : "编辑 HTML 源码",
                        label: editing ? "预览" : "编辑",
                        icon: editing ? "👁" : "✎",
                        active: editing,
                        onClick: () => ctx.view.update({ editing: !editing }),
                    },
                ];
            },
        },
    ],
});
