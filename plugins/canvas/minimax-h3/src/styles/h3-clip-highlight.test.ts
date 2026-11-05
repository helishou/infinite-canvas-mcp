import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// h3.css 里 .minimax-tl-clip.active 有 4+ 条同名规则，主题化那几条在后面把
// 早先醒目的红/蓝描边覆盖成 1px inset 阴影；而 .minimax-clip-media 铺满卡片又
// 把 inset 阴影和底色一起盖住，结果用户看到「选中的 Clip 完全没有高亮」。
// 这里按源码顺序解析真实层叠结果，锁住最后一次生效的声明。
const css = readFileSync(new URL("./h3.css", import.meta.url), "utf8");

function activeClipRules() {
    return [...css.matchAll(/([^{}]*\.minimax-tl-clip\.active[^{}]*)\{([^}]*)\}/g)]
        .map((match) => ({ selector: match[1].trim(), declarations: match[2] }));
}

test("选中 Clip 最终生效的是卡片外描边，不再被主题化 inset 规则盖掉", () => {
    const withShadow = activeClipRules().filter((rule) => /box-shadow\s*:/.test(rule.declarations));
    const last = withShadow.at(-1);
    assert.ok(last, "h3.css 缺少 .minimax-tl-clip.active 的 box-shadow 规则");
    const shadow = last.declarations.match(/box-shadow\s*:\s*([^;]+)/)?.[1] ?? "";
    assert.doesNotMatch(shadow, /inset/, "inset 阴影会被铺满卡片的 .minimax-clip-media 遮住");
    assert.match(shadow, /--h3-selection/, "选中描边必须使用画布选中色，而不是与底色近似的 --h3-active");
    assert.match(last.declarations, /z-index\s*:\s*[1-9]/, "描边需要抬高层级，否则被相邻卡片压住");
});

test("选中描边变量带 fallback，弹框/独立面板未继承 --h3-* 时仍可见", () => {
    const withShadow = activeClipRules().filter((rule) => /box-shadow\s*:/.test(rule.declarations));
    const last = withShadow.at(-1);
    assert.ok(last);
    assert.match(last.declarations, /var\(--h3-selection\s*,\s*#[0-9a-f]{6}\)/i);
    const themeSource = readFileSync(new URL("../h3-theme.ts", import.meta.url), "utf8");
    assert.match(themeSource, /"--h3-selection"\s*:\s*theme\.canvas/, "主题出口必须注入画布选中色，深浅主题才都可读");
});

// 拉远画布时视频行整排变成场记板图标、参考行图片却还在，是因为三个组件按
// ctx.scale < 0.2 卸载 <video>。工作台是 data-canvas-no-zoom 内容，画布缩放不改变
// 媒体实际屏幕尺寸；懒加载由 IntersectionObserver + preload="metadata" 负责。
test("画布拉远不卸载 H3 节点内的视频缩略图", () => {
    for (const file of ["H3ClipCard.tsx", "H3Timeline.tsx", "H3MaterialCard.tsx"]) {
        const source = readFileSync(new URL(`../components/${file}`, import.meta.url), "utf8");
        assert.doesNotMatch(source, /\bcompactMedia\b|ctx\.scale\s*</, `${file} 又按画布缩放卸载了媒体`);
    }
});
