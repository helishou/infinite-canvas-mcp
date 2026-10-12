import assert from "node:assert/strict";
import test from "node:test";
import { readAssetRemoteBlob, requireAssetBlob, validateAssetPackage } from "./asset-transfer-validation";
import { readFileSync } from "node:fs";
const manifest = () => ({ app: "infinite-canvas", version: 1, assets: [{ id: "a", kind: "image", data: { storageKey: "image:a" } }], files: [{ storageKey: "image:a", path: "files/a.png", bytes: 0, mimeType: "image/png" }] });
test("missing media fails, but zero-byte blobs remain legitimate files", () => {
    assert.throws(() => requireAssetBlob(null), /ASSET_MEDIA_INCOMPLETE/);
    assert.throws(() => requireAssetBlob(undefined), /ASSET_MEDIA_INCOMPLETE/);
    assert.equal(requireAssetBlob(new Blob([])).size, 0);
});
test("manifest completeness is checked before any media writes", () => {
    const data = manifest();
    const files = new Map([["files/a.png", new Blob([])]]);
    assert.doesNotThrow(() => validateAssetPackage(data, files));
    assert.throws(() => validateAssetPackage(data, new Map()), /INCOMPLETE/);
    assert.throws(() => validateAssetPackage({ ...data, files: [] }, files), /INCOMPLETE/);
    assert.throws(() => validateAssetPackage({ ...data, files: [{ ...data.files[0], bytes: 8 }] }, files), /INCOMPLETE/);
});
test("duplicate references are valid; duplicate archive identities and unsafe paths are rejected", () => {
    const data = manifest(), files = new Map([["files/a.png", new Blob([])]]);
    assert.doesNotThrow(() => validateAssetPackage({ ...data, assets: [...data.assets, { ...data.assets[0], id: "b" }] }, files));
    assert.throws(() => validateAssetPackage({ ...data, assets: [data.assets[0], data.assets[0]] }, files), /INVALID/);
    assert.throws(() => validateAssetPackage({ ...data, files: [...data.files, data.files[0]] }, files), /INVALID/);
    assert.throws(() => validateAssetPackage({ ...data, files: [{ ...data.files[0], path: "../a" }] }, files), /INVALID/);
    assert.throws(() => validateAssetPackage({ ...data, assets: [{ id: "c", kind: "character", data: { images: null } }] }, files), /INVALID/);
});
test("export and import call the completeness guard before download and writes", () => {
    const source = readFileSync(new URL("./asset-transfer.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /if \(!blob\) (?:return|continue)/);
    assert.ok(source.indexOf("validateAssetPackage(data, zip)") < source.indexOf("return importAssetMedia(data.assets"));
    assert.match(source, /blob = requireAssetBlob\(blob\)/);
    assert.match(source, /const blob = requireAssetBlob\(await getMediaBlob/);
    const ui = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
    assert.match(ui, /transferBusyRef.current\) return false/);
    assert.match(ui, /assetTransfer.incomplete/);
});

test("remote error documents never become image downloads", async () => {
    const original = globalThis.fetch;
    try {
        globalThis.fetch = async () => new Response("not found", { status: 404 });
        await assert.rejects(readAssetRemoteBlob("https://mock.invalid/image.png"), /INCOMPLETE/);
        globalThis.fetch = async () => new Response(new Blob(["image"]), { status: 200 });
        assert.equal(await (await readAssetRemoteBlob("https://mock.invalid/image.png")).text(), "image");
    } finally { globalThis.fetch = original; }
});
