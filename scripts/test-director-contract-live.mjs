// Opt-in single real Codex request verifying deterministic mandatory-contract preload.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../backend/src/config.ts';
import { professionalContract, loadWorkContract } from '../backend/src/drama/director-work-package.ts';
import { LlmAgent } from '@basketikun/canvas-agent/agent/llm';
import { ProductionAgentPool } from '@basketikun/canvas-agent/agent/production';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig(false), response = await fetch(config.url + '/settings/ai-config', { headers: { authorization: `Bearer ${config.token}` } });
assert.ok(response.ok);
const ai = (await response.json()).config;
const models = new LlmAgent({ get: key => key === 'ai.config' ? ai : undefined, set: () => {} }, config.url, config.token).providers();
const native = models.find(model => model.kind === 'codex-cli'); assert.ok(native);
const professional = professionalContract('shots'), loaded = loadWorkContract(professional);
for (const module of ['shots', 'performance', 'effects']) assert.ok(loaded.text.replaceAll('\\', '/').includes(`modules/${module}/SKILL.md ---`));
const pool = new ProductionAgentPool();
try {
    const result = await pool.run({ workId: 'mandatory-contract-preload-acceptance', cwd: repo, model: native.model, readRoots: [loaded.runtime.path],
        prompt: `这是只读合同预载验收，不创作、不生成、不调用其他工具。所有必载文件正文已由 Backend 核验并提供，不重复打开。请从 shots、performance、effects 三个模块各提取一项具体原则，用自己的话简述，每字段最多四十个汉字，严格 JSON 三字段。\n${loaded.text}`,
        schema: { type: 'object', additionalProperties: false, properties: { shots: { type: 'string' }, performance: { type: 'string' }, effects: { type: 'string' } }, required: ['shots', 'performance', 'effects'] }, onThread: () => {} });
    for (const module of ['shots', 'performance', 'effects']) assert.ok(typeof result.output[module] === 'string' && result.output[module].length > 5);
    const file = path.join(repo, '.tmp/director-live-acceptance.json');
    const report = JSON.parse(await fs.readFile(file, 'utf8'));
    report.professionalContractPreload = { passed: true, runtimeId: professional.runtimeId, fileCount: professional.skillPaths.length, principles: result.output };
    await fs.writeFile(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report.professionalContractPreload));
} finally { pool.stop(); }
process.exit(process.exitCode || 0);
