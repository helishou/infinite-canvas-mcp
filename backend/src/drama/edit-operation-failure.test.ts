import test from "node:test";
import assert from "node:assert/strict";

import { EpisodeProductionService } from "./production.js";

/** editOperationFailure 只做定位与措辞，不访问数据库；用原型对象即可验证。 */
const service = Object.create(EpisodeProductionService.prototype) as EpisodeProductionService;
const failureOf = (operation: unknown, index: number, error: unknown) => (service as any).editOperationFailure(operation, index, error) as {
    message: string; opIndex: number; opType: string; fieldPath?: string; unexpectedKeys?: string[];
};

test("edit operation failures name the operation, field and unexpected keys", () => {
    const failure = failureOf({ type: "set_director_shot_utterances" }, 15, Object.assign(new Error("zod"), {
        issues: [{ code: "unrecognized_keys", keys: ["role", "textStart"], path: ["utterances", 0], message: "Unrecognized key(s) in object: 'role', 'textStart'" }],
    }));
    assert.equal(failure.opIndex, 15);
    assert.equal(failure.opType, "set_director_shot_utterances");
    assert.equal(failure.fieldPath, "utterances.0");
    assert.deepEqual(failure.unexpectedKeys, ["role", "textStart"]);
    assert.match(failure.message, /第 15 个操作/);
    assert.match(failure.message, /utterances\.0/);
    assert.match(failure.message, /role、textStart/);
    assert.match(failure.message, /不用重读合同/);
    // 短句必须落在出口的 240 字符截断之内，否则又会只剩半截路径。
    assert.ok(failure.message.length < 200, failure.message);
});

test("edit operation failures without a schema issue still point at the exact operation", () => {
    const failure = failureOf({ type: "patch_director_source", id: "S1" }, 3, new Error("实体 S1 不存在"));
    assert.equal(failure.opIndex, 3);
    assert.equal(failure.fieldPath, undefined);
    assert.equal(failure.unexpectedKeys, undefined);
    assert.equal(failure.message, "第 3 个操作（patch_director_source）失败：实体 S1 不存在");
});
