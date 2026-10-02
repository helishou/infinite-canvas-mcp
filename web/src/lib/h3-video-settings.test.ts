import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "@/stores/use-config-store";
import { h3VideoSettingChanges, resolveH3VideoSettings } from "./h3-video-settings";

test("720/480 竖屏映射到 V15 真实比例、MP 和 latent 网格", () => {
    const portrait = { ...defaultConfig, size: "720x1280", videoSeconds: "6", vquality: "480" };
    const effective = resolveH3VideoSettings(portrait);
    assert.deepEqual(effective.fields, { duration: 6, aspect_ratio: "9:16 (Portrait Widescreen)", megapixels: 0.9 });
    assert.deepEqual(effective.parameters, { size: "736x1280", resolution: "736", seconds: "6" });
    assert.deepEqual(resolveH3VideoSettings({ ...portrait, size: "9:16" }), effective);
    const changed = h3VideoSettingChanges(portrait, "vquality", "480");
    assert.deepEqual(changed, { vquality: "480", size: "480x853" });
    assert.deepEqual(h3VideoSettingChanges({ ...portrait, size: "9:16" }, "vquality", "480"), changed);
    assert.equal(resolveH3VideoSettings({ ...portrait, ...changed }).parameters.size, "480x864");
});

test("尺寸预设同步清晰度；横屏、方形、宽屏使用各自实际输入", () => {
    assert.deepEqual(h3VideoSettingChanges(defaultConfig, "size", "720x1280"), { size: "720x1280", vquality: "720" });
    assert.equal(resolveH3VideoSettings({ ...defaultConfig, size: "1280x720", videoSeconds: "10" }).parameters.size, "1280x736");
    assert.equal(resolveH3VideoSettings({ ...defaultConfig, size: "1024x1024" }).parameters.size, "1024x1024");
    assert.equal(resolveH3VideoSettings({ ...defaultConfig, size: "1792x1024" }).parameters.size, "1792x1024");
});

test("自动尺寸：首帧沿原图比例，文生使用工作流比例，清晰度仍生效", () => {
    const config = { ...defaultConfig, size: "auto", vquality: "480", videoSeconds: "12" };
    const image = resolveH3VideoSettings(config, { originalRatio: true, referenceDimensions: { width: 900, height: 1600 } });
    assert.equal(image.fields.aspect_ratio, "原图比例");
    assert.equal(image.parameters.size, "480x864");
    const text = resolveH3VideoSettings(config, { aspectRatio: "16:9 (Widescreen)" });
    assert.equal(text.parameters.size, "864x480");
});

test("H3 不接受超过15秒、小于1秒或非整数时长", () => {
    for (const value of ["0", "16", "20", "6.5", "-1"]) assert.throws(() => resolveH3VideoSettings({ ...defaultConfig, videoSeconds: value }), /h3-duration/);
    assert.equal(resolveH3VideoSettings({ ...defaultConfig, videoSeconds: "15" }).parameters.seconds, "15");
});
