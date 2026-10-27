import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

/** 建一个独立数据目录的临时 MediaStore（数据目录必须在 import 前设定）。 */
async function fixture(t: import("node:test").TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "media-dedupe-"));
    const previous = process.env.INFINITE_CANVAS_DATA_DIR;
    process.env.INFINITE_CANVAS_DATA_DIR = root;
    let db: import("../db.js").BackendDatabase | undefined;
    t.after(async () => {
        db?.close();
        if (previous === undefined) delete process.env.INFINITE_CANVAS_DATA_DIR;
        else process.env.INFINITE_CANVAS_DATA_DIR = previous;
        await fs.rm(root, { recursive: true, force: true });
    });
    const [{ BackendDatabase }, { createMediaStore }] = await Promise.all([import("../db.js"), import("./media-store.js")]);
    db = new BackendDatabase(path.join(root, "runtime.sqlite"));
    return { db, media: createMediaStore(db), mediaDir: path.join(root, "runtime-media") };
}

test("同内容二次入库复用同一份物理文件，只登记新的 storageKey", async (t) => {
    const { db, media } = await fixture(t);
    const bytes = Buffer.from("identical frame bytes");
    const first = media.store(bytes, { name: "a.png", mimeType: "image/png" });
    const second = media.store(bytes, { name: "b.png", mimeType: "image/png" });

    assert.notEqual(second.storageKey, first.storageKey, "storageKey 仍是各自的身份");
    assert.equal(second.filePath, first.filePath, "同 sha256 必须复用同一份文件");
    assert.equal(db.getMediaFile(second.storageKey)?.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
    const files = await fs.readdir(path.join(first.filePath, ".."));
    assert.equal(files.filter((name) => !name.startsWith(".")).length, 1, "磁盘上只应有一份文件");
    assert.deepEqual(await media.read(second.storageKey), bytes, "复用文件必须可读且内容一致");
});

test("流式入库同样复用同内容文件，且不会误删共享文件", async (t) => {
    const { db, media } = await fixture(t);
    const bytes = Buffer.from("identical streamed bytes");
    const first = await media.storeStream(Readable.from([bytes]), { name: "a.mp4", mimeType: "video/mp4" });
    const second = await media.storeStream(Readable.from([bytes]), { name: "b.mp4", mimeType: "video/mp4" });

    assert.equal(second.filePath, first.filePath);
    assert.equal(db.countMediaFileSharers(first.filePath, first.storageKey), 1);
    // 删掉其中一个 key：文件必须留下，另一个 key 仍可读。
    media.delete(first.storageKey);
    assert.deepEqual(await media.read(second.storageKey), bytes);
    // 最后一个引用消失后才真正删文件。
    media.delete(second.storageKey);
    await assert.rejects(media.read(second.storageKey));
});

test("不同内容不共享文件，缺失的旧文件不会被当成可复用目标", async (t) => {
    const { db, media, mediaDir } = await fixture(t);
    const first = media.store(Buffer.from("content one"), { name: "a.png", mimeType: "image/png" });
    const other = media.store(Buffer.from("content two"), { name: "b.png", mimeType: "image/png" });
    assert.notEqual(other.filePath, first.filePath);

    // 记录还在但文件被外部清掉：同内容再次入库必须重新落盘，而不是登记一个不存在的路径。
    await fs.rm(first.filePath);
    const again = media.store(Buffer.from("content one"), { name: "c.png", mimeType: "image/png" });
    assert.notEqual(again.filePath, first.filePath);
    assert.deepEqual(await media.read(again.storageKey), Buffer.from("content one"));
    assert.equal(db.getMediaFile(again.storageKey)?.filePath, again.filePath);
    assert.equal(db.countMediaFileSharers(again.filePath, again.storageKey), 0);
    void mediaDir;
});
