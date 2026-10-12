import assert from "node:assert/strict";
import test from "node:test";
import { registerCanvasBrowserScriptRoutes } from "./browser-script-routes.js";

test("browser route contract returns nonce only on claim and forwards it for every mutation", () => {
    const routes = new Map<string, (req: any, res: any) => void>();
    const calls: { name: string; args: unknown[] }[] = [];
    const dispatcher = Object.fromEntries(["claim", "checkpoint", "complete", "fail", "release"].map(name => [name, (...args: unknown[]) => {
        calls.push({ name, args }); return name === "claim" ? { task: { id: "task" }, claimToken: "nonce" } : { id: "task" };
    }]));
    registerCanvasBrowserScriptRoutes({ post: (path: string, handler: any) => routes.set(path, handler) } as never, dispatcher as never);
    const request = (action: string, body: any) => {
        let status = 200, result: any;
        const response = { status(value: number) { status = value; return response; }, json(value: unknown) { result = value; return response; } };
        routes.get(`/canvas/browser-tasks/:id/${action}`)!({ params: { id: "task" }, body }, response);
        return { status, result };
    };
    assert.deepEqual(request("claim", { workerId: "worker" }), { status: 200, result: { ok: true, task: { id: "task" }, claimToken: "nonce" } });
    for (const action of ["checkpoint", "complete", "fail", "release"]) {
        assert.equal(request(action, { workerId: "worker" }).status, 409);
        const count = calls.length;
        const response = request(action, { workerId: "worker", claimToken: "nonce", recovery: { version: 1 }, result: { texts: ["mock"] }, terminalConfirmed: true });
        assert.equal(response.status, 200); assert.equal(response.result.claimToken, undefined);
        assert.equal(calls.length, count + 1); assert.ok(calls.at(-1)!.args.includes("nonce"));
    }
    assert.equal(calls.find(call => call.name === "fail")!.args.at(-2), true);
    assert.deepEqual(request("claim", {}), { status: 409, result: { ok: false, error: "workerId 必填" } });
    assert.deepEqual([...routes.keys()], ["claim", "checkpoint", "complete", "fail", "release"].map(action => `/canvas/browser-tasks/:id/${action}`));
});
