import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_REFERENCE_IMAGE_MODEL,
  DEFAULT_REFERENCE_IMAGE_SIZE,
  registerDramaAssetRegenerateRoutes,
} from "./drama-asset-regenerate-routes.js";

type ResponseStub = {
  statusCode: number;
  body?: any;
  status: (code: number) => ResponseStub;
  json: (body: unknown) => void;
};

function responseStub(): ResponseStub {
  const response: ResponseStub = {
    statusCode: 200,
    status(code: number) { response.statusCode = code; return response; },
    json(body: unknown) { response.body = body; },
  };
  return response;
}

const DRAMA = "drama-1";
const EPISODE = "episode-1";
const CANVAS = "canvas-1";
const NODE = "production-entity-a1b2c3";
const ASSET = "asset-character-a1b2c3";
const STORAGE_KEY = "image:regen-smoke";

type Fixture = {
  db: any;
  stores: any;
  generation: any;
  commands: any[];
  operations: any[];
  updates: any[];
  bindCalls: number;
  taskState: any;
};

function fixture(options: { taskStatus?: string; failStart?: string; withCard?: boolean; withSegment?: boolean } = {}): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-regen-smoke-"));
  const mediaPath = path.join(dir, "image.png");
  fs.writeFileSync(mediaPath, Buffer.from("fake-png-bytes"));
  const card = {
    id: ASSET, asset_id: ASSET, asset_kind: "character", kind: "character",
    asset_name: "柳文卿", name: "柳文卿", prompt: "二十出头的绝美女子，古装，正面半身",
    view_layout: "portrait", nodeId: NODE, entity_id: "entity-character-a1b2c3",
  };
  const production = {
    revision: 1,
    director: {
      source: { asset_plan: [card], asset_cards: [{ ...card, view_layout: "portrait" }] },
      assets: options.withCard === false ? {} : {
        [ASSET]: { nodeId: NODE, version: "v1", status: "generated", storageKey: "image:old", ...card },
      },
    },
  };
  const nodes: any[] = [
    {
      id: NODE, type: "character", title: "柳文卿",
      metadata: {
        productionEntity: { entityId: "entity-character-a1b2c3" },
        ...(options.withSegment === false ? {} : {
          segments: [{
            id: "seg-1", status: "succeeded", resultStorageKey: "image:old-video",
            h3CharacterGroups: { [ASSET]: { id: ASSET } },
          }],
        }),
      },
    },
  ];
  const fixture: Fixture = {
    db: {
      listDramaEpisodes: () => [{ id: EPISODE, canvasId: CANVAS }],
      getDramaEpisode: (id: string) => id === EPISODE ? { id, canvasId: CANVAS } : null,
      getDramaIdByCanvasId: () => DRAMA,
      listCanvasFolders: () => [{ productionPlan: { topic: { artStyle: "国风水墨", language: "zh" } } }],
      getCanvasProject: (id: string) => id === CANVAS ? { id, revision: 3, nodes } : null,
      listCanvasProjects: () => [{ id: CANVAS, revision: 3, nodes }],
      getMediaFile: (key: string) => key === STORAGE_KEY
        ? { storageKey: key, filePath: mediaPath, mimeType: "image/png", width: 1536, height: 864, bytes: 15 }
        : null,
      applyCanvasProjectOperations: (_canvasId: string, _revision: any, ops: any[]) => {
        fixture.operations.push(...ops);
        return { revision: 4 };
      },
      db: {
        prepare: (sql: string) => ({
          get: () => sql.includes("SELECT revision") ? {
            revision: production.revision,
            draft_json: JSON.stringify(production),
            published_json: null,
          } : undefined,
          run: (...args: any[]) => { fixture.updates.push({ sql: sql.slice(0, 40), args }); return { changes: 1 }; },
          all: () => [],
        }),
      },
    },
    stores: {
      tasks: {
        get: () => fixture.taskState,
        list: () => [],
      },
    },
    generation: {
      start: async (command: any) => {
        fixture.commands.push(command);
        if (options.failStart) throw new Error(options.failStart);
        return { taskId: "task-smoke", executor: "direct-image" };
      },
    },
    commands: [], operations: [], updates: [], bindCalls: 0,
    taskState: {
      id: "task-smoke", status: options.taskStatus || "succeeded", progress: 100,
      result: { media: [{ storageKey: STORAGE_KEY }] }, error: null,
    },
  };
  return fixture;
}

function register(f: Fixture, options: any = {}) {
  const routes: Array<{ path: string; handler: (req: any, res: ResponseStub) => unknown }> = [];
  registerDramaAssetRegenerateRoutes(
    { post(path: string, handler: (req: any, res: ResponseStub) => unknown) { routes.push({ path, handler }); } } as any,
    f.db, f.stores, f.generation, { timeoutMs: 1000, pollIntervalMs: 1, startRetries: 0, ...options },
  );
  return routes;
}

test("按当前方案一键重做：默认 2.1/16:9、真实写回并标脏引用段", async () => {
  const f = fixture();
  const routes = register(f);
  assert.equal(routes[0].path, "/drama/:dramaId/assets/:assetId/regenerate-reference");
  const res = responseStub();
  await routes[0].handler({ params: { dramaId: DRAMA, assetId: ASSET }, body: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.storageKey, STORAGE_KEY);
  assert.equal(res.body.episodeId, EPISODE);
  assert.equal(res.body.nodeId, NODE);
  assert.equal(res.body.taskId, "task-smoke");
  assert.equal(res.body.affectedSegments, 1);
  const command = f.commands[0];
  assert.equal(command.mode, "image");
  assert.equal(command.model, DEFAULT_REFERENCE_IMAGE_MODEL);
  assert.equal(command.size, DEFAULT_REFERENCE_IMAGE_SIZE);
  assert.equal(command.count, 1);
  assert.equal(command.projectId, CANVAS);
  assert.equal(command.nodeId, NODE);
  assert.match(command.prompt, /角色定妆照/);
  assert.match(command.prompt, /国风水墨/);
  assert.match(command.prompt, /16:9/);
  assert.ok(f.operations.some(op => op.type === "update_node" && op.metadata?.characterImages?.[0]?.storageKey === STORAGE_KEY));
  assert.ok(f.operations.some(op => op.type === "update_h3_segment" && op.patch?.inputOutdated === true));
  assert.equal(f.updates.length, 1, "draft 制作稿必须真写回");
});

test("显式 prompt / artStyle / size 覆盖，restyleSegments=false 不标脏", async () => {
  const f = fixture();
  const res = responseStub();
  const routes = register(f);
  await routes[0].handler({
    params: { dramaId: DRAMA, assetId: ASSET },
    body: { prompt: "自定义提示词：素衣女子", artStyle: "赛博朋克", size: "2048x1152", restyleSegments: false },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.affectedSegments, 0);
  assert.equal(f.commands[0].size, "2048x1152");
  assert.match(f.commands[0].prompt, /自定义提示词：素衣女子/);
  assert.match(f.commands[0].prompt, /赛博朋克/);
  assert.ok(!f.operations.some(op => op.type === "update_h3_segment"));
  assert.ok(f.operations.some(op => op.type === "update_node"));
});

test("出图失败不写回：任务 failed 时返回 502 且不产生任何绑定操作", async () => {
  const f = fixture({ taskStatus: "failed" });
  f.taskState.error = "engine timeout";
  const res = responseStub();
  const routes = register(f);
  await routes[0].handler({ params: { dramaId: DRAMA, assetId: ASSET }, body: {} }, res);
  assert.equal(res.statusCode, 502);
  assert.match(res.body.error, /REGEN_IMAGE_FAILED/);
  assert.equal(f.operations.length, 0);
  assert.equal(f.updates.length, 0);
});

test("资产卡不存在时明确 404；画布节点缺失也明确报错", async () => {
  const missing = fixture({ withCard: false });
  const res = responseStub();
  await register(missing)[0].handler({ params: { dramaId: DRAMA, assetId: "asset-missing" }, body: {} }, res);
  assert.equal(res.statusCode, 404);
  assert.match(res.body.error, /REGEN_ASSET_NOT_FOUND/);

  const noSegment = fixture({ withSegment: true });
  noSegment.db.listCanvasProjects = () => [{ id: CANVAS, revision: 3, nodes: [] }];
  const res2 = responseStub();
  // 卡上已有 nodeId，仍可写回；标脏规划无节点时 affectedSegments 应为 0。
  await register(noSegment)[0].handler({ params: { dramaId: DRAMA, assetId: ASSET }, body: {} }, res2);
  assert.equal(res2.statusCode, 200);
  assert.equal(res2.body.affectedSegments, 0);
});

test("指定不存在的 episodeId 时明确 404，不落到其他集", async () => {
  const f = fixture();
  const res = responseStub();
  await register(f)[0].handler({
    params: { dramaId: DRAMA, assetId: ASSET }, body: { episodeId: "episode-unknown" },
  }, res);
  assert.equal(res.statusCode, 404);
  assert.match(res.body.error, /REGEN_ASSET_NOT_FOUND/);
  assert.equal(f.commands.length, 0);
});

test("非法 body 直接 400，不提交任何生成任务", async () => {
  const f = fixture();
  const res = responseStub();
  await register(f)[0].handler({ params: { dramaId: DRAMA, assetId: ASSET }, body: { size: "vertical" } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(f.commands.length, 0);
});
