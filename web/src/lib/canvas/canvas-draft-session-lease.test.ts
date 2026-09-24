import assert from "node:assert/strict";
import test from "node:test";
import localforage from "localforage";

const stores = new Map<string, Map<string, unknown>>();
localforage.createInstance = ((options: { name: string }) => {
    const values = stores.get(options.name) || new Map<string, unknown>();
    stores.set(options.name, values);
    return {
        getItem: async (key: string) => values.get(key) ?? null,
        setItem: async (key: string, value: unknown) => { values.set(key, value); return value; },
        removeItem: async (key: string) => { values.delete(key); },
        iterate: async (visit: (value: unknown, key: string) => void) => values.forEach(visit),
    };
}) as unknown as typeof localforage.createInstance;

const storage = () => {
    const values = new Map<string, string>();
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
    } as Storage;
};
const local = storage(), sessionStorageMock = storage();
sessionStorageMock.setItem("canvas-draft-session", "old-owner");
sessionStorageMock.setItem("backend-connection", JSON.stringify({ url: "http://backend", token: "token" }));
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local });
Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: sessionStorageMock });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
const listeners = new Map<string, (event: Event) => void>();
Object.defineProperty(globalThis, "window", { configurable: true, value: {
    addEventListener: (name: string, listener: (event: Event) => void) => listeners.set(name, listener),
    dispatchEvent: () => true,
    location: { reload: () => undefined },
} });

const calls: Array<{ method: string; path: string; holderId: string }> = [];
Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) as { holderId?: string } : {};
    const holderId = body.holderId || url.searchParams.get("holderId") || "";
    calls.push({ method: init?.method || "GET", path: url.pathname, holderId });
    if (url.pathname.endsWith("/old-owner/acquire")) return new Response(JSON.stringify({ lease: { active: true, owned: false, expiresAt: Date.now() + 30_000 } }), { status: 409, headers: { "Content-Type": "application/json" } });
    if (url.pathname.endsWith("/old-owner/lease")) return Response.json({ ok: true, lease: { active: true, owned: false, expiresAt: Date.now() + 30_000 } });
    if (url.pathname.endsWith("/acquire")) return Response.json({ ok: true, lease: { active: true, owned: true, expiresAt: Date.now() + 30_000 } });
    if (url.pathname.endsWith("/release")) return Response.json({ ok: true, released: true });
    return new Response("not found", { status: 404 });
} });

const drafts = await import("./canvas-draft-session");

test("无 Web Locks 时由 Backend 阻止重复 owner，并支持状态查询、临时导入和正常关闭释放", async () => {
    await drafts.initializeCanvasDraftSession();
    const owner = drafts.getCanvasDraftSessionId();
    assert.notEqual(owner, "old-owner");
    assert.equal(sessionStorageMock.getItem("canvas-draft-session"), owner);
    assert.equal(await drafts.canvasDraftOwnerActive("old-owner"), true);
    let ran = false;
    await drafts.withCanvasDraftOwner("import-owner", async () => { ran = true; });
    assert.equal(ran, true);
    assert.ok(calls.some((call) => call.path.endsWith("/import-owner/acquire")));
    assert.ok(calls.some((call) => call.path.endsWith("/import-owner/release")));

    listeners.get("pagehide")?.({ persisted: false } as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(calls.some((call) => decodeURIComponent(call.path).endsWith(`/${owner}/release`)));
    assert.match(sessionStorageMock.getItem("canvas-draft-lease-handoff") || "", new RegExp(owner));
});
