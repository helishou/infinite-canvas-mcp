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

test("导演大师技能包作为可安装 catalog 源导入，正文与版权声明原样保留", () => {
    const catalogUrl = new URL("../../../../.canvas-runtime/skill-market/catalog/dm-v0.7.2/catalog.json", import.meta.url);
    const catalog = JSON.parse(readFileSync(catalogUrl, "utf8")) as {
        id: string; notice: string; skills: Array<{ slug: string; title: string; group: string; slots: string[] }>;
        functionSlots: Record<string, { label: string; defaultSkill: string; skills: string[] }>;
    };
    assert.equal(catalog.id, "dm-v0.7.2");
    assert.equal(catalog.skills.length, 45, "45 个技能全部导入");
    assert.match(catalog.notice, /版权/, "保留版权声明");
    assert.equal(Object.keys(catalog.functionSlots).length, 27, "27 个功能槽映射");
    assert.ok(catalog.skills.every(skill => /^[a-z0-9-]+$/.test(skill.slug)), "slug 符合技能名规范");
    assert.ok(catalog.skills.some(skill => skill.title === "选题立项"), "中文 frontmatter 名保留");
    assert.ok(catalog.skills.some(skill => skill.slots.includes("boardSplit")), "技能带功能槽标注");
    // 抽查正文版权声明未被改写
    const topicSkill = readFileSync(new URL("../../../../.canvas-runtime/skill-market/catalog/dm-v0.7.2/drama-topic/SKILL.md", import.meta.url), "utf8");
    assert.match(topicSkill, /license: proprietary/);
    assert.match(topicSkill, /redistribution: forbidden/);
    assert.match(topicSkill, /版权声明/);
});

test("后端支持 catalog 源安装、列表合并未安装项、功能槽映射端点", () => {
    const routes = read("../../../../backend/src/server/skill-market-routes.ts");
    assert.match(routes, /source !== "markdown" && source !== "zip" && source !== "catalog"/, "安装来源支持 catalog");
    assert.match(routes, /\/api\/skill-market\/slot-map/, "功能槽映射端点存在");
    assert.match(routes, /installed: false/, "未安装 catalog 项有标记");
    assert.match(routes, /findCatalogEntry/, "未安装技能详情从 catalog 源读取");
    assert.match(routes, /function effectiveBuiltin/, "catalog 安装的技能不被误判为内置（可卸载、显示对话按钮）");
    assert.match(routes, /isUserInstalled\(name, state\)/, "按 state.source 区分用户安装与内置");
});

test("广场可安装技能标功能槽、一键安装与用此技能对话（跨页面总线）", () => {
    const market = read("./market.tsx");
    const api = read("../../services/api/skill-market.ts");
    const bus = read("../../lib/market-skill-bus.ts");
    const panel = read("../../components/agent/local-agent-panel.tsx");
    assert.match(api, /type SkillSource = "builtin" \| "markdown" \| "zip" \| "catalog"/);
    assert.match(api, /installCatalogSkill/);
    assert.match(api, /fetchSkillSlotMap/);
    assert.match(market, /data-testid="market-card-install"/, "未安装 catalog 技能显示安装按钮");
    assert.match(market, /data-testid="market-card-use"/, "已安装技能显示对话按钮");
    assert.match(market, /data-testid="market-slot-map"/, "功能槽映射视图");
    assert.doesNotMatch(market, /data-testid="market-detail-license"/, "详情不再显示版权提示");
    assert.doesNotMatch(market, /\{map\.notice\}/, "功能槽映射视图不再展示 notice");
    assert.match(bus, /USE_MARKET_SKILL_EVENT/, "跨页面用技能总线");
    assert.match(panel, /subscribeUseMarketSkill/, "Agent 面板监听用技能事件");
    assert.match(panel, /selectSkill\(matched/, "选中对应技能而非改生成 prompt");
});
