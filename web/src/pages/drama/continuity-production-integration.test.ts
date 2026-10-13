import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { isSubjectPromptAssembly } from "@basketikun/canvas-agent/drama/production-contract";
import { commandNeedsRecovery, commandFailureRecord, normalizeCommandRecovery, commandErrorSummary } from "./production-command-recovery";
import { readContinuityLedgerDraft } from "./continuity-ledger-draft";
import { continuityPreviewStatus } from "./continuity-timeline-model";

// Execute the actual private production handlers, replacing only network, storage,
// and React state boundaries. These are not Backend transaction or browser tests.
const source = readFileSync(new URL("./production.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("production.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function handler(name: string, context: Record<string, any>): (...args: any[]) => any {
    let expression: string | undefined;
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isCallExpression(node.initializer) && ts.isArrowFunction(node.initializer.arguments[0]))) {
            assert.equal(expression, undefined, `${name} must be unambiguous`);
            expression = (ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer).getText(ast);
        }
        ts.forEachChild(node, visit);
    };
    visit(ast);
    assert.ok(expression, `Actual production handler ${name} must exist`);
    const js = ts.transpileModule(`const extracted = ${expression};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    return new Function("context", `with (context) { ${js}; return extracted; }`)(context);
}
class TestBackendApiError extends Error {
    constructor(message: string, readonly status: number, readonly details: Record<string, unknown> = {}) { super(message); }
}
const fixture = () => ({
    contract_version: 2,
    facts: [{ id: "position", allowed_values: ["outside", "inside"], display_name: "Position" }],
    timelines: [{ id: "main" }],
    initial: [{ timeline_id: "main", fact_id: "position", value: "outside" }],
    events: [{ id: "entry", timeline_id: "main", fact_id: "position", after: "inside" }],
    requirements: [{ id: "hold", fact_id: "position", shot_id: "shot-2", value: "inside" }],
    coverage: [{ id: "evidence", fact_ids: ["position"], shot_ids: ["shot-2"], source_digest: "retained-evidence" }],
});
function harness() {
    const ledger = fixture();
    const calls: any[] = [], writes: any[] = [], failures: unknown[] = [], checks: any[] = [];
    let sequence = 0;
    const context: Record<string, any> = {
        production: { episodeId: "fixture", revision: 17, draft: { director: { source: { prompt_assembly: { version: 2 }, ledger } } } },
        target: { kind: "episode", id: "fixture" }, workspace: "continuity", busy: false,
        draftKey: "test-only", briefDraft: "", sourceDrafts: {}, remoteRevision: null, pendingRunStart: null,
        pendingCommandRef: { current: null }, commandNoticeRef: { current: null }, pendingCommand: null,
        commandNeedsRecovery, commandFailureRecord, normalizeCommandRecovery, commandErrorSummary, isSubjectPromptAssembly, BackendApiError: TestBackendApiError,
        useAgentStore: { getState: () => ({ conversation: { status: "idle" } }) },
        t: (key: string) => key, message: { warning() {}, success() {} }, nanoid: () => `test-op-${++sequence}`,
        setBusy: (value: boolean) => { context.busy = value; },
        setPendingCommand: (value: unknown) => { context.pendingCommand = value; },
        setProduction: (update: (value: any) => any) => { context.production = update(context.production); },
        setRemoteRevision: (value: unknown) => { context.remoteRevision = value; },
        ensureCanvasDraftLease: async () => undefined,
        writeLocalDraft: async (_key: string, value: unknown) => { writes.push(structuredClone(value)); },
        pendingCommandMessage: () => "pending command", warnPendingCommand: () => undefined,
        fail: (error: unknown) => { failures.push(error); }, refreshRemote: async () => undefined,
        editEpisodeProduction: async (...args: any[]) => {
            calls.push(structuredClone(args));
            if (context.backendError) throw context.backendError;
            return { production: { ...context.production, revision: context.production.revision + 1 } };
        },
        continuitySnapshot: "draft", continuityReport: undefined, continuityOwnerKey: "episode:fixture", continuityCheckRef: { current: null },
        continuityReadRef: { current: { ownerKey: "episode:fixture", snapshot: "draft", displayedSnapshot: "draft", loading: false, selection: 0, sequence: 0, active: true } },
        setContinuitySnapshotLoading: (value: boolean) => { context.continuitySnapshotLoading = value; },
        setContinuitySnapshot: (value: string) => { context.continuitySnapshot = value; },
        checkProductionContinuity: async (...args: any[]) => { checks.push(structuredClone(args)); },
        fetchProductionContinuity: async (_target: unknown, options: object) => ({ continuity: { status: "stale", ...options } }),
        fetchProductionReadiness: async () => ({ readiness: {} }),
        setContinuityReport: (value: unknown) => { context.continuityReport = value; }, setReadiness: () => undefined,
    };
    for (const name of ["beginContinuityRead", "finishContinuityRead", "pending", "sendCommand", "edit", "saveContinuity", "recoverPending", "checkContinuity", "changeContinuitySnapshot"]) context[name] = handler(name, context);
    return { context, ledger, calls, writes, failures, checks };
}

test("real save emits granular subject ledger changes and treats unchanged input as no request", async () => {
    const { context, ledger, calls, writes } = harness();
    assert.equal(await context.saveContinuity(structuredClone(ledger)), true);
    assert.equal(calls.length, 0);
    const next = structuredClone(ledger);
    next.facts[0].display_name = "Location";
    next.initial[0].value = "inside";
    next.events = [];
    context.sourceDrafts.v2ledger = JSON.stringify({ version: 1, base: ledger, value: next });
    assert.equal(await context.saveContinuity(next), true);
    const [target, revision, ops, operationId] = calls[0];
    assert.deepEqual(target, context.target);
    assert.equal(revision, 17);
    assert.equal(operationId, "test-op-1");
    assert.deepEqual(ops, [{ type: "edit_director_continuity", changes: [
        { collection: "facts", action: "upsert", id: "position", value: next.facts[0] },
        { collection: "initial", action: "upsert", id: "main:position", value: next.initial[0] },
        { collection: "events", action: "delete", id: "entry" },
    ] }]);
    assert.deepEqual(next.requirements, ledger.requirements);
    assert.deepEqual(next.coverage, ledger.coverage);
    assert.deepEqual(writes[0].pendingCommand.ops, ops);
    assert.equal(writes[0].pendingCommand.expectedRevision, 17);
    assert.equal(writes.at(-1).pendingCommand, null);
});

test("requirements and coverage changes survive the real save adapter", async () => {
    const { context, ledger, calls } = harness();
    const next = structuredClone(ledger);
    next.requirements[0].value = "outside";
    next.coverage[0].source_digest = "updated-evidence";
    await context.saveContinuity(next);
    assert.deepEqual(calls[0][2][0].changes.map((change: any) => change.collection), ["requirements", "coverage"]);
});

test("validation rejection retains ledger input and permits a corrected submission", async () => {
    const { context, ledger, calls, writes } = harness();
    const next = structuredClone(ledger);
    next.initial[0].value = "invalid";
    const raw = JSON.stringify({ version: 1, base: ledger, value: next });
    context.sourceDrafts.v2ledger = raw;
    context.backendError = new TestBackendApiError("Invalid state", 400);
    assert.equal(await context.saveContinuity(next), false);
    assert.equal(writes.at(-1).sourceDrafts.v2ledger, raw);
    assert.equal(readContinuityLedgerDraft(writes.at(-1).sourceDrafts.v2ledger, ledger).value.initial[0].value, "invalid");
    assert.equal(writes.at(-1).pendingCommand.status, "rejected");
    assert.equal(context.pendingCommandRef.current, null);
    delete context.backendError;
    next.initial[0].value = "inside";
    assert.equal(await context.saveContinuity(next), true);
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0][3], calls[1][3]);
});

test("unknown outcome recovers the original operation/revision; version conflict does not resubmit", async () => {
    const { context, ledger, calls, writes } = harness();
    const next = structuredClone(ledger);
    next.initial[0].value = "inside";
    context.sourceDrafts.v2ledger = JSON.stringify({ version: 1, base: ledger, value: next });
    context.backendError = new Error("Connection interrupted");
    assert.equal(await context.saveContinuity(next), false);
    assert.equal(writes.at(-1).pendingCommand.status, "unknown");
    next.initial[0].value = "newer unsaved edit";
    context.production.revision = 22;
    delete context.backendError;
    await context.recoverPending();
    assert.deepEqual(calls[1], calls[0], "Recovery cannot invent a new ID or revision");
    assert.equal(calls[1][2][0].changes[0].value.value, "inside");
    context.backendError = new TestBackendApiError("Revision conflict", 409, { code: "REVISION_CONFLICT" });
    assert.equal(await context.saveContinuity(next), false);
    const count = calls.length;
    assert.equal(await context.saveContinuity(next), false);
    assert.equal(calls.length, count);
    assert.equal(context.pendingCommandRef.current.status, "rejected");
});

test("check targets the saved snapshot without silently saving or discarding local ledger changes", async () => {
    for (const snapshot of ["draft", "published"]) {
        const { context, ledger, calls, writes, checks } = harness();
        const next = structuredClone(ledger);
        next.initial[0].value = "inside";
        const raw = JSON.stringify({ version: 1, base: ledger, value: next });
        context.sourceDrafts.v2ledger = raw;
        context.continuitySnapshot = snapshot;
        context.continuityReadRef.current.snapshot = snapshot;
        await context.checkContinuity();
        assert.deepEqual(checks[0][1], { expectedRevision: 17, operationId: "test-op-1", snapshot });
        assert.equal(calls.length, 0);
        assert.equal(writes.length, 0);
        assert.equal(context.sourceDrafts.v2ledger, raw);
        assert.deepEqual(context.continuityReport, { status: "stale", snapshot });
    }
});

test("real DirectorPanel routes formal data and disables published draft writes", () => {
    const panel = readFileSync(new URL("./director-panel.tsx", import.meta.url), "utf8");
    const tree = ts.createSourceFile("director-panel.tsx", panel, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const attributes = new Map<string, string>();
    const visit = (node: ts.Node) => {
        if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(tree) === "ContinuityPanel") {
            for (const property of node.attributes.properties) {
                if (ts.isJsxAttribute(property)) attributes.set(property.name.getText(tree), property.initializer?.getText(tree) || "");
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(tree);
    assert.match(attributes.get("ledger") || "", /continuitySource\?\.source\.ledger/);
    assert.match(attributes.get("onSave") || "", /onSaveContinuity/);
    assert.match(attributes.get("onCheck") || "", /onCheckContinuity/);
    assert.match(attributes.get("editable") || "", /continuityReport\?\.snapshot !== "published"/);
    assert.match(attributes.get("draftValue") || "", /snapshot !== "published" \? sourceDrafts\.v2ledger : undefined/);
    assert.match(attributes.get("onDraftChange") || "", /snapshot !== "published" \? value => onSourceDraftChange\("v2ledger", value\) : undefined/);
    assert.match(source, /onSaveContinuity=\{saveContinuity\}/);
    assert.match(source, /onCheckContinuity=\{checkContinuity\}/);
});

function deferred<T = any>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const settle = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };

test("rapid published/draft reads cannot let the earlier snapshot replace the current report", async () => {
    const { context } = harness();
    const requests: { snapshot: string; result: ReturnType<typeof deferred> }[] = [];
    context.fetchProductionContinuity = (_target: unknown, { snapshot }: { snapshot: string }) => {
        const result = deferred(); requests.push({ snapshot, result }); return result.promise;
    };
    context.changeContinuitySnapshot("published");
    context.changeContinuitySnapshot("draft");
    assert.deepEqual(requests.map(request => request.snapshot), ["published", "draft"]);
    requests[1].result.resolve({ continuity: { snapshot: "draft", status: "stale" } });
    await settle();
    requests[0].result.resolve({ continuity: { snapshot: "published", status: "passed" } });
    await settle();
    assert.deepEqual(context.continuityReport, { snapshot: "draft", status: "stale" });
    assert.equal(context.busy, false);
});

test("late check result cannot overwrite a newly selected published report or its readiness", async () => {
    const { context } = harness();
    const checked = deferred();
    context.checkProductionContinuity = () => checked.promise;
    const checking = context.checkContinuity();
    context.changeContinuitySnapshot("published");
    await settle();
    checked.resolve({});
    await checking;
    assert.deepEqual(context.continuityReport, { status: "stale", snapshot: "published" });
    assert.equal(context.busy, false);
});

test("late check read and obsolete errors are ignored after switching snapshots", async () => {
    const { context, failures } = harness();
    const oldReport = deferred();
    let reads = 0, readinessWrites = 0;
    context.setReadiness = () => { readinessWrites++; };
    context.fetchProductionContinuity = (_target: unknown, { snapshot }: { snapshot: string }) => {
        reads++;
        return snapshot === "draft" ? oldReport.promise : Promise.resolve({ continuity: { snapshot, status: "passed" } });
    };
    const checking = context.checkContinuity();
    await settle();
    context.changeContinuitySnapshot("published");
    await settle();
    oldReport.reject(new Error("Obsolete draft read failed"));
    await checking;
    assert.equal(reads, 2);
    assert.equal(readinessWrites, 0);
    assert.deepEqual(failures, []);
    assert.deepEqual(context.continuityReport, { snapshot: "published", status: "passed" });
});

test("shared report guard rejects delayed load/refresh responses and invalidated owner lifetimes", async () => {
    const { context } = harness();
    const loading = context.beginContinuityRead();
    const refreshing = context.beginContinuityRead();
    assert.equal(loading.isCurrent(), false);
    assert.equal(refreshing.isCurrent(), true);
    context.changeContinuitySnapshot("published");
    assert.equal(refreshing.isCurrent(), false);
    await settle();
    const oldOwner = context.beginContinuityRead();
    const oldScope = context.continuityReadRef.current;
    context.continuityReadRef.current = { ownerKey: "episode:new-owner", snapshot: "published", displayedSnapshot: "published", loading: false, selection: 0, sequence: 0, active: true };
    assert.equal(oldOwner.isOwnerCurrent(), false);
    assert.equal(oldOwner.isCurrent(), false);
    // Even switching back to the same owner must not revive a captured old scope.
    context.continuityReadRef.current = { ...oldScope };
    assert.equal(oldOwner.isCurrent(), false);
    const unmounting = context.beginContinuityRead();
    context.continuityReadRef.current.active = false;
    context.continuityReadRef.current.sequence++;
    assert.equal(unmounting.isOwnerCurrent(), false);
    assert.equal(unmounting.isCurrent(), false);
});

test("initial load and refresh both use the shared report guard", () => {
    for (const name of ["load", "refreshRemote"]) {
        let declaration = "";
        const visit = (node: ts.Node) => {
            if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) declaration = node.getText(ast);
            ts.forEachChild(node, visit);
        };
        visit(ast);
        assert.match(declaration, /const continuityRead = beginContinuityRead\(\)/);
        assert.match(declaration, /fetchProductionContinuity\(target, \{ snapshot: continuityRead.snapshot \}\)/);
        assert.match(declaration, /finishContinuityRead\(continuityRead, continuity.continuity\)/);
    }
});

test("a background refresh cannot suppress the result of a check still on the same snapshot", async () => {
    const { context } = harness();
    const checked = deferred();
    context.checkProductionContinuity = () => checked.promise;
    const checking = context.checkContinuity();
    const backgroundRead = context.beginContinuityRead();
    assert.equal(backgroundRead.isCurrent(), true);
    context.fetchProductionContinuity = async () => ({ continuity: { snapshot: "draft", status: "passed" } });
    checked.resolve({});
    await checking;
    assert.equal(backgroundRead.isCurrent(), false);
    assert.deepEqual(context.continuityReport, { snapshot: "draft", status: "passed" });
    assert.equal(context.busy, false);
});

test("a check cannot revive after a published/draft round trip", async () => {
    const { context } = harness();
    const checked = deferred();
    context.checkProductionContinuity = () => checked.promise;
    const checking = context.checkContinuity();
    context.changeContinuitySnapshot("published");
    context.changeContinuitySnapshot("draft");
    await settle();
    context.fetchProductionContinuity = async () => { assert.fail("Obsolete check must not fetch a report"); };
    checked.resolve({});
    await checking;
    assert.deepEqual(context.continuityReport, { snapshot: "draft", status: "stale" });
    assert.equal(context.busy, false);
});

test("actual initial load and refresh cannot replace a newer selected snapshot", async () => {
    for (const operation of ["load", "refreshRemote"]) {
        const { context } = harness();
        const oldReport = deferred();
        Object.assign(context, {
            projectId: "", episodeId: "fixture", canvasId: "", remoteSequence: { current: 0 },
            refreshInFlight: { current: null }, refreshQueued: { current: false },
            fetchBackendDramaEpisode: async () => ({ episode: { id: "fixture", dramaId: "drama", title: "Fixture", canvasId: "" } }),
            fetchEpisodeProduction: async () => ({ production: context.production }),
            fetchEpisodeProductionVersions: async () => ({ versions: [] }),
            fetchProductionBatches: async () => ({ runs: [] }),
            fetchBackendProject: async () => ({ project: null }),
            setEpisode() {}, setProductionContext() {}, setTitle() {}, setCanvasId() {}, setCanvasRead() {},
            setProduction() {}, setVersions() {}, setBatches() {}, setRuntimeTasks() {}, setBriefDraft() {}, setLoadError() {},
            fetchProductionContinuity: (_target: unknown, { snapshot }: { snapshot: string }) => snapshot === "draft" ? oldReport.promise : Promise.resolve({ continuity: { snapshot: "published", status: "passed" } }),
        });
        context[operation] = handler(operation, context);
        const pending = context[operation]();
        context.changeContinuitySnapshot("published");
        await settle();
        oldReport.resolve({ continuity: { snapshot: "draft", status: "stale" } });
        await pending;
        assert.deepEqual(context.continuityReport, { snapshot: "published", status: "passed" }, operation);
    }
});

test("an old owner's or unmounted check cannot write a report or release another operation's busy state", async () => {
    for (const invalidation of ["owner", "unmount"]) {
        const { context } = harness();
        const checked = deferred();
        context.checkProductionContinuity = () => checked.promise;
        const pending = context.checkContinuity();
        if (invalidation === "owner") {
            context.continuityReadRef.current = { ownerKey: "episode:other", snapshot: "draft", displayedSnapshot: "draft", loading: false, selection: 0, sequence: 0, active: true };
        } else {
            context.continuityReadRef.current.active = false;
            context.continuityReadRef.current.sequence++;
        }
        checked.resolve({});
        await pending;
        assert.equal(context.continuityReport, undefined);
        assert.equal(context.busy, true, "The obsolete owner's finally must not clear current busy state");
    }
});

test("snapshot loading blocks check only locally and failure restores the displayed snapshot", async () => {
    const { context, checks, failures } = harness();
    context.continuityReport = { snapshot: "draft", status: "passed" };
    const switching = deferred();
    context.fetchProductionContinuity = () => switching.promise;
    context.changeContinuitySnapshot("published");
    assert.equal(context.continuitySnapshotLoading, true);
    assert.equal(context.busy, false, "Other workspaces must not be locked by a snapshot read");
    await context.checkContinuity();
    assert.equal(checks.length, 0);
    switching.reject(new Error("Published snapshot unavailable"));
    await settle();
    assert.equal(context.continuitySnapshotLoading, false);
    assert.equal(context.continuitySnapshot, "draft");
    assert.equal(context.continuityReadRef.current.snapshot, "draft");
    assert.deepEqual(context.continuityReport, { snapshot: "draft", status: "passed" });
    assert.equal(failures.length, 1);
    context.fetchProductionContinuity = async () => ({ continuity: { snapshot: "draft", status: "passed" } });
    await context.checkContinuity();
    assert.equal(checks[0][1].snapshot, "draft");
});

test("an intervening failed refresh cannot strand a pending snapshot loading state", async () => {
    const { context } = harness();
    const switching = deferred();
    context.fetchProductionContinuity = () => switching.promise;
    context.changeContinuitySnapshot("published");
    const refresh = context.beginContinuityRead();
    assert.equal(context.finishContinuityRead(refresh), true);
    assert.equal(context.continuitySnapshotLoading, false);
    assert.equal(context.continuityReadRef.current.snapshot, "draft");
    switching.resolve({ continuity: { snapshot: "published", status: "passed" } });
    await settle();
    assert.equal(context.continuityReport, undefined);
});

test("ordinary background read failure does not invalidate a same-snapshot check", async () => {
    const { context } = harness();
    const check = context.beginContinuityRead();
    const background = context.beginContinuityRead();
    assert.equal(context.finishContinuityRead(background), false);
    assert.equal(check.isSelectionCurrent(), true);
});

function expressionFrom(file: string, name: string) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let expression = "";
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name && node.initializer) expression = node.initializer.getText(tree);
        ts.forEachChild(node, visit);
    };
    visit(tree);
    assert.ok(expression, `${name} must be present in ${file}`);
    return expression;
}

test("actual panel status cannot borrow a saved pass for dirty inputs, while published remains independent", () => {
    const dirty = expressionFrom("./continuity-panel.tsx", "ledgerDirty");
    const pending = expressionFrom("./continuity-panel.tsx", "pendingLedgerEdits");
    const label = expressionFrom("./continuity-panel.tsx", "stateLabel");
    const status = new Function("context", `with (context) { const ledgerDirty = ${dirty}; const pendingLedgerEdits = ${pending}; return ${label}; }`);
    const context = { continuityPreviewStatus, editable: true, legacy: false, changeDraft: undefined, sourceConflict: false, invalidLedgerDraft: false, stable: (value: string) => value, formalLedger: "saved", ledgerKey: "new draft", sourceHash: "draft-hash", report: { status: "passed", sourceHash: "draft-hash" } };
    assert.equal(status(context), "unsaved");
    assert.equal(status({ ...context, ledgerKey: "saved" }), "passed");
    assert.equal(status({ ...context, ledgerKey: "saved", sourceHash: "new-hash" }), "stale");
    assert.equal(status({ ...context, editable: false, sourceHash: "published-hash", report: { snapshot: "published", status: "passed", sourceHash: "published-hash" } }), "passed");
});

test("missing published source cannot be replaced by the editable draft", () => {
    const expression = expressionFrom("./director-panel.tsx", "continuitySource");
    const read = new Function("context", `with (context) { return ${expression}; }`);
    const draft = { source: { ledger: fixture() } };
    assert.equal(read({ continuityReport: { snapshot: "published" }, production: {}, d: draft }), undefined);
    const published = { source: { ledger: { ...fixture(), events: [] } } };
    assert.equal(read({ continuityReport: { snapshot: "published" }, production: { published: { director: published } }, d: draft }), published);
    assert.equal(read({ continuityReport: { snapshot: "draft" }, production: { published: { director: published } }, d: draft }), draft);
    const panel = readFileSync(new URL("./director-panel.tsx", import.meta.url), "utf8");
    assert.match(panel, /data-continuity-empty-published/);
    assert.match(panel, /busy=\{busy \|\| continuitySnapshotLoading\} snapshotLoading=\{continuitySnapshotLoading\}/);
});

test("a superseded check cannot fetch a report or release a newer check's busy state", async () => {
    const { context } = harness();
    const first = deferred(), second = deferred();
    let checks = 0, reads = 0;
    context.checkProductionContinuity = () => (++checks === 1 ? first : second).promise;
    context.fetchProductionContinuity = async () => { reads++; return { continuity: { snapshot: "draft", status: "passed" } }; };
    const previous = context.checkContinuity();
    context.busy = false; // Simulate a newer allowed operation taking ownership.
    const current = context.checkContinuity();
    first.resolve({});
    await previous;
    assert.equal(reads, 0);
    assert.equal(context.busy, true);
    second.resolve({});
    await current;
    assert.equal(reads, 1);
    assert.equal(context.busy, false);
});

test("blocked workspace navigation preserves the mounted continuity form; approved routes synchronize through the existing effect", () => {
    let workspace = "continuity", routeWorkspace = "continuity", blocked = true;
    const updates: string[] = [];
    const context: Record<string, any> = {
        useProductionFollowStore: { getState: () => ({ pause() {} }) }, t: (key: string) => key,
        setWorkspace: (value: string) => { updates.push(value); workspace = value; },
        searchParams: {}, embedded: false,
        productionWorkspaceQuery: (_: unknown, next: string) => next,
        setSearchParams: (next: string) => { if (!blocked) routeWorkspace = next; },
    };
    const navigate = handler("navigateWorkspace", context);
    navigate("shots");
    assert.equal(routeWorkspace, "continuity"); assert.equal(workspace, "continuity"); assert.deepEqual(updates, []);
    let effect: string | undefined;
    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" && ts.isArrowFunction(node.arguments[0]) && node.arguments[0].getText(ast).includes("workspace !== routeWorkspace")) effect = node.arguments[0].getText(ast);
        ts.forEachChild(node, visit);
    }; visit(ast); assert.ok(effect);
    blocked = false; navigate("shots"); assert.equal(workspace, "continuity"); assert.equal(routeWorkspace, "shots");
    const js = ts.transpileModule(`const sync = ${effect};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    const sync = new Function("context", `with(context) { ${js}; return sync; }`)({ ...context, routeWorkspace, workspace, productionWorkspaces: ["continuity", "shots"], series: undefined });
    sync(); assert.equal(workspace, "shots"); assert.deepEqual(updates, ["shots"]);
});
