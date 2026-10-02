import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
    KNOWN_FIRST_PARTY, PluginMcpRegistry,
    type PluginMcpContext, type PluginMcpDeclaration, type PluginMcpModule, type PluginMcpToolWire,
} from "./plugin-mcp.js";

const ID = "schema-registry-fixture";
function tool(id: string, inputJsonSchema: Record<string, unknown>, version = "1"): PluginMcpToolWire {
    return { id, version, name: `Title ${version}`, description: `Description ${version}`, inputJsonSchema };
}
function declaration(version = "1", enabled = true): PluginMcpDeclaration {
    return { id: ID, version, name: ID, mcp: { enabled, tools: [] } };
}
async function fixture(t: TestContext, tools: PluginMcpToolWire[]) {
    let calls = 0;
    let loads = 0;
    let registrations = 0;
    let observed = 0;
    const errors: Array<{ code?: string; issues?: unknown[] }> = [];
    let module: PluginMcpModule = {
        id: ID, version: "1", tools,
        createHandler: () => Object.fromEntries(tools.map((item) => [item.id, async (input: Record<string, unknown>) => {
            calls++;
            return { version: "1", input };
        }])),
    };
    KNOWN_FIRST_PARTY[ID] = { version: "1", load: async () => { loads++; return module; } };
    const server = new McpServer({ name: "isolated-plugin-schema-test", version: "1" });
    // Match the Backend's registration-time observability wrapper. Reloads must not bypass it.
    const register = server.registerTool.bind(server);
    server.registerTool = ((name: string, config: any, callback: any) => {
        registrations++;
        return register(name, config, async (...args: any[]) => {
            observed++;
            try { return await callback(...args); }
            catch (error) { errors.push(error as { code?: string; issues?: unknown[] }); throw error; }
        });
    }) as typeof server.registerTool;
    const registry = new PluginMcpRegistry(server, {} as PluginMcpContext);
    await registry.apply([declaration()]);
    const client = new Client({ name: "isolated-plugin-schema-client", version: "1" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    t.after(async () => { delete KNOWN_FIRST_PARTY[ID]; await client.close(); await server.close(); });
    return {
        client, registry, errors,
        counts: () => ({ calls, loads, registrations, observed }),
        reload(next: PluginMcpModule) { module = next; KNOWN_FIRST_PARTY[ID].version = next.version; },
    };
}
function resultValue(result: any) {
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
}

const constrainedSchema = {
    type: "object", description: "Root description", additionalProperties: false,
    properties: {
        label: { type: "string", description: "Exact label", minLength: 2, maxLength: 4, pattern: "^[A-Z]+$" },
        count: { type: "integer", description: "Bounded count", minimum: 1, maximum: 3 },
        ratio: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
        tags: { type: "array", minItems: 1, maxItems: 2, uniqueItems: true, items: { type: "string", minLength: 1 } },
        closed: { type: "object", additionalProperties: false, properties: { flag: { type: "boolean" } }, required: ["flag"] },
        open: { type: "object", properties: { label: { type: "string" } } },
        values: { type: "object", additionalProperties: { type: "integer", minimum: 0 } },
        choice: { enum: [1, false, null, "exact"] },
    },
    required: ["label", "count", "ratio", "tags", "closed", "open", "values", "choice"],
};
const valid = { label: "AB", count: 2, ratio: 0.5, tags: ["tag"], closed: { flag: true }, open: { untouched: { deep: 1 } }, values: { extra: 0 }, choice: "exact" };

test("tools/list preserves declared constraints, descriptions and nested unknown-field policies", async (t) => {
    const { client } = await fixture(t, [tool("constrained", constrainedSchema)]);
    const listed = (await client.listTools()).tools[0];
    const { $schema: _dialect, ...served } = listed.inputSchema;
    assert.deepEqual(served, constrainedSchema);
});

test("tools/call rejects invalid common JSON Schema inputs without invoking the plugin", async (t) => {
    const f = await fixture(t, [tool("constrained", constrainedSchema)]);
    const cases: Record<string, unknown>[] = [
        { ...valid, count: "2" }, { ...valid, count: 1.5 }, { ...valid, count: 0 }, { ...valid, count: 4 },
        { ...valid, ratio: 0 }, { ...valid, ratio: 1 },
        { ...valid, label: "A" }, { ...valid, label: "ABCDE" }, { ...valid, label: "ab" },
        { ...valid, tags: [] }, { ...valid, tags: ["a", "b", "c"] }, { ...valid, tags: [""] }, { ...valid, tags: ["a", "a"] },
        { ...valid, closed: { flag: true, secret: 1 } }, { ...valid, closed: {} },
        { ...valid, values: { extra: "0" } }, { ...valid, choice: "false" }, { ...valid, unexpected: true },
        { ...valid, count: undefined },
    ];
    for (const args of cases) {
        const result = await f.client.callTool({ name: "constrained", arguments: args });
        assert.equal(result.isError, true, `accepted ${JSON.stringify(args)}`);
    }
    assert.equal(f.counts().calls, 0);
    assert.equal(f.counts().observed, cases.length, "validation errors reach the registration-time wrapper");
    assert.equal(f.errors.length, cases.length);
    assert.ok(f.errors.every((error) => error.code === "INVALID_INPUT" && Array.isArray(error.issues)));
    assert.deepEqual(resultValue(await f.client.callTool({ name: "constrained", arguments: valid })).input, valid);
});

test("default-open root preserves arbitrary fields and mixed enum values without coercion", async (t) => {
    const schema = { type: "object", properties: { choice: { enum: [1, false, null, "exact"] } }, required: ["choice"] };
    const f = await fixture(t, [tool("open-root", schema)]);
    for (const choice of [1, false, null, "exact"]) {
        const input = { choice, extension: { untouched: [1, false, null] } };
        assert.deepEqual(resultValue(await f.client.callTool({ name: "open-root", arguments: input })).input, input);
    }
});

test("root oneOf, anyOf, allOf, not and if/then/else survive tools/list and enforce tools/call", async (t) => {
    const schema = {
        type: "object", additionalProperties: false,
        properties: { mode: { enum: ["left", "right"] }, left: { type: "string" }, right: { type: "string" }, token: { type: "string" } },
        required: ["mode"],
        oneOf: [{ required: ["left"] }, { required: ["right"] }],
        anyOf: [{ required: ["token"] }, { properties: { mode: { const: "right" } } }],
        allOf: [{ not: { properties: { left: { const: "forbidden" } }, required: ["left"] } }],
        if: { properties: { mode: { const: "left" } } }, then: { required: ["left"] }, else: { required: ["right"] },
    };
    const f = await fixture(t, [tool("cross-fields", schema)]);
    const { $schema: _dialect, ...served } = (await f.client.listTools()).tools[0].inputSchema;
    assert.deepEqual(served, schema);
    for (const args of [{ mode: "left" }, { mode: "left", left: "ok" }, { mode: "left", left: "forbidden", token: "t" }, { mode: "left", right: "ok", token: "t" }, { mode: "right", left: "a", right: "b" }]) {
        assert.equal((await f.client.callTool({ name: "cross-fields", arguments: args })).isError, true, JSON.stringify(args));
    }
    for (const args of [{ mode: "left", left: "ok", token: "t" }, { mode: "right", right: "ok" }]) {
        assert.deepEqual(resultValue(await f.client.callTool({ name: "cross-fields", arguments: args })).input, args);
    }
});

test("version reload updates schema, metadata and callback, hides removed tools, and keeps wrappers", async (t) => {
    const first = { $id: "https://isolated.test/changing", type: "object", properties: { old: { type: "string" } }, required: ["old"], additionalProperties: false };
    const f = await fixture(t, [tool("changing", first), tool("removed", first)]);
    assert.equal(resultValue(await f.client.callTool({ name: "changing", arguments: { old: "ok" } })).version, "1");
    const next = { $id: "https://isolated.test/changing", type: "object", properties: { fresh: { type: "integer", minimum: 2 } }, required: ["fresh"], additionalProperties: false };
    f.reload({ id: ID, version: "2", tools: [{ ...tool("changing", next, "2"), annotations: { readOnlyHint: true } }], createHandler: () => ({ changing: async (input) => ({ version: "2", input }) }) });
    await f.registry.apply([declaration("browser-stale")]);
    const listed = (await f.client.listTools()).tools;
    assert.deepEqual(listed.map((item) => item.name), ["changing"]);
    assert.equal(listed[0].title, "Title 2");
    assert.equal(listed[0].description, "Description 2");
    assert.deepEqual(listed[0].annotations, { readOnlyHint: true });
    const { $schema: _dialect, ...served } = listed[0].inputSchema;
    assert.deepEqual(served, next);
    assert.equal(resultValue(await f.client.callTool({ name: "changing", arguments: { fresh: 2 } })).version, "2");
    assert.equal((await f.client.callTool({ name: "changing", arguments: { old: "old" } })).isError, true);
    assert.equal((await f.client.callTool({ name: "removed", arguments: { old: "ok" } })).isError, true);
    assert.equal(f.counts().observed, 3, "two successful calls plus one observed input validation failure");
    assert.equal(f.registry.listTools()[0].version, "2");
    const counts = f.counts();
    await f.registry.apply([declaration("browser-stale")]);
    assert.deepEqual(f.counts(), counts, "unchanged authoritative local version must not reload");
    await f.registry.apply([]);
    assert.deepEqual((await f.client.listTools()).tools, []);
    await f.registry.apply([declaration("2")]);
    assert.equal(resultValue(await f.client.callTool({ name: "changing", arguments: { fresh: 2 } })).version, "2");
});

test("same-schema reload updates handler without dropping an existing observability wrapper or stale annotations", async (t) => {
    const schema = { type: "object", properties: {}, additionalProperties: true };
    const f = await fixture(t, [{ ...tool("stable", schema), annotations: { destructiveHint: true } }]);
    f.reload({ id: ID, version: "2", tools: [tool("stable", schema, "2")], createHandler: () => ({ stable: async () => "new raw string" }) });
    await f.registry.apply([declaration("2")]);
    const result = await f.client.callTool({ name: "stable", arguments: {} });
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.content, [{ type: "text", text: "new raw string" }]);
    assert.equal(f.counts().registrations, 1, "same-schema update should reuse the SDK handle");
    assert.equal(f.counts().observed, 1);
    assert.deepEqual((await f.client.listTools()).tools[0].annotations, {});
    await f.registry.apply([declaration("2", false)]);
    assert.deepEqual((await f.client.listTools()).tools, []);
    assert.equal((await f.client.callTool({ name: "stable", arguments: {} })).isError, true);
});

test("oneOf means exactly one match, formats/local refs validate, and defaults never mutate input", async (t) => {
    const schema = {
        type: "object", additionalProperties: true,
        definitions: { bounded: { type: "integer", minimum: 1, maximum: 2 } },
        properties: {
            value: { oneOf: [{ type: "number" }, { type: "integer" }] },
            nullable: { type: ["string", "null"] },
            email: { type: "string", format: "email" },
            reference: { $ref: "#/definitions/bounded" },
            optional: { type: "string", default: "must not insert" },
        },
        required: ["value", "nullable", "email", "reference"],
    };
    const f = await fixture(t, [tool("composed", schema)]);
    const { $schema: _dialect, ...served } = (await f.client.listTools()).tools[0].inputSchema;
    assert.deepEqual(served, schema);
    const input = { value: 0.5, nullable: null, email: "valid@example.test", reference: 1, literal_field_name: { preserved: true } };
    assert.deepEqual(resultValue(await f.client.callTool({ name: "composed", arguments: input })).input, input);
    for (const args of [{ ...input, value: 1 }, { ...input, email: "invalid" }, { ...input, reference: 3 }, { ...input, nullable: 1 }]) {
        assert.equal((await f.client.callTool({ name: "composed", arguments: args })).isError, true, JSON.stringify(args));
    }
});

test("unsupported schemas fail registration rather than serving a weakened contract; previous tools stay usable", async (t) => {
    const schema = { type: "object", properties: {}, additionalProperties: true };
    const f = await fixture(t, [tool("still-working", schema)]);
    for (const bad of [
        { ...schema, dependentRequired: { x: ["y"] } },
        { ...schema, $schema: "https://json-schema.org/draft/2020-12/schema" },
        { ...schema, properties: { external: { $ref: "https://unresolved.test/schema" } } },
    ]) {
        f.reload({ id: ID, version: "2", tools: [tool("replacement", bad, "2")], createHandler: () => ({ replacement: async () => "not served" }) });
        await assert.rejects(f.registry.apply([declaration("2")]));
        assert.deepEqual((await f.client.listTools()).tools.map((item) => item.name), ["still-working"]);
        assert.equal(resultValue(await f.client.callTool({ name: "still-working", arguments: {} })).version, "1");
        assert.equal(f.registry.listTools()[0].version, "1");
    }
});

test("browser declarations do not authorize third-party handlers or replace local schemas", async (t) => {
    const schema = { type: "object", properties: {}, additionalProperties: true };
    const f = await fixture(t, [tool("local-only", schema)]);
    await f.registry.apply([
        { ...declaration("browser-newer"), mcp: { enabled: true, tools: [tool("injected", schema)] } },
        { id: "untrusted-remote", version: "1", name: "remote", mcp: { enabled: true, tools: [tool("unauthorized", schema)] } },
    ]);
    assert.deepEqual((await f.client.listTools()).tools.map((item) => item.name), ["local-only"]);
    assert.equal((await f.client.callTool({ name: "unauthorized", arguments: {} })).isError, true);
    assert.equal(f.counts().loads, 1);
});
