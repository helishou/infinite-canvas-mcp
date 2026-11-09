import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("./workbench-canvas.tsx", import.meta.url), "utf8");
const tree = ts.createSourceFile("workbench-canvas.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler: ts.Expression | undefined;
const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "keydown") handler = node.initializer;
    ts.forEachChild(node, visit);
};
visit(tree);
assert.ok(handler);
const code = ts.transpileModule(`return (${handler.getText(tree)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test("Escape never collapses the hosted canvas", () => {
    let collapsed = 0;
    const onKeyDown = new Function("document", "panel", "overlay", "collapse", "queueMicrotask", code)({ querySelector: () => null }, null, null, () => collapsed++, (callback: () => void) => callback());
    onKeyDown({ key: "Escape", defaultPrevented: false });
    assert.equal(collapsed, 0);
});