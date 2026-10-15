import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import zhCN from "../../i18n/locales/zh-CN";
import enUS from "../../i18n/locales/en-US";
import { continuityPreviewStatus } from "./continuity-timeline-model";
import { continuityLedgerFactDescriptions } from "./continuity-ledger-mutations";

// Run the actual derived state, header and handlers. Production adapter tests
// separately exercise the request lifecycle; these checks do not render a browser.
const source = readFileSync(new URL("./continuity-panel.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("panel.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const expressions = new Map<string, string>();
let header = "";
function collect(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) expressions.set(node.name.text, node.initializer.getText(ast));
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === "header") header = node.getText(ast);
    ts.forEachChild(node, collect);
}
collect(ast);
function evaluate(expression: string, context: Record<string, any>) {
    const js = ts.transpileModule(`const result = ${expression};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText;
    return new Function("context", `with (context) { ${js}; return result; }`)(context);
}
function declaration(name: string, context: Record<string, any>) {
    assert.ok(expressions.has(name), `Missing actual declaration: ${name}`);
    return evaluate(expressions.get(name)!, context);
}
type Element = { type: string; props: Record<string, any>; children: any[] };
function elements(node: Element): Element[] {
    return [node, ...node.children.flat(Infinity).filter(child => child && typeof child === "object" && child.type).flatMap(elements)];
}
const fixture = () => ({ contract_version: 2, facts: [{ id: "F", allowed_values: ["a", "b"], value_descriptions: { a: "State A", b: "State B" } }], timelines: [{ id: "T" }], initial: [{ timeline_id: "T", fact_id: "F", value: "a" }], events: [], requirements: [], coverage: [] });
function harness(patch: Record<string, any> = {}, locale: any = zhCN) {
    const checks: string[] = [], saves: any[] = [], snapshots: string[] = [], notices: string[] = [];
    const c: Record<string, any> = {
        stable: JSON.stringify, formalLedger: fixture(), ledger: fixture(), editable: true, legacy: false,
        continuityLedgerFactDescriptions,
        changeDraft: undefined, sourceConflict: false, invalidLedgerDraft: false, busy: false, snapshotLoading: false,
        sourceHash: "source", report: { sourceHash: "source", snapshot: "draft", status: "passed", report: { diagnostics: [] } },
        subjectAssembly: true, ledgerV2: true, activeView: "workbench", entryFocus: "events:E", issues: [{}], titleAlreadyVisible: true,
        filterObject: "all", filterTarget: "all", objectOptions: [], targetOptions: [],
        continuityPreviewStatus, invalidEventPositions: [], lastDeletion: { rows: [] },
        t: (key: string, values: Record<string, any> = {}) => {
            const value = key.split(".").reduce((value: any, key) => value?.[key], locale);
            assert.equal(typeof value, "string", `Missing locale key: ${key}`);
            return value.replace(/{{(\w+)}}/g, (_: string, name: string) => String(values[name]));
        },
        React: { createElement: (type: string, props: any, ...children: any[]): Element => ({ type, props: props || {}, children }) },
        Dropdown: "Dropdown", Button: "Button", Select: "Select", Tag: "Tag", Popover: "Popover", ChevronDown: "ChevronDown", CircleHelp: "CircleHelp",
        setEntryFocus: (value: string) => { c.entryFocus = value; }, setActiveView: (value: string) => { c.activeView = value; },
        setFilterObject: (value: string) => { c.filterObject = value; }, setFilterTarget: (value: string) => { c.filterTarget = value; },
        onCheck: async () => { checks.push(c.report?.snapshot || "draft"); }, onSave: async (value: any) => { saves.push(value); return false; },
        setLastDeletion: (value: any) => { c.lastDeletion = value; }, onSnapshot: (value: string) => { snapshots.push(value); },
        message: { warning: (value: string) => { notices.push(value); } }, ...patch,
    };
    const refresh = () => {
        c.ledgerKey = c.stable(c.ledger);
        for (const name of ["ledgerDirty", "pendingLedgerEdits", "stateLabel", "checkBlockReason", "checkBlocked", "checkSavedLedger", "saveLedger", "reportCurrent", "readingViews", "managementViews", "viewName", "viewItems"]) c[name] = declaration(name, c);
        return elements(evaluate(header, c));
    };
    return { c, checks, saves, snapshots, notices, refresh, render: refresh() };
}
const checkAction = (render: Element[]) => render.find(node => node.props["data-continuity-check-action"])!;
const saveActions = (render: Element[]) => render.filter(node => node.props["data-continuity-save-action"]);
const blockedHint = (render: Element[]) => render.find(node => node.props["data-continuity-check-blocked"]);
const edited = () => ({ ...fixture(), initial: [{ timeline_id: "T", fact_id: "F", value: "b" }] });

test("the v2 ledger timeline has a direct entry regardless of Prompt version; management views stay grouped", () => {
    for (const subjectAssembly of [true, false]) for (const locale of [zhCN, enUS]) {
        const { c, render, refresh } = harness({ subjectAssembly, activeView: subjectAssembly ? "workbench" : "objects" }, locale);
        const dropdowns = render.filter(node => node.type === "Dropdown");
        assert.equal(dropdowns.length, 1);
        const menu = dropdowns[0].props.menu;
        const keys = menu.items.flatMap((group: any) => group.children.map((item: any) => item.key));
        assert.deepEqual(keys, ["objects", "shots", "timeline", "issues", "ledger", "boundaries"]);
        const timelineEntry = render.find(node => node.props["data-continuity-timeline-entry"]);
        assert.equal(Boolean(timelineEntry), true);
        if (timelineEntry) {
            timelineEntry.props.onClick();
            assert.equal(c.activeView, "workbench");
            assert.equal(c.entryFocus, "");
        }
        assert.equal(render.some(node => node.props["data-continuity-record-action"]), false);
        for (const key of keys) {
            menu.onClick({ key });
            assert.equal(c.activeView, key);
            assert.equal(c.entryFocus, "");
            const next = refresh();
            assert.deepEqual(next.find(node => node.type === "Dropdown")!.props.menu.selectedKeys, [key]);
            assert.equal(next.find(node => node.props["data-continuity-view-selector"])!.props["aria-label"], locale.director.workspace.continuity.views);
        }
    }
});

test("a source assembly version alone never exposes the ledger timeline without a saved v2 ledger", () => {
    const { render } = harness({ subjectAssembly: true, ledgerV2: false });
    assert.equal(render.some(node => node.props["data-continuity-timeline-entry"]), false);
});

test("clean draft/published checks use the selected saved snapshot without saving or adding a warning row", async () => {
    for (const snapshot of ["draft", "published"]) {
        const { c, checks, saves, render } = harness({ editable: snapshot === "draft", report: { sourceHash: "source", snapshot, status: "passed", report: {} } });
        assert.equal(checkAction(render).props.disabled, false);
        assert.equal(blockedHint(render), undefined);
        assert.equal(saveActions(render).length, 0);
        await c.checkSavedLedger();
        assert.deepEqual(checks, [snapshot]);
        assert.deepEqual(saves, []);
        assert.equal(c.stateLabel, "passed");
    }
});

test("unsaved ledger, unconfirmed change and invalid/conflicting drafts cannot check old content", async () => {
    for (const patch of [{ ledger: edited() }, { changeDraft: { shotId: "S", factId: "F", reason: "unfinished" } }, { sourceConflict: true }, { invalidLedgerDraft: true }]) {
        const { c, checks, saves, render } = harness(patch);
        assert.equal(c.stateLabel, "unsaved");
        assert.equal(c.reportCurrent, false);
        assert.equal(checkAction(render).props.disabled, true);
        assert.equal(blockedHint(render)?.props.role, "status");
        assert.ok(blockedHint(render)?.children[0]);
        assert.doesNotMatch(c.viewName("issues"), / · 1/);
        await c.checkSavedLedger();
        assert.deepEqual(checks, []);
        assert.deepEqual(saves, []);
    }
});

test("busy and switching snapshots block checking at both the button and handler", async () => {
    for (const patch of [{ busy: true }, { snapshotLoading: true }]) {
        const { c, checks, render } = harness(patch);
        assert.equal(checkAction(render).props.disabled, true);
        await c.checkSavedLedger();
        assert.deepEqual(checks, []);
    }
});

test("legacy diagnosis and an unchanged empty ledger are not false unsaved edits", async () => {
    const empty = { contract_version: 2, facts: [], timelines: [], initial: [], events: [], requirements: [], coverage: [] };
    for (const patch of [{ legacy: true, report: { sourceHash: "source", snapshot: "draft", status: "diagnosticOnly" } }, { formalLedger: empty, ledger: structuredClone(empty), report: undefined }]) {
        const { c, checks, render } = harness({ savedLedgerKey: "legacy", ...patch });
        assert.equal(c.ledgerDirty, false);
        assert.equal(c.pendingLedgerEdits, false);
        assert.equal(checkAction(render).props.disabled, false);
        assert.equal(blockedHint(render), undefined);
        assert.equal(c.stateLabel, patch.legacy ? "diagnosticOnly" : "unchecked");
        await c.checkSavedLedger();
        assert.deepEqual(checks, ["draft"]);
    }
    const { c, render } = harness({ formalLedger: empty, ledger: fixture() });
    assert.equal(c.ledgerDirty, true, "The first edit of a new ledger remains dirty");
    assert.equal(checkAction(render).props.disabled, true);
});

test("every view exposes the same sole save action when dirty, with all existing save guards", async () => {
    for (const activeView of ["workbench", "objects", "shots", "timeline", "issues", "ledger", "boundaries"]) {
        const { c, render, saves } = harness({ ledger: edited(), activeView });
        assert.equal(saveActions(render).length, 1);
        assert.equal(saveActions(render)[0].props.disabled, false);
        await saveActions(render)[0].props.onClick();
        assert.deepEqual(saves, [c.ledger]);
    }
    for (const patch of [{ busy: true }, { snapshotLoading: true }, { sourceConflict: true }, { invalidLedgerDraft: true }, { invalidEventPositions: [{}] }, { changeDraft: {} }]) {
        const { c, render, saves } = harness({ ledger: edited(), ...patch });
        assert.equal(saveActions(render)[0].props.disabled, true);
        await c.saveLedger();
        assert.deepEqual(saves, []);
    }
    assert.equal((source.match(/onClick=\{saveLedger\}/g) || []).length, 1, "The ledger and collapsed manual editor cannot retain duplicate save buttons");
});

test("save failure or an outstanding receipt retains dirty edits; saved props enable an explicit check", async () => {
    const { c, checks, refresh } = harness({ ledger: edited() });
    await c.saveLedger();
    assert.ok(c.lastDeletion);
    assert.equal(checkAction(refresh()).props.disabled, true);
    let finish!: (saved: boolean) => void;
    c.onSave = () => new Promise<boolean>(resolve => { finish = resolve; });
    const saving = c.saveLedger();
    assert.equal(checkAction(refresh()).props.disabled, true);
    await c.checkSavedLedger();
    assert.deepEqual(checks, []);
    finish(true);
    await saving;
    assert.equal(c.lastDeletion, undefined);
    assert.equal(checkAction(refresh()).props.disabled, true, "A success boolean cannot impersonate saved ledger props");
    c.formalLedger = structuredClone(c.ledger);
    c.sourceHash = "saved-revision";
    assert.equal(checkAction(refresh()).props.disabled, false);
    assert.equal(c.stateLabel, "stale", "The old report stays stale after saving changed source");
    assert.equal(c.reportCurrent, false);
    assert.deepEqual(checks, [], "Saving does not silently check");
    await c.checkSavedLedger();
    assert.deepEqual(checks, ["draft"]);
});

test("snapshot source remains separate from view and preserves the incomplete-change guard", () => {
    const { c, render, snapshots, notices, refresh } = harness();
    const select = render.find(node => node.type === "Select")!;
    assert.deepEqual(select.props.options.map((option: any) => option.value), ["draft", "published"]);
    assert.equal(select.props["aria-label"], "内容来源");
    select.props.onChange("published");
    assert.deepEqual(snapshots, ["published"]);
    assert.equal(c.activeView, "workbench");
    c.changeDraft = { shotId: "S" };
    refresh().find(node => node.type === "Select")!.props.onChange("draft");
    assert.deepEqual(snapshots, ["published"]);
    assert.equal(notices.length, 1);
    assert.ok(c.changeDraft);
});
