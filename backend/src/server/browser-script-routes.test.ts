import assert from "node:assert/strict";
import test from "node:test";

import { registerCanvasBrowserScriptRoutes } from "./browser-script-routes.js";

type Route = { path: string; handler: (req: any, res: any) => void };

test("浏览器脚本路由要求 workerId，并把认领与结果交给同一调度器", () => {
    const routes: Route[] = [];
    const calls: unknown[] = [];
    const dispatcher = {
        claim: (...args: unknown[]) => { calls.push(["claim", ...args]); return { id: "t", status: "running" }; },
        complete: (...args: unknown[]) => { calls.push(["complete", ...args]); return { id: "t", status: "succeeded" }; },
        fail: () => ({}), release: () => ({}),
    };
    registerCanvasBrowserScriptRoutes({ post: (path: string, handler: Route["handler"]) => routes.push({ path, handler }) } as never, dispatcher as never);
    assert.deepEqual(routes.map((route) => route.path), [
        "/canvas/browser-tasks/:id/claim", "/canvas/browser-tasks/:id/complete",
        "/canvas/browser-tasks/:id/fail", "/canvas/browser-tasks/:id/release",
    ]);

    let response: any;
    const res = { statusCode: 200, status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { response = body; } };
    routes[0].handler({ params: { id: "t" }, body: {} }, res);
    assert.equal(res.statusCode, 409);
    assert.deepEqual(response, { ok: false, error: "workerId 必填" });

    routes[0].handler({ params: { id: "t" }, body: { workerId: "tab-a" } }, res);
    routes[1].handler({ params: { id: "t" }, body: { workerId: "tab-a", result: { texts: ["ok"] } } }, res);
    assert.deepEqual(calls, [["claim", "t", "tab-a"], ["complete", "t", "tab-a", { texts: ["ok"] }]]);
});
