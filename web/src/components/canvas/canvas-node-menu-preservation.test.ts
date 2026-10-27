import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import ts from "typescript";
import { groupCanvasNodeActions } from "./canvas-node-action-groups";

// Exercise actual source projections without mounting a canvas or calling a backend.
const source = readFileSync(new URL("./canvas-node-hover-toolbar.tsx", import.meta.url), "utf8");
const tree = ts.createSourceFile("toolbar.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function findNode<T extends ts.Node>(predicate: (node: ts.Node) => node is T): T {
    let result: T | undefined;
    const visit = (node: ts.Node) => { if (predicate(node)) result ||= node; ts.forEachChild(node, visit); };
    visit(tree);
    assert.ok(result, "expected toolbar source node");
    return result;
}
function variable(name: string) {
    return findNode((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && node.name.getText(tree) === name).initializer!;
}
const menu = findNode((node): node is ts.JsxOpeningElement => ts.isJsxOpeningElement(node) && node.tagName.getText(tree) === "Dropdown" && node.attributes.properties.some(attr => ts.isJsxAttribute(attr) && attr.name.getText(tree) === "open" && attr.initializer?.getText(tree) === "{actionsOpen}"));
function attribute(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string) {
    return node.attributes.properties.find((attr): attr is ts.JsxAttribute => ts.isJsxAttribute(attr) && attr.name.getText(tree) === name);
}
function expression(name: string) {
    const initializer = attribute(menu, name)?.initializer;
    assert.ok(initializer && ts.isJsxExpression(initializer) && initializer.expression);
    return initializer.expression;
}
function evaluate<T>(node: ts.Node, scope: Record<string, unknown> = {}): T {
    const compiled = ts.transpileModule(`return (${node.getText(tree)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS } }).outputText;
    return new Function(...Object.keys(scope), compiled)(...Object.values(scope)) as T;
}

test("the complete menu starts from every source collection, including dynamic plugin actions", () => {
    const input = {
        baseToolbarTools: [{ id: "info" }], nodeToolbarTools: [{ id: "crop" }],
        extraTools: [{ id: "plugin:tool", active: true, disabled: true }], sharedTools: [{ id: "discardShared" }],
    };
    const actual = evaluate<Array<{ id: string }>>(variable("allToolbarTools"), input);
    const expected = [...input.baseToolbarTools, ...input.nodeToolbarTools, ...input.extraTools, ...input.sharedTools];
    assert.deepEqual(actual, expected);
    expected.forEach((action, index) => assert.equal(actual[index], action));
});

test("every built-in tool declared by the toolbar or image registry survives grouping", () => {
    const ids = new Set<string>();
    const collect = (node: ts.Node, file: ts.SourceFile) => {
        if (ts.isPropertyAssignment(node) && node.name.getText(file) === "id" && ts.isStringLiteral(node.initializer)) ids.add(node.initializer.text);
        ts.forEachChild(node, child => collect(child, file));
    };
    for (const name of ["baseToolbarTools", "nodeToolbarTools", "sharedTools"]) collect(variable(name), tree);
    const imageTree = ts.createSourceFile("image-tools.tsx", readFileSync(new URL("./canvas-image-toolbar-tools.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    collect(imageTree, imageTree);
    assert.equal(ids.size, 39);
    const groups = groupCanvasNodeActions([...ids].map(id => ({ id })));
    assert.deepEqual(groups.flatMap(group => group.actions.map(action => action.id)).sort(), [...ids].sort());
    assert.ok(!groups.some(group => group.id === "extensions"), "built-in actions must have deliberate sections");
});

test("menu projections preserve callbacks, disabled/loading/danger state and current active keys", () => {
    const active = { id: "plugin:active", label: "Active", title: "Active tool", active: true, disabled: true, loading: true, icon: "plain", onClick: () => undefined };
    const remove = { id: "delete", title: "Delete", danger: true, onClick: () => undefined };
    const allToolbarTools = [active, remove];
    const dropdownTools = [active, remove];
    const moreTools = [active];
    const actionMenuItems = evaluate<Array<{ children: Array<{ key: string; onClick: () => void; disabled?: boolean; danger?: boolean; icon?: unknown }> }>>(variable("actionMenuItems"), { React, LoaderCircle: () => null, groupCanvasNodeActions, dropdownTools, t: (key: string) => key });
    const items = actionMenuItems.flatMap(group => group.children);
    assert.equal(items.find(item => item.key === active.id)?.onClick, active.onClick);
    assert.equal(items.find(item => item.key === active.id)?.disabled, true);
    assert.ok(React.isValidElement(items.find(item => item.key === active.id)?.icon));
    assert.equal(items.find(item => item.key === remove.id)?.danger, true);
    const props = evaluate<{ selectedKeys: string[]; selectable: boolean }>(expression("menu"), { actionMenuItems, moreTools, setActionsOpen: () => undefined });
    assert.equal(props.selectable, true);
    assert.deepEqual(props.selectedKeys, [active.id]);
});

test("menu keyboard isolation blocks canvas mutations and keeps Escape and Tab dismissal", () => {
    const closed: boolean[] = [];
    let focused = 0;
    const popupRender = evaluate<(content: React.ReactNode) => React.ReactElement<{ className: string; "data-canvas-shortcuts-ignore": boolean; "data-canvas-no-zoom": boolean; onKeyDown: (event: { key: string; stopPropagation: () => void; preventDefault: () => void }) => void }>>(expression("popupRender"), { React, setActionsOpen: (open: boolean) => closed.push(open), actionsTriggerRef: { current: { focus: () => focused++ } } });
    const popup = popupRender("menu");
    assert.match(popup.props.className, /canvas-blocking-overlay/);
    assert.equal(popup.props["data-canvas-shortcuts-ignore"], true);
    assert.equal(popup.props["data-canvas-no-zoom"], true);
    for (const key of ["Delete", "z", "a", "Escape", "Tab"]) {
        let stopped = false;
        let prevented = false;
        popup.props.onKeyDown({ key, stopPropagation: () => { stopped = true; }, preventDefault: () => { prevented = true; } });
        assert.equal(stopped, true, key);
        if (key === "Escape") assert.equal(prevented, true);
    }
    assert.deepEqual(closed, [false, false]);
    assert.equal(focused, 1);
    assert.ok(attribute(menu, "autoFocus"));
    const trigger = menu.parent;
    assert.ok(ts.isJsxElement(trigger));
    const button = trigger.children.find((child): child is ts.JsxElement => ts.isJsxElement(child) && child.openingElement.tagName.getText(tree) === "button");
    assert.ok(button && attribute(button.openingElement, "data-canvas-shortcuts-ignore"));
    assert.match(attribute(button.openingElement, "className")!.getText(tree), /canvas-blocking-overlay/);
});
