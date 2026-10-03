import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BackendDatabase, type Asset } from "./db.js";
import { compileReferenceSubmission } from "@basketikun/canvas-agent/reference-contract";

function asset(id: string, title: string, folderId: string | null = null): Asset {
  const now = "2026-01-01T00:00:00.000Z";
  return { id, kind: "text", title, coverUrl: "", tags: [], folderId, data: { content: title }, note: null, source: null, metadata: {}, createdAt: now, updatedAt: now };
}

test("MCP canvas command receipt commits atomically with ops and rejects changed input on replay", () => {
  const db = new BackendDatabase(":memory:");
  try {
    const now = new Date().toISOString();
    db.createCanvasProject({ id: "mcp-project", title: "Before", nodes: [], connections: [], selectedNodeIds: [], revision: 0, createdAt: now, updatedAt: now });
    const operationId = "mcp-command-canvas-1";
    const targetId = "mcp-project";
    const request = { projectId: targetId, expectedRevision: 0, ops: [{ type: "update_project", patch: { title: "After" } }] };
    const operations = [{ type: "update_project", patch: { title: "After" } }];
    db.prepareMcpCommand({ operationId, tool: "canvas_apply_ops", targetId, projectId: targetId, request, payload: { operations, baseRevision: 0 }, receipt: { projectId: targetId, operationTypes: ["update_project"] } });
    const committed = db.applyCanvasProjectOperations(targetId, undefined, operations as never, { operationId, baseRevision: 0, mcpCommand: { tool: "canvas_apply_ops", targetId, request } });
    assert.equal(committed.revision, 1);
    assert.equal(db.getMcpCommandReceipt(operationId)?.status, "committed");
    assert.deepEqual(db.getCanvasProject(targetId)?.title, "After");

    const replay = db.applyCanvasProjectOperations(targetId, undefined, operations as never, { operationId, baseRevision: 0, mcpCommand: { tool: "canvas_apply_ops", targetId, request } });
    assert.equal(replay.duplicated, true);
    assert.equal(db.getCanvasProject(targetId)?.revision, 1);
    assert.throws(() => db.getMcpCommandReceipt(operationId, { tool: "canvas_apply_ops", targetId, projectId: targetId, request: { ...request, expectedRevision: 1 } }), /operationId/);
  } finally { db.close(); }
});

test("MCP asset batches are atomic, compactly receipted, and safe to replay", () => {
  const db = new BackendDatabase(":memory:");
  try {
    const operationId = "mcp-command-assets-1";
    const request = { items: [{ id: "a-1", title: "甲" }, { id: "a-2", title: "乙" }] };
    const assets = [asset("a-1", "甲"), asset("a-2", "乙")];
    db.prepareMcpCommand({ operationId, tool: "assets_upsert_batch", targetId: "asset-library", request, payload: { assets }, receipt: { count: 2, assetIds: ["a-1", "a-2"] } });
    const first = db.commitMcpAssetCommand({ operationId, tool: "assets_upsert_batch", request, assets });
    assert.deepEqual(first.assetIds, ["a-1", "a-2"]);
    assert.equal(first.committed, true);
    assert.equal(db.getMcpCommandReceipt(operationId)?.status, "committed");
    const replay = db.commitMcpAssetCommand({ operationId, tool: "assets_upsert_batch", request, assets });
    assert.equal(replay.replayed, true);
    assert.equal(db.listAssets().length, 2);
  } finally { db.close(); }
});

test("prepared and committed MCP receipt survives Backend database reopen", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-command-reopen-"));
  const file = path.join(directory, "runtime.sqlite");
  let db = new BackendDatabase(file);
  try {
    const operationId = "mcp-command-reopen";
    const request = { items: [{ id: "reopen-asset", title: "续读素材" }] };
    const assets = [asset("reopen-asset", "续读素材")];
    db.prepareMcpCommand({ operationId, tool: "assets_upsert_batch", targetId: "asset-library", request, payload: { assets }, receipt: { count: 1, assetIds: ["reopen-asset"] } });
    db.commitMcpAssetCommand({ operationId, tool: "assets_upsert_batch", request, assets });
    db.close();
    db = new BackendDatabase(file);
    assert.equal(db.getMcpCommandReceipt(operationId)?.status, "committed");
    assert.equal(db.getAsset("reopen-asset")?.title, "续读素材");
    assert.equal(db.commitMcpAssetCommand({ operationId, tool: "assets_upsert_batch", request, assets }).replayed, true);
    assert.equal(db.listAssets().length, 1);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("v20 database applies MCP receipts and the following migration with one verified backup", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-command-migration-"));
  const file = path.join(directory, "runtime.sqlite");
  const seed = new DatabaseSync(file);
  seed.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations (version, applied_at) VALUES (20, '2026-01-01T00:00:00.000Z');");
  seed.close();
  let db: BackendDatabase | undefined;
  try {
    db = new BackendDatabase(file);
    assert.equal((db.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version, 22);
    assert.ok(db.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mcp_command_receipts'").get());
    const backups = fs.readdirSync(directory).filter(name => name.includes("pre-schema-v20-to-v22"));
    assert.equal(backups.length, 1);
    for (const backup of backups) {
      const copy = new DatabaseSync(path.join(directory, backup), { readOnly: true });
      try { assert.equal((copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok"); }
      finally { copy.close(); }
    }
  } finally {
    db?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("asset pagination filters before paging, uses stable order, and treats LIKE metacharacters literally", () => {
  const db = new BackendDatabase(":memory:");
  try {
    db.upsertAsset(asset("b", "中文素材 %_"));
    db.upsertAsset(asset("a", "中文素材 %_"));
    db.upsertAsset(asset("c", "中文素材普通"));
    const first = db.listAssetsPage({ keyword: "%_", page: 1, pageSize: 1 });
    const second = db.listAssetsPage({ keyword: "%_", page: 2, pageSize: 1 });
    assert.equal(first.total, 2);
    assert.deepEqual([first.items[0].id, second.items[0].id], ["a", "b"]);
    assert.equal(db.listAssetsPage({ keyword: "中文素材普通" }).total, 1);
  } finally { db.close(); }
});

test("asset batch failure rolls back every asset and leaves a rejected command receipt", () => {
  const db = new BackendDatabase(":memory:");
  try {
    const operationId = "mcp-command-assets-invalid";
    const request = { items: [{ id: "good", title: "有效" }, { id: "bad", title: "失败" }] };
    const assets = [asset("good", "有效"), asset("bad", "失败", "missing-folder")];
    db.prepareMcpCommand({ operationId, tool: "assets_upsert_batch", targetId: "asset-library", request, payload: { assets }, receipt: { count: 2, assetIds: ["good", "bad"] } });
    assert.throws(() => db.commitMcpAssetCommand({ operationId, tool: "assets_upsert_batch", request, assets }));
    assert.equal(db.getAsset("good"), null);
    assert.equal(db.getMcpCommandReceipt(operationId)?.status, "rejected");
  } finally { db.close(); }
});

test("H3 context projection preserves reference compilation while excluding unrelated node metadata", () => {
  const db = new BackendDatabase(":memory:");
  try {
    const project: any = {
      id: "h3-context", title: "H3 context", revision: 0, connections: [], selectedNodeIds: [], referenceCatalog: [
        { id: "scene-asset", label: "Rainy courtyard", role: "scene", mediaType: "image", sourceNodeId: "scene-source" },
        { id: "pending-asset", label: "New storyboard frame", role: "storyboard", mediaType: "image", sourceNodeId: "pending-source" },
      ],
      nodes: [
        { id: "h3", type: "minimax-h3:video", title: "Clip", position: { x: 0, y: 0 }, width: 400, height: 300, metadata: { segments: [{ id: "clip-1", prompt: "<Subject 1> enters <Picture 1>.", taskMode: "ref2va", referenceBindings: [{ id: "scene-binding", assetId: "scene-asset", label: "Rainy courtyard", role: "scene", enabled: true, sourceNodeId: "scene-source" }], h3CharacterGroups: { heroine: { id: "heroine", characterNodeId: "character-source", characterAssetId: "character-asset", characterName: "Heroine", subjectId: "heroine", outfits: [{ id: "turnaround", storageKey: "image:heroine", url: "http://local/heroine.png", enabled: true, role: "character_identity" }] } } }] } },
        { id: "scene-source", type: "scene", title: "Scene", position: { x: 0, y: 0 }, width: 1, height: 1, metadata: { sceneImage: { storageKey: "image:courtyard", url: "http://local/courtyard.png" } } },
        { id: "character-source", type: "character", title: "Heroine", position: { x: 0, y: 0 }, width: 1, height: 1, metadata: { characterAssetId: "character-asset", characterImages: [{ storageKey: "image:heroine", url: "http://local/heroine.png", role: "character_identity" }] } },
        { id: "pending-source", type: "image", title: "New storyboard frame", position: { x: 0, y: 0 }, width: 1, height: 1, metadata: { storageKey: "image:pending-frame" } },
        ...Array.from({ length: 30 }, (_, index) => ({ id: `unrelated-${index}`, type: "text", title: `Unrelated ${index}`, position: { x: 0, y: 0 }, width: 1, height: 1, metadata: { prompt: "unrelated".repeat(1000) } })),
      ],
    };
    db.createCanvasProject(project);
    const full = db.getCanvasProject(project.id)! as Record<string, unknown>;
    const fullNode = (full.nodes as any[]).find(node => node.id === "h3");
    const fullSegment = fullNode.metadata.segments[0];
    const expected = compileReferenceSubmission(full, fullSegment);
    const scoped = db.getCanvasProjectH3Context(project.id, "h3", "clip-1")!;
    const scopedNode = (scoped.nodes as any[]).find(node => node.id === "h3");
    const actual = compileReferenceSubmission(scoped, scopedNode.metadata.segments[0]);
    assert.deepEqual(actual.references, expected.references);
    assert.deepEqual(actual.issues, expected.issues);
    assert.equal(actual.compiledPrompt, expected.compiledPrompt);
    assert.deepEqual((scoped.nodes as any[]).map(node => node.id), ["h3", "scene-source", "character-source"]);
    assert.equal(scoped.revision, full.revision);
    const candidateScoped = db.getCanvasProjectH3Context(project.id, "h3", "clip-1", { sourceNodeIds: ["pending-source"], assetIds: ["pending-asset"] })!;
    assert.deepEqual((candidateScoped.nodes as any[]).map(node => node.id), ["h3", "scene-source", "character-source", "pending-source"]);
    assert.deepEqual((candidateScoped.referenceCatalog as any[]).map(asset => asset.id), ["scene-asset", "pending-asset"]);
  } finally { db.close(); }
});
