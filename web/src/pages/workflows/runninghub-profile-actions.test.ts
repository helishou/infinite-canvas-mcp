import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// Execute the actual component with deterministic hooks and delayed API receipts.
// No browser, network, profile storage or cloud workflow is touched.
const source = readFileSync(new URL("./runninghub-profile-actions.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function deferred() {
    let resolve!: (value: any) => void;
    let reject!: (value: any) => void;
    const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const a = { id: "a", name: "A", workflowId: "101", fields: [] };
const b = { id: "b", name: "B", workflowId: "202", fields: [] };
function harness(api: Record<string, (...args: any[]) => any> = {}, scope: "library" | "selected" = "selected") {
    const slots: any[] = [];
    let cursor = 0;
    const effects: (() => void)[] = [];
    const selected: any[] = [];
    const notices: any[] = [];
    const confirms: any[] = [];
    let refreshes = 0;
    const hooks = {
        useState(initial: any) {
            const index = cursor++;
            if (!(index in slots)) slots[index] = initial;
            return [slots[index], (value: any) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
        },
        useRef(initial: any) {
            const index = cursor++;
            if (!(index in slots)) slots[index] = { current: initial };
            return slots[index];
        },
        useEffect(effect: () => any, deps: any[]) {
            const index = cursor++;
            if (!slots[index] || deps.some((value, i) => value !== slots[index].deps[i])) {
                const previous = slots[index];
                slots[index] = { deps };
                effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = effect(); });
            }
        },
    };
    const jsx = (type: any, props: any) => ({ type, props });
    const exports: any = {};
    const toast = { success: (value: any) => notices.push(value), error: (value: any) => notices.push(value) };
    const antd = Object.fromEntries(["Button", "Input", "Modal", "Select", "Tooltip"].map(name => [name, name]));
    const require = (id: string) => {
        if (id === "react") return hooks;
        if (id === "react-i18next") return { useTranslation: () => ({ t: (key: string) => key === "workflowLibraryActions.addCloud" ? "添加 RunningHub 工作流" : key }) };
        if (id === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
        if (id === "antd") return { ...antd, App: { useApp: () => ({ message: toast, modal: { confirm: (options: any) => { confirms.push(options); return { destroy: () => options.afterClose?.() }; } } }) } };
        if (id === "lucide-react") return {};
        return api;
    };
    new Function("require", "exports", compiled)(require, exports);
    let tree: any;
    const render = (owner: any = a) => {
        cursor = 0;
        tree = exports.RunningHubProfileActions({ scope, profiles: [a, b], selected: owner, onSelected: (...args: any[]) => selected.push(args), onChanged: () => { refreshes++; } });
        effects.splice(0).forEach(run => run());
        return tree;
    };
    const nodes = () => {
        const result: any[] = [];
        const visit = (node: any) => {
            if (Array.isArray(node)) return node.forEach(visit);
            if (!node || typeof node !== "object") return;
            if (node.type) { result.push(node); visit(node.props.children); }
        };
        visit(tree);
        return result;
    };
    render();
    return {
        render, selected, notices, confirms, nodes,
        refreshes: () => refreshes,
        button: (label: string) => nodes().find(n => n.type === "Button" && (n.props.children === label || n.props["aria-label"] === label)).props,
        input: (label?: string) => nodes().find(n => n.type === "Input" && (label ? n.props["aria-label"] === label : n.props.autoFocus)).props,
        modal: () => nodes().find(n => n.type === "Modal").props,
        unmount: () => slots.forEach(slot => slot?.cleanup?.()),
    };
}

test("rename Enter plus blur saves once and cannot select a former owner", async () => {
    const response = deferred(); let calls = 0;
    const h = harness({ saveRunningHubWorkflow: () => { calls++; return response.promise; } });
    h.button("重命名").onClick(); h.render();
    h.input().onChange({ target: { value: "renamed" } }); h.render();
    h.input().onPressEnter(); h.input().onBlur();
    assert.equal(calls, 1);
    h.render(b);
    response.resolve({ workflow: { ...a, name: "renamed" } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.selected, []);
    assert.equal(h.refreshes(), 1);
});

test("resync deduplicates clicks, preserves current selection and releases on failure", async () => {
    const response = deferred(); let calls = 0;
    const h = harness({ resyncRunningHubWorkflow: () => { calls++; return response.promise; } });
    const button = h.button("重新同步"); button.onClick(); button.onClick();
    assert.equal(calls, 1);
    response.reject(new Error("offline"));
    await new Promise(resolve => setImmediate(resolve)); h.render();
    assert.equal(h.button("重新同步").disabled, false);
    assert.deepEqual(h.selected, []);
    assert.deepEqual(h.notices, ["offline"]);
});

test("delete modal and confirmation deduplicate; late receipt cannot clear another owner", async () => {
    const response = deferred(); let calls = 0;
    const h = harness({ deleteRunningHubWorkflow: () => { calls++; return response.promise; } });
    h.button("删除").onClick(); h.button("删除").onClick();
    assert.equal(h.confirms.length, 1);
    const first = h.confirms[0].onOk(); await h.confirms[0].onOk();
    assert.equal(calls, 1);
    h.render(b); response.resolve({}); await first;
    assert.deepEqual(h.selected, []);
    assert.equal(h.refreshes(), 1);
});

test("closing add during inspect prevents save; duplicate registration is blocked", async () => {
    const response = deferred(); let inspections = 0; let saves = 0;
    const h = harness({ inspectRunningHubWorkflow: () => { inspections++; return response.promise; }, saveRunningHubWorkflow: () => { saves++; } }, "library");
    h.button("添加 RunningHub 工作流").onClick(); h.render();
    h.input("RunningHub 工作流 ID").onChange({ target: { value: "303" } }); h.render();
    h.modal().onOk(); h.modal().onOk();
    assert.equal(inspections, 1);
    h.modal().onCancel();
    response.resolve({ fields: [] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(saves, 0);
});

test("already submitted add can finish without closing or resetting a newer dialog", async () => {
    const response = deferred();
    const h = harness({ inspectRunningHubWorkflow: async () => ({ fields: [] }), saveRunningHubWorkflow: () => response.promise }, "library");
    h.button("添加 RunningHub 工作流").onClick(); h.render();
    h.input("RunningHub 工作流 ID").onChange({ target: { value: "303" } }); h.render(); h.modal().onOk();
    await new Promise(resolve => setImmediate(resolve));
    h.modal().onCancel(); h.button("添加 RunningHub 工作流").onClick(); h.render();
    h.input("RunningHub 工作流 ID").onChange({ target: { value: "404" } }); h.render();
    response.resolve({ workflow: a }); await new Promise(resolve => setImmediate(resolve)); h.render();
    assert.equal(h.modal().open, true);
    assert.equal(h.input("RunningHub 工作流 ID").value, "404");
    assert.equal(h.refreshes(), 1);
    assert.deepEqual(h.notices, []);
});

test("unmount suppresses late selection and refresh callbacks", async () => {
    const response = deferred();
    const h = harness({ resyncRunningHubWorkflow: () => response.promise });
    h.button("重新同步").onClick(); h.unmount();
    response.resolve({ workflow: a }); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.selected, []); assert.equal(h.refreshes(), 0);
});

test("successful resync returns its owner ID without adding a confirmation", async () => {
    const h = harness({ resyncRunningHubWorkflow: async () => ({ workflow: a }) });
    h.button("重新同步").onClick(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.selected, [[a, "a"]]); assert.equal(h.confirms.length, 0);
});

test("rename blur after a completed Enter receipt does not save again", async () => {
    let calls = 0;
    const h = harness({ saveRunningHubWorkflow: async () => { calls++; return { workflow: { ...a, name: "new" } }; } });
    h.button("重命名").onClick(); h.render();
    h.input().onChange({ target: { value: "new" } }); h.render();
    const input = h.input(); input.onPressEnter();
    await new Promise(resolve => setImmediate(resolve)); input.onBlur();
    assert.equal(calls, 1);
});

test("owner change invalidates an unsubmitted delete confirmation", async () => {
    let calls = 0;
    const h = harness({ deleteRunningHubWorkflow: async () => { calls++; } });
    h.button("删除").onClick(); h.render(b);
    await h.confirms[0].onOk(); assert.equal(calls, 0);
});


test("library action stays compact and available without a selection; object actions stay separate", () => {
    const library = harness({}, "library");
    library.render(null);
    const add = library.button("添加 RunningHub 工作流");
    assert.equal(add.type, "text");
    assert.equal(add.size, "small");
    assert.equal(add.children, undefined);
    assert.equal(add["aria-label"], add.title);
    assert.equal(library.nodes().filter(node => node.type === "Button").length, 1);
    add.onClick(); library.render(null);
    assert.equal(library.modal().open, true);
    const selected = harness();
    assert.deepEqual(selected.nodes().filter(node => node.type === "Button").map(node => node.props.children), ["重命名", "重新同步", "删除"]);
    assert.equal(selected.nodes().some(node => node.type === "Modal"), false);
    selected.render(null);
    assert.equal(selected.nodes().filter(node => node.type === "Button").length, 0);
});

test("failed registration preserves the dialog and input, releases loading and permits retry", async () => {
    let inspections = 0;
    const h = harness({
        inspectRunningHubWorkflow: async () => { inspections++; throw new Error("offline"); },
    }, "library");
    h.render(null);
    h.button("添加 RunningHub 工作流").onClick(); h.render(null);
    h.input("RunningHub 工作流 ID").onChange({ target: { value: "303" } }); h.render(null);
    h.modal().onOk(); h.render(null);
    assert.equal(h.button("添加 RunningHub 工作流").loading, true);
    await new Promise(resolve => setImmediate(resolve)); h.render(null);
    assert.equal(h.modal().open, true);
    assert.equal(h.modal().confirmLoading, false);
    assert.equal(h.button("添加 RunningHub 工作流").loading, false);
    assert.equal(h.input("RunningHub 工作流 ID").value, "303");
    assert.ok(h.nodes().some(node => node.props.children === "offline"));
    h.modal().onOk(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(inspections, 2);
});
