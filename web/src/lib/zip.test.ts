import assert from "node:assert/strict";
import test from "node:test";
import { createZip, readZip } from "./zip";

test("逐文件流式归档保留二进制、中文文件名和空文件", async () => {
    const data = Uint8Array.from({ length: 200000 }, (_, i) => i % 256);
    async function* files() {
        yield { name: "媒体/视频.bin", data };
        yield { name: "empty.txt", data: "" };
        yield { name: "projects.json", data: '{"title":"中文"}' };
    }
    const entries = await readZip(await createZip(files()));
    assert.deepEqual(new Uint8Array(await entries.get("媒体/视频.bin")!.arrayBuffer()), data);
    assert.equal(await entries.get("empty.txt")!.text(), "");
    assert.equal(await entries.get("projects.json")!.text(), '{"title":"中文"}');
});

test("读取中途失败不会产出部分归档", async () => {
    async function* files() {
        yield { name: "first.txt", data: "first" };
        throw new Error("媒体缺失");
    }
    await assert.rejects(createZip(files()), /媒体缺失/);
});

test("损坏的 ZIP 明确报错", async () => {
    await assert.rejects(readZip(new Blob(["invalid archive"])));
});
