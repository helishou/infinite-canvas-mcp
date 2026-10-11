import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preflightDirector, preflightProductionRequest } from '@basketikun/canvas-agent/skills/acheng';

export { preflightDirector };
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [file, stage = 'edit'] = process.argv.slice(2);
  if (!file || !['edit', 'publish', 'generate'].includes(stage)) throw new Error('Usage: node scripts/acheng/preflight.mjs director.json [edit|publish|generate]');
  const input = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const result = Object.hasOwn(input, 'action') ? preflightProductionRequest(input, input.production) : preflightDirector(input, stage);
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 1;
}
