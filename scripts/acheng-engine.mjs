import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveAchengPython } from '@basketikun/canvas-agent/skills/acheng';

export const UPSTREAM = 'https://github.com/AharaOoO/acheng-director-skill.git';
const scripts = path.dirname(fileURLToPath(import.meta.url));
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
const ignored = new Set(['.git', '__pycache__', '.pytest_cache', 'output']);
export function inventory(root, directory = root) {
  return Object.fromEntries(fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (ignored.has(entry.name) || entry.name === 'canvas-engine.json') return [];
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected runtime link: ${file}`);
    return entry.isDirectory() ? Object.entries(inventory(root, file)) : [[path.relative(root, file).replaceAll('\\', '/'), sha(fs.readFileSync(file))]];
  }).sort(([a], [b]) => a.localeCompare(b)));
}
export function verifyRuntime(directory) {
  const manifest = read(path.join(directory, 'canvas-engine.json'));
  if (JSON.stringify(inventory(directory)) !== JSON.stringify(manifest.files)) throw new Error('Acheng runtime was modified; preserve local changes before updating');
  return manifest;
}
export class AchengEngine {
  constructor(home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), upstream = UPSTREAM) {
    this.home = path.resolve(home); this.upstream = upstream;
    this.base = path.join(this.home, 'skill-runtimes', 'acheng-director');
    this.source = path.join(this.home, 'skill-sources', 'acheng-director');
    this.entry = path.join(this.home, 'skills', 'acheng-director');
    this.stateFile = path.join(this.base, 'active.json');
  }
  state() { return fs.existsSync(this.stateFile) ? read(this.stateFile) : null; }
  status() {
    const state = this.state();
    if (state && (!fs.existsSync(this.entry) || fs.realpathSync(this.entry) !== fs.realpathSync(state.active.path))) throw new Error('Acheng discovery entry differs from the active runtime; preserve the local entry before updating');
    return { upstream: this.upstream, branch: 'main', source: this.source, entry: this.entry, ...state,
      compatibility: state ? (verifyRuntime(state.active.path), 'verified') : 'unmanaged',
      installed: fs.existsSync(this.entry) };
  }
  locked(fn) {
    fs.mkdirSync(this.base, { recursive: true });
    const lock = path.join(this.base, 'update.lock');
    const handle = fs.openSync(lock, 'wx');
    fs.writeFileSync(handle, JSON.stringify({ pid: process.pid }));
    try { return fn(); } finally { fs.closeSync(handle); fs.unlinkSync(lock); }
  }
  fetch() {
    fs.mkdirSync(path.dirname(this.source), { recursive: true });
    if (!fs.existsSync(this.source)) run('git', ['clone', '--branch', 'main', '--single-branch', this.upstream, this.source]);
    if (run('git', ['status', '--porcelain', '--untracked-files=all'], this.source).trim()) throw new Error('Upstream checkout has local changes; update aborted');
    if (run('git', ['remote', 'get-url', 'origin'], this.source).trim() !== this.upstream) throw new Error('Unexpected Acheng origin');
    run('git', ['fetch', 'origin', 'main'], this.source);
    return run('git', ['rev-parse', 'origin/main'], this.source).trim();
  }
  update(check = false, local = false) { return this.locked(() => {
    const old = this.state();
    if (old) this.status();
    if (local && !old?.active) throw new Error('Local overlay update requires an activated runtime');
    const commit = local ? old.active.commit : this.fetch();
    const changes = old ? run('git', ['diff', '--name-only', old.active.commit, commit], this.source).trim().split('\n').filter(Boolean) : ['initial managed installation'];
    const overlayFiles = ['compat.py', 'verify.py', 'contracts.json', 'restore-source-bytes.py', 'source-contract.py'];
    const patchVersion = sha(Buffer.concat(overlayFiles.map(file => fs.readFileSync(path.join(scripts, 'acheng', file))))).slice(0, 16);
    const runtimeId = `${commit}-${patchVersion}`;
    const runtime = path.join(this.base, 'versions', runtimeId);
    if (fs.existsSync(runtime)) verifyRuntime(runtime);
    else {
      fs.mkdirSync(path.dirname(runtime), { recursive: true });
      const candidate = fs.mkdtempSync(path.join(this.base, 'candidate-'));
      const archive = path.join(candidate, 'upstream.tar');
      const directory = path.join(candidate, 'skill'); fs.mkdirSync(directory);
      run('git', ['archive', '--format=tar', `--output=${archive}`, commit], this.source);
      const python = resolveAchengPython();
      run(python, ['-B', '-X', 'utf8', '-c', 'import tarfile,sys; tarfile.open(sys.argv[1]).extractall(sys.argv[2], filter="data")', archive, directory]);
      const contracts = read(path.join(scripts, 'acheng', 'contracts.json'));
      const changedContracts = [];
      for (const [file, expected] of Object.entries(contracts)) {
        const actual = sha(fs.readFileSync(path.join(directory, file), 'utf8').replaceAll('\r\n', '\n'));
        if (actual !== expected) changedContracts.push(file);
      }
      let upstreamFixed = false;
      if (changedContracts.length) {
        const fixes = ['SKILL.md', 'scripts/h3_contract.py', 'scripts/h3_final_format.py', 'scripts/style_anchor.py'];
        if (changedContracts.some(file => !fixes.includes(file))) throw new Error(`Upstream contract changed: ${changedContracts.join(', ')}. Review compatibility before activation. Candidate retained: ${candidate}`);
        // Retire the local overlay only if the real upstream behavior already
        // satisfies its tests; a failed textual patch is never evidence of a fix.
        run(python, ['-B', '-X', 'utf8', path.join(scripts, 'acheng', 'verify.py'), directory]);
        upstreamFixed = true;
      }
      run(python, ['-B', '-X', 'utf8', path.join(scripts, 'acheng', 'restore-source-bytes.py'), directory]);
      // Verify the unchanged upstream suite first; its historical fixtures have
      // intentionally different density expectations from new Canvas production.
      run(python, ['-B', '-X', 'utf8', '-m', 'unittest', 'discover', '-s', 'scripts', '-p', 'test_*.py'], directory);
      if (!upstreamFixed) run(python, ['-B', '-X', 'utf8', path.join(scripts, 'acheng', 'compat.py'), directory]);
      run(python, ['-B', '-X', 'utf8', path.join(scripts, 'acheng', 'verify.py'), directory]);
      run(python, ['-B', '-X', 'utf8', 'scripts/validate_director_contract.py'], directory);
      const version = fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8').match(/version:\s*"([^"]+)"/)?.[1] || 'unknown';
      const manifest = { upstream: this.upstream, branch: 'main', commit, version, patchVersion, runtimeId, overlayApplied: !upstreamFixed, files: inventory(directory), verifiedAt: new Date().toISOString() };
      fs.writeFileSync(path.join(directory, 'canvas-engine.json'), JSON.stringify(manifest, null, 2));
      fs.renameSync(directory, runtime);
      fs.unlinkSync(archive); fs.rmdirSync(candidate);
    }
    const manifest = verifyRuntime(runtime);
    const active = { path: runtime, runtimeId, commit, patchVersion, version: manifest.version };
    if (!check && old?.active.runtimeId !== runtimeId) this.activate(active, old?.active || null);
    return { ...active, changes, activated: !check, unchanged: old?.active.runtimeId === runtimeId, compatibility: 'verified' };
  }); }
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
    verifyRuntime(state.active.path); this.activate(state.previous, state.active); return this.status();
  }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const engine = new AchengEngine(); const command = process.argv[2] || 'status';
    const result = command === 'status' ? engine.status() : command === 'update' ? engine.update(process.argv.includes('--check'), process.argv.includes('--local')) : command === 'rollback' ? engine.rollback() : (() => { throw new Error('Use status, update [--check] [--local], or rollback'); })();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
