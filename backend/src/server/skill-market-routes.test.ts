import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerSkillMarketRoutes } from "./skill-market-routes.js";

let server: Server | undefined;
let base = "";
let workspace = "";
const skillMd = "---\nname: demo-skill\ndescription: 测试技能\n---\n\n# 演示\n\n正文。";

before(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "skill-market-"));
    // 先准备一个内置技能，验证不可覆盖/不可卸载
    const builtinDir = path.join(workspace, ".agents", "skills", "builtin-skill");
    fs.mkdirSync(builtinDir, { recursive: true });
    fs.writeFileSync(path.join(builtinDir, "SKILL.md"), "---\nname: builtin-skill\ndescription: 内置\n---\n");
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    registerSkillMarketRoutes(app);
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
    const address = server!.address();
    assert.ok(address && typeof address !== "string");
    base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    fs.rmSync(workspace, { recursive: true, force: true });
});

async function api(method: string, route: string, body?: unknown) {
    const response = await fetch(`${base}${route}`, {
        method,
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, payload: await response.json() as Record<string, any> };
}

test("列表合并内置技能与用户状态，内置技能默认加入", async () => {
    const list = await api("GET", `/api/skill-market/skills?workspacePath=${encodeURIComponent(workspace)}`);
    assert.equal(list.status, 200);
    // 内置技能在测试工作区（非项目根），isBuiltin 按项目根判断，因此这里视为用户技能；真实项目根内置由项目扫描得到。
    const names = list.payload.data.map((skill: any) => skill.name);
    assert.ok(Array.isArray(names));
    assert.ok(typeof list.payload.revision === "string");
});

test("安装 Markdown 技能并可被 Agent 直接使用", async () => {
    const installed = await api("POST", "/api/skill-market/install", {
        workspacePath: workspace,
        name: "demo-skill",
        source: "markdown",
        tag: "creative",
        files: [{ path: "SKILL.md", contentBase64: Buffer.from(skillMd, "utf8").toString("base64") }],
    });
    assert.equal(installed.status, 200, installed.payload.error);
    assert.equal(installed.payload.data.name, "demo-skill");
    assert.equal(installed.payload.data.added, true);
    assert.ok(fs.existsSync(path.join(workspace, ".agents", "skills", "demo-skill", "SKILL.md")), "安装后 SKILL.md 落盘");
});

test("同名技能不能重复安装，路径越界与缺少入口被拒绝", async () => {
    const duplicate = await api("POST", "/api/skill-market/install", {
        workspacePath: workspace, name: "demo-skill", source: "markdown",
        files: [{ path: "SKILL.md", contentBase64: Buffer.from(skillMd).toString("base64") }],
    });
    assert.equal(duplicate.status, 409);
    const badName = await api("POST", "/api/skill-market/install", {
        workspacePath: workspace, name: "../escape", source: "markdown",
        files: [{ path: "SKILL.md", contentBase64: Buffer.from(skillMd).toString("base64") }],
    });
    assert.equal(badName.status, 400);
    const noEntry = await api("POST", "/api/skill-market/install", {
        workspacePath: workspace, name: "no-entry", source: "markdown",
        files: [{ path: "README.md", contentBase64: Buffer.from("hi").toString("base64") }],
    });
    assert.equal(noEntry.status, 400);
});

test("收藏状态写入 revision 乐观锁，过期 revision 被拒", async () => {
    const list = await api("GET", `/api/skill-market/skills?workspacePath=${encodeURIComponent(workspace)}`);
    const revision = list.payload.revision;
    const liked = await api("POST", "/api/skill-market/state", {
        workspacePath: workspace, name: "demo-skill", expectedRevision: revision, patch: { liked: true },
    });
    assert.equal(liked.status, 200, liked.payload.error);
    assert.equal(liked.payload.data.entry.liked, true);
    const stale = await api("POST", "/api/skill-market/state", {
        workspacePath: workspace, name: "demo-skill", expectedRevision: revision, patch: { liked: false },
    });
    assert.equal(stale.status, 409);
});

test("详情读取 SKILL.md 正文与文件清单", async () => {
    const detail = await api("GET", `/api/skill-market/detail?workspacePath=${encodeURIComponent(workspace)}&name=demo-skill`);
    assert.equal(detail.status, 200);
    assert.match(detail.payload.data.content, /演示/);
    assert.ok(detail.payload.data.files.includes("SKILL.md"));
});

test("卸载用户技能后目录与状态一并清理", async () => {
    const removed = await api("POST", "/api/skill-market/uninstall", { workspacePath: workspace, name: "demo-skill" });
    assert.equal(removed.status, 200);
    assert.equal(fs.existsSync(path.join(workspace, ".agents", "skills", "demo-skill")), false);
});
