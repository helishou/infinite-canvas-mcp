import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowExecutor } from "./executor.js";

const image = (filename: string) => ({ images: [{ filename, type: "output", subfolder: "" }] });
for (const scenario of ["running-history", "cached", "ws-events", "subset", "all-cached"] as const) {
    test(`multi-output completion: ${scenario}`, async (t) => {
        let socket: any, reads = 0;
        const archived: string[] = [];
        const selected = scenario === "subset" ? ["237"] : scenario === "all-cached" ? [] : ["237", "812"];
        class Socket {
            onmessage: any;
            constructor() { socket = this; }
            close() {}
            emit(type: string, data: object) { this.onmessage({ data: JSON.stringify({ type, data: { prompt_id: "multi", ...data } }) }); }
        }
        const previous = globalThis.WebSocket;
        (globalThis as any).WebSocket = Socket;
        t.mock.method(globalThis, "setTimeout", ((fn: () => void) => { queueMicrotask(fn); return 0; }) as any);
        t.mock.method(globalThis, "fetch", async (url: any) => {
            if (String(url).endsWith("/prompt")) return Response.json({ prompt_id: "multi" });
            if (String(url).includes("/history/")) {
                reads++;
                assert.ok(reads < 5, "completion must resolve from bounded replay");
                if (reads === 1) {
                    socket.emit("executed", { node: "237", output: image("237.png") });
                    if (scenario === "cached" || scenario === "all-cached") socket.emit("execution_success", {});
                    return Response.json(scenario === "running-history" ? { multi: { outputs: { "237": image("237.png") }, status: { status_str: "running", completed: false } } } : {});
                }
                assert.equal(archived.length, 0, "node executed / partial history must not trigger archival");
                if (scenario === "ws-events" || scenario === "subset") {
                    socket.emit("executed", { node: "812", output: image("812.png") });
                    socket.emit("execution_success", {});
                    return Response.json({});
                }
                return Response.json({ multi: { outputs: { "237": image("237.png"), "812": image("812.png"), "818": { text: ["not an image"] } }, status: { status_str: "success", completed: true } } });
            }
            if (String(url).includes("/view?")) {
                const filename = new URL(String(url)).searchParams.get("filename")!;
                archived.push(filename);
                return new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } });
            }
            throw new Error(`unexpected fetch ${url}`);
        });
        const media = { async storeStream(stream: AsyncIterable<Uint8Array>) { for await (const _ of stream) {} return { storageKey: `image:${archived.at(-1)}`, mimeType: "image/png" }; }, url: (key: string) => `/media/${key}` };
        const executor = new WorkflowExecutor({} as never, { addEvent() {} } as never, media as never);
        try {
            const result = await (executor as any).executeWorkflow({ id: "test" }, {}, "http://comfy.test", new AbortController(), "client", selected);
            assert.deepEqual(archived, scenario === "subset" ? ["237.png"] : ["237.png", "812.png"]);
            assert.equal(result.media.length, scenario === "subset" ? 1 : 2);
            assert.ok(reads >= 2);
        } finally { (globalThis as any).WebSocket = previous; }
    });
}
