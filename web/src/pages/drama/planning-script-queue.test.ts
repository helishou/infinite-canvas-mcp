import assert from "node:assert/strict";
import test from "node:test";
import type { DramaEpisode } from "@/services/backend-api";
import { batchFailure, episodeHasScript, pendingScriptEpisodes, SCRIPT_SYNOPSIS_THRESHOLD, writtenScriptCount } from "./planning-script-queue";

const episode = (episodeNumber: number, fullPlot = "", synopsis = ""): DramaEpisode => ({
    id: `ep-${episodeNumber}`, dramaId: "d", episodeNumber, title: `第${episodeNumber}集`, synopsis, fullPlot,
    canvasId: null, createdAt: "", updatedAt: "",
});

test("只排没写剧本大纲的集，并且按集号升序", () => {
    const list = [episode(3), episode(1, "已经写了"), episode(2), episode(10, "也有")];
    assert.deepEqual(pendingScriptEpisodes(list).map((item) => item.episodeNumber), [2, 3]);
});

test("全是空白也算没写", () => {
    assert.deepEqual(pendingScriptEpisodes([episode(1, "   \n ")]).map((item) => item.episodeNumber), [1]);
});

test("已写集数用来看还剩几集", () => {
    assert.equal(writtenScriptCount([episode(1, "a"), episode(2), episode(3, " c ")]), 2);
    assert.equal(pendingScriptEpisodes([]).length, 0);
});

test("失败提示点名哪一集，不把整批说成失败", () => {
    assert.equal(batchFailure(4, "模型返回了空内容"), "第 4 集没写成：模型返回了空内容");
});

test("老数据把整份剧本塞在简介里，够长也算写过，不会被重写覆盖", () => {
    const longSynopsis = "字".repeat(SCRIPT_SYNOPSIS_THRESHOLD);
    assert.equal(episodeHasScript({ fullPlot: "", synopsis: longSynopsis }), true);
    assert.equal(episodeHasScript({ fullPlot: "", synopsis: "一句话简介" }), false);
    assert.equal(episodeHasScript({ fullPlot: "场1｜…", synopsis: "" }), true);
    assert.deepEqual(pendingScriptEpisodes([episode(1, "", longSynopsis), episode(2, "", "短短一句")]).map((item) => item.episodeNumber), [2]);
});
