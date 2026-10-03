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
  return new AchengEngine(home, undefined, path.join(home, 'project'));
}
function version(engine, id, commit = id, versionLabel = id) {
  const directory = path.join(engine.base, 'versions', id); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), `version ${id}`);
  const value = { path: directory, runtimeId: id, commit, patchVersion: 'test', version: versionLabel };
  fs.writeFileSync(path.join(directory, 'canvas-engine.json'), JSON.stringify({ ...value, files: inventory(directory) }));
  return value;
}
function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}
function initUpstream(engine) {
  fs.mkdirSync(engine.source, { recursive: true });
  git(engine.source, ['init']);
  git(engine.source, ['config', 'user.email', 'acheng-test@example.com']);
  git(engine.source, ['config', 'user.name', 'Acheng Test']);
  return engine.source;
}
function commitFiles(engine, files) {
  for (const [relative, value] of Object.entries(files)) {
    const destination = path.join(engine.source, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, value);
  }
  git(engine.source, ['add', '-A']);
  git(engine.source, ['commit', '-m', 'upstream snapshot']);
  return git(engine.source, ['rev-parse', 'HEAD']);
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
test('project vendor installs the full upstream tree with a pinned commit manifest', t => {
  const engine = fixture(t); initUpstream(engine);
  const commit = commitFiles(engine, {
    'SKILL.md': '---\nversion: "4.3.9"\n---\nAcheng\n',
    'modules/story/SKILL.md': 'story module',
    'references/camera.mp4': Buffer.from([0, 1, 2, 255]),
    'references/中文指南/操作规则.md': 'UTF-8 upstream filename',
    'output/upstream-example.json': '{"fixture":true}',
  });
  const plan = engine.prepareProjectSkill(commit, '4.3.9'); plan.finalize();
  const metadata = JSON.parse(fs.readFileSync(path.join(engine.projectSkill, '.canvas-upstream.json'), 'utf8'));
  assert.equal(metadata.commit, commit);
  assert.equal(metadata.version, '4.3.9');
  assert.equal(fs.readFileSync(path.join(engine.projectSkill, 'modules/story/SKILL.md'), 'utf8'), 'story module');
  assert.deepEqual(fs.readFileSync(path.join(engine.projectSkill, 'references/camera.mp4')), Buffer.from([0, 1, 2, 255]));
  assert.equal(fs.readFileSync(path.join(engine.projectSkill, 'references/中文指南/操作规则.md'), 'utf8'), 'UTF-8 upstream filename');
  assert.equal(fs.readFileSync(path.join(engine.projectSkill, 'output/upstream-example.json'), 'utf8'), '{"fixture":true}');
  assert.deepEqual(engine.projectSkillStatus().modifiedFiles, []);
  assert.doesNotThrow(() => engine.prepareProjectSkill(commit, '4.3.9').finalize());
});
test('project vendor refuses to overwrite local edits and can sync a clean upstream revision', t => {
  const engine = fixture(t); initUpstream(engine);
  const firstCommit = commitFiles(engine, {
    'SKILL.md': '---\nversion: "4.3.9"\n---\nAcheng\n',
    'modules/story/SKILL.md': 'story v1',
  });
  engine.prepareProjectSkill(firstCommit, '4.3.9').finalize();
  fs.writeFileSync(path.join(engine.projectSkill, 'modules/story/SKILL.md'), 'local edit');
  fs.rmSync(path.join(engine.source, 'modules/story/SKILL.md'));
  const secondCommit = commitFiles(engine, {
    'SKILL.md': '---\nversion: "4.4.0"\n---\nAcheng updated\n',
    'modules/assets/SKILL.md': 'assets v2',
  });
  assert.throws(() => engine.prepareProjectSkill(secondCommit, '4.4.0'), /local changes/);
  assert.equal(fs.readFileSync(path.join(engine.projectSkill, 'modules/story/SKILL.md'), 'utf8'), 'local edit');
  assert.equal(JSON.parse(fs.readFileSync(path.join(engine.projectSkill, '.canvas-upstream.json'), 'utf8')).commit, firstCommit);
  fs.writeFileSync(path.join(engine.projectSkill, 'modules/story/SKILL.md'), 'story v1');
  const plan = engine.prepareProjectSkill(secondCommit, '4.4.0'); plan.finalize();
  assert.equal(fs.existsSync(path.join(engine.projectSkill, 'modules/story/SKILL.md')), false);
  assert.equal(fs.readFileSync(path.join(engine.projectSkill, 'modules/assets/SKILL.md'), 'utf8'), 'assets v2');
  assert.equal(engine.projectSkillStatus().commit, secondCommit);
  assert.deepEqual(engine.projectSkillStatus().modifiedFiles, []);
});
test('runtime rollback restores the matching full project Skill commit', t => {
  const engine = fixture(t); initUpstream(engine);
  const firstCommit = commitFiles(engine, { 'SKILL.md': '---\nversion: "4.3.9"\n---\nAcheng v1\n', 'modules/story/SKILL.md': 'story v1' });
  const first = version(engine, 'runtime-v1', firstCommit, '4.3.9');
  const secondCommit = commitFiles(engine, { 'SKILL.md': '---\nversion: "4.4.0"\n---\nAcheng v2\n', 'modules/story/SKILL.md': 'story v2' });
  const second = version(engine, 'runtime-v2', secondCommit, '4.4.0');
  engine.activate(first, null);
  engine.activate(second, first);
  engine.prepareProjectSkill(secondCommit, '4.4.0').finalize();
  engine.rollback();
  assert.equal(engine.state().active.runtimeId, 'runtime-v1');
  assert.equal(engine.projectSkillStatus().commit, firstCommit);
  assert.match(fs.readFileSync(path.join(engine.projectSkill, 'SKILL.md'), 'utf8'), /Acheng v1/);
});
