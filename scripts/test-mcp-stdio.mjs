import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!process.env.INFINITE_CANVAS_DATA_DIR) throw new Error("Run through scripts/run-canvas-browser-tests.mjs mcp-stdio");
const env = Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== undefined));
const client = new Client({ name: "isolated-mcp-stdio-v2-check", version: "1" });
const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "backend", "dist", "index.js"), "mcp"],
    cwd: root,
    env,
    stderr: "pipe",
});
const stderrChunks = [];
transport.stderr?.on("data", (chunk) => stderrChunks.push(String(chunk)));
try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, "0.1.0+mcp2");
    const catalog = await client.listTools();
    const tool = (name) => catalog.tools.find((entry) => entry.name === name);
    assert.ok(tool("mcp_get_command_receipt"));
    assert.ok(tool("assets_get"));
    assert.ok(tool("assets_add").inputSchema.required.includes("operationId"));
    assert.ok(tool("canvas_apply_ops").inputSchema.required.includes("expectedRevision"));

    const assets = await client.callTool({ name: "assets_list", arguments: {} });
    const assetsText = assets.content?.find((entry) => entry.type === "text")?.text;
    assert.equal(typeof assetsText, "string");
    const page = JSON.parse(assetsText);
    assert.equal(page.page, 1);
    assert.equal(page.pageSize, 20);
    assert.equal(page.total, 0);
    assert.deepEqual(page.items, []);

    const receipt = await client.callTool({ name: "mcp_get_command_receipt", arguments: { operationId: "stdio-missing-receipt-check" } });
    const receiptText = receipt.content?.find((entry) => entry.type === "text")?.text;
    assert.equal(JSON.parse(String(receiptText)).found, false);
    console.log("PASS: stdio MCP exposes the v2 contract and reads paginated assets/command receipts from the isolated authoritative Backend");
} catch (error) {
    const stderr = stderrChunks.join("").replaceAll(process.env.INFINITE_CANVAS_BACKEND_TOKEN || "\u0000", "[redacted]");
    if (stderr) console.error("MCP stdio server stderr:", stderr.slice(-4000));
    throw error;
} finally {
    await client.close().catch(() => undefined);
}
