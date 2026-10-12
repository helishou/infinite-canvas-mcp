import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
const source = readFileSync(new URL("./canvas-host.tsx", import.meta.url), "utf8");
const tree = ts.createSourceFile("host.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler: ts.Expression | undefined;
const visit = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "escape") handler = node.initializer; ts.forEachChild(node, visit); };
visit(tree); assert.ok(handler);
const code = ts.transpileModule(`return (${handler.getText(tree)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
test("Escape belongs to an open Radix Select before the parent canvas editor", () => {
    let closed = 0, prevented = 0;
    const document = { querySelector: (selector: string) => selector.includes("[data-slot='select-content'][data-state='open']") ? {} : null };
    const escape = new Function("document", "close", "deferToPopovers", code)(document, () => closed++, false);
    escape({key:"Escape", preventDefault:()=>prevented++, stopImmediatePropagation:()=>prevented++});
    assert.equal(closed,0); assert.equal(prevented,0);
});
test("the next Escape closes only the parent tool once child overlays are gone", () => {
    let closed = 0, prevented = 0;
    const escape = new Function("document", "close", "deferToPopovers", code)({querySelector:()=>null}, () => closed++, false);
    escape({key:"Escape", preventDefault:()=>prevented++, stopImmediatePropagation:()=>prevented++});
    assert.equal(closed,1); assert.equal(prevented,2);
});

test("an editor defers to its open popover instead of dismissing both layers", () => {
    let closed = 0;
    const escape = new Function("document", "close", "deferToPopovers", code)({ querySelector: (selector: string) => selector.includes(".ant-popover") ? {} : null }, () => closed++, true);
    escape({key:"Escape", preventDefault:()=>{}, stopImmediatePropagation:()=>{}});
    assert.equal(closed,0);
});
