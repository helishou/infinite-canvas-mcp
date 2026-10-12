import assert from "node:assert/strict";
import test from "node:test";
import type { Asset } from "@/stores/use-asset-store";
import { importAssetMedia } from "./asset-import-media";
const files = [
    { storageKey: "image:existing", path: "files/image.png", mimeType: "image/png", bytes: 3 },
    { storageKey: "audio:voice", path: "files/voice.wav", mimeType: "audio/wav", bytes: 5 },
];
const assets = [
    { id: "a", kind: "image", coverUrl: "old-image-url", data: { storageKey: "image:existing", dataUrl: "old-image-url" } },
    { id: "b", kind: "character", coverUrl: "old-image-url", data: { voiceStorageKey: "audio:voice", images: [{ storageKey: "image:existing", url: "old-image-url" }] } },
] as Asset[];
const blobs = () => new Map([["files/image.png", new Blob(["new"])], ["files/voice.wav", new Blob(["voice"])]]);
test("package collisions never replace existing bytes; shared image/voice references and URLs are remapped", async () => {
    const existing = new Map<string, Blob>([["image:existing", new Blob(["original"])], ["audio:voice", new Blob(["old voice"])]]);
    const result = await importAssetMedia(assets, files, blobs(), key => `${key}-import`, async (key, blob) => { existing.set(key, blob); return `new/${key}`; });
    assert.equal(await existing.get("image:existing")!.text(), "original");
    assert.equal(await existing.get("audio:voice")!.text(), "old voice");
    assert.equal(await existing.get("image:existing-import")!.text(), "new");
    const image = result[0] as any, character = result[1] as any;
    assert.equal(image.data.storageKey, character.data.images[0].storageKey);
    assert.equal(character.data.voiceStorageKey, "audio:voice-import");
    assert.equal(image.coverUrl, "new/image:existing-import");
    assert.equal(character.data.images[0].url, image.coverUrl);
    assert.equal(character.coverUrl, image.coverUrl);
    assert.equal((assets[0] as any).data.storageKey, "image:existing");
});
test("missing archive entry and generated key collision fail before any writes", async () => {
    let writes = 0;
    const save = async () => { writes++; return "url"; };
    await assert.rejects(importAssetMedia(assets, files, new Map(), key => `${key}-new`, save), /INCOMPLETE/);
    await assert.rejects(importAssetMedia(assets, files, blobs(), key => key, save), /COLLISION/);
    assert.equal(writes, 0);
});
test("partial upload failure rejects instead of returning assets with stale references", async () => {
    let writes = 0;
    await assert.rejects(importAssetMedia(assets, files, blobs(), key => `${key}-new`, async () => { if (++writes === 2) throw new Error("mock upload failed"); return "new-url"; }), /mock upload failed/);
    assert.equal(writes, 2);
    assert.equal((assets[1] as any).data.voiceStorageKey, "audio:voice");
});
