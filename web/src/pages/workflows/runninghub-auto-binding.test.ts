// 本地 ↔ 云端两个方向的自动配对：
// - 上传到 RunningHub 后，把新建的云端档案绑到本地工作流；
// - 从 RunningHub 下载本地副本后，把副本绑回它来自的云端档案。
// 两边都是「用户不用再手动选一次」，所以用源码契约锁住，避免以后被改回去。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const index = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
const uploadHook = readFileSync(new URL("./runninghub-workflow-upload.tsx", import.meta.url), "utf8");
const importPanel = readFileSync(new URL("./runninghub-workflow-import.tsx", import.meta.url), "utf8");

test("上传完成时把本地工作流名一起交给调用方", () => {
    assert.match(uploadHook, /onUploaded\(result\.profile,\s*result\.cloudRead,\s*name\)/);
    assert.match(uploadHook, /onUploaded:\s*\(profile[^)]*localName:\s*string\)\s*=>\s*void/);
});

test("上传回调把档案 id 写回本地工作流的绑定字段", () => {
    assert.match(index, /const bindLocalWorkflowToCloud = useCallback/);
    assert.match(index, /bindLocalWorkflowToCloud\(localName,\s*profile\.id\)/);
    assert.match(index, /runningHubProfileId:\s*profileId/);
});

test("下载本地副本时按选中档案或 workflowId 找回绑定对象", () => {
    assert.match(importPanel, /const bindingProfile = profile\s*\|\|\s*profiles\.find\(\(item\) => item\.workflowId === id\)/);
});

test("下载生成的本地配置带上 runningHubProfileId", () => {
    assert.match(importPanel, /runningHubProfileId:\s*bindingProfile\.id/);
    // 绑定时要说清楚绑的是哪个云端工作流，不绑时也不能声称绑了。
    assert.match(importPanel, /runningHub\.import\.successBound/);
    assert.match(importPanel, /runningHub\.import\.successCopy/);
});
