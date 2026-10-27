import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import ts from "typescript";
const source = readFileSync(new URL("./canvas-toolbar.tsx", import.meta.url), "utf8");
const tree = ts.createSourceFile("toolbar.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function evaluate(name: string, scope: Record<string, unknown>) {
    let expression: ts.Expression | undefined;
    const visit = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name) expression = node.initializer; ts.forEachChild(node, visit); };
    visit(tree); assert.ok(expression);
    const code = ts.transpileModule(`return (${expression.getText(tree)});`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
    return new Function(...Object.keys(scope), code)(...Object.values(scope)) as Array<any>;
}
const t = (key: string) => key;
test("Add preserves all original builtin callbacks and current extension registry actions", () => {
    const names = ["Text", "Image", "Video", "Audio", "H3", "Character", "Scene", "Prop", "Config", "Loop", "Group"];
    const invoked: string[] = [];
    const handlers = Object.fromEntries(names.map(name => [`onAdd${name}`, () => invoked.push(name)]));
    const scope = { React, t, ...handlers, groupSelection: true, item: (key: string, onClick: () => void) => ({key, onClick}), extensionDefs: [{type: "test:node", icon: "★"}], getNodeSpec: () => ({title: "Live extension"}), onAddExtensionNode: (type: string) => invoked.push(type) };
    const groups = evaluate("creationItems", scope);
    const items = groups.flatMap(group => group.children);
    assert.equal(items.length, 12);
    for (const item of items) item.onClick();
    assert.deepEqual(invoked, [...names, "test:node"]);
    assert.equal(items.find(item => item.key === "group").label, "canvas.controls.group");
});
test("multi-selection actions preserve focus, rename, arrange, group and destructive target callbacks", () => {
    let block: ts.JsxElement | undefined;
    const visit = (node: ts.Node) => {
        if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some(a => ts.isJsxAttribute(a) && a.name.getText(tree) === "className" && a.initializer?.getText(tree) === '"canvas-selection-actions"')) block ||= node;
        ts.forEachChild(node, visit);
    };
    visit(tree); assert.ok(block);
    const invoked: string[] = [];
    const handlers = Object.fromEntries(["FocusSelection", "BatchRename", "Arrange", "AddGroup", "Delete"].map(name => [`on${name}`, () => invoked.push(name)]));
    const icons = Object.fromEntries(["Focus", "PencilLine", "Grid2x2", "Group", "Trash2"].map(name => [name, () => null]));
    const Button = () => null;
    const scope: Record<string, unknown> = { React, t, Button, Tooltip: ({ children }: { children: unknown }) => children, ...handlers, ...icons, selectedCount: 2, groupSelection: true, deleteDisabled: false, theme: { toolbar: { panel: "", border: "", item: "" } } };
    const code = ts.transpileModule(`return (${block.getText(tree)});`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
    const renderButtons = (extra: Record<string, unknown> = {}) => {
        const input = { ...scope, ...extra };
        const root = new Function(...Object.keys(input), code)(...Object.values(input));
        const buttons: Array<any> = [];
        const walk = (n: unknown) => {
            if (!n || typeof n !== "object") return;
            if (Array.isArray(n)) { n.forEach(walk); return; }
            const el = n as { type?: unknown; props?: { children?: unknown; onClick?: () => void; danger?: boolean } };
            if (el.type === Button) buttons.push(el.props);
            if (el.props?.children) walk(el.props.children);
        };
        walk((root as { props: { children?: unknown } }).props.children);
        return buttons;
    };
    const buttons = renderButtons();
    assert.deepEqual(buttons.map(button => button.onClick), [handlers.onFocusSelection, handlers.onBatchRename, handlers.onAddGroup, handlers.onArrange, handlers.onDelete]);
    buttons.forEach(button => button.onClick!());
    assert.deepEqual(invoked, ["FocusSelection", "BatchRename", "AddGroup", "Arrange", "Delete"]);
    assert.equal(buttons.at(-1)?.danger, true);
    assert.deepEqual(renderButtons({ selectedCount: 1, groupSelection: false }).map(button => button.onClick), [handlers.onFocusSelection, handlers.onArrange, handlers.onDelete]);
});

test("panning out of cull bounds keeps the single builtin editor owner mounted without pinning unrelated plugins", () => {
    const project = readFileSync(new URL("../../pages/canvas/project.tsx", import.meta.url), "utf8");
    const projectTree = ts.createSourceFile("project.tsx", project, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let callback: ts.Expression | undefined;
    const visit = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && node.name.getText(projectTree) === "visibleNodes" && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0]; ts.forEachChild(node, visit); };
    visit(projectTree); assert.ok(callback);
    const code = ts.transpileModule(`return (${callback.getText(projectTree)})();`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const image = { id:"image", type:"image" }, plugin = { id:"plugin", type:"custom" }, visible = [{id:"nearby"}];
    const scope = {queryCanvasSpatialIndex: () => visible, graphIndex:{nodeSpatialIndex:{}}, visibleWorldBounds:{}, dialogNodeId:"image", nodeById:new Map([["image",image],["plugin",plugin]]), getNodeDefinition:(type:string) => type === "custom" ? {Panel:()=>null} : undefined, refPickActive:false, refPickTargetNodeId:null};
    const run = (extra = {}) => { const input = {...scope,...extra}; return new Function(...Object.keys(input),code)(...Object.values(input)); };
    assert.deepEqual(run(),[...visible,image]);
    assert.equal(run({dialogNodeId:null}),visible);
    assert.equal(run({dialogNodeId:"plugin"}),visible);
    assert.equal(run({queryCanvasSpatialIndex:()=>[image]}).length,1);
});
