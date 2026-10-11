import assert from "node:assert/strict";
import test from "node:test";

test("部署默认连接使用访问者的网页来源和代理前缀；不向运行期配置存密钥", async () => {
    const { defaultBackendUrl, normalizeBackendAddress } = await import("./backend-connection");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://canvas.example.com" }, __RUNTIME_CONFIG__: { BACKEND_URL: "/api" } } });
    try {
        assert.equal(defaultBackendUrl(), "https://canvas.example.com/api");
        assert.equal(normalizeBackendAddress("https://canvas.example.com/api/"), "https://canvas.example.com/api");
        assert.equal(normalizeBackendAddress("http://localhost:17370/"), "http://localhost:17370");
        for (const value of ["https://user:secret@example.com/api", "https://example.com/api?token=x", "https://example.com/#x", "file:///tmp"]) assert.throws(() => normalizeBackendAddress(value));
        window.__RUNTIME_CONFIG__ = {};
        assert.equal(defaultBackendUrl(), "http://127.0.0.1:17370");
    } finally { Reflect.deleteProperty(globalThis, "window"); }
});

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
