import assert from "node:assert/strict";
import test from "node:test";
import { readAllPages } from "./read-all-pages";

test("分页按实际条数推进，完整读取超过 500 条的记录", async () => {
    const values = Array.from({ length: 1203 }, (_, i) => i);
    const offsets: number[] = [];
    const result = await readAllPages(async (offset) => {
        offsets.push(offset);
        return values.slice(offset, offset + 500);
    });
    assert.deepEqual(result, values);
    assert.deepEqual(offsets, [0, 500, 1000, 1203]);
});

test("分页失败向上传递，不把失败当成空结果", async () => {
    await assert.rejects(readAllPages(async (offset) => {
        if (offset) throw new Error("network failure");
        return [1];
    }), /network failure/);
});
