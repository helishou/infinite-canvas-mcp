import { H3_STYLE_TEMPLATES, applyH3StyleTemplate, composeStoryboardOpening, matchStyleTemplatePrefix, styleTemplateFromPrompt, styleTemplateText } from "./style-templates";

let failed = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (!ok) { failed += 1; console.error(`FAIL ${label}${detail ? ` -> ${detail}` : ""}`); }
  else console.log(`ok   ${label}`);
};

// 历史保存的旧模板正文仅用于迁移识别，不能继续进入运行输入。
const REFERENCE = "Visual style: smooth dewy luminous skin with an idol-like beauty; long-lens candid dynamic framing with shallow depth of field; high-key bright exposure; pale, fresh, delicate color palette. Modern Korean webtoon / Korean-manhwa aesthetic, low-contrast soft-focus matte filter with diffusion glow, low-saturation color grading mixing cool and warm tones. The background is bright overexposed cool white window light; the character carries a faint warm daylight and natural skin tone, producing a soft, delicate film texture. For atmosphere, use a wide-aperture shallow depth of field with dreamy blurred falloff, shaping a sun-drenched, gently tipsy mood that is tensioned yet gentle, feminine and restrained.";
const currentKorean = styleTemplateText("modern-korean");
const legacySoftLight = REFERENCE.replace("pale, fresh, delicate color palette.", "pale, fresh, delicate color palette with strong airy presence.");

check("六个模板", H3_STYLE_TEMPLATES.length === 6, String(H3_STYLE_TEMPLATES.length));
check("现代韩系已修订", currentKorean !== REFERENCE);
check("六个 id 唯一", new Set(H3_STYLE_TEMPLATES.map((t) => t.id)).size === 6);
check("六个 label 齐全", ["日式CCD", "清冷仙侠风", "港风", "法式奶油", "现代韩系", "柔光"].every((label) => H3_STYLE_TEMPLATES.some((t) => t.label === label)));

// 模板词加在开头总体描述最前面。
check("注入在最前", composeStoryboardOpening("modern-korean", "统一环境说明。").startsWith(currentKorean));
check("注入后接用户正文", composeStoryboardOpening("modern-korean", "统一环境说明。") === `${currentKorean}\n\n统一环境说明。`);
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

// 新旧现代韩系 / 柔光都必须能识别为各自的模板。
check("柔光不误判为现代韩系", matchStyleTemplatePrefix(styleTemplateText("soft-light"))?.id === "soft-light",
  matchStyleTemplatePrefix(styleTemplateText("soft-light"))?.id);
check("现代韩系不误判为柔光", matchStyleTemplatePrefix(styleTemplateText("modern-korean"))?.id === "modern-korean",
  matchStyleTemplatePrefix(styleTemplateText("modern-korean"))?.id);
check("历史柔光不误判为现代韩系", matchStyleTemplatePrefix(legacySoftLight)?.id === "soft-light");

// 往返：编译 → 载入 → 再编译，结果稳定，不叠加。
const roundTrip = matchStyleTemplatePrefix(withUserText);
check("往返稳定", composeStoryboardOpening(roundTrip?.id ?? null, roundTrip?.rest ?? "") === withUserText);

const savedRef2va = `summary:\n雪中相遇。\n\ndetailed_description:\n开头总体描述。\n\n[Shot 1] 人物走入画面。\n\noverall_soundscape:\n风声。`;
const submittedRef2va = applyH3StyleTemplate(savedRef2va, "ref2va", "modern-korean");
check("运行时插入 Ref2VA 描述段首", submittedRef2va.includes(`detailed_description:\n${currentKorean}\n\n开头总体描述。`));
check("不修改已保存提示词", !savedRef2va.includes(REFERENCE));
check("关闭模板时原文不变", applyH3StyleTemplate(savedRef2va, "ref2va", null) === savedRef2va);
const oldSaved = savedRef2va.replace("开头总体描述。", `${REFERENCE}\n\n开头总体描述。`);
check("旧提示词能反推模板", styleTemplateFromPrompt(oldSaved, "ref2va") === "modern-korean");
check("旧提示词运行时升级模板且不重复", !applyH3StyleTemplate(oldSaved, "ref2va", undefined).includes(REFERENCE)
  && applyH3StyleTemplate(oldSaved, "ref2va", undefined).split(currentKorean).length === 2);
check("改选模板会替换旧前缀", !applyH3StyleTemplate(oldSaved, "ref2va", "soft-light").includes(REFERENCE));
check("清空模板会移除旧前缀", !applyH3StyleTemplate(oldSaved, "ref2va", null).includes(REFERENCE));
const guided = `detailed_description:\nKeyframe guidance.\n\n${REFERENCE}\n\n[Shot 1] 保持人物。`;
check("旧 MCP 指导语后的模板可识别", styleTemplateFromPrompt(guided, "ref2va") === "modern-korean");
check("旧 MCP 指导语在运行时保留", applyH3StyleTemplate(guided, "ref2va", null).includes("Keyframe guidance."));
const otherMode = applyH3StyleTemplate("integrated_multimodal_description:\n镜头缓慢推进。\n\noverall_soundscape:\n风声。", "i2v", "soft-light");
check("固定首帧模式也注入到描述段首", otherMode.includes(`integrated_multimodal_description:\n${styleTemplateText("soft-light")}\n\n镜头缓慢推进。`));

// 复现夜晚池塘场景搭配旧柔光/韩系模板的冲突，验证最终提交与原文隔离。
const scene = "A moonlit bridge over a dark pond, illuminated by lanterns. Preserve the trees and water behind the characters.";
const shots = '[Shot 1] Wide shot of the bridge. The character says "等我。"\n\n[Shot 2] Close-up, the same pond behind her.';
const sound = "overall_soundscape:\nWater and distant crickets.\n\nnon_diegetic_music:\nNone.";
for (const [id, legacy] of [["modern-korean", REFERENCE], ["soft-light", legacySoftLight]]) {
  for (const mode of ["ref2va", "i2v", "fl2v", "t2v"]) {
    const header = mode === "ref2va" ? "detailed_description" : "integrated_multimodal_description";
    const original = `summary:\nNight by the pond.\n\n${header}:\n${scene}\n\n${shots}\n\n${sound}`;
    const historical = original.replace(scene, `Keyframe guidance.\n\n${legacy}\n\n${scene}`);
    const updated = applyH3StyleTemplate(historical, mode, undefined);
    const style = styleTemplateText(id);
    const label = `${id}/${mode}`;
    check(`${label} 历史模板保留选择并替换`, styleTemplateFromPrompt(historical, mode) === id
      && updated.includes(style) && !updated.includes(legacy));
    check(`${label} 不再强制白窗背景、白天或长焦`, !updated.includes("white window light")
      && !updated.includes("sun-drenched") && !updated.includes("high-key bright exposure") && !updated.includes("long-lens"));
    check(`${label} 风格服从场景与镜头`, updated.includes("scene and shot instructions take priority")
      && updated.includes("Preserve the described location, background, time of day"));
    check(`${label} 场景镜头对白与声音保持原文`, updated.includes(scene) && updated.includes(shots)
      && updated.endsWith(sound) && updated.includes("Keyframe guidance."));
    check(`${label} 重复应用不叠加`, applyH3StyleTemplate(updated, mode, undefined) === updated);
    check(`${label} 关闭模板仅移除风格`, applyH3StyleTemplate(historical, mode, null) === original.replace(scene, `Keyframe guidance.\n\n${scene}`));
  }
}
check("柔光不再隐含漫画画风", !styleTemplateText("soft-light").includes("manhwa"));

if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
console.log("\n全部通过");
