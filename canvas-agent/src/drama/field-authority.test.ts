import assert from "node:assert/strict";
import test from "node:test";

import { CLIP_FIELD_AUTHORITY, fieldEntry, protectedClipFields, protectedNodeFields, withFieldEntry } from "./field-authority.js";

test("画布侧禁止直改的 Clip 字段名单被钉死", () => {
    // 名单变动会放宽画布写入权，必须同时改 h3 守卫与 backend 投影保护，不允许悄悄漂。
    assert.deepEqual(protectedClipFields().sort(), [
        "directorEngine", "directorSourceHash", "prompt",
        "referenceBindings", "storyboardInput", "storyboardShots",
    ]);
});

test("节点 metadata 层的投影保护只含 Backend 投影字段，不混进 Clip 名单", () => {
    assert.deepEqual(protectedNodeFields().sort(), ["directorEngine", "directorSourceHash", "productionClipProjection"]);
    // productionClipProjection 是节点层字段：混进 Clip patch 名单会误拒正常的 Clip 编辑。
    assert.equal(protectedClipFields().includes("productionClipProjection"), false);
});

test("编译身份类字段归 Backend 投影，不是源稿字段", () => {
    for (const field of ["directorEngine", "directorSourceHash", "productionClipProjection"]) {
        assert.equal(CLIP_FIELD_AUTHORITY[field].owner, "backend-projection", field);
    }
});

test("每个字段都写了可执行的正确入口", () => {
    for (const [field, value] of Object.entries(CLIP_FIELD_AUTHORITY)) {
        assert.ok(value.entry.trim().length > 10, `${field} 缺少可执行的入口说明`);
    }
});

test("续接配置允许两侧编辑，不算受保护字段", () => {
    for (const field of ["tailFrameContinuation", "motionContextEnabled", "videoContinuation"]) {
        assert.equal(CLIP_FIELD_AUTHORITY[field].owner, "either", field);
        assert.equal(protectedClipFields().includes(field), false, field);
    }
});

test("报错补齐入口：已知字段追加路线，未知字段保持原样", () => {
    assert.equal(fieldEntry("not-a-field"), "");
    assert.equal(withFieldEntry("not-a-field", "原报错"), "原报错");
    const decorated = withFieldEntry("storyboardShots", "FORMAL_CLIP_OWNED: 正式 Clip 的 storyboardShots 由编译投影维护");
    assert.match(decorated, /^FORMAL_CLIP_OWNED/);
    assert.match(decorated, /改这个字段请走：/);
    assert.match(decorated, /replace_director_clip_storyboard/);
});
