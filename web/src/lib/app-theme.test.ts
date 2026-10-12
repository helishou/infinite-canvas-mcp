import assert from "node:assert/strict";
import test from "node:test";
import { getAntThemeConfig } from "./app-theme";
import { canvasThemes } from "./canvas-theme";

function luminance(hex: string) {
    const rgb = hex.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(foreground: string, background: string) {
    const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    return (values[0] + 0.05) / (values[1] + 0.05);
}
for (const mode of ["light", "dark"] as const) {
    test(`${mode} studio text and primary controls meet normal-text contrast`, () => {
        const token = getAntThemeConfig(mode === "dark").token!;
        for (const foreground of [token.colorText!, token.colorTextSecondary!, token.colorTextPlaceholder!]) {
            for (const background of [token.colorBgBase!, token.colorBgContainer!, token.colorBgElevated!]) {
                assert.ok(contrast(foreground, background) >= 4.5, `${foreground} on ${background}`);
            }
        }
        assert.ok(contrast(token.colorTextLightSolid!, token.colorPrimary!) >= 4.5);
    });
    test(`${mode} canvas node text remains readable on its shared surfaces`, () => {
        const theme = canvasThemes[mode];
        for (const foreground of [theme.node.text, theme.node.muted, theme.node.faint]) {
            for (const background of [theme.node.fill, theme.node.panel, theme.canvas.background]) {
                assert.ok(contrast(foreground, background) >= 4.5, `${foreground} on ${background}`);
            }
        }
    });
}
