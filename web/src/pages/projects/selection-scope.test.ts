import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("index.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function initializer(name: string) {
    let value = "";
    function visit(node: ts.Node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name && node.initializer) value = node.initializer.getText(ast);
        ts.forEachChild(node, visit);
    }
    visit(ast);
    assert.ok(value, `${name} exists`);
    return value;
}

test("hidden selection count preserves cross-filter selections and reports only hidden IDs", () => {
    const count = new Function("selectedIds", "visibleProjects", `return (${initializer("hiddenSelectedCount")})`);
    const selected = ["in-folder", "outside-folder"];
    assert.equal(count(selected, [{ id: "in-folder" }]), 1);
    assert.equal(count(selected, []), 2);
    assert.equal(count(selected, selected.map(id => ({ id }))), 0);
    assert.deepEqual(selected, ["in-folder", "outside-folder"]);
    assert.match(source, /setDeleteIds\(selectedIds\)/);
    assert.match(source, /removeSelectedIds\(selectedIds\)/);
});

test("asset library deletion confirmation identifies both object and library scope", () => {
    const panel = readFileSync(new URL("../../components/canvas/canvas-side-panel.tsx", import.meta.url), "utf8");
    assert.match(panel, /removeAssetTitle", \{ name: asset.title \}/);
    assert.match(panel, /description=\{t\("canvas.sidePanel.removeAssetDescription"\)\}/);
    assert.match(panel, /onConfirm=\{onRemove\}/);
    const dialog = readFileSync(new URL("../../components/canvas/canvas-delete-projects-dialog.tsx", import.meta.url), "utf8");
    assert.match(dialog, /ids.map\(\(id\) =>/);
    assert.match(dialog, /projects.find\(\(project\) => project.id === id\)\?\.title \|\| id/);
    assert.match(dialog, /deleteProjects\(ids\)/);
});
