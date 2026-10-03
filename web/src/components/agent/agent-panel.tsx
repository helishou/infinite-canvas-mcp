import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";

import { LocalAgentPanel } from "./local-agent-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { CANVAS_AGENT_PANEL_MOTION_MS, useAgentStore } from "@/stores/use-agent-store";
import { useThemeStore } from "@/stores/use-theme-store";

const PANEL_MOTION_SECONDS = CANVAS_AGENT_PANEL_MOTION_MS / 1000;

export function AgentPanel() {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const width = useAgentStore((state) => state.width);
    const [resizing, setResizing] = useState(false);
    const panelMounted = useAgentStore((state) => state.panelMounted);
    const panelOpen = useAgentStore((state) => state.panelOpen);
    const panelClosing = useAgentStore((state) => state.panelClosing);
    const setAgentState = useAgentStore((state) => state.setAgentState);
    const closePanel = useAgentStore((state) => state.closePanel);
    const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches);
    useEffect(() => {
        const media = window.matchMedia("(max-width: 767px)");
        const update = () => setNarrow(media.matches);
        update();
        media.addEventListener("change", update);
        return () => media.removeEventListener("change", update);
    }, []);
    useEffect(() => {
        if (!narrow || !panelOpen) return;
        const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") closePanel(); };
        window.addEventListener("keydown", closeOnEscape);
        return () => window.removeEventListener("keydown", closeOnEscape);
    }, [narrow, panelOpen, closePanel]);
    const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = width;
        let nextWidth = startWidth;
        const onMove = (moveEvent: PointerEvent) => {
            nextWidth = Math.min(760, Math.max(360, startWidth + startX - moveEvent.clientX));
            setAgentState({ width: nextWidth });
        };
        const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            setResizing(false);
        };
        setResizing(true);
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    return (
        <motion.div
            className={narrow ? "fixed inset-0 z-[70] flex h-dvh items-end justify-center" : "relative z-[70] flex h-full shrink-0"}
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: panelOpen ? (narrow ? window.innerWidth : width + 1) : 0, opacity: panelOpen ? 1 : 0 }}
            transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
            onClick={event => { if (narrow && event.target === event.currentTarget) closePanel(); }}
            style={{ overflow: "clip", maxWidth: "100dvw", pointerEvents: panelOpen && !panelClosing ? undefined : "none", background: narrow && panelOpen ? "rgba(0,0,0,.48)" : "transparent" }}
        >
            <motion.aside
                className={`relative flex shrink-0 flex-col border-l ${narrow ? "max-h-[88dvh] self-end rounded-t-2xl border-l-0 border-t" : "h-full"}`}
                data-canvas-shortcuts-ignore
                role={narrow && panelOpen ? "dialog" : undefined}
                aria-modal={narrow && panelOpen ? true : undefined}
                aria-label={narrow && panelOpen ? "Agent" : undefined}
                aria-hidden={!panelOpen}
                inert={!panelOpen}
                initial={{ x: 48 }}
                animate={{ x: panelClosing ? 28 : 0 }}
                transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
                style={{ width: narrow ? Math.min(window.innerWidth, 600) : width, height: narrow ? Math.min(window.innerHeight * .88, 720) : "100%", maxWidth: "100dvw", display: panelMounted || panelClosing ? "flex" : "none", background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
            >
                {!narrow && <button type="button" className="absolute inset-y-0 left-0 z-40 w-4 -translate-x-1/2 cursor-col-resize" onPointerDown={startResize} aria-label={t("agent.panel.resize")} />}
                <LocalAgentPanel embedded headless={!panelMounted} autoConnect />
            </motion.aside>
        </motion.div>
    );
}
