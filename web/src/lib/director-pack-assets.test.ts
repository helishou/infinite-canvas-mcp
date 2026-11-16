import assert from "node:assert/strict";
import test from "node:test";

import { packEpisodeTag, packGroupOf, packGroupTag } from "./director-pack-assets";

const EP = "episode-abc";

test("段号标签能解析回来", () => {
    const asset = { tags: ["导演包", packEpisodeTag(EP), packGroupTag(EP, 7)] };
    assert.equal(packGroupOf(asset, EP), 7);
});

test("别的集的导演包资产不算", () => {
    const other = { tags: ["导演包", packEpisodeTag("episode-xyz"), packGroupTag("episode-xyz", 3)] };
    assert.equal(packGroupOf(other, EP), null);
});

test("普通图片资产 / 无标签不会误判", () => {
    assert.equal(packGroupOf({ tags: ["海报"] }, EP), null);
    assert.equal(packGroupOf({}, EP), null);
    assert.equal(packGroupOf({ tags: [packEpisodeTag(EP)] }, EP), null, "只有集标签没有段号 → 不算");
});

test("段号 1 与 10 不会串（前缀必须带冒号）", () => {
    assert.equal(packGroupOf({ tags: [packGroupTag(EP, 1)] }, EP), 1);
    assert.equal(packGroupOf({ tags: [packGroupTag(EP, 10)] }, EP), 10);
});
