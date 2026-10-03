import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { AchengEngine, inventory, verifyRuntime } from './acheng-engine.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acheng-manager-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return new AchengEngine(home);
}
function version(engine, id) {
  const directory = path.join(engine.base, 'versions', id); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), `version ${id}`);
  const value = { path: directory, runtimeId: id, commit: id, patchVersion: 'test', version: id };
  fs.writeFileSync(path.join(directory, 'canvas-engine.json'), JSON.stringify({ ...value, files: inventory(directory) }));
  return value;
}
test('unmanaged install is backed up; old runtimes stay usable across activation and rollback', t => {
  const engine = fixture(t); const first = version(engine, 'v1'), second = version(engine, 'v2');
  fs.mkdirSync(engine.entry, { recursive: true }); fs.writeFileSync(path.join(engine.entry, 'SKILL.md'), 'original');
  engine.activate(first, null);
  assert.equal(fs.readFileSync(path.join(engine.state().installedBackup, 'SKILL.md'), 'utf8'), 'original');
  engine.activate(second, first); engine.rollback();
  assert.equal(engine.status().active.runtimeId, 'v1');
  assert.equal(fs.readFileSync(path.join(second.path, 'SKILL.md'), 'utf8'), 'version v2');
});
test('modified runtime is refused and no rollback silently discards it', t => {
  const engine = fixture(t); const first = version(engine, 'v1'), second = version(engine, 'v2');
  engine.activate(first, null); engine.activate(second, first);
  fs.writeFileSync(path.join(second.path, 'SKILL.md'), 'user edit');
  assert.throws(() => engine.rollback(), /modified/);
  assert.equal(engine.state().active.runtimeId, 'v2');
});
test('failed activation restores the entry and preserves the last state', t => {
  const engine = fixture(t); const first = version(engine, 'v1'), second = version(engine, 'v2');
  engine.activate(first, null);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === engine.stateFile) throw new Error('simulated state write failure'); return rename(from, to); };
  try { assert.throws(() => engine.activate(second, first), /simulated/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.realpathSync(engine.entry), fs.realpathSync(first.path));
  assert.equal(engine.state().active.runtimeId, 'v1');
});
test('dirty upstream and update locks fail closed', t => {
  const engine = fixture(t); fs.mkdirSync(engine.source, { recursive: true });
  execFileSync('git', ['init'], { cwd: engine.source, windowsHide: true, stdio: 'ignore' });
  fs.writeFileSync(path.join(engine.source, 'local.txt'), 'keep');
  assert.throws(() => engine.fetch(), /local changes/);
  engine.locked(() => assert.throws(() => engine.locked(() => {}), /EEXIST/));
  assert.equal(fs.existsSync(path.join(engine.base, 'update.lock')), false);
});
test('candidate validation does not activate or change a pinned run', t => {
  const engine = fixture(t); const active = version(engine, 'v1'), candidate = version(engine, 'v2');
  engine.activate(active, null); verifyRuntime(candidate.path);
  assert.equal(engine.state().active.runtimeId, 'v1');
  assert.equal(verifyRuntime(active.path).runtimeId, 'v1');
});
