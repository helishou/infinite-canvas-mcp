import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("./runninghub-workflow-import.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;

function harness() {
    const slots: any[] = [];
    let cursor = 0;
    let reads = 0;
    let finishRead!: (value: any) => void;
    const receipt = new Promise(resolve => { finishRead = resolve; });
    const jsx = (type: any, props: any) => ({ type, props });
    const exports: any = {};
    const require = (id: string) => {
        if (id === "react") return { useState(initial: any) {
            const index = cursor++;
            if (!(index in slots)) slots[index] = initial;
            return [slots[index], (value: any) => { slots[index] = value; }];
        } };
        if (id === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
        if (id === "react-i18next") return { useTranslation: () => ({ t: (key: string) => key }) };
        if (id === "antd") return Object.fromEntries(["Alert", "Button", "Input", "Modal", "Select", "Tooltip"].map(name => [name, name]));
        if (id === "lucide-react") return { DownloadCloud: "DownloadCloud" };
        return { fetchRunningHubWorkflows: () => { reads++; return receipt; } };
    };
    new Function("require", "exports", compiled)(require, exports);
    let nodes: any[] = [];
    const render = () => {
        cursor = 0;
        nodes = [];
        const tree = exports.RunningHubWorkflowImport({ workflows: [], onImported: () => {} });
        const visit = (node: any) => {
            if (Array.isArray(node)) return node.forEach(visit);
            if (node && typeof node === "object" && node.type) { nodes.push(node); visit(node.props.children); }
        };
        visit(tree);
    };
    render();
    return { render, reads: () => reads, finishRead, node: (type: string) => nodes.find(node => node.type === type).props };
}

test("local-copy action is compact, keyboard-accessible and opens the existing profile picker", async () => {
    const h = harness();
    const button = h.node("Button");
    assert.equal(button.type, "text");
    assert.equal(button.size, "small");
    assert.equal(button["aria-label"], "runningHub.import.localCopy");
    assert.equal(button.title, button["aria-label"]);
    assert.equal(button.children, undefined);
    assert.equal(h.node("Modal").open, false);
    button.onClick();
    h.render();
    assert.equal(h.reads(), 1);
    assert.equal(h.node("Modal").open, true);
    assert.equal(h.node("Button").loading, true);
    h.finishRead({ workflows: [{ id: "cloud", name: "Cloud workflow", workflowId: "101" }] });
    await new Promise(resolve => setImmediate(resolve));
    h.render();
    assert.equal(h.node("Button").loading, false);
    assert.deepEqual(h.node("Select").options, [{ value: "cloud", label: "Cloud workflow · 101" }]);
    h.node("Modal").onCancel();
    h.render();
    assert.equal(h.node("Modal").open, false);
});

test("local-copy entry belongs to the library heading, never a workflow row", () => {
    const page = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
    const tree = ts.createSourceFile("index.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const entries: ts.JsxSelfClosingElement[] = [];
    const visit = (node: ts.Node) => {
        if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(tree) === "RunningHubWorkflowImport") entries.push(node);
        ts.forEachChild(node, visit);
    };
    visit(tree);
    assert.equal(entries.length, 1);
    let container: ts.Node = entries[0].parent;
    while (!(ts.isJsxElement(container) && container.children.some(node => ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === "h2"))) container = container.parent;
    assert.equal(container.openingElement.tagName.getText(tree), "div");
    assert.ok(container.children.some(node => ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === "h2"));
    assert.match(container.openingElement.getText(tree), /items-center justify-between/);
    assert.match(container.getText(tree), /library === "local"/);
});
