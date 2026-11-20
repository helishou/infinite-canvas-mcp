import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PROMPT_TOO_LONG,
  assertVideoPromptWithinLimit,
  checkPromptLength,
  checkVideoPromptLength,
  normalizeVideoCapabilities,
  promptCodePoints,
  videoCapabilitiesFromWorkflowPackage,
  videoCapabilitiesOf,
} from "./model-video-capability.js";

const aiConfig = (models: Array<Record<string, unknown>>) => ({
  channels: [{ id: "engine-local", name: "本地引擎", kind: "local", apiFormat: "openai", baseUrl: "http://127.0.0.1:8300", apiKey: "", models }],
});

test("显式登记值按真值读取；缺字段不补默认（缺省 = 未知/不限制）", () => {
  const config = aiConfig([
    {
      name: "H3 首尾帧",
      capability: "video",
      videoRatios: ["16:9 (Widescreen)", "9:16 (Portrait Widescreen)"],
      generateAudio: true,
      tailFrameChain: true,
      maxAudios: 3,
    },
    { name: "别的视频模型", capability: "video", generateAudio: false, tailFrameChain: false, videoResolutions: [] },
    { name: "什么都没登记", capability: "video" },
  ]);
  assert.deepEqual(videoCapabilitiesOf(config, "engine-local::H3 首尾帧"), {
    videoRatios: ["16:9", "9:16"],
    generateAudio: true,
    tailFrameChain: true,
  });
  assert.deepEqual(videoCapabilitiesOf(config, "H3 首尾帧"), videoCapabilitiesOf(config, "engine-local::H3 首尾帧"));
  assert.deepEqual(videoCapabilitiesOf(config, "engine-local::别的视频模型"), {
    generateAudio: false,
    tailFrameChain: false,
    videoResolutions: [],
  });
  assert.deepEqual(videoCapabilitiesOf(config, "engine-local::什么都没登记"), {});
  assert.deepEqual(videoCapabilitiesOf(config, "engine-local::已删除模型"), {});
});

test("引擎上报字段原样透传（camelCase / snake_case），非法值一律丢弃", () => {
  assert.deepEqual(
    normalizeVideoCapabilities({
      video_ratios: ["16:9", "9:16"],
      video_resolutions: ["720p", "1080p"],
      generate_audio: false,
      tail_frame_chain: true,
      max_video_seconds: 15,
    }),
    { videoRatios: ["16:9", "9:16"], videoResolutions: ["720p", "1080p"], generateAudio: false, tailFrameChain: true, maxVideoSeconds: 15 },
  );
  assert.deepEqual(
    normalizeVideoCapabilities({
      videoRatios: ["16:9", ""], // 含空串的脏数组整体不采信
      generateAudio: "false",
      tailFrameChain: null,
      maxVideoSeconds: 0,
    }),
    {},
  );
  assert.deepEqual(normalizeVideoCapabilities(null), {});
  assert.deepEqual(normalizeVideoCapabilities("video"), {});
  assert.deepEqual(normalizeVideoCapabilities({ videoRatios: ["16:9 (Widescreen)", "9 : 16", "原图比例"] }), {
    videoRatios: ["16:9", "9:16"],
  });
});

test("登记脚本从真实工作流派生：比例选项 / 图片字段 / 出片节点音频绑定", () => {
  const packageFor = (imageFields: string[], audioBinding: unknown) => ({
    format: "infinite-canvas-workflow",
    version: 1,
    name: "custom/h3-local-fl2va.json",
    config: {
      fields: [
        ...imageFields.map((name, index) => ({ id: `reference_image_${index + 1}`, name, type: "image" })),
        { id: "prompt", name: "视频提示词", type: "text", isPrompt: true },
        { id: "aspect_ratio", name: "画面比例", type: "dropdown", options: ["16:9 (Widescreen)", "9:16 (Portrait Widescreen)", "原图比例"] },
        { id: "duration", name: "时长秒", type: "number" },
      ],
      mediaInputs: {},
    },
    workflow: {
      nf_v15: { class_type: "NanFengH3MultiReferenceGeneratorV15", inputs: { "画面比例": "16:9 (Widescreen)" } },
      nf_output: { class_type: "VHS_VideoCombine", inputs: { images: ["nf_v15", 0], ...(audioBinding === undefined ? {} : { audio: audioBinding }) } },
    },
  });

  assert.deepEqual(videoCapabilitiesFromWorkflowPackage(packageFor(["首帧", "尾帧"], ["nf_v15", 1])), {
    videoRatios: ["16:9", "9:16"],
    generateAudio: true,
    tailFrameChain: true,
  });
  // 文生视频没有图片字段 → 不能尾帧续接（真实 false，不是缺省）
  assert.deepEqual(videoCapabilitiesFromWorkflowPackage(packageFor([], ["nf_v15", 1])), {
    videoRatios: ["16:9", "9:16"],
    generateAudio: true,
    tailFrameChain: false,
  });
  // 出片节点没接音频 → 确实无声
  assert.deepEqual(videoCapabilitiesFromWorkflowPackage(packageFor(["首帧"], undefined)), {
    videoRatios: ["16:9", "9:16"],
    generateAudio: false,
    tailFrameChain: true,
  });
});

test("分辨率/时长只在字段真的声明时才登记；H3 连续百万像素不伪造分辨率档位", () => {
  assert.deepEqual(
    videoCapabilitiesFromWorkflowPackage({
      config: {
        fields: [
          { id: "size_option", name: "分辨率", type: "dropdown", options: ["720p", "1080p"] },
          { id: "duration", name: "时长秒", type: "number", max: 15 },
          { id: "aspect_ratio", name: "画面比例", type: "dropdown", options: ["16:9"] },
        ],
      },
      workflow: {},
    }),
    { videoRatios: ["16:9"], videoResolutions: ["720p", "1080p"], tailFrameChain: false, maxVideoSeconds: 15 },
  );
  assert.deepEqual(videoCapabilitiesFromWorkflowPackage({ config: { fields: [{ id: "megapixels", name: "百万像素", type: "number" }] }, workflow: {} }), {
    tailFrameChain: false,
  });
  assert.deepEqual(videoCapabilitiesFromWorkflowPackage({}), {});
  assert.deepEqual(videoCapabilitiesFromWorkflowPackage(null), {});
});

test("分辨率真值派生只认显式档位下拉，连续百万像素工作流不伪造档位", () => {
  // 本地 H3 工作流的真实现状：画面比例是下拉，尺寸是连续 megapixels number 字段（min/max/step），
  // 没有离散分辨率档位。此时 videoResolutions 必须缺省 → 设置页不告警、所有档位可选。
  const realH3LikePackage = {
    config: {
      fields: [
        { id: "prompt", name: "提示词", type: "text", isPrompt: true },
        { id: "std_size_option", name: "画面比例", type: "dropdown", role: "size_option", default: "16:9 (Widescreen)" },
        { id: "megapixels", name: "Megapixels", type: "number", min: 0, max: 10, step: 0.1 },
      ],
    },
    workflow: {},
  };
  assert.deepEqual(videoCapabilitiesFromWorkflowPackage(realH3LikePackage), { tailFrameChain: false });
  // 只有工作流真写了分辨率档位下拉才登记真值，设置页据此告警。
  assert.deepEqual(
    videoCapabilitiesFromWorkflowPackage({
      config: { fields: [{ id: "resolution", name: "分辨率档位", type: "dropdown", options: ["720p", "1080p"] }] },
      workflow: {},
    }),
    { videoResolutions: ["720p", "1080p"], tailFrameChain: false },
  );
});

test("promptMaxChars 真值读取：只收正整数显式登记/上报，非法值与缺省都不臆造", () => {
  assert.deepEqual(normalizeVideoCapabilities({ promptMaxChars: 8000 }), { promptMaxChars: 8000 });
  assert.deepEqual(normalizeVideoCapabilities({ prompt_max_chars: 32000 }), { promptMaxChars: 32000 });
  // camelCase 优先；0 / 负数 / 小数 / 字符串一律不是真值。
  assert.deepEqual(normalizeVideoCapabilities({ promptMaxChars: 8000, prompt_max_chars: 32000 }), { promptMaxChars: 8000 });
  for (const bad of [0, -1, 8000.5, "8000", null, true, Number.NaN]) {
    assert.deepEqual(normalizeVideoCapabilities({ promptMaxChars: bad }), {}, `非法值不得登记: ${String(bad)}`);
  }
  const config = aiConfig([
    { name: "已登记", capability: "video", promptMaxChars: 8000, videoResolutions: [] },
    { name: "未登记", capability: "video" },
  ]);
  assert.equal(videoCapabilitiesOf(config, "engine-local::已登记").promptMaxChars, 8000);
  assert.equal(videoCapabilitiesOf(config, "已登记").promptMaxChars, 8000);
  assert.equal(videoCapabilitiesOf(config, "engine-local::未登记").promptMaxChars, undefined);
  assert.equal(videoCapabilitiesOf(config, "engine-local::无此模型").promptMaxChars, undefined);
});

test("工作流只在显式声明 promptMaxChars 时派生；普通 prompt 字段的 max 不是字数上限", () => {
  assert.deepEqual(
    videoCapabilitiesFromWorkflowPackage({
      config: { fields: [{ id: "prompt", name: "提示词", type: "text", isPrompt: true, max: 5000 }] },
      workflow: {},
    }),
    { tailFrameChain: false },
  );
  assert.deepEqual(
    videoCapabilitiesFromWorkflowPackage({
      config: { fields: [{ id: "prompt", name: "提示词", type: "text", isPrompt: true }], promptMaxChars: 8000 },
      workflow: {},
    }),
    { promptMaxChars: 8000, tailFrameChain: false },
  );
});

test("生成链字符数校验：按码点计数，超限拒绝且返回明确错误码；缺省不限制", () => {
  assert.equal(promptCodePoints(""), 0);
  assert.equal(promptCodePoints("你好，世界"), 5);
  assert.equal(promptCodePoints("🎬"), 1, "emoji 按 1 个码点，对齐影策 RuneCount");
  assert.equal(promptCodePoints("a🎬b"), 3);

  assert.deepEqual(checkPromptLength("甲".repeat(8000), 8000), { ok: true, chars: 8000, maxChars: 8000 });
  assert.deepEqual(checkPromptLength("甲".repeat(8001), undefined), { ok: true, chars: 8001, maxChars: undefined });
  assert.deepEqual(checkPromptLength("甲".repeat(8001), 0), { ok: true, chars: 8001, maxChars: undefined });

  const over = checkPromptLength("甲".repeat(8001), 8000);
  assert.equal(over.ok, false);
  if (!over.ok) {
    assert.equal(over.code, PROMPT_TOO_LONG);
    assert.equal(over.chars, 8001);
    assert.equal(over.maxChars, 8000);
    assert.match(over.message, /8001/);
    assert.match(over.message, /8000/);
  }
  assert.doesNotThrow(() => assertVideoPromptWithinLimit(aiConfig([{ name: "模型", capability: "video", promptMaxChars: 8000 }]), "engine-local::模型", "🎬".repeat(8000)));
  assert.throws(
    () => assertVideoPromptWithinLimit(aiConfig([{ name: "模型", capability: "video", promptMaxChars: 8000 }]), "engine-local::模型", "🎬".repeat(8001)),
    (error: unknown) => (error as { code?: string }).code === PROMPT_TOO_LONG,
  );
  assert.doesNotThrow(() => assertVideoPromptWithinLimit(aiConfig([{ name: "模型", capability: "video" }]), "engine-local::模型", "甲".repeat(100_000)));
  assert.deepEqual(checkVideoPromptLength(aiConfig([{ name: "模型", capability: "video" }]), "engine-local::模型", "甲"), {
    ok: true, chars: 1, maxChars: undefined,
  });
});
