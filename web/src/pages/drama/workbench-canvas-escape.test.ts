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

test("Escape closes the open director dialog before collapsing the hosted canvas", () => {
    let collapsed = 0;
    let queued = 0;
    const document = { querySelector: (selector: string) => selector.includes("#canvas-director-dialog") ? {} : null };
    const onKeyDown = new Function("document", "collapse", "queueMicrotask", code)(document, () => collapsed++, (callback: () => void) => { queued++; callback(); });
    onKeyDown({ key: "Escape", defaultPrevented: false });
    assert.equal(collapsed, 0);
    assert.equal(queued, 0);
});

test("Escape collapses the hosted canvas after its director dialog is closed", () => {
    let collapsed = 0;
    const document = { querySelector: () => null };
    const onKeyDown = new Function("document", "collapse", "queueMicrotask", code)(document, () => collapsed++, (callback: () => void) => callback());
    onKeyDown({ key: "Escape", defaultPrevented: false });
    assert.equal(collapsed, 1);
});
