import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readCompilationReference } from "./acheng.js";
test("absolute frozen references are accepted only when the formal resolver returned that exact file", t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "compiled-reference-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const output = path.join(root, "compiled"), inputs = path.join(root, "inputs"); fs.mkdirSync(output); fs.mkdirSync(inputs);
    const image = path.join(inputs, "approved.png"), unrelated = path.join(inputs, "other.png"); fs.writeFileSync(image, "approved"); fs.writeFileSync(unrelated, "other");
    assert.equal(readCompilationReference(output, image, [image]).toString(), "approved");
    assert.throws(() => readCompilationReference(output, unrelated, [image]), /not in the package/);
    assert.throws(() => readCompilationReference(output, "../inputs/other.png", [image]), /not in the package/);
    fs.writeFileSync(path.join(output, "copy.png"), "copy"); assert.equal(readCompilationReference(output, "copy.png", []).toString(), "copy");
});
