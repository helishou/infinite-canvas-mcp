import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { AchengEngine, inventory, verifyRuntime, runtimePatchVersion, runtimeIdentity, applyRuntimeSkillOverlay, copySourceSnapshot, sourceSnapshotHash } from './acheng-engine.mjs';

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
  git(engine.source, ['config', 'core.autocrlf', 'false']);
  git(engine.source, ['remote', 'add', 'origin', engine.upstream]);
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
test('working-tree snapshot includes authored local edits and verifies exact source bytes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acheng-source-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), destination = path.join(root, 'snapshot');
  fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(source, 'output'), { recursive: true });
  fs.writeFileSync(path.join(source, 'scripts/dialogue_editing.py'), 'authored local change\n');
  fs.writeFileSync(path.join(source, 'output/transient.txt'), 'ignored build output');
  fs.writeFileSync(path.join(source, 'canvas-engine.json'), 'ignored runtime manifest');
  const before = sourceSnapshotHash(source);
  fs.mkdirSync(destination);
  copySourceSnapshot(source, destination);
  assert.equal(fs.readFileSync(path.join(destination, 'scripts/dialogue_editing.py'), 'utf8'), 'authored local change\n');
  assert.equal(fs.existsSync(path.join(destination, 'output')), false);
  assert.equal(fs.existsSync(path.join(destination, 'canvas-engine.json')), false);
  assert.equal(sourceSnapshotHash(source), before);
  fs.writeFileSync(path.join(source, 'scripts/dialogue_editing.py'), 'changed during next build\n');
  assert.notEqual(sourceSnapshotHash(source), before);
});
test('working-tree fingerprints bind the runtime without changing the loader identity format', () => {
  const commit = 'a'.repeat(40), patch = 'b'.repeat(16), firstTree = 'c'.repeat(64), secondTree = 'd'.repeat(64);
  const first = runtimeIdentity(commit, patch, firstTree), second = runtimeIdentity(commit, patch, secondTree);
  assert.match(first.runtimeId, /^[a-f0-9]{40}-[a-f0-9]{16}$/);
  assert.notEqual(first.runtimeId, second.runtimeId);
  assert.equal(runtimeIdentity(commit, patch, undefined).runtimeId, `${commit}-${patch}`);
});
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

const entry = '---\nname: acheng-director\ndescription: Test director\nmetadata:\n  version: "4.3.9"\n---\n你是总导演及生产合同的唯一写入者。先读用户 brief。\n';
function cachedVersion(engine, commit) {
  return version(engine, `${commit}-${runtimePatchVersion(engine.upstream)}`, commit, '4.3.9');
}

test('source status uses the editable Git checkout and reports uncommitted files', t => {
  const engine = fixture(t); initUpstream(engine);
  const commit = commitFiles(engine, { 'SKILL.md': entry, 'scripts/example.py': 'original' });
  assert.equal(engine.source, engine.projectSkill);
  assert.equal(engine.projectSkillStatus().commit, commit);
  fs.writeFileSync(path.join(engine.source, 'scripts/example.py'), 'user edit');
  fs.writeFileSync(path.join(engine.source, 'draft.md'), 'user draft');
  const status = engine.projectSkillStatus();
  assert.deepEqual(status.modifiedFiles.sort(), ['draft.md', 'scripts/example.py']);
  assert.throws(() => engine.update(false, true), /local changes/);
  assert.equal(fs.readFileSync(path.join(engine.source, 'scripts/example.py'), 'utf8'), 'user edit');
  assert.equal(fs.readFileSync(path.join(engine.source, 'draft.md'), 'utf8'), 'user draft');
  assert.equal(engine.state(), null);
});

test('uninitialized source and unexpected origins cannot build a runtime', t => {
  const engine = fixture(t);
  fs.mkdirSync(engine.source, { recursive: true });
  fs.writeFileSync(path.join(engine.source, 'SKILL.md'), entry);
  assert.throws(() => engine.update(false, true), /submodule is not initialized/);
  initUpstream(engine); commitFiles(engine, { 'SKILL.md': entry });
  git(engine.source, ['remote', 'set-url', 'origin', 'https://example.invalid/other.git']);
  assert.throws(() => engine.update(false, true), /Unexpected Acheng origin/);
  assert.equal(engine.state(), null);
});

test('update locks fail closed without discarding source edits', t => {
  const engine = fixture(t);
  engine.locked(() => assert.throws(() => engine.locked(() => {}), /EEXIST/));
  assert.equal(fs.existsSync(path.join(engine.base, 'update.lock')), false);
});

test('local check and activation use committed HEAD without replacing the editable tree', t => {
  const engine = fixture(t); initUpstream(engine);
  const firstCommit = commitFiles(engine, { 'SKILL.md': entry, 'scripts/example.py': 'v1' });
  const first = cachedVersion(engine, firstCommit); engine.activate(first, null);
  const secondCommit = commitFiles(engine, { 'SKILL.md': entry, 'scripts/example.py': 'v2' });
  const second = cachedVersion(engine, secondCommit);
  const result = engine.update(true, true);
  assert.equal(result.commit, secondCommit);
  assert.equal(result.activated, false);
  assert.equal(engine.state().active.runtimeId, first.runtimeId);
  assert.equal(git(engine.source, ['rev-parse', 'HEAD']), secondCommit);
  engine.update(false, true);
  assert.equal(engine.state().active.runtimeId, second.runtimeId);
  assert.equal(fs.readFileSync(path.join(engine.source, 'scripts/example.py'), 'utf8'), 'v2');
  assert.deepEqual(engine.projectSkillStatus().modifiedFiles, []);
});

test('remote check leaves HEAD intact; verified update fast-forwards and refuses local commits', t => {
  const engine = fixture(t);
  const remote = path.join(engine.home, 'remote.git');
  fs.mkdirSync(remote); git(remote, ['init', '--bare']);
  engine.upstream = remote; initUpstream(engine);
  git(engine.source, ['branch', '-M', 'main']);
  const firstCommit = commitFiles(engine, { 'SKILL.md': entry, 'scripts/example.py': 'v1' });
  git(engine.source, ['push', '-u', 'origin', 'main']);
  const first = cachedVersion(engine, firstCommit); engine.activate(first, null);
  const secondCommit = commitFiles(engine, { 'SKILL.md': entry, 'scripts/example.py': 'v2' });
  git(engine.source, ['push', 'origin', 'main']);
  const second = cachedVersion(engine, secondCommit);
  git(engine.source, ['checkout', '--detach', firstCommit]);
  engine.update(true);
  assert.equal(git(engine.source, ['rev-parse', 'HEAD']), firstCommit);
  assert.equal(engine.state().active.runtimeId, first.runtimeId);
  engine.update(false);
  assert.equal(git(engine.source, ['rev-parse', 'HEAD']), secondCommit);
  assert.equal(engine.state().active.runtimeId, second.runtimeId);
  const localCommit = commitFiles(engine, { 'scripts/example.py': 'local v3' });
  assert.throws(() => engine.update(false), /local commits ahead of or diverged/);
  assert.equal(git(engine.source, ['rev-parse', 'HEAD']), localCommit);
  assert.equal(engine.state().active.runtimeId, second.runtimeId);
});

test('runtime rollback preserves the source branch, local commits and uncommitted drafts', t => {
  const engine = fixture(t); initUpstream(engine);
  const firstCommit = commitFiles(engine, { 'SKILL.md': entry, 'scripts/example.py': 'v1' });
  const first = cachedVersion(engine, firstCommit); engine.activate(first, null);
  const secondCommit = commitFiles(engine, { 'scripts/example.py': 'v2' });
  const second = cachedVersion(engine, secondCommit); engine.activate(second, first);
  fs.writeFileSync(path.join(engine.source, 'draft.md'), 'keep draft');
  engine.rollback();
  assert.equal(engine.state().active.runtimeId, first.runtimeId);
  assert.equal(git(engine.source, ['rev-parse', 'HEAD']), secondCommit);
  assert.equal(fs.readFileSync(path.join(engine.source, 'scripts/example.py'), 'utf8'), 'v2');
  assert.equal(fs.readFileSync(path.join(engine.source, 'draft.md'), 'utf8'), 'keep draft');
});

test('deployment clones only an explicitly configured writable source', t => {
  const engine = fixture(t); initUpstream(engine);
  const commit = commitFiles(engine, { 'SKILL.md': entry });
  git(engine.source, ['branch', '-M', 'main']);
  const deployed = new AchengEngine(path.join(engine.home, 'deployed-home'), engine.source,
    path.join(engine.home, 'packaged-app'), path.join(engine.home, 'writable-source'));
  assert.equal(deployed.fetch(), commit);
  assert.equal(deployed.cleanSource().commit, commit);
  fs.writeFileSync(path.join(deployed.source, 'draft.md'), 'keep deployment draft');
  assert.throws(() => deployed.fetch(), /local changes/);
  assert.equal(fs.readFileSync(path.join(deployed.source, 'draft.md'), 'utf8'), 'keep deployment draft');
});

test('runtime adaptation removes promotions without altering source or license notices', t => {
  const engine = fixture(t); initUpstream(engine);
  const skill = [entry,
    '### 首次会话固定响应与版权声明（首次交互唯一输出规则）',
    '必须输出开场：🎬 Acheng 影视牛马竭诚为您服务！',
    '新建一次长内容生产运行时，首次响应在开场横幅下方发送以下固定长内容交付方式选择题，不开始正文生产：',
    '```text\n1. 自动文件批处理模式\n2. 交互制作模式\n```',
    '首次响应（或首次交付包）末尾必须附加的固定版权与免责声明：',
    '```text\n💡 认准唯一开源主页：关注 B站【Acheng琢影】\n```',
    '将选择写入本次请求的 `execution_mode`：`autonomous_file_batch` 或 `interactive_segment`。后续所有输出严禁重复携带上述开场横幅与末尾免责声明。',
    '### `/goal` 多轮执行合同\n保留完整生产正文。',
  ].join('\n\n');
  const notice = 'Copyright (c) 2026 Acheng';
  commitFiles(engine, { 'SKILL.md': skill, NOTICE: notice });
  const candidate = path.join(engine.home, 'candidate');
  fs.mkdirSync(candidate); fs.cpSync(engine.source, candidate, { recursive: true, filter: file => path.basename(file) !== '.git' });
  for (let pass = 0; pass < 2; pass++) {
    applyRuntimeSkillOverlay(candidate);
    const installed = fs.readFileSync(path.join(candidate, 'SKILL.md'), 'utf8');
    assert.doesNotMatch(installed, /影视牛马|认准唯一开源主页|必须输出开场|必须附加的固定版权|开场横幅下方|上述开场横幅/);
    assert.match(installed, /1\. 自动文件批处理模式\n2\. 交互制作模式/);
    assert.match(installed, /`execution_mode`：`autonomous_file_batch` 或 `interactive_segment`/);
    assert.match(installed, /### `\/goal` 多轮执行合同\n保留完整生产正文。/);
    assert.equal(fs.readFileSync(path.join(candidate, 'NOTICE'), 'utf8'), notice);
    assert.equal(fs.readFileSync(path.join(engine.source, 'SKILL.md'), 'utf8'), skill);
    assert.deepEqual(engine.projectSkillStatus().modifiedFiles, []);
  }
});


test('Canvas instructions remain a single block with Windows line endings', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acheng-overlay-crlf-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fragment = fs.readFileSync(new URL('./acheng/canvas-kickoff.md', import.meta.url), 'utf8').replaceAll('\r\n', '\n').trim();
  const entry = path.join(root, 'SKILL.md');
  fs.writeFileSync(entry, `你是总导演及生产合同的唯一写入者。\n\n${fragment}\n\n## 后续正文\n`.replaceAll('\n', '\r\n'));
  for (let pass = 0; pass < 2; pass++) {
    applyRuntimeSkillOverlay(root);
    const output = fs.readFileSync(entry, 'utf8');
    assert.equal(output.split(fragment.split('\n')[0]).length, 2);
    assert.ok(output.replaceAll('\r\n', '\n').includes(fragment));
    assert.ok(!output.includes('\r\r\n'));
  }
});
