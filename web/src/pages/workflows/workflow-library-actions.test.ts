import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
const tree = ts.createSourceFile("index.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function findAll(predicate: (node: ts.Node) => boolean) {
    const found: ts.Node[] = [];
    const visit = (node: ts.Node) => { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); };
    visit(tree);
    return found;
}
function attribute(node: ts.JsxSelfClosingElement, name: string) {
    return node.attributes.properties.find(prop => ts.isJsxAttribute(prop) && prop.name.getText(tree) === name) as ts.JsxAttribute;
}
function expression(node: ts.JsxSelfClosingElement, name: string) {
    return (attribute(node, name).initializer as ts.JsxExpression).expression!.getText(tree);
}
function compile(value: string, scope: Record<string, unknown>) {
    const code = ts.transpileModule(`const value = ${value}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return new Function("scope", `with(scope) { ${code}; return value; }`)(scope);
}
function headingAncestor(node: ts.Node): ts.JsxElement | undefined {
    for (let current = node.parent; current; current = current.parent) {
        if (ts.isJsxElement(current) && current.children.some(child => ts.isJsxElement(child) && child.openingElement.tagName.getText(tree) === "h2")) return current;
    }
}
const fileInput = findAll(node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(tree) === "input" && node.attributes.getText(tree).includes('type="file"'))[0] as ts.JsxSelfClosingElement;

test("file import and cloud registration share the persistent library header, never list or empty-state bodies", () => {
    const heading = headingAncestor(fileInput);
    assert.ok(heading);
    const actions = findAll(node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(tree) === "RunningHubProfileActions") as ts.JsxSelfClosingElement[];
    assert.equal(actions.length, 2);
    const library = actions.find(node => attribute(node, "scope").initializer!.getText(tree) === '"library"')!;
    const selected = actions.find(node => attribute(node, "scope").initializer!.getText(tree) === '"selected"')!;
    assert.equal(headingAncestor(library), heading);
    assert.equal(selected.parent.parent.getText(tree).startsWith("actions="), true);
    assert.equal(expression(library, "selected"), "null");
    assert.equal(expression(selected, "selected"), "selectedProfile");
    assert.doesNotMatch(heading.getText(tree), /libraryLoading|libraryError|profilesLoading|profilesError|WorkflowLibraryList|RunTab/);
    assert.match(heading.getText(tree), /role="group"/);
    assert.match(heading.getText(tree), /RunningHubWorkflowImport/);
});

test("local file import retains an accessible label, JSON filter, focus and loading lock", () => {
    assert.equal(fileInput.parent.kind, ts.SyntaxKind.JsxElement);
    const label = fileInput.parent as ts.JsxElement;
    assert.equal(label.openingElement.tagName.getText(tree), "label");
    assert.match(label.getText(tree), /sr-only/);
    assert.match(label.getText(tree), /focus-within:ring/);
    assert.equal(attribute(fileInput, "accept").initializer!.getText(tree), '".json"');
    assert.equal(expression(fileInput, "aria-label"), 't("workflowLibraryActions.importFile")');
    assert.equal(compile(expression(fileInput, "disabled"), { loading: true }), true);
    assert.equal(compile(expression(fileInput, "disabled"), { loading: false }), false);
});

test("file change invokes the existing importer once, resets only after receipt, and ignores picker cancellation", async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const files: unknown[] = [];
    const onChange = compile(expression(fileInput, "onChange"), { handleUpload: (file: unknown) => { files.push(file); return pending; } });
    const file = { name: "workflow.json" };
    const input = { files: [file], value: "workflow.json" };
    const upload = onChange({ currentTarget: input });
    assert.deepEqual(files, [file]);
    assert.equal(input.value, "workflow.json");
    finish(); await upload;
    assert.equal(input.value, "");
    await onChange({ currentTarget: { files: [], value: "" } });
    assert.equal(files.length, 1);
});
