import { H3_STYLE_TEMPLATES, applyH3StyleTemplate, composeStoryboardOpening, matchStyleTemplatePrefix, styleTemplateFromPrompt, styleTemplateText } from "./style-templates";

let failed = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (!ok) { failed += 1; console.error(`FAIL ${label}${detail ? ` -> ${detail}` : ""}`); }
  else console.log(`ok   ${label}`);
};

// 参考里给的现代韩系英文，必须逐字出现在模板里。
const REFERENCE = "Visual style: smooth dewy luminous skin with an idol-like beauty; long-lens candid dynamic framing with shallow depth of field; high-key bright exposure; pale, fresh, delicate color palette. Modern Korean webtoon / Korean-manhwa aesthetic, low-contrast soft-focus matte filter with diffusion glow, low-saturation color grading mixing cool and warm tones. The background is bright overexposed cool white window light; the character carries a faint warm daylight and natural skin tone, producing a soft, delicate film texture. For atmosphere, use a wide-aperture shallow depth of field with dreamy blurred falloff, shaping a sun-drenched, gently tipsy mood that is tensioned yet gentle, feminine and restrained.";

check("六个模板", H3_STYLE_TEMPLATES.length === 6, String(H3_STYLE_TEMPLATES.length));
check("现代韩系 = 参考原文", styleTemplateText("modern-korean") === REFERENCE);
check("六个 id 唯一", new Set(H3_STYLE_TEMPLATES.map((t) => t.id)).size === 6);
check("六个 label 齐全", ["日式CCD", "清冷仙侠风", "港风", "法式奶油", "现代韩系", "柔光"].every((label) => H3_STYLE_TEMPLATES.some((t) => t.label === label)));

// 模板词加在开头总体描述最前面。
check("注入在最前", composeStoryboardOpening("modern-korean", "统一环境说明。").startsWith(REFERENCE));
check("注入后接用户正文", composeStoryboardOpening("modern-korean", "统一环境说明。") === `${REFERENCE}\n\n统一环境说明。`);
check("null = 不注入", composeStoryboardOpening(null, "统一环境说明。") === "统一环境说明。");
check("null + 空正文", composeStoryboardOpening(null, "  ") === "");
check("模板 + 空正文", composeStoryboardOpening("hong-kong-retro", "") === styleTemplateText("hong-kong-retro"));

// 载入时按前缀反推并剥掉，用户不看到重复前缀。
const withUserText = composeStoryboardOpening("modern-korean", "统一环境说明。");
check("反推模板 id", matchStyleTemplatePrefix(withUserText)?.id === "modern-korean");
check("反推后正文干净", matchStyleTemplatePrefix(withUserText)?.rest === "统一环境说明。");
check("只有模板无正文", matchStyleTemplatePrefix(REFERENCE)?.id === "modern-korean" && matchStyleTemplatePrefix(REFERENCE)?.rest === "");
check("无模板时返回 null", matchStyleTemplatePrefix("用户自己写的风格说明") === null);
check("未知前缀不识别为模板", matchStyleTemplatePrefix("未知风格\n\n正文") === null);
// 调用方按 `matchStyleTemplatePrefix(x)?.rest ?? x` 回退，未知前缀原样进入可编辑正文。
const unknown = "未知风格\n\n正文";
check("未知前缀原样保留", (matchStyleTemplatePrefix(unknown)?.rest ?? unknown) === unknown);

// 现代韩系 / 柔光 前两段几乎相同：必须按最长前缀命中正确模板。
check("柔光不误判为现代韩系", matchStyleTemplatePrefix(styleTemplateText("soft-light"))?.id === "soft-light",
  matchStyleTemplatePrefix(styleTemplateText("soft-light"))?.id);
check("现代韩系不误判为柔光", matchStyleTemplatePrefix(styleTemplateText("modern-korean"))?.id === "modern-korean",
  matchStyleTemplatePrefix(styleTemplateText("modern-korean"))?.id);

// 往返：编译 → 载入 → 再编译，结果稳定，不叠加。
const roundTrip = matchStyleTemplatePrefix(withUserText);
check("往返稳定", composeStoryboardOpening(roundTrip?.id ?? null, roundTrip?.rest ?? "") === withUserText);

const savedRef2va = `summary:\n雪中相遇。\n\ndetailed_description:\n开头总体描述。\n\n[Shot 1] 人物走入画面。\n\noverall_soundscape:\n风声。`;
const submittedRef2va = applyH3StyleTemplate(savedRef2va, "ref2va", "modern-korean");
check("运行时插入 Ref2VA 描述段首", submittedRef2va.includes(`detailed_description:\n${REFERENCE}\n\n开头总体描述。`));
check("不修改已保存提示词", !savedRef2va.includes(REFERENCE));
check("关闭模板时原文不变", applyH3StyleTemplate(savedRef2va, "ref2va", null) === savedRef2va);
const oldSaved = savedRef2va.replace("开头总体描述。", `${REFERENCE}\n\n开头总体描述。`);
check("旧提示词能反推模板", styleTemplateFromPrompt(oldSaved, "ref2va") === "modern-korean");
check("旧提示词运行时不重复模板", applyH3StyleTemplate(oldSaved, "ref2va", undefined).split(REFERENCE).length === 2);
check("改选模板会替换旧前缀", !applyH3StyleTemplate(oldSaved, "ref2va", "soft-light").includes(REFERENCE));
check("清空模板会移除旧前缀", !applyH3StyleTemplate(oldSaved, "ref2va", null).includes(REFERENCE));
const guided = `detailed_description:\nKeyframe guidance.\n\n${REFERENCE}\n\n[Shot 1] 保持人物。`;
check("旧 MCP 指导语后的模板可识别", styleTemplateFromPrompt(guided, "ref2va") === "modern-korean");
check("旧 MCP 指导语在运行时保留", applyH3StyleTemplate(guided, "ref2va", null).includes("Keyframe guidance."));
const otherMode = applyH3StyleTemplate("integrated_multimodal_description:\n镜头缓慢推进。\n\noverall_soundscape:\n风声。", "i2v", "soft-light");
check("固定首帧模式也注入到描述段首", otherMode.includes(`integrated_multimodal_description:\n${styleTemplateText("soft-light")}\n\n镜头缓慢推进。`));

if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
console.log("\n全部通过");
