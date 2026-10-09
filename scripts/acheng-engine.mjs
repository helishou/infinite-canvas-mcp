import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveAchengPython } from '@basketikun/canvas-agent/skills/acheng';

export const UPSTREAM = 'https://github.com/helishou/acheng-director-skill.git';
const scripts = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scripts, '..');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const projectOverlayPath = path.join(scripts, 'acheng', 'canvas-kickoff.md');
const run = (cmd, args, cwd, env) => execFileSync(cmd, args, { cwd, ...(env ? { env: { ...process.env, ...env } } : {}), encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
const ignored = new Set(['.git', '__pycache__', '.pytest_cache', 'output']);
export function applyRuntimeSkillOverlay(directory) {
  const entry = path.join(directory, 'SKILL.md');
  const fragment = fs.readFileSync(projectOverlayPath, 'utf8').replaceAll('\r\n', '\n').trim();
  const newline = fs.readFileSync(entry, 'utf8').includes('\r\n') ? '\r\n' : '\n';
  let text = fs.readFileSync(entry, 'utf8').replaceAll('\r\n', '\n');
  // Keep production choices while removing upstream's mandatory promotional output.
  const opening = '### 首次会话固定响应与版权声明（首次交互唯一输出规则）';
  if (text.includes(opening)) {
    const question = '新建一次长内容生产运行时，首次响应在开场横幅下方发送以下固定长内容交付方式选择题，不开始正文生产：';
    const footer = '首次响应（或首次交付包）末尾必须附加的固定版权与免责声明：';
    const execution = '将选择写入本次请求的 `execution_mode`';
    const start = text.indexOf(opening), questionStart = text.indexOf(question, start);
    const footerStart = text.indexOf(footer, questionStart), executionStart = text.indexOf(execution, footerStart);
    if (questionStart < start || footerStart < questionStart || executionStart < footerStart) {
      throw new Error('Acheng promotional output section changed; review before applying the Canvas overlay');
    }
    text = `${text.slice(0, start)}### 长内容交付方式\n\n新建一次长内容生产运行时，首次响应发送以下长内容交付方式选择题，不开始正文生产：${text.slice(questionStart + question.length, footerStart)}${text.slice(executionStart)}`;
    text = text.replace('后续所有输出严禁重复携带上述开场横幅与末尾免责声明。', '');
  }
  const heading = fragment.split('\n', 1)[0];
  if (text.includes(heading)) {
    if (!text.includes(fragment)) throw new Error('Canvas kickoff overlay exists with different content; review before replacing');
    fs.writeFileSync(entry, text.replaceAll('\n', newline), 'utf8');
    return;
  }
  const marker = '你是总导演及生产合同的唯一写入者。';
  if (text.split(marker).length !== 2) throw new Error('Acheng director entry changed; cannot place the Canvas kickoff overlay');
  const start = text.indexOf(marker);
  const paragraphEnd = text.indexOf('\n\n', start);
  const end = paragraphEnd >= 0 ? paragraphEnd : text.indexOf('\n', start);
  if (end < 0) throw new Error('Acheng director entry has no paragraph boundary for the Canvas kickoff overlay');
  text = `${text.slice(0, end)}\n\n${fragment}${text.slice(end)}`;
  fs.writeFileSync(entry, text.replaceAll('\n', newline), 'utf8');
}
export function inventory(root, directory = root) {
  return Object.fromEntries(fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (ignored.has(entry.name) || entry.name === 'canvas-engine.json') return [];
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected runtime link: ${file}`);
    return entry.isDirectory() ? Object.entries(inventory(root, file)) : [[path.relative(root, file).replaceAll('\\', '/'), sha(fs.readFileSync(file))]];
  }).sort(([a], [b]) => a.localeCompare(b)));
}
export function sourceSnapshotHash(directory) {
  return sha(Buffer.from(JSON.stringify(inventory(directory))));
}
export function runtimeIdentity(commit, patchVersion, sourceTreeHash) {
  if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{16}$/.test(patchVersion) || sourceTreeHash && !/^[a-f0-9]{64}$/.test(sourceTreeHash)) {
    throw new Error('Invalid Acheng runtime identity input');
  }
  const boundPatchVersion = sourceTreeHash ? sha(Buffer.from(`${patchVersion}\n${sourceTreeHash}`)).slice(0, 16) : patchVersion;
  return { patchVersion: boundPatchVersion, runtimeId: `${commit}-${boundPatchVersion}` };
}
export function copySourceSnapshot(source, destination) {
  for (const relative of Object.keys(inventory(source))) {
    const from = path.join(source, ...relative.split('/'));
    const to = path.join(destination, ...relative.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}
export function verifyRuntime(directory) {
  const manifest = read(path.join(directory, 'canvas-engine.json'));
  if (JSON.stringify(inventory(directory)) !== JSON.stringify(manifest.files)) throw new Error('Acheng runtime was modified; preserve local changes before updating');
  return manifest;
}
export function runtimePatchVersion(upstream) {
  const files = ['compat.py', 'canvas_subject_prompt_v2.py', 'character-layout.py', 'h3-prompt-policy.py', 'model-contract.py', 'prompt-diagnostics.py', 'shot-diagnostics.py', 'model-contract.test.py', 'verify.py', 'contracts.json', 'restore-source-bytes.py', 'source-contract.py', 'canvas-kickoff.md'];
  return sha(Buffer.concat([Buffer.from(upstream + '\n'), fs.readFileSync(path.join(scripts, 'acheng-engine.mjs')), ...files.map(file => fs.readFileSync(path.join(scripts, 'acheng', file)))])).slice(0, 16);
}
export class AchengEngine {
  constructor(home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), upstream = UPSTREAM, repository = projectRoot, sourceDirectory = process.env.ACHENG_SOURCE) {
    this.home = path.resolve(home); this.upstream = upstream;
    this.repository = path.resolve(repository);
    this.projectSkill = path.join(this.repository, '.agents', 'skills', 'acheng-director');
    this.base = path.join(this.home, 'skill-runtimes', 'acheng-director');
    this.source = sourceDirectory ? path.resolve(sourceDirectory) : this.projectSkill;
    this.entry = path.join(this.home, 'skills', 'acheng-director');
    this.stateFile = path.join(this.base, 'active.json');
  }
  state() { return fs.existsSync(this.stateFile) ? read(this.stateFile) : null; }
  status() {
    const state = this.state();
    if (state && (!fs.existsSync(this.entry) || fs.realpathSync(this.entry) !== fs.realpathSync(state.active.path))) throw new Error('Acheng discovery entry differs from the active runtime; preserve the local entry before updating');
    return { upstream: this.upstream, branch: 'main', source: this.source, entry: this.entry, ...state,
      compatibility: state ? (verifyRuntime(state.active.path), 'verified') : 'unmanaged',
      installed: fs.existsSync(this.entry), projectSkill: this.projectSkillStatus() };
  }
  projectSkillStatus() {
    const gitEntry = path.join(this.source, '.git');
    if (!fs.existsSync(gitEntry)) return { path: this.source, installed: false, managed: false, modifiedFiles: [] };
    if (!fs.statSync(this.source).isDirectory() || fs.lstatSync(this.source).isSymbolicLink()) throw new Error('Project Acheng Skill path is not a plain directory');
    const root = run('git', ['rev-parse', '--show-toplevel'], this.source).trim();
    if (fs.realpathSync(root) !== fs.realpathSync(this.source)) throw new Error('Acheng source must be an independent Git checkout');
    const origin = run('git', ['remote', 'get-url', 'origin'], this.source).trim();
    if (origin !== this.upstream) throw new Error('Unexpected Acheng origin');
    const modifiedFiles = run('git', ['status', '--porcelain', '--untracked-files=all'], this.source).split(/\r?\n/).filter(Boolean).map(line => line.slice(3));
    const commit = run('git', ['rev-parse', 'HEAD'], this.source).trim();
    const branch = run('git', ['branch', '--show-current'], this.source).trim() || null;
    const version = fs.readFileSync(path.join(this.source, 'SKILL.md'), 'utf8').match(/version:\s*"([^"]+)"/)?.[1] || 'unknown';
    return { path: this.source, installed: true, managed: true, upstream: origin, commit, branch, version, modifiedFiles };
  }
  cleanSource() {
    const status = this.projectSkillStatus();
    if (!status.installed) throw new Error(this.source === this.projectSkill
      ? 'Acheng submodule is not initialized; run git submodule update --init -- .agents/skills/acheng-director'
      : 'Configured Acheng source is not initialized; run update to clone the fork before building locally');
    if (status.modifiedFiles.length) throw new Error('Acheng source has local changes; commit them in the submodule before building or updating. No files were overwritten.');
    return status;
  }
  locked(fn) {
    fs.mkdirSync(this.base, { recursive: true });
    const lock = path.join(this.base, 'update.lock');
    const handle = fs.openSync(lock, 'wx');
    fs.writeFileSync(handle, JSON.stringify({ pid: process.pid }));
    try { return fn(); } finally { fs.closeSync(handle); fs.unlinkSync(lock); }
  }
  fetch() {
    // Deployment images explicitly select a writable checkout outside their packaged source.
    if (this.source !== this.projectSkill && !fs.existsSync(path.join(this.source, '.git'))) {
      fs.mkdirSync(path.dirname(this.source), { recursive: true });
      run('git', ['clone', '--branch', 'main', '--single-branch', this.upstream, this.source]);
    }
    const current = this.cleanSource();
    run('git', ['fetch', 'origin', 'main'], this.source);
    const target = run('git', ['rev-parse', 'refs/remotes/origin/main'], this.source).trim();
    try { run('git', ['merge-base', '--is-ancestor', current.commit, target], this.source); }
    catch { throw new Error('Acheng source has local commits ahead of or diverged from origin/main; use update --local to build HEAD, or reconcile the branches explicitly.'); }
    return target;
  }
  update(check = false, local = false, workingTree = false) { return this.locked(() => {
    const old = this.state();
    if (old) this.status();
    if (local && workingTree) throw new Error('Choose either --local committed HEAD or --working-tree snapshot, not both.');
    const sourceStatus = workingTree ? this.projectSkillStatus() : (local ? this.cleanSource() : null);
    if (workingTree && (!sourceStatus?.installed || !sourceStatus.managed)) throw new Error('Working-tree snapshots require the configured independent Acheng Git checkout.');
    const commit = local || workingTree ? sourceStatus.commit : this.fetch();
    const treeHash = workingTree ? sourceSnapshotHash(this.source) : null;
    const baseChanges = old ? run('git', ['diff', '--name-only', old.active.commit, commit], this.source).trim().split('\n').filter(Boolean) : [];
    const changes = old ? [...new Set([...baseChanges, ...(workingTree ? sourceStatus.modifiedFiles : [])])] : ['initial managed installation'];
    const identity = runtimeIdentity(commit, runtimePatchVersion(this.upstream), treeHash);
    const { patchVersion, runtimeId } = identity;
    const runtime = path.join(this.base, 'versions', runtimeId);
    if (fs.existsSync(runtime)) verifyRuntime(runtime);
    else {
      fs.mkdirSync(path.dirname(runtime), { recursive: true });
      const candidate = fs.mkdtempSync(path.join(this.base, 'candidate-'));
      const archive = path.join(candidate, 'upstream.tar');
      const directory = path.join(candidate, 'skill'); fs.mkdirSync(directory);
      const python = resolveAchengPython();
      if (workingTree) copySourceSnapshot(this.source, directory);
      else {
        run('git', ['archive', '--format=tar', `--output=${archive}`, commit], this.source);
        run(python, ['-B', '-X', 'utf8', '-c', 'import tarfile,sys; tarfile.open(sys.argv[1]).extractall(sys.argv[2], filter="data")', archive, directory]);
      }
      const contracts = read(path.join(scripts, 'acheng', 'contracts.json'));
      const changedContracts = [];
      for (const [file, expected] of Object.entries(contracts)) {
        const actual = sha(fs.readFileSync(path.join(directory, file), 'utf8').replaceAll('\r\n', '\n'));
        if (actual !== expected) changedContracts.push(file);
      }
      let upstreamFixed = false;
      const changedCodeContracts = changedContracts.filter(file => file !== 'SKILL.md');
      if (changedCodeContracts.length) {
        const fixes = ['SKILL.md', 'scripts/h3_contract.py', 'scripts/h3_final_format.py', 'scripts/style_anchor.py'];
        if (changedCodeContracts.some(file => !fixes.includes(file))) throw new Error(`Upstream contract changed: ${changedContracts.join(', ')}. Review compatibility before activation. Candidate retained: ${candidate}`);
        // The Canvas contract probe imports the compatibility source schema, so
        // it cannot run against the raw archive. Apply the reviewed overlay and
        // validate the composed candidate below; never infer overlay retirement
        // from a raw upstream-only verification attempt.
      }
      run(python, ['-B', '-X', 'utf8', path.join(scripts, 'acheng', 'restore-source-bytes.py'), directory]);
      // Verify the unchanged upstream suite first; its historical fixtures have
      // intentionally different density expectations from new Canvas production.
      run(python, ['-B', '-X', 'utf8', '-m', 'unittest', 'discover', '-s', 'scripts', '-p', 'test_*.py'], directory);
      if (!upstreamFixed) run(python, ['-B', '-X', 'utf8', path.join(scripts, 'acheng', 'compat.py'), directory]);
      run(python, ['-B', '-X', 'utf8', path.join(scripts, 'acheng', 'verify.py'), directory]);
      run(python, ['-B', '-X', 'utf8', path.join(scripts, 'acheng', 'model-contract.test.py'), directory]);
      run(python, ['-B', '-X', 'utf8', 'scripts/validate_director_contract.py'], directory);
      applyRuntimeSkillOverlay(directory);
      const version = fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8').match(/version:\s*"([^"]+)"/)?.[1] || 'unknown';
      const manifest = { upstream: this.upstream, branch: 'main', commit, version, patchVersion, runtimeId, ...(treeHash ? { sourceTreeHash: treeHash } : {}), overlayApplied: !upstreamFixed, files: inventory(directory), verifiedAt: new Date().toISOString() };
      fs.writeFileSync(path.join(directory, 'canvas-engine.json'), JSON.stringify(manifest, null, 2));
      fs.renameSync(directory, runtime);
      if (fs.existsSync(archive)) fs.unlinkSync(archive);
      fs.rmdirSync(candidate);
    }
    const manifest = verifyRuntime(runtime);
    const active = { path: runtime, runtimeId, commit, patchVersion, version: manifest.version, ...(manifest.sourceTreeHash ? { sourceTreeHash: manifest.sourceTreeHash } : {}) };
    if (!check) {
      const current = workingTree ? this.projectSkillStatus() : this.cleanSource();
      if (workingTree && sourceSnapshotHash(this.source) !== treeHash) throw new Error('Acheng working tree changed during verification; rerun against a stable snapshot.');
      if (local && current.commit !== commit) throw new Error('Acheng HEAD changed during verification; rerun against the current commit');
      if (!local && !workingTree && current.commit !== commit) run('git', ['merge', '--ff-only', commit], this.source);
      if (old?.active.runtimeId !== runtimeId) this.activate(active, old?.active || null);
    }
    return { ...active, changes, activated: !check, unchanged: old?.active.runtimeId === runtimeId,
      compatibility: 'verified', projectSkill: this.projectSkillStatus() };
  }); }
  // Retained for the existing npm command; local builds no longer vendor over source files.
  vendor() { return this.update(false, true); }
  activate(active, previous) {
    verifyRuntime(active.path);
    fs.mkdirSync(path.dirname(this.entry), { recursive: true });
    const backupRoot = path.join(this.base, 'backups'); fs.mkdirSync(backupRoot, { recursive: true });
    const backup = path.join(backupRoot, `entry-${Date.now()}-${crypto.randomUUID()}`);
    const staged = `${this.entry}.activating-${crypto.randomUUID()}`;
    fs.symlinkSync(active.path, staged, process.platform === 'win32' ? 'junction' : 'dir');
    const existed = fs.existsSync(this.entry);
    try {
      if (existed) fs.renameSync(this.entry, backup);
      fs.renameSync(staged, this.entry);
      const temporary = `${this.stateFile}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ active, previous, installedBackup: existed ? backup : null }, null, 2));
      fs.renameSync(temporary, this.stateFile);
    } catch (error) {
      if (fs.existsSync(this.entry) && fs.lstatSync(this.entry).isSymbolicLink()) fs.unlinkSync(this.entry);
      if (existed && fs.existsSync(backup)) fs.renameSync(backup, this.entry);
      if (fs.existsSync(staged)) fs.unlinkSync(staged);
      throw error;
    }
  }
  rollback() { return this.locked(() => {
    const state = this.state(); if (!state?.previous) throw new Error('No previous verified Acheng runtime');
    verifyRuntime(state.active.path);
    this.activate(state.previous, state.active);
    return this.status();
  }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const engine = new AchengEngine(); const command = process.argv[2] || 'status';
    const result = command === 'status' ? engine.status() : command === 'update' ? engine.update(process.argv.includes('--check'), process.argv.includes('--local'), process.argv.includes('--working-tree')) : command === 'rollback' ? engine.rollback() : command === 'vendor' ? engine.vendor() : (() => { throw new Error('Use status, update [--check] [--local|--working-tree], rollback, or vendor'); })();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
