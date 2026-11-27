import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendDatabase } from '../db.js';
import { createStores } from '../stores/index.js';
import { BackendEventBus } from '../events.js';
import { NativeProductionGeneration } from './native-generation.js';

/**
 * 复现：任务终态为 failed/cancelled 时，submitted 占用必须被收口，
 * 否则该 Clip 永久被失败任务占用，重试被 H3_CLIP_OCCUPIED 拒绝，
 * 流水线 attempt 累加到硬上限，前端「全部重试」按钮因 busy 卡住灰显。
 */
function makeObserver(db: BackendDatabase, stores: ReturnType<typeof createStores>, events: BackendEventBus) {
    const service = {} as any;
    return new NativeProductionGeneration(db, stores, service, service, events);
}

test('失败任务的 submitted 占用在 start 全量扫描时被收口，不再占用 Clip', () => {
    const db = new BackendDatabase(':memory:');
    const stores = createStores(db);
    const events = new BackendEventBus();
    const taskId = 'failed-occupying-task';
    stores.tasks.create(taskId, 'canvas-h3-run', {}, {});
    db.db.prepare(`INSERT INTO production_task_bindings
        (task_id, owner_kind, owner_id, version, source_hash, target_kind, target_id, project_id, node_id, targets_json, status)
        VALUES (?, 'episode', 'ep', 1, 'hash', 'segment', 'clip-1', 'proj', 'node', ?, 'submitted')`)
        .run(taskId, JSON.stringify([{ targetId: 'clip-1', segmentId: 'clip-1', inputHash: 'h' }]));
    // 任务失败
    stores.tasks.update(taskId, { status: 'failed', error: 'boom' });
    assert.equal((db.db.prepare("SELECT status FROM production_task_bindings WHERE task_id=?").get(taskId) as any).status, 'submitted');

    const observer = makeObserver(db, stores, events);
    observer.start();
    const after = (db.db.prepare("SELECT status FROM production_task_bindings WHERE task_id=?").get(taskId) as any).status;
    assert.notEqual(after, 'submitted', '失败任务的占用不应继续停在 submitted');
    db.close();
});

test('running 时触发过 finish 后转 failed，占用仍须被收口（非终态分支不留 Set 残影）', () => {
    const db = new BackendDatabase(':memory:');
    const stores = createStores(db);
    const events = new BackendEventBus();
    const taskId = 'running-then-failed-task';
    stores.tasks.create(taskId, 'canvas-h3-run', {}, {});
    db.db.prepare(`INSERT INTO production_task_bindings
        (task_id, owner_kind, owner_id, version, source_hash, target_kind, target_id, project_id, node_id, targets_json, status)
        VALUES (?, 'episode', 'ep', 1, 'hash', 'segment', 'clip-3', 'proj', 'node', ?, 'submitted')`)
        .run(taskId, JSON.stringify([{ targetId: 'clip-3', segmentId: 'clip-3', inputHash: 'h' }]));
    const observer = makeObserver(db, stores, events);

    // 任务在 running 时触发 finish（start 全量扫描会调用它）——非终态分支不应留下 Set 标记
    stores.tasks.update(taskId, { status: 'running' });
    observer.start();
    assert.equal((db.db.prepare("SELECT status FROM production_task_bindings WHERE task_id=?").get(taskId) as any).status, 'submitted');

    // 随后任务失败并发出终态事件，占用必须被收口
    stores.tasks.update(taskId, { status: 'failed', error: 'boom' });
    events.publish({ type: 'task.failed', entityId: taskId, payload: {} });
    const after = (db.db.prepare("SELECT status FROM production_task_bindings WHERE task_id=?").get(taskId) as any).status;
    assert.notEqual(after, 'submitted', 'running 阶段的 finish 不得让后续 failed 收口被守卫短路');
    db.close();
});

test('启动中的任务 submitted 占用保持不动', () => {
    const db = new BackendDatabase(':memory:');
    const stores = createStores(db);
    const events = new BackendEventBus();
    const taskId = 'running-task';
    stores.tasks.create(taskId, 'canvas-h3-run', {}, {});
    db.db.prepare(`INSERT INTO production_task_bindings
        (task_id, owner_kind, owner_id, version, source_hash, target_kind, target_id, project_id, node_id, targets_json, status)
        VALUES (?, 'episode', 'ep', 1, 'hash', 'segment', 'clip-2', 'proj', 'node', ?, 'submitted')`)
        .run(taskId, JSON.stringify([{ targetId: 'clip-2', segmentId: 'clip-2', inputHash: 'h' }]));
    stores.tasks.update(taskId, { status: 'running' });
    const observer = makeObserver(db, stores, events);
    observer.start();
    const after = (db.db.prepare("SELECT status FROM production_task_bindings WHERE task_id=?").get(taskId) as any).status;
    assert.equal(after, 'submitted', '在跑任务占用应保留');
    db.close();
});
