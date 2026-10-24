import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { findUiWorkflowFile, normalizeWorkflowStem } from "./ui-workflow-file.js";

/** 造一个最小的 UI 格式工作流。 */
function ui(nodes: number) {
    return { last_node_id: nodes, links: [], nodes: Array.from({ length: nodes }, (_, index) => ({ id: index + 1, type: "SaveImage" })) };
}

describe("ui-workflow-file.normalizeWorkflowStem", () => {
    it("去掉副本后缀", () => {
        assert.equal(normalizeWorkflowStem("YZ金鱼-终极篇 (1).json"), normalizeWorkflowStem("YZ金鱼-终极篇.json"));
        assert.equal(normalizeWorkflowStem("扩图（2）.json"), "扩图");
        assert.equal(normalizeWorkflowStem("扩图 - 副本.json"), "扩图");
        assert.equal(normalizeWorkflowStem("扩图_1.json"), "扩图");
    });

    it("不把中间文字相同的不同流认成一个", () => {
        assert.notEqual(normalizeWorkflowStem("2.1 文生图.json"), normalizeWorkflowStem("2.1 文生图-加速开关.json"));
    });
});

describe("ui-workflow-file.findUiWorkflowFile", () => {
    let dir = "";

    before(async () => {
        dir = await mkdtemp(path.join(tmpdir(), "uiwf-"));
        await mkdir(path.join(dir, "custom"), { recursive: true });
        // 库名是 xxx.json，磁盘上是 xxx (1).json —— 这就是「读不出来」的那条流的真实形态
        await writeFile(path.join(dir, "名字带副本 (1).json"), JSON.stringify(ui(3)), "utf8");
        // 两个副本时用最近修改的
        await writeFile(path.join(dir, "多副本 (1).json"), JSON.stringify(ui(2)), "utf8");
        await writeFile(path.join(dir, "多副本 (2).json"), JSON.stringify(ui(5)), "utf8");
        const old = new Date(Date.now() - 60_000);
        await utimes(path.join(dir, "多副本 (1).json"), old, old);
        // 子目录里的精确同名优先
        await writeFile(path.join(dir, "custom", "精确.json"), JSON.stringify(ui(4)), "utf8");
        await writeFile(path.join(dir, "精确 (1).json"), JSON.stringify(ui(9)), "utf8");
        // 坏文件：同名但不是 UI 格式
        await writeFile(path.join(dir, "坏文件.json"), JSON.stringify({ "1": { class_type: "SaveImage" } }), "utf8");
    });

    after(async () => {
        if (dir) await rm(dir, { recursive: true, force: true });
    });

    it("库名与磁盘名差一个 (1) 后缀时仍能找到", async () => {
        const hit = await findUiWorkflowFile(dir, "custom/名字带副本.json") as { nodes: unknown[] } | null;
        assert.ok(hit, "应该按去后缀的名字匹配到");
        assert.equal(hit!.nodes.length, 3);
    });

    it("多个副本取最近修改的那份", async () => {
        const hit = await findUiWorkflowFile(dir, "多副本.json") as { nodes: unknown[] } | null;
        assert.equal(hit!.nodes.length, 5);
    });

    it("精确同名优先于去后缀匹配", async () => {
        const hit = await findUiWorkflowFile(dir, "custom/精确.json") as { nodes: unknown[] } | null;
        assert.equal(hit!.nodes.length, 4);
    });

    it("同名但不是 UI 格式的文件会被跳过并继续找", async () => {
        await writeFile(path.join(dir, "坏文件 (1).json"), JSON.stringify(ui(7)), "utf8");
        const hit = await findUiWorkflowFile(dir, "坏文件.json") as { nodes: unknown[] } | null;
        assert.equal(hit!.nodes.length, 7);
    });

    it("完全找不到时返回 null", async () => {
        assert.equal(await findUiWorkflowFile(dir, "不存在.json"), null);
    });
});
