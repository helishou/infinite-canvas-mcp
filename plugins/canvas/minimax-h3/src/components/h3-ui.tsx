import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";

export const buttonStyle = (ctx: CanvasNodeContext, active = false) => ({
    border: `1px solid ${active ? ctx.theme.toolbar.activeText : ctx.theme.node.stroke}`,
    borderRadius: 8,
    background: active ? ctx.theme.toolbar.activeBg : ctx.theme.toolbar.panel,
    color: active ? ctx.theme.toolbar.activeText : ctx.theme.node.text,
    padding: "6px 9px",
    cursor: "pointer",
    fontSize: 11,
    fontWeight: 700,
});

export function Toggle({ ctx, label, value, onChange }: { ctx: CanvasNodeContext; label: string; value: boolean; onChange: (value: boolean) => void }) {
    return <button type="button" onClick={() => onChange(!value)} style={buttonStyle(ctx, value)}>{value ? "●" : "○"} {label}</button>;
}
