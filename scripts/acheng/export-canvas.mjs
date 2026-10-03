import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { AchengEngine, verifyRuntime } from '../acheng-engine.mjs';

const [sourceArg, mappingArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !mappingArg || !outputArg) throw new Error('Usage: node scripts/acheng/export-canvas.mjs production.json canvas-mapping.json NEW_OUTPUT_DIRECTORY');
const sourceFile = path.resolve(sourceArg), out = path.resolve(outputArg);
const mapping = JSON.parse(fs.readFileSync(mappingArg, 'utf8'));
const active = mapping.engine || new AchengEngine().state()?.active;
if (!active?.path) throw new Error('No activated/pinned Acheng runtime. Run npm run acheng:update first.');
const engine = verifyRuntime(active.path);
const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
if (JSON.stringify(source).includes('"legacy_fixture"')) throw new Error('Historical fixtures cannot be submitted as new production');
if (fs.existsSync(out)) throw new Error('Output already exists; choose a new revision directory');
fs.mkdirSync(out, { recursive: true });
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const sourceHash = sha(canonical(source));
const python = process.env.ACHENG_PYTHON || 'python';
const artifactFolder = path.join(out, 'compiled');
const onlyAssets = !(source.segments?.length);
try {
  execFileSync(python, ['-B', '-X', 'utf8', path.join(active.path, 'scripts', onlyAssets ? 'compile_assets.py' : 'compile_h3.py'), sourceFile, '--out', artifactFolder, '--draft'], { cwd: active.path, windowsHide: true, stdio: 'inherit' });
} catch (error) {
  // H3 code 2 means a successfully retained draft with unresolved dependencies.
  if (onlyAssets || error.status !== 2 || !fs.existsSync(path.join(artifactFolder, 'index.json'))) throw error;
}
const index = JSON.parse(fs.readFileSync(path.join(artifactFolder, 'index.json'), 'utf8'));
const artifacts = [];
for (const [kind, entries] of [['image', index.asset_prompts || index.assets || []], ['h3', index.segments || []]]) {
  for (const entry of entries) {
    const targetId = entry.asset_id || entry.segment_id;
    const prompt = fs.readFileSync(path.join(artifactFolder, entry.prompt_file || entry.file), 'utf8');
    const ready = kind === 'h3' ? entry.accepted === true && entry.format_pass === 'PASSED' : ['PROMPT_READY', 'ready-to-submit-not-generated'].includes(entry.status);
    const references = (entry.references || entry.binding_snapshot?.references || []).filter(ref => ref.file).flatMap(ref => {
      const label = ref.label || `<Picture ${ref.image}>`;
      const binding = mapping.references?.[targetId]?.find(item => item.label === label);
      const copied = path.resolve(artifactFolder, ref.file);
      const original = path.resolve(path.dirname(sourceFile), ref.source_file || ref.file);
      const file = fs.existsSync(copied) ? copied : original;
      if (!binding || !fs.existsSync(file)) {
        if (ready) throw new Error(`Missing Canvas mapping/media for ${targetId} ${label}`);
        return []; // Unresolved planned references remain in source, never invented as actual inputs.
      }
      const bytes = fs.readFileSync(file);
      const digest = sha(bytes);
      if (ref.sha256 && ref.sha256 !== digest) throw new Error('Compiled reference hash changed');
      return [{ ...binding, label, sha256: digest }];
    });
    artifacts.push({ id: `${kind}-${targetId}`, kind, targetId, prompt, sha256: sha(prompt), sourceHash, status: ready ? 'ready' : 'draft', references,
      receipt: { sourceHash, promptHash: sha(prompt), engineRuntimeId: engine.runtimeId, validator: onlyAssets ? 'compile_assets/validate_asset_entries' : 'compile_h3/validate_package' } });
  }
}
const director = { schemaVersion: 1, engine: { commit: engine.commit, patchVersion: engine.patchVersion, runtimeId: engine.runtimeId, version: engine.version },
  source, sourceHash, modules: mapping.modules || {}, artifacts, assets: mapping.assets || {}, shotInputs: mapping.shotInputs || {}, boundaries: mapping.boundaries || [],
  executionAuthorized: mapping.executionAuthorized === true, unresolved: mapping.unresolved || [], workflow: mapping.workflow || {} };
fs.writeFileSync(path.join(out, 'director.json'), JSON.stringify(director, null, 2));
console.log(path.join(out, 'director.json'));
