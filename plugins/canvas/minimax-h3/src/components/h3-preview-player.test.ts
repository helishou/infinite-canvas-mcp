import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, test } from "node:test";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { H3PreviewPlayer } from "./H3WorkbenchPrimitives";

// Render with the host's React singleton, as the plugin SDK does in the browser.
const require = createRequire(new URL("../../../../../web/package.json", import.meta.url));
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const runtimeGlobal = globalThis as unknown as { InfiniteCanvasRuntime?: unknown };
const previousRuntime = runtimeGlobal.InfiniteCanvasRuntime;
runtimeGlobal.InfiniteCanvasRuntime = { React };
after(() => { runtimeGlobal.InfiniteCanvasRuntime = previousRuntime; });

function renderPlayer(livePreview = false, kind = "video") {
    return renderToStaticMarkup(React.createElement(H3PreviewPlayer, {
        ctx: { node: { metadata: {} } } as unknown as CanvasNodeContext,
        url: "data:video/mp4;base64,AA==",
        kind,
        playhead: 12,
        timelineOffset: 10,
        playToken: 0,
        playRequest: 0,
        livePreview,
    })) as string;
}

test("实时视频预览仅活动槽自动播放、循环且默认静音", () => {
    const videos = renderPlayer(true).match(/<video\b[^>]*>/g) || [];
    assert.equal(videos.length, 2);
    assert.match(videos[0], /\bautoplay=""/i);
    assert.match(videos[0], /\bloop=""/i);
    assert.match(videos[0], /\bmuted=""/i);
    assert.doesNotMatch(videos[1], /\b(?:autoplay|loop)=""/i);
});

test("普通成片预览保持手动起播，不自动循环", () => {
    const videos = renderPlayer().match(/<video\b[^>]*>/g) || [];
    assert.equal(videos.length, 2);
    videos.forEach((video) => assert.doesNotMatch(video, /\b(?:autoplay|loop)=""/i));
});

test("实时图片预览不创建自动播放的视频槽", () => {
    const html = renderPlayer(true, "image");
    assert.match(html, /<img\b/);
    assert.doesNotMatch(html, /<video\b/);
});
