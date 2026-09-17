import assert from "node:assert/strict";
import test from "node:test";

test("窗口连接固定，其他窗口修改默认地址不影响在途请求；切换仅准备下一次加载", async () => {
    const mockStorage = () => {
        const values = new Map<string, string>();
        return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } } as Storage;
    };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: mockStorage() });
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: mockStorage() });
    localStorage.setItem("backend-url", "http://first:17370");
    localStorage.setItem("backend-token", "first-token");
    const { backendConnection, persistBackendConnection, updateBackendToken } = await import("./backend-connection");
    assert.deepEqual(backendConnection(), { url: "http://first:17370", token: "first-token" });
    localStorage.setItem("backend-url", "http://other:17370");
    localStorage.setItem("backend-token", "other-token");
    assert.deepEqual(backendConnection(), { url: "http://first:17370", token: "first-token" });
    updateBackendToken("refreshed");
    assert.equal(backendConnection().url, "http://first:17370");
    persistBackendConnection({ url: "http://next:17370", token: "next-token" });
    assert.deepEqual(backendConnection(), { url: "http://first:17370", token: "refreshed" });
    assert.deepEqual(JSON.parse(sessionStorage.getItem("backend-connection")!), { url: "http://next:17370", token: "next-token" });
});
