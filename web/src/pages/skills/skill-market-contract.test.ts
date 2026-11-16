import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

test("技能广场复用文件系统存储：本体在 .agents/skills，状态在 skill-market/state.json", () => {
    const routes = read("../../../../backend/src/server/skill-market-routes.ts");
    assert.match(routes, /\.agents", "skills"/, "技能本体落在 .agents/skills，安装后 Codex 可直接使用");
    assert.match(routes, /\.canvas-runtime", "skill-market", "state\.json"/, "广场状态集中存储，无数据库");
    assert.match(routes, /sha256/, "状态用哈希 revision");
    assert.match(routes, /expectedRevision/, "状态更新带乐观锁");
    assert.match(routes, /const NAME_PATTERN = \/\^\[a-z\]\[a-z0-9-\]/, "技能名白名单校验");
    assert.match(routes, /isBuiltin\(name\)/, "内置技能受保护");
    for (const endpoint of ["/api/skill-market/skills", "/api/skill-market/detail", "/api/skill-market/state", "/api/skill-market/install", "/api/skill-market/uninstall"]) {
        assert.ok(routes.includes(endpoint), `缺少端点 ${endpoint}`);
    }
});

test("前端技能广场覆盖四范围、分类、搜索排序、详情与安装分发", () => {
    const market = read("./market.tsx");
    const api = read("../../services/api/skill-market.ts");
    assert.match(market, /data-testid=\{`market-scope-\$\{value\}`\}/, "四个范围由 scope 数组渲染");
    assert.match(market, /\["all", "mine", "created", "favorites"\] as Scope\[\]/, "覆盖四范围");
    for (const category of ["drama", "ecommerce", "creative", "social", "others"]) assert.match(api, new RegExp(`"${category}"`));
    assert.match(market, /data-testid="market-search"/);
    assert.match(market, /data-testid="market-sort"/);
    assert.match(market, /data-testid="market-grid"/);
    assert.match(market, /data-testid="market-detail-preview"/);
    assert.match(market, /data-testid="market-detail-source"/);
    assert.match(market, /data-testid="market-install-mode"/);
    assert.match(market, /data-testid="market-install-confirm"/);
    assert.match(market, /unzipSync/, "ZIP 技能包在前端用 fflate 解压");
    assert.match(market, /Streamdown/, "详情用 Markdown 预览");
    assert.match(market, /splitSkillFrontmatter\(detail\.content\)\.body/, "预览拆分 frontmatter，不渲染原始 YAML");
    assert.match(api, /fileToBase64/, "上传走 base64 JSON，复用现有 request 通道");
});

test("技能广场作为默认视图，原 Acheng 项目管理保留为可切换 Tab", () => {
    const index = read("./index.tsx");
    assert.match(index, /import \{ SkillMarket \} from "\.\/market"/);
    assert.match(index, /useState<"market" \| "acheng">\("market"\)/, "默认进入技能广场");
    assert.match(index, /view === "market" \? <SkillMarket \/> : <AchengSkillManager \/>/, "两个视图都保留");
    assert.match(index, /function AchengSkillManager\(\)/, "原项目管理逻辑未删");
    assert.match(index, /data-testid="skills-view-switch"/);
});

test("中英文案覆盖广场、范围、分类、安装与详情", () => {
    for (const locale of ["zh-CN", "en-US"]) {
        const source = read(`../../i18n/locales/${locale}.ts`);
        assert.match(source, /skillMarket: \{/);
        for (const key of ["title", "scope:", "category:", "sort:", "installModal:", "detail:", "loadFailed"]) {
            assert.ok(source.includes(key), `${locale} 缺少 skillMarket.${key}`);
        }
    }
});
