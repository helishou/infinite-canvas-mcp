export type CanvasColorTheme = "light" | "dark";
export type CanvasBackgroundMode = "dots" | "lines" | "blank";

export const canvasThemes = {
    light: {
        canvas: {
            background: "#f6f5f0",
            dot: "rgba(68,64,60,.28)",
            line: "rgba(68,64,60,.12)",
            selectionStroke: "#2f80ff",
            selectionFill: "rgba(47,128,255,.10)",
        },
        node: {
            label: "#626b5c",
            fill: "#eaeae2",
            panel: "#fcfbf7",
            stroke: "#dddfd4",
            activeStroke: "#1c1917",
            linkActive: "#2563eb",
            placeholder: "#8a8479",
            text: "#30352e",
            muted: "#62695b",
            faint: "#62695b",
            generating: "#d97706",
            typeStroke: { character: "#7c3aed", scene: "#0f766e", prop: "#b45309", group: "#b45309" },
        },
        toolbar: {
            panel: "rgba(252,251,247,.96)",
            border: "#dddfd4",
            item: "#626b5c",
            itemHover: "#eaeae2",
            activeBg: "#eaeae2",
            activeText: "#30352e",
        },
    },
    dark: {
        canvas: {
            background: "#20231f",
            dot: "rgba(245,245,244,.24)",
            line: "rgba(245,245,244,.10)",
            selectionStroke: "#60a5fa",
            selectionFill: "rgba(96,165,250,.16)",
        },
        node: {
            label: "#adb5a5",
            fill: "#30352d",
            panel: "#272b25",
            stroke: "#3c4436",
            activeStroke: "#fafaf9",
            linkActive: "#60a5fa",
            placeholder: "#a8a29e",
            text: "#e9ece3",
            muted: "#adb5a5",
            faint: "#a1ad98",
            generating: "#fbbf24",
            typeStroke: { character: "#c4b5fd", scene: "#5eead4", prop: "#fbbf24", group: "#fbbf24" },
        },
        toolbar: {
            panel: "rgba(39,43,37,.96)",
            border: "#3c4436",
            item: "#adb5a5",
            itemHover: "#30352e",
            activeBg: "#384332",
            activeText: "#e9ece3",
        },
    },
} as const;

export type CanvasTheme = (typeof canvasThemes)[CanvasColorTheme];
