import assert from "node:assert/strict";
import test from "node:test";

import { BackendClient, BackendClientError } from "./backend-client.js";

const client = new BackendClient("http://backend.test", "test-token");

async function withFetch(
  implementation: typeof fetch,
  run: () => Promise<void>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("BackendClient keeps HTTP status and backend error code", async () => {
  await withFetch(
    (async () => new Response(JSON.stringify({ ok: false, error: "task not found", code: "TASK_NOT_FOUND" }), { status: 404 })) as typeof fetch,
    async () => {
      await assert.rejects(
        client.get("/runtime/tasks/missing"),
        (error: unknown) => {
          assert.ok(error instanceof BackendClientError);
          assert.equal(error.kind, "http");
          assert.equal(error.status, 404);
          assert.equal(error.code, "TASK_NOT_FOUND");
          return true;
        },
      );
    },
  );

  await withFetch(
    (async () => new Response(JSON.stringify({ ok: false, error: { code: "AUTH_REQUIRED", message: "permission denied" } }), { status: 403 })) as typeof fetch,
    async () => {
      await assert.rejects(client.get("/canvas/projects"), (error: unknown) => {
        assert.ok(error instanceof BackendClientError);
        assert.equal(error.kind, "http");
        assert.equal(error.status, 403);
        assert.equal(error.code, "AUTH_REQUIRED");
        return true;
      });
    },
  );

  await withFetch(
    (async () => new Response(JSON.stringify({ ok: false, error: "provider failed", code: "PROVIDER_FAILED" }), { status: 500 })) as typeof fetch,
    async () => {
      await assert.rejects(client.get("/canvas/generation"), (error: unknown) => {
        assert.ok(error instanceof BackendClientError);
        assert.equal(error.status, 500);
        assert.equal(error.code, "PROVIDER_FAILED");
        return true;
      });
    },
  );
});

test("BackendClient distinguishes network, timeout and invalid responses", async () => {
  await withFetch(
    (async () => {
      throw new Error("connection refused");
    }) as typeof fetch,
    async () => {
      await assert.rejects(client.get("/health"), (error: unknown) => {
        assert.ok(error instanceof BackendClientError);
        assert.equal(error.kind, "network");
        assert.equal(error.status, undefined);
        return true;
      });
    },
  );

  await withFetch(
    (async () => {
      throw new DOMException("The operation timed out", "TimeoutError");
    }) as typeof fetch,
    async () => {
      await assert.rejects(client.get("/health"), (error: unknown) => {
        assert.ok(error instanceof BackendClientError);
        assert.equal(error.kind, "timeout");
        return true;
      });
    },
  );

  await withFetch(
    (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch,
    async () => {
      await assert.rejects(client.getTask("missing-from-body"), (error: unknown) => {
        assert.ok(error instanceof BackendClientError);
        assert.equal(error.kind, "invalid_response");
        assert.equal(error.code, "BACKEND_INVALID_RESPONSE");
        return true;
      });
    },
  );
});

test("BackendClient reads one project by id without listing every canvas", async () => {
  let requestedUrl = "";
  await withFetch(
    (async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ ok: true, project: { id: "project/1", revision: 4 } }), { status: 200 });
    }) as typeof fetch,
    async () => {
      const project = await client.getCanvasProject("project/1");
      assert.deepEqual(project, { id: "project/1", revision: 4 });
      assert.match(requestedUrl, /\/canvas\/projects\/project%2F1\?/);
    },
  );
});

test("BackendClient parses replayed Backend SSE events and ignores heartbeats", async () => {
  const encoder = new TextEncoder();
  await withFetch(
    (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": heartbeat\n\nid: instance:1\nevent: task.updated\ndata: {\"id\":\"task-1\",\"type\":\"task.updated\",\"entityId\":\"task-1\",\"payload\":{\"status\":\"running\"}}\n\n"));
        controller.enqueue(encoder.encode("id: instance:2\nevent: events.sync\ndata: {\"cursor\":\"instance:2\",\"reset\":false}\n\n"));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch,
    async () => {
      const events = [];
      for await (const event of client.streamEvents()) events.push(event);
      assert.deepEqual(events.map((event) => event.type), ["task.updated", "events.sync"]);
      assert.equal((events[0].payload as Record<string, unknown>).status, "running");
    },
  );
});
