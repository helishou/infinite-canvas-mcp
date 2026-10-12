import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import * as jsx from "react/jsx-runtime";
import ts from "typescript";
import { groupWorkflowFields } from "./field-groups";

// Run the actual component bodies and event handlers with isolated hooks and fake media I/O.
// This deliberately does not mount AntD or touch a browser, backend, or generation service.
type Slot = { value?: any; deps?: unknown[]; cleanup?: () => void };
let active: Host;
class Host {
    slots: Slot[] = [];
    index = 0;
    dirty = false;
    effects: Array<() => void> = [];
    tree: any;
    constructor(readonly component: (props: any) => any, public props: any) {}
    render(props = this.props) {
        this.props = props;
        for (let pass = 0; pass < 20; pass++) {
            this.index = 0; this.dirty = false; this.effects = []; active = this;
            this.tree = this.component(this.props);
            this.effects.forEach(effect => effect());
            if (!this.dirty) return this.tree;
        }
        throw new Error("Hook render did not settle");
    }
    unmount() { this.slots.forEach(slot => slot.cleanup?.()); }
}
const hooks = {
    useState(initial: any) {
        const host = active; const index = host.index++;
        const slot = host.slots[index] ||= { value: typeof initial === "function" ? initial() : initial };
        return [slot.value, (next: any) => { const value = typeof next === "function" ? next(slot.value) : next; if (!Object.is(value, slot.value)) { slot.value = value; host.dirty = true; } }];
    },
    useRef(initial: any) { return (active.slots[active.index++] ||= { value: { current: initial } }).value; },
    useEffect(setup: () => (() => void) | void, deps: unknown[]) {
        const host = active; const slot = host.slots[host.index++] ||= {};
        if (slot.deps && deps.every((value, index) => Object.is(value, slot.deps![index]))) return;
        host.effects.push(() => { slot.cleanup?.(); slot.deps = deps; slot.cleanup = setup() || undefined; });
    },
};
const Input = Object.assign(() => null, { TextArea: "TextArea" });
const errors: unknown[] = [];
let upload: (input: unknown) => Promise<any> = async () => { throw new Error("Unexpected upload"); };
function load(file: string, extra = "") {
    const source = readFileSync(new URL(file, import.meta.url), "utf8") + extra;
    const code = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports: Record<string, any> = {};
    new Function("require", "exports", code)((name: string) => {
        if (name === "react") return hooks;
        if (name === "react/jsx-runtime") return jsx;
        if (name === "react-i18next") return { useTranslation: () => ({ t: (key: string) => key }) };
        if (name === "antd") return { Input, Button: "Button", Progress: "Progress", Select: "Select", Switch: "Switch", Tag: "Tag", message: { error: (error: unknown) => errors.push(error) } };
        if (name === "lucide-react") return { Play: "Play", Trash2: "Trash2", Upload: "Upload", Code: "Code", History: "History" };
        if (name === "./field-groups") return { groupWorkflowFields };
        if (name === "@/services/backend-api") return { uploadBackendMedia: (input: unknown) => upload(input), backendMediaUrl: (key: string) => `/media/${key}` };
        throw new Error(`Unexpected import ${name}`);
    }, exports);
    return exports;
}
const { RunPanel, RunTab, MediaFieldUpload } = load("./run-panel.tsx", "\nexport { MediaFieldUpload };\n");
const { WorkflowWorkbench } = load("./workflow-workbench.tsx");
function nodes(tree: any): any[] {
    if (Array.isArray(tree)) return tree.flatMap(nodes);
    if (!React.isValidElement(tree)) return [];
    return [tree, ...nodes((tree.props as any).children)];
}
function find(host: Host, type: any) { const found = nodes(host.tree).find(node => node.type === type); assert.ok(found, `Missing ${String(type)}`); return found.props; }
const field = (id: string, type = "text", defaults = "initial") => ({ id, type, default: defaults, node: "1", input: id, name: id });
function panel(fields = [field("prompt")], extra = {}) { return new Host(RunPanel, { config: { fields }, running: false, result: null, onRun: () => {}, ...extra }); }
function deferred() { let resolve!: (value: any) => void; let reject!: (reason: unknown) => void; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const fileEvent = () => ({ target: { value: "upload", files: [{ name: "input.png", type: "image/png" }] } });

test("switching workflow tabs keeps the same run owner mounted and only changes visibility", () => {
    const run = React.createElement(RunTab, { key: "local:owner-a" });
    const host = new Host(WorkflowWorkbench, { activeTab: "run", onTabChange() {}, historyCount: 0, title: "A", graph: "graph", history: "history", run });
    for (const activeTab of ["run", "graph", "history", "run"]) {
        host.render({ ...host.props, activeTab });
        const pane = nodes(host.tree).find(node => node.props.children === run);
        assert.ok(pane, "Run pane must not be conditionally removed");
        assert.equal(pane.props.hidden, activeTab !== "run");
        assert.equal(nodes(host.tree).filter(node => node.type === RunTab).length, 1);
        assert.equal(nodes(host.tree).find(node => node.type === RunTab).key, "local:owner-a");
    }
});

test("fresh config, label/default edits and reruns retain user input", () => {
    const submissions: unknown[] = [];
    const host = panel(undefined, { onRun: (value: unknown) => submissions.push(value) }); host.render();
    find(host, "TextArea").onChange({ target: { value: "my draft" } }); host.render();
    host.render({ ...host.props, config: { fields: [{ ...field("prompt", "text", "new default"), name: "renamed" }] } });
    assert.equal(find(host, "TextArea").value, "my draft");
    find(host, "Button").onClick(); host.render({ ...host.props, running: true }); host.render({ ...host.props, running: false });
    assert.equal(find(host, "TextArea").value, "my draft"); assert.deepEqual(submissions, [{ prompt: "my draft" }]);
});

test("field reconciliation preserves surviving bindings, initializes additions and removes stale fields", () => {
    const submitted: unknown[] = []; const host = panel(undefined, { onRun: (value: unknown) => submitted.push(value) }); host.render();
    find(host, "TextArea").onChange({ target: { value: "edited" } }); host.render();
    host.render({ ...host.props, config: { fields: [field("prompt"), field("new", "number", "7")] } });
    assert.equal(find(host, "TextArea").value, "edited"); find(host, "Button").onClick();
    assert.deepEqual(submitted.pop(), { prompt: "edited", new: "7" });
    host.render({ ...host.props, config: { fields: [{ ...field("prompt", "text", "replacement"), node: "2" }] } });
    find(host, "Button").onClick(); assert.deepEqual(submitted.pop(), { prompt: "replacement" });
});

test("pending media blocks even the previous run handler; external disabled and cancel pending are honest", () => {
    let runs = 0; const host = panel([field("ref", "image", "old")], { onRun: () => runs++ }); host.render();
    const run = find(host, "Button").onClick; const media = find(host, MediaFieldUpload);
    media.onUploadingChange(true); run(); assert.equal(runs, 0); host.render(); assert.equal(find(host, "Button").disabled, true);
    media.onChange("new"); media.onUploadingChange(false); host.render(); find(host, "Button").onClick(); assert.equal(runs, 1);
    host.render({ ...host.props, disabled: true }); find(host, "Button").onClick(); assert.equal(runs, 1); assert.equal(find(host, "Button").loading, false);
    const tab = new Host(RunTab, { ...host.props, running: true, cancelPending: true, onCancel() {} }); tab.render();
    assert.equal(find(tab, RunPanel).disabled, true); assert.equal(find(tab, RunPanel).cancelPending, true);
    host.render({ ...host.props, running: true, cancelPending: true, onCancel() {} });
    const cancel = nodes(host.tree).find(node => node.type === "Button" && node.props.children === "取消");
    assert.equal(cancel.props.disabled, true); assert.equal(cancel.props.loading, true);
});

test("duplicate file events issue one upload, ordinary rerenders retain it, and success updates once", async () => {
    const pending = deferred(); let calls = 0; const values: string[] = []; const busy: boolean[] = [];
    upload = async () => { calls++; return pending.promise; };
    const host = new Host(MediaFieldUpload, { fieldId: "ref", kind: "image", value: "", onChange: (value: string) => values.push(value), onUploadingChange: (value: boolean) => busy.push(value) }); host.render();
    const change = find(host, "input").onChange; const first = change(fileEvent()); await change(fileEvent());
    host.render({ ...host.props, onChange: (value: string) => values.push(value) }); assert.equal(calls, 1); assert.equal(find(host, "input").disabled, true);
    pending.resolve({ storageKey: "result", url: "/media/result" }); await first;
    assert.deepEqual(values, ["/media/result"]); assert.equal(busy.at(-1), false);
});

test("changed field/value or removed owner ignores late media success without corrupting another draft", async () => {
    for (const change of ["field", "value", "owner"]) {
        const pending = deferred(); const values: string[] = []; upload = () => pending.promise;
        const host = new Host(MediaFieldUpload, { fieldId: "ref", kind: "image", value: "old", onChange: (value: string) => values.push(value), onUploadingChange() {} }); host.render();
        const task = find(host, "input").onChange(fileEvent());
        if (change === "owner") host.unmount(); else host.render({ ...host.props, ...(change === "field" ? { fieldId: "other" } : { value: "replacement" }) });
        pending.resolve({ storageKey: "late", url: "/media/late" }); await task; assert.deepEqual(values, [], change);
    }
});

test("failed upload releases the busy state and permits retry without touching the chosen value", async () => {
    errors.length = 0; let calls = 0; const values: string[] = []; const busy: boolean[] = [];
    upload = async () => { calls++; if (calls === 1) throw new Error("offline"); return { storageKey: "retry", url: "/media/retry" }; };
    const host = new Host(MediaFieldUpload, { fieldId: "ref", kind: "image", value: "old", onChange: (value: string) => values.push(value), onUploadingChange: (value: boolean) => busy.push(value) }); host.render();
    await find(host, "input").onChange(fileEvent()); host.render(); assert.deepEqual(values, []); assert.equal(busy.at(-1), false); assert.equal(errors.length, 1);
    await find(host, "input").onChange(fileEvent()); assert.deepEqual(values, ["/media/retry"]); assert.equal(calls, 2);
});

test("a surviving media binding accepts its upload after unrelated fields change; a rebound one rejects the old callback", () => {
    const submissions: unknown[] = []; const host = panel([field("ref", "image", "old")], { onRun: (value: unknown) => submissions.push(value) }); host.render();
    const originalMedia = find(host, MediaFieldUpload);
    const originalKey = nodes(host.tree).find(node => node.type === "div" && node.key)?.key;
    host.render({ ...host.props, config: { fields: [field("ref", "image", "new default"), field("extra")] } });
    assert.equal(nodes(host.tree).find(node => node.type === "div" && node.key && node.props.children?.some?.((child: any) => child?.type === MediaFieldUpload))?.key, originalKey);
    originalMedia.onChange("uploaded"); host.render(); find(host, "Button").onClick(); assert.deepEqual(submissions.pop(), { ref: "uploaded", extra: "initial" });
    host.render({ ...host.props, config: { fields: [{ ...field("ref", "image", "replacement"), node: "other" }] } });
    originalMedia.onChange("late"); host.render(); find(host, "Button").onClick(); assert.deepEqual(submissions.pop(), { ref: "replacement" });
});

test("an untouched field without a default remains omitted, while an explicitly cleared value is retained", () => {
    const submitted: unknown[] = [];
    const host = panel([{ ...field("prompt"), default: undefined } as any], { onRun: (value: unknown) => submitted.push(value) }); host.render();
    find(host, "Button").onClick(); assert.deepEqual(submitted.pop(), {});
    find(host, "TextArea").onChange({ target: { value: "" } }); host.render();
    host.render({ ...host.props, config: { fields: [field("prompt", "text", "changed"), { ...field("new"), default: undefined }] } });
    find(host, "Button").onClick(); assert.deepEqual(submitted.pop(), { prompt: "" });
});
