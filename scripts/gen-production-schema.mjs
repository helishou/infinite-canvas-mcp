#!/usr/bin/env node
// 从 schema/production.schema.json 生成 Python 元数据、TS 类型与表单描述、文档表格。
// 用法: node scripts/gen-production-schema.mjs [--check]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(readFileSync(resolve(root, "schema/production.schema.json"), "utf8"));
const shot = schema.shot;

const keys = (list) => list.map((item) => item.key);
const maxes = (list) => Object.fromEntries(list.map((item) => [item.key, item.max]));
const camel = (value) => value.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

function pyModule() {
  return [
    '"""由 schema/production.schema.json 生成，勿手改。运行 node scripts/gen-production-schema.mjs 重生成。"""',
    "",
    `SCHEMA_VERSION = ${schema.version}`,
    `MAX_CHARS_PER_TEXT_ITEM = ${schema.limits.max_chars_per_text_item}`,
    "",
    `FACTS_FIELDS = ${JSON.stringify(keys(shot.facts.fields))}`,
    `FACTS_MAX = ${JSON.stringify(maxes(shot.facts.fields))}`,
    "",
    `COMBAT_FIELDS = ${JSON.stringify(keys(shot.combat_contract.fields))}`,
    `COMBAT_MAX = ${JSON.stringify(maxes(shot.combat_contract.fields))}`,
    "",
    `PERFORMANCE_FIELDS = ${JSON.stringify(keys(shot.performance_contract.fields))}`,
    `PERFORMANCE_MAX = ${JSON.stringify(maxes(shot.performance_contract.fields))}`,
    "",
    `TEMPLATES = ${JSON.stringify(schema.templates, null, 4)}`,
    "",
    `GUIDANCE = ${JSON.stringify(schema.guidance_only, null, 4)}`,
    "",
  ].join("\n");
}

function tsModule() {
  const iface = (name, list) => `export interface ${name}Contract {\n${list.map((f) => `  ${camel(f.key)}?: string;`).join("\n")}\n}\n`;
  const describe = (list) => JSON.stringify(list.map((f) => ({ key: f.key, label: f.zh, max: f.max, hint: f.hint || "" })));
  return `// 由 schema/production.schema.json 生成，勿手改。
export const SCHEMA_VERSION = ${schema.version};
export const MAX_CHARS_PER_TEXT_ITEM = ${schema.limits.max_chars_per_text_item};

export const FACTS_FIELDS = ${JSON.stringify(keys(shot.facts.fields))} as const;
export const COMBAT_FIELDS = ${JSON.stringify(keys(shot.combat_contract.fields))} as const;
export const PERFORMANCE_FIELDS = ${JSON.stringify(keys(shot.performance_contract.fields))} as const;

export interface FieldDescriptor { key: string; label: string; max: number; hint: string }

export const FACTS_FIELD_DESCRIPTORS: FieldDescriptor[] = ${describe(shot.facts.fields)};
export const COMBAT_FIELD_DESCRIPTORS: FieldDescriptor[] = ${describe(shot.combat_contract.fields)};
export const PERFORMANCE_FIELD_DESCRIPTORS: FieldDescriptor[] = ${describe(shot.performance_contract.fields)};

${iface("ShotFacts", shot.facts.fields)}
${iface("Combat", shot.combat_contract.fields)}
${iface("Performance", shot.performance_contract.fields)}

export const GUIDANCE = ${JSON.stringify(schema.guidance_only, null, 2)} as const;
`;
}

function mdDoc() {
  const table = (fields) => `| 字段 | 中文 | 建议上限 |\n|---|---|---|\n${fields.map((f) => `| \`${f.key}\` | ${f.zh} | ${f.max} |`).join("\n")}\n`;
  return `# 生成字段表（勿手改）

来源：\`schema/production.schema.json\` v${schema.version}
单文本项上限：**${schema.limits.max_chars_per_text_item}** 字符

## 镜级事实（写一次，可从上镜继承）

${table(shot.facts.fields)}
## 武戏连续性契约（只有跨镜必须校验的事实）

${table(shot.combat_contract.fields)}
## 文戏连续性契约

${table(shot.performance_contract.fields)}
## 写作方法（不进 schema、不进校验、不进编译）

- 武戏五拍：${schema.guidance_only.combat_beats.join(" → ")}
- 武戏七层：${schema.guidance_only.combat_layers.join(" · ")}
- 文戏五拍：${schema.guidance_only.performance_beats.join(" → ")}
- 详见：${schema.guidance_only.see.join("、")}
`;
}

const outputs = [
  [resolve(root, ".agents/skills/acheng-director/scripts/production_schema.py"), pyModule()],
  [resolve(root, "web/src/pages/drama/production-schema.generated.ts"), tsModule()],
  [resolve(root, ".agents/skills/acheng-director/references/90-fields.generated.md"), mdDoc()],
];

const check = process.argv.includes("--check");
let drift = 0;
for (const [path, content] of outputs) {
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (check) {
    if (current !== content) {
      drift += 1;
      console.error(`DRIFT ${path.replace(root, ".")}`);
    }
  } else if (current !== content) {
    writeFileSync(path, content);
    console.log(`wrote ${path.replace(root, ".")}`);
  }
}
if (check) {
  if (drift) {
    console.error(`schema 漂移 ${drift} 处：先运行 node scripts/gen-production-schema.mjs`);
    process.exit(1);
  }
  console.log("schema 一致");
}
