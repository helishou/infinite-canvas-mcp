import assert from "node:assert/strict";
import test from "node:test";

import { buildCreativeCommandReferences } from "./creative-command-references.js";

test("共享素材关键帧的 /media/ 代理地址走 url，不塞进 dataUrl（否则后端报缺媒体句柄 400）", () => {
    // 来自画布共享素材节点的真实形态：content 是 URL 编码的 /media/...，没有 storageKey。
    const [ref] = buildCreativeCommandReferences([
        {
            id: "library-asset-9f7c102c",
            title: "E3-CLIP-15 定稿关键帧 KB · A 主视角起幅帧",
            mimeType: "image/png",
            dataUrl: "/media/image%3A423073ff-f9d9-4e49-9e37-320eb36ceee0",
            url: "/media/image%3A423073ff-f9d9-4e49-9e37-320eb36ceee0",
        },
    ]);
    assert.equal(ref.url, "/media/image%3A423073ff-f9d9-4e49-9e37-320eb36ceee0");
    assert.equal("dataUrl" in ref, false, "代理 URL 不能当 dataUrl 提交");
    assert.equal(ref.name, "E3-CLIP-15 定稿关键帧 KB · A 主视角起幅帧.png");
});

test("base64 dataUrl 原样进 dataUrl，URL 型不混入", () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    const [ref] = buildCreativeCommandReferences([
        { id: "r1", title: "上传图", mimeType: "image/png", dataUrl, url: dataUrl },
    ]);
    assert.equal(ref.dataUrl, dataUrl);
    assert.equal("url" in ref, false);
});

test("storageKey 与 url 并存：两者都带，后端可优先用 storageKey、失效回落 url", () => {
    const [ref] = buildCreativeCommandReferences([
        {
            id: "r2",
            title: "关键帧",
            storageKey: "image:423073ff-f9d9-4e49-9e37-320eb36ceee0",
            dataUrl: "/media/image%3A423073ff-f9d9-4e49-9e37-320eb36ceee0",
        },
    ]);
    assert.equal(ref.storageKey, "image:423073ff-f9d9-4e49-9e37-320eb36ceee0");
    assert.equal(ref.url, "/media/image%3A423073ff-f9d9-4e49-9e37-320eb36ceee0");
    assert.equal("dataUrl" in ref, false);
});

test("节点 id 由调用方指定，顺序与参考图一致", () => {
    const refs = buildCreativeCommandReferences(
        [{ title: "A", dataUrl: "/media/a" }, { title: "B", dataUrl: "/media/b" }],
        (_item, index) => `node-${index}`,
    );
    assert.deepEqual(refs.map((ref) => ref.id), ["node-0", "node-1"]);
    assert.deepEqual(refs.map((ref) => ref.url), ["/media/a", "/media/b"]);
});
