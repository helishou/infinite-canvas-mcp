/**
 * 拆镜引用清单命名的行为测试。
 *
 * 真实事故：ep1 拆镜产出的 prop_ids 全空（0/18），参考图一个道具都绑不上。
 * 根因是 asset_cards 只有 prompt 长描述、没有 name，pipeline 拿 prompt 当名字，
 * 模型看到的是「一条通体乌黑的金属长鞭，由多节铁节相连而成……」，对不上「铁鞭」。
 * 道具名真值在 asset_plan.asset_name。修复后实测 prop_ids 9/17。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { characterRefsOf, planNameIndex, propRefsOf } from "./shot-refs.js";

test("道具名回查 asset_plan：asset_cards 没有 name 时也能取到真名", () => {
    const source = {
        asset_plan: [
            { id: "asset-prop-a", kind: "prop", asset_name: "铁鞭", description: "乌黑金属长鞭" },
            { id: "asset-prop-b", kind: "prop", asset_name: "悬赏告示", description: "泛黄黄纸" },
        ],
        asset_cards: [
            { id: "asset-prop-a", asset_kind: "prop", prompt: "一条通体乌黑的金属长鞭，由多节铁节相连而成，鞭身粗实带有金属磨损痕迹" },
            { id: "asset-prop-b", asset_kind: "prop", prompt: "张贴在城中木板墙上的粗糙黄纸告示，纸面边缘微微卷曲" },
        ],
    };
    const refs = propRefsOf(source);
    assert.deepEqual(refs, [
        { id: "asset-prop-a", name: "铁鞭" },
        { id: "asset-prop-b", name: "悬赏告示" },
    ]);
});

test("卡片自带 name 时优先用它，不被 asset_plan 覆盖", () => {
    const source = {
        asset_plan: [{ id: "asset-prop-a", asset_name: "铁鞭" }],
        asset_cards: [{ id: "asset-prop-a", asset_kind: "prop", name: "九节铁鞭" }],
    };
    assert.equal(propRefsOf(source)[0].name, "九节铁鞭");
});

test("名字实在没有时退回 prompt 前 12 字，绝不返回空名", () => {
    const source = { asset_cards: [{ id: "asset-prop-x", asset_kind: "prop", prompt: "一柄古朴的单手长剑剑身修长笔直" }] };
    const refs = propRefsOf(source);
    assert.equal(refs.length, 1);
    assert.ok(refs[0].name.length > 0);
    assert.ok(refs[0].name.length <= 12);
});

test("连 prompt 都没有时落回 id，name 不为空", () => {
    const refs = propRefsOf({ asset_cards: [{ id: "asset-prop-z", asset_kind: "prop" }] });
    assert.equal(refs[0].name, "asset-prop-z");
});

test("只收 kind=prop 的卡，角色/场景卡不进道具清单", () => {
    const source = {
        asset_cards: [
            { id: "asset-prop-a", asset_kind: "prop", name: "铁鞭" },
            { id: "asset-character-b", asset_kind: "character", name: "崇良" },
            { id: "asset-scene-c", asset_kind: "scene", name: "南漳城内" },
        ],
    };
    const refs = propRefsOf(source);
    assert.deepEqual(refs.map(item => item.id), ["asset-prop-a"]);
});

test("没有 asset_plan 时仍能从卡片 name 取到道具", () => {
    const refs = propRefsOf({ asset_cards: [{ id: "p1", kind: "prop", price: 0, name: "长剑" }] });
    assert.deepEqual(refs, [{ id: "p1", name: "长剑" }]);
});

test("角色清单：id 或名字缺失的条目被丢弃，不造假", () => {
    const refs = characterRefsOf({
        character_registry: [
            { id: "entity-character-a", name: "崇良" },
            { id: "", name: "无名" },
            { id: "entity-character-c", name: "" },
            { id: "entity-character-d", characterName: "朴素女子" },
        ],
    });
    assert.deepEqual(refs, [
        { id: "entity-character-a", name: "崇良" },
        { id: "entity-character-d", name: "朴素女子" },
    ]);
});

test("空输入不抛异常，返回空清单", () => {
    assert.deepEqual(propRefsOf(null), []);
    assert.deepEqual(propRefsOf({}), []);
    assert.deepEqual(characterRefsOf(undefined), []);
    assert.equal(planNameIndex(null).size, 0);
});

test("asset_plan 同时用 id/asset_id 与 asset_name/name 两种写法都能识别", () => {
    const index = planNameIndex([
        { id: "a", asset_name: "铁鞭" },
        { asset_id: "b", name: "长剑" },
    ]);
    assert.equal(index.get("a"), "铁鞭");
    assert.equal(index.get("b"), "长剑");
});
