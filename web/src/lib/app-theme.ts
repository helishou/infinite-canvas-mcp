import type { ThemeConfig } from "antd";
import { theme as antdTheme } from "antd";

import { canvasThemes } from "./canvas-theme";

const neutral = {
    light: {
        primary: "#4e6048",
        primaryHover: "#3c4f35",
        primaryText: "#ffffff",
        elevatedBg: "#fcfbf7",
        itemHoverBg: "rgba(23, 23, 23, 0.06)",
        itemSelectedBg: "rgba(23, 23, 23, 0.1)",
        itemSelectedHoverBg: "rgba(23, 23, 23, 0.14)",
        itemText: "#30352e",
        tableSelectedBg: "rgba(17, 17, 17, 0.05)",
        tableSelectedHoverBg: "rgba(17, 17, 17, 0.08)",
    },
    dark: {
        primary: "#c1cfa3",
        primaryHover: "#ffffff",
        primaryText: "#20271c",
        elevatedBg: "#2b3028",
        itemHoverBg: "rgba(250, 250, 249, 0.08)",
        itemSelectedBg: "rgba(250, 250, 249, 0.12)",
        itemSelectedHoverBg: "rgba(250, 250, 249, 0.16)",
        itemText: "#e9ece3",
        tableSelectedBg: "rgba(255, 255, 255, 0.08)",
        tableSelectedHoverBg: "rgba(255, 255, 255, 0.12)",
    },
};

export function getAntThemeConfig(dark: boolean): ThemeConfig {
    const color = dark ? neutral.dark : neutral.light;
    // antd 的容器、文本与次级边框与画布主题同源，避免两套色板手工同步后漂移。
    const canvas = canvasThemes[dark ? "dark" : "light"];

    return {
        algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        cssVar: { key: dark ? "infinite-canvas-dark" : "infinite-canvas-light" },
        token: {
            fontFamily: "var(--font-sans)",
            fontSize: 14,
            fontSizeSM: 12,
            fontWeightStrong: 600,
            lineHeight: 22 / 14,
            lineHeightSM: 18 / 12,
            borderRadius: 6,
            borderRadiusLG: 12,
            controlHeight: 36,
            controlHeightSM: 32,
            controlHeightLG: 44,
            colorBgBase: canvas.canvas.background,
            colorBgContainer: canvas.node.panel,
            colorBgLayout: canvas.canvas.background,
            colorText: canvas.node.text,
            colorTextSecondary: canvas.node.muted,
            colorTextPlaceholder: dark ? "#929c89" : "#62695b",
            colorBorder: dark ? "#4b5643" : "#cdd1c3",
            colorBorderSecondary: canvas.node.stroke,
            colorPrimary: color.primary,
            colorInfo: color.primary,
            // antd 默认 error 色在深色底（#272b25）上只有 3.4:1，删除类文字按钮读不清。
            // antd 6 没有独立的 colorErrorText，文字色由 colorError 派生（约压暗到四分之三亮度），
            // 所以这里给的值要比目标色再亮一档；断言见 app-theme.test.ts。
            colorError: dark ? "#ff8a87" : "#cf1322",
            colorLink: color.primary,
            colorLinkHover: color.primaryHover,
            colorLinkActive: color.primary,
            colorTextLightSolid: color.primaryText,
            colorBgElevated: color.elevatedBg,
            controlItemBgHover: color.itemHoverBg,
            controlItemBgActive: color.itemSelectedBg,
            controlItemBgActiveHover: color.itemSelectedHoverBg,
        },
        components: {
            Button: {
                fontWeight: 400,
                primaryShadow: "none",
            },
            Dropdown: {
                colorBgElevated: color.elevatedBg,
                colorText: color.itemText,
                controlItemBgHover: color.itemHoverBg,
                controlItemBgActive: color.itemSelectedBg,
                controlItemBgActiveHover: color.itemSelectedHoverBg,
            },
            Menu: {
                popupBg: color.elevatedBg,
                itemActiveBg: color.itemSelectedBg,
                itemHoverBg: color.itemHoverBg,
                itemSelectedBg: color.itemSelectedBg,
                itemSelectedColor: color.itemText,
                darkPopupBg: neutral.dark.elevatedBg,
                darkItemHoverBg: neutral.dark.itemHoverBg,
                darkItemSelectedBg: neutral.dark.itemSelectedBg,
                darkItemSelectedColor: neutral.dark.itemText,
            },
            Select: {
                optionActiveBg: color.itemHoverBg,
                optionSelectedBg: color.itemSelectedBg,
                optionSelectedFontWeight: 500,
                optionSelectedColor: color.itemText,
            },
            Table: {
                rowSelectedBg: color.tableSelectedBg,
                rowSelectedHoverBg: color.tableSelectedHoverBg,
            },
        },
    };
}
