# 官方知识库索引（Hailuo AI Knowledge Base）

用途：写 H3 Clip 提示词或排查生成问题时，按现象在本索引里定位官方文章，只读命中的那几篇，不通读全库。

范围与可信度：站点 `hailuoai.video/pages/knowledge` 共 559 篇（2026-09-29 从官方 sitemap 抓取）。这些是 Hailuo/MiniMax 自家创作团队的 workflow 经验文章，**不是 H3 的官方提示词规范**（格式规范唯一权威是 `h3-prompt-writing`），也没有第三方对照实验。文章里的量化结论（4-6 秒稳定性、摇 3 次、形容词降低 30-40% reset 等）均来自官方自述的内部测试，跨模型迁移时只作方向参考，不要当验收阈值。少数文章标明引用第三方框架（Ekman FACS、NIST AI RMF、EU AI Act 等），引用关系可查，结论仍属经验总结。

用法：
1. 先在本索引按现象找主题。
2. 打开命中文章，用 `curl` 或浏览器读取正文；不要整库批量抓取。
3. 只把**会改变生产决策**的技术规则迁进对应子 Skill，不迁作者声明、推广文案、合规免责段和站内 CTA。
4. 文章结论与实测冲突时以实测为准，并把结论差异记下来。

其他入口：
- H3 官方提示词规范：仓库 `MiniMax-AI/MiniMax-H3` 的 `skills/h3-prompt-writing/references/{base-en,ref-en}.txt`（本地副本见 `h3-prompt-enhancer/references/`）
- H3 README 示例（`README.zh-CN.md`）：官方真实提示词样例，判断"官方写法长什么样"时优先看它
- 站内总览：<https://hailuoai.video/pages/knowledge>

## 核心必读（每个主题先读这几篇）

| 现象 | 先读 |
|---|---|
| 笑容假、露齿、表情僵硬、眼神死 | `fix-stiff-ai-faces` · `micro-expressions-realistic-human-ai-video` · `directing-micro-expressions-cinematic-ai-close-ups` · `facial-micro-expressions-asmr-roleplays-guide` |
| 情绪转折突兀、五官融化 morphing | `prompting-emotional-transitions-ai-video` · `director-mode-ai-character-emotions` · `prompting-ai-actors-conflict-subtext` |
| 眼神锁死镜头、Eye-Dart、瞳孔抖动 | `control-eye-contact-ai-video-brand-hooks` · `predictable-eye-line-framing-multi-angle-character-scenes` · `biological-eye-realism-ai-video-guide` |
| 说话口型/唇齿动作不理想 | `high-fidelity-lip-sync-asmr-whispers-guide` · `ai-video-ots-shots-dialogue-workflow` · `mastering-ai-reaction-shots` |
| 多人对话、说话人归属错乱 | `ai-video-group-dynamics-consistency` · `sync-multiple-characters-s2v-scenes` · `ai-video-ots-shots-dialogue-workflow` |
| 脸在不同片段不一致、身份漂移 | `consistent-ai-characters-s2v-guide` · `model-consistency-ai-video-s2v-workflow` · `troubleshooting-character-drift-ai-video` · `face-persistence-ai-video-influencer-identity` |
| 角色突然变样/换风格 | `s2v-consistent-style-reels-guide` · `maintain-style-consistency-modular-video-posts` · `directing-consistent-ai-subjects-social-video` |
| 画面发糊、过曝、蒙雾、bloom 溢出 | `mastering-depth-of-field-cinematic-bokeh-prompting` · `soft-focus-bokeh-ai-product-video-guide` · `fix-neon-glow-bleed-ai-night-city-scenes` · `prompting-film-halation-retro-glow-guide` |
| 画面像镜头没擦干净、灰蒙、噪点 | `fix-window-reflection-artifacts-ai-urban-renders` · `narrative-light-leaks-ai-prompting-cinematic-flaws` · `ai-video-color-grading-teal-orange` · `low-light-saturation-ai-video-control` |
| 闪烁、抖动、重影、拖影 | `fix-ai-video-flicker-stable-lighting` · `fix-ai-video-jitter-cinematic-stability` · `fix-motion-ghosting-ai-video` · `gate-weave-organic-jitter-ai-video` |
| 画面结构变形、下颌/五官扭曲 | `fixing-uncanny-valley-ai-product-renders-guide` · `predictable-subject-size-scale-drift-ai-video` · `perspective-warping-multi-angle-framing-guide` |
| 提示词越改越糟、约束冲突 | `prompting-subtle-motion-ai-video` · `ai-video-motion-intensity-control` · `anti-prompt-cinematic-ai-video-guide` · `negative-prompts-cinematic-ai-video` |
| 负向提示该写什么、怎么写排除 | `negative-prompts-cinematic-ai-video` · `negative-prompts-brand-safety-ai-video` · `anti-prompt-cinematic-ai-video-guide` |
| 提示词该写多细、模块怎么拆 | `modular-prompt-library-cinematic-broll` · `prompt-engineering-cinematic-ai-video-workflow` · `minimalist-prompt-modules-clean-social-ads` · `prompt-weight-impact-character-environment-interaction` |
| 10 秒以上面部崩、节奏拖 | `ai-video-motion-intensity-control` · `motion-control-speed-ramping-dynamic-ai-clips` · `framing-transitions-wide-closeup-predictability` |
| 第一人称 POV 不对劲 | `director-mode-first-person-product-pov` · `immersive-fitness-pov-ai-cinematography-guide` · `main-character-energy-pov-clips-guide` |
| 机位/景别/轴线/切镜不听话 | `director-guide-shot-reverse-shot-spatial-logic` · `wide-vs-tight-shots-ai-video-guide` · `ai-video-camera-motion-control` · `ai-video-multi-axis-camera-control` · `trajectory-matching-seamless-ai-video-cuts` |
| 动作僵硬不自然、走路像飘 | `physics-gait-prompting-natural-character-movement` · `realistic-limbs-posture-ai-video-guide` · `prompting-subtle-motion-ai-video` |
| 布料/头发/服装不自然 | `ai-fabric-physics-realistic-clothes-movement` · `ai-video-textures-leather-silk-prompting-guide` · `ai-fashion-b-roll-wind-hair-flare-guide` · `mastering-fabric-drape-ai-video` |
| 光线不连续/每段阴影不一致 | `consistent-ai-lighting-standards` · `ai-video-lighting-consistency` · `lighting-consistency-ai-video-campaigns` · `ai-video-shadow-drift-physics-solutions` |
| 皮肤假、磨皮、塑料感 | `ai-video-skin-realism-pores-blemishes-guide` · `subsurface-scattering-ai-skin-realism-master-guide` · `mastering-skin-tones-cinematic-ai-video` |
| 色彩跟参考图对不上 | `ai-produce-video-color-accuracy-guide` · `brand-color-ai-video-hex-accuracy` · `s2v-color-continuity-palette-consistency` |
| 氛围/情绪能量不足、没张力 | `ai-video-emotional-body-language` · `motion-pacing-ai-video-emotional-energy` · `prompting-pacing-brand-story-rhythm-ai` · `directing-ai-emotion-color-lighting` |
| 字幕/水印/多余文字 | `ai-video-safe-zone-social-ui` · `ai-artifacts-genz-aesthetics-guide`（文字噪点） |
| 道具/物件交互失败 | `simulating-impact-prompting-debris-gravity` · `soft-body-deformations-ai-video-guide` · `consistent-material-impact-ai-video-guide` |
| 手部特写崩 | `asmr-persona-feature-stability-micro-motions` · `fix-mascot-limb-artifacts-ai-360-pans` |

## 全部文章（按主题，slug → URL 末尾，拼到上面的 BASE 后即为完整地址）


### 面部·表演·情绪（39 篇）

- `ai-face-consistency-virtual-cosplay`
- `ai-ip-us-eu-copyright-digital-actors`
- `ai-video-consistency-vloggers-personal-brand`
- `ai-video-emotional-body-language`
- `asmr-persona-continuity-multi-platform-feeds`
- `asmr-persona-feature-stability-micro-motions`
- `biological-eye-realism-ai-video-guide`
- `control-eye-contact-ai-video-brand-hooks`
- `cyberpunk-glow-subsurface-scattering-prompting-guide`
- `directing-ai-actors-b2b-commercials`
- `directing-ai-emotion-color-lighting`
- `directing-micro-expressions-cinematic-ai-close-ups`
- `director-mode-ai-character-emotions`
- `face-persistence-ai-video-influencer-identity`
- `faceless-social-channel-prompt-templates`
- `facial-micro-expressions-asmr-roleplays-guide`
- `fix-stiff-ai-faces`
- `fixing-uncanny-valley-ai-product-renders-guide`
- `hard-surface-asmr-wood-stone-textures-ai-guide`
- `high-fidelity-lip-sync-asmr-whispers-guide`
- `intimate-portraits-director-mode-guide`
- `mascot-facial-consistency-multi-angle-video`
- `mastering-ai-reaction-shots`
- `micro-atmospheres-floating-dust-light-particles-ai-video`
- `micro-expressions-realistic-human-ai-video`
- `micro-realism-prompting-water-surface-tension-droplets`
- `motion-pacing-ai-video-emotional-energy`
- `predictable-eye-line-framing-multi-angle-character-scenes`
- `prompting-ai-actors-conflict-subtext`
- `prompting-emotional-transitions-ai-video`
- `s2v-workflows-consistent-asmr-hand-model-personas`
- `simulating-heavy-rainfall-surface-runoff-ai-video`
- `smooth-asmr-persona-transitions-guide`
- `subsurface-scattering-ai-skin-realism-master-guide`
- `subsurface-scattering-realistic-skin-tones-guide`
- `three-point-lighting-studio-portraiture-hailuo-ai`
- `uncanny-valley-weirdcore-ai-visuals-guide`
- `unique-visual-signature-personal-vlogs-ai-guide`
- `virtual-personal-trainers-coach-consistency-s2v`

### 角色一致性·身份·服装（92 篇）

- `180-degree-reveal-mascot-continuity-ai-video`
- `aesthetic-longevity-future-proof-ai-brand-asset-library`
- `ai-ads-consistent-exposure-brands`
- `ai-b-roll-subject-consistency-workflow`
- `ai-character-asset-library-workflow`
- `ai-cosplay-fabric-physics-guide`
- `ai-mascot-digital-style-guide-brand-consistency`
- `ai-mascot-visual-consistency`
- `ai-video-consistent-b-roll-localization`
- `ai-video-group-dynamics-consistency`
- `ai-video-lighting-consistency`
- `ai-video-mascot-lighting-consistency`
- `ai-video-mascot-scale-consistency`
- `ai-video-shadow-drift-physics-solutions`
- `ai-video-volumetric-light-continuity`
- `animate-custom-character-designs-s2v-workflow`
- `animating-brand-mascots-ai-consistency-workflow`
- `animating-ecommerce-apparel-s2v`
- `anime-intro-tropes-consistent-heroes-s2v`
- `asmr-host-consistency-across-triggers-guide`
- `asmr-lighting-consistency-subject-to-video-workflow`
- `batch-influencer-content-consistent-ai-video`
- `brand-color-ai-video-mood-boards-consistency`
- `brand-mascot-consistency-ads-ai`
- `branded-asmr-mascots-s2v-workflow-guide`
- `camera-paths-consistent-subjects-ai-video-guide`
- `character-continuity-ai-fan-storyboards`
- `cinematic-backdrops-virtual-cosplay-guide`
- `combat-texture-drift-ai-mascot-renders`
- `consistent-ai-characters-b2b-storytelling`
- `consistent-ai-characters-s2v-guide`
- `consistent-ai-characters-social-video`
- `consistent-ai-lighting-standards`
- `consistent-ai-video-social-platforms`
- `consistent-ai-vs-one-shot-brand-work`
- `consistent-character-ai-video-action-scenes-s2v-guide`
- `consistent-mascot-props-multi-angle-ai-video`
- `consistent-material-impact-ai-video-guide`
- `consistent-narrative-b2b-social-video`
- `consistent-virtual-studio-asmr-series-guide`
- `consistent-virtual-vlog-sets-ai-guide`
- `cyberpunk-digital-cosplay-prompts-consistency-guide`
- `directing-consistent-ai-subjects-social-video`
- `director-mode-cosplay-hero-shot-costume-reveal`
- `episodic-social-stories-subject-consistency-ai-video`
- `fix-subject-drift-multi-angle-director-mode-sequences`
- `hailuo-ai-virtual-cosplay-realism-evaluation-guide`
- `historical-accuracy-fan-cosplay-digital-period-pieces`
- `historical-parody-series-s2v-character-consistency`
- `lighting-consistency-ai-video-campaigns`
- `main-character-energy-pov-clips-guide`
- `maintain-style-consistency-modular-video-posts`
- `maintaining-spatial-logic-s2v-clips`
- `mascot-color-grading-consistent-ai-video`
- `mascot-consistency-global-ai-video`
- `masking-hero-headpiece-physics-s2v`
- `model-consistency-ai-video-s2v-workflow`
- `motion-branding-ai-physics-corporate-identity`
- `multi-format-continuity-sync-influencer-s2v-platforms`
- `narrative-vlogging-s2v-consistent-character-stories`
- `oddly-satisfying-loops-s2v-sensory-media`
- `physics-gait-prompting-natural-character-movement`
- `predictable-aesthetics-subject-consistency-social-media`
- `predictable-subject-size-scale-drift-ai-video`
- `prompt-weight-impact-character-environment-interaction`
- `prompting-tactile-asmr-textures-subject-consistency`
- `reimagining-iconic-heroes-new-styles-s2v-guide`
- `s2v-color-continuity-palette-consistency`
- `s2v-consistent-character-stories`
- `s2v-consistent-characters-social-series`
- `s2v-consistent-culinary-video-assets`
- `s2v-consistent-ecommerce-product-videos`
- `s2v-consistent-product-demos-instagram-ads`
- `s2v-consistent-style-reels-guide`
- `s2v-cross-platform-video-consistency`
- `s2v-global-ad-localization`
- `s2v-youtube-shorts-character-continuity`
- `scaling-fan-backlots-consistent-series-environments`
- `scaling-social-video-s2v-workflows`
- `seasonal-branding-influencer-continuity-ai-vlogs`
- `simulating-silk-satin-motion-s2v`
- `sync-multiple-characters-s2v-scenes`
- `temporal-consistency-ai-dance-video-guide`
- `tiktok-series-consistency-s2v-brand-mascots`
- `troubleshoot-ai-product-rotations-consistency`
- `troubleshooting-character-drift-ai-video`
- `update-label-vfx-s2v-consistency-guide`
- `vfx-wardrobe-glowing-runes-magical-cosplay-effects`
- `virtual-fit-check-s2v-cosplay-iterations`
- `virtual-test-kitchen-consistent-backdrops-series`
- `virtual-wardrobe-s2v-influencer-outfit-continuity`
- `visual-continuity-social-media-retention`

### 运镜·构图·镜头语言（61 篇）

- `advanced-dolly-zoom-vertigo-effect`
- `ai-camera-movements-pan-tilt-zoom-guide`
- `ai-handheld-camera-motion-guide-cinematic-grittiness`
- `ai-protagonists-low-angle-tilts-power`
- `ai-technocrane-sweeps-luxury-brands`
- `ai-video-3d-rendering-multi-angle-strategy`
- `ai-video-camera-motion-control`
- `ai-video-crane-dolly-shots`
- `ai-video-hidden-camera-paths-tension`
- `ai-video-multi-axis-camera-control`
- `ai-video-ots-shots-dialogue-workflow`
- `anamorphic-aesthetics-cinematic-lens-flares-ai-video`
- `aspect-ratio-guide-choose-frame-video-goals`
- `cinematic-framing-director-mode-mascot-shots`
- `composition-prompts-rule-of-thirds-center-frame`
- `controlling-ai-landscape-composition`
- `directing-multi-shot-fan-series-ai`
- `director-guide-shot-reverse-shot-spatial-logic`
- `director-mode-floating-paths-ethereal-transitions-guide`
- `dolly-zoom-vertigo-effect-ai-video-parody-hooks-guide`
- `dutch-angles-ai-video-guide`
- `foreground-background-ai-video-cinematic-depth`
- `framing-transitions-wide-closeup-predictability`
- `geometric-precision-leading-lines-video`
- `high-low-angle-transitions-tech-showcases-ai`
- `low-angle-pathing-b2b-branding-authority`
- `mascot-safe-zone-framing-ai-video`
- `mastering-depth-of-field-cinematic-bokeh-prompting`
- `modular-prompts-realistic-social-media-transitions`
- `motion-control-speed-ramping-dynamic-ai-clips`
- `negative-space-multi-angle-social-layouts-prompting`
- `perspective-warping-multi-angle-framing-guide`
- `phonk-edit-camera-speed-kineticism`
- `plating-orbit-director-mode-360-food-shots`
- `precision-framing-director-mode-product-close-ups`
- `prevent-mascot-warping-ai-video-camera-tilts`
- `prompting-pacing-brand-story-rhythm-ai`
- `psychology-of-motion-kinetic-pacing-retention`
- `refining-prompts-ai-video-cinematic-shots`
- `replicate-trending-camera-angles-ai`
- `retro-anamorphic-lens-physics-prompting`
- `retro-camera-ai-70s-zooms-director-mode`
- `rule-of-thirds-multi-angle-ai-video-sequences`
- `rule-thirds-cinematic-ai-clip-framing-guide`
- `slow-reveal-camera-pathing-ai-video`
- `soft-focus-bokeh-ai-product-video-guide`
- `speed-ramping-director-mode-ai-video`
- `stable-dutch-angle-ai-video-framing-guide`
- `subtle-lens-flares-director-mode-ai-video`
- `synchronize-background-atmosphere-ai-video-shots`
- `testing-social-media-camera-trends-director-mode`
- `threshold-move-interior-exterior-transitions-ai-video`
- `tiktok-instagram-ai-camera-paths`
- `top-down-reveal-camera-guide-food-beverage`
- `trajectory-matching-seamless-ai-video-cuts`
- `vertical-storytelling-crane-jib-shots-ai-video`
- `visualizing-anxiety-dutch-angles-ai-director-mode`
- `vlog-cinematography-director-mode-branded-transitions`
- `wide-angle-product-realism-ai`
- `wide-vs-tight-shots-ai-video-guide`
- `youtube-shorts-pacing-camera-speed`

### 光影·曝光·色彩（76 篇）

- `ai-ads-high-key-lighting-luxury`
- `ai-lightning-electrical-arcs-effects-guide`
- `ai-noir-aesthetic-chiaroscuro-guide`
- `ai-particle-lighting-cinematic-god-rays`
- `ai-produce-video-color-accuracy-guide`
- `ai-video-brand-tone-avoid-gritty-lighting`
- `ai-video-color-grading-teal-orange`
- `ai-video-cultural-color-theory-guide`
- `ai-video-dust-light-motes-guide`
- `ai-video-golden-hour-lighting`
- `ai-video-lighting-prompted-vs-grading`
- `ai-video-lighting-regional-preferences`
- `ai-video-lighting-terms-guide`
- `ai-video-translucent-materials-light-gels-guide`
- `atmospheric-lighting-ai-environment-art`
- `beyond-general-lighting-rim-kick-lights-prompting`
- `bioluminescent-glow-prompting-organic-light-sci-fi`
- `brand-color-accuracy-ai-video`
- `brand-colors-ai-video-hex-accuracy`
- `chiaroscuro-ai-cinematography-guide`
- `chromatic-relaxation-sensory-color-stable-ai-video`
- `cinematic-moonlight-noir-lighting-guide`
- `color-theory-ai-prompts-cinematic-video`
- `cottagecore-gorpcore-lighting-guide-ai-video`
- `dappled-light-forest-shadows-ai-prompting-guide`
- `dark-academia-cinematic-lighting-fanfic-guide`
- `evoking-nostalgia-soft-focus-pastel-ai-tones-guide`
- `firelight-heat-haze-prompting-guide`
- `fix-ai-video-flicker-stable-lighting`
- `fix-neon-glow-bleed-ai-night-city-scenes`
- `gaslight-candlelight-period-realism-ai`
- `golden-hour-ai-lighting-food-vlogs`
- `golden-hour-lighting-virtual-fashion-b-roll`
- `hdr-exposure-latitude-ai-video-guide`
- `high-key-lighting-arctic-broll-guide`
- `historical-film-looks-ai-color-palettes`
- `industrial-flickering-fluorescent-lighting-ai-simulation`
- `integrate-brand-colors-modular-prompt-templates`
- `kelvin-color-temperature-ai-video-prompt-guide`
- `kinetic-light-paths-ai-motion-blur-guide`
- `kodachrome-palette-ai-prompting-1960s-color-science`
- `low-light-saturation-ai-video-control`
- `luxury-gym-aesthetic-studio-lighting-ai-video`
- `macro-texture-lighting-asmr-guide`
- `mastering-chiaroscuro-film-noir-ai-shadows`
- `mastering-skin-tones-cinematic-ai-video`
- `motivated-lighting-ai-video-guide`
- `narrative-light-leaks-ai-prompting-cinematic-flaws`
- `neon-rain-color-saturation-ai-video-guide`
- `neutralize-ai-video-saturation-natural-cinematic-tones`
- `nocturnal-realism-prompting-deep-shadow-detail-night-scenes`
- `optical-realism-anamorphic-flares-light-leaks-guide`
- `prompting-cold-moonlight-warm-urban-glow`
- `prompting-film-halation-retro-glow-guide`
- `prompting-flickering-firelight-asmr-ambience`
- `prompting-light-shadow-cinematic-viral-video`
- `prompting-period-grime-weathering-guide`
- `recreating-ancient-textures-stone-bronze`
- `rim-lighting-subject-separation-guide`
- `sequin-effect-light-refraction-rendering-ai`
- `shadow-puppetry-moving-light-sources-sensory-narrative`
- `shadow-softness-umbra-control-prompting`
- `shadowless-commercial-ai-video-lighting-guide`
- `silver-halide-black-white-film-tones-prompting-guide`
- `specular-highlights-luxury-ai-video-guide`
- `studio-lighting-ai-product-ads`
- `symbolic-lighting-ai-video-prompting-guide`
- `teal-orange-cinematic-palette-ai-video-guide`
- `technicolor-nostalgia-mid-century-saturated-styles-ai-video`
- `techwear-neon-lighting-metallic-fabrics-ai-video-guide`
- `tone-mapping-ai-video-highlight-detail`
- `urban-blue-hour-lighting-lifestyle-vlogs-guide`
- `urban-steam-grime-industrial-b-roll-guide`
- `virtual-three-point-lighting-ai-studio-setups`
- `visual-contrast-ai-video-subjects-guide`
- `wet-asphalt-neon-reflections-ai-video`

### 材质·物理·特效（69 篇）

- `1970s-sci-fi-aesthetic-analog-physics-guide`
- `ai-atmospheric-overlays-vfx`
- `ai-beverage-commercial-director-mode-liquid-motion`
- `ai-fabric-physics-realistic-clothes-movement`
- `ai-fashion-b-roll-wind-hair-flare-guide`
- `ai-product-videos-glass-metal-rendering`
- `ai-realism-material-textures-video-guide`
- `ai-vfx-cgi-workflows-integration`
- `ai-vfx-compliance-regulated-ads-guide`
- `ai-vfx-glass-fracture-prompting-guide`
- `ai-vfx-product-environment-cleanup`
- `ai-video-jewelry-physics-ecommerce-guide`
- `ai-video-skin-realism-pores-blemishes-guide`
- `ai-video-textures-leather-silk-prompting-guide`
- `artifacts-as-texture-generative-noise-art`
- `brittle-physics-simulating-chocolate-bread-snap`
- `cinematic-physics-product-social-ads-ai`
- `closing-vfx-gap-concept-commercial-hailuo-ai`
- `control-smoke-turbulence-ai-video-director-mode`
- `controlling-particle-dissipation-ai-video`
- `creative-director-ai-vfx-guide-workflow-control`
- `defining-texture-materiality-ai-style-guides`
- `director-mode-fan-script-vfx-guide`
- `dust-motes-sunbeams-attic-scenes-sensory-depth`
- `dynamic-skyboxes-virtual-backlots-vfx-filmmaking`
- `dynamic-water-simulation-realistic-vfx-oceans-hailuo-ai`
- `fix-fluid-artifacts-ai-video-troubleshooting`
- `fragmented-realities-ai-physics-vfx-guide`
- `garnish-physics-falling-herbs-salt-prompting`
- `generative-ai-tileable-textures-game-art`
- `generative-impressionism-motion-blur-tool`
- `high-fidelity-steam-food-close-ups-ai-video`
- `high-speed-liquid-splashes-ai-video-guide`
- `high-viscosity-liquid-physics-luxury-marketing`
- `hydrodynamic-branding-logos-fluid-simulations`
- `kinetic-sand-textures-genz-asmr-hailuo-ai`
- `layered-atmosphere-variable-fog-density-visual-depth`
- `liquid-pearls-fluid-dynamics-ai-video-guide`
- `luxury-silk-textures-ai-video-guide`
- `macro-refraction-soap-bubble-ai-video-guide`
- `mastering-fabric-drape-ai-video`
- `organic-meat-textures-ai-video-guide`
- `physics-of-foliage-realistic-wind-ai-landscapes`
- `prompting-ferrofluid-ink-water-ai-guide`
- `prompting-lava-liquid-metal-vfx-plates`
- `prompting-smoke-foam-high-end-culinary-ai-video`
- `realistic-beverage-bubble-dynamics-ai-video`
- `realistic-fire-heat-haze-ai-generation-guide`
- `realistic-fur-dynamics-clumping-matting-ai-video`
- `realistic-limbs-posture-ai-video-guide`
- `realistic-muscle-contraction-ai-video-guide`
- `realistic-sandstorms-dust-plumes-guide`
- `realistic-volumetric-fire-ai-vfx-guide`
- `realistic-water-glass-caustics-ai-video-guide`
- `sandstorm-haze-ai-broll-guide-cinematic-effects`
- `simulate-squishy-ai-textures-asmr-sensory-content`
- `simulating-compression-fabric-physics-gear-ai-video`
- `simulating-premium-material-physics-ai-ads`
- `simulating-viscosity-thick-liquid-motion-luxury-ads`
- `slime-physics-asmr-textures-ai-video-guide`
- `soft-body-deformations-ai-video-guide`
- `soft-body-physics-ai-video-guide`
- `super-8mm-textures-nostalgic-ai-home-movies`
- `textures-motion-high-fidelity-product-closeups`
- `urban-rainy-days-wet-textures-city-ads`
- `viral-visuals-x-physics-feed-stopping-clips`
- `volumetric-fog-haze-cinematic-ai-depth`
- `volumetric-fog-meditation-broll-guide`
- `y2k-style-ai-video-prompt-guide-retro-textures`

### 声音·口型·音频（9 篇）

- `ai-visual-asmr-guide-social-media`
- `asmr-restock-visuals-guide`
- `director-mode-binaural-asmr-visuals-guide`
- `high-viscosity-honey-asmr-video-guide`
- `managing-temporal-flow-asmr-kinetic-clips`
- `simulate-high-fidelity-debris-asmr-guide`
- `tactile-unboxing-ai-video-guide-asmr`
- `temporal-asmr-director-mode-slow-sensory-beats`
- `virtual-asmr-channel-ai-video-guide`

### 节奏·情绪能量·叙事（33 篇）

- `6-second-narrative-product-demos`
- `ai-concept-art-fantasy-sci-fi-game-worlds`
- `ai-creative-blocks-world-building`
- `ai-kinetic-control-showdown-hailuo-vs-competitors`
- `ai-prototype-viral-social-hooks`
- `ai-set-extensions-product-commercials`
- `ai-storyboard-budgeting-indie-fan-documentaries`
- `ai-storyboards-dynamic-scenes`
- `ai-storyboards-pitch-deck-fan-concepts`
- `ai-video-ad-hooks-seasonal-fatigue`
- `ai-video-kinetic-sand-powder-motion-guide`
- `atmospheric-set-extensions-weather-backlots`
- `balcony-reveal-director-mode-paths-guide`
- `cinematic-tiktok-loops-director-mode`
- `digital-zen-kinetic-sculptures-social-media-guide`
- `fanfic-to-film-cinematic-ai-video-guide`
- `hailuo-ai-kinetic-backgrounds-ads`
- `hiit-kinetic-motion-fitness-ads-prompting`
- `indie-devs-ai-concept-art-worlds`
- `iterating-social-ad-hooks-ai-variations`
- `kinetic-energy-high-impact-product-ads-guide`
- `lore-visualization-unproduced-game-scripts-ai`
- `mastering-tiktok-hooks-director-mode`
- `modular-formulas-high-retention-social-video-hooks`
- `modular-storytelling-ai-b2b-brand-snippets`
- `motion-psychology-ai-video-ad-retention`
- `multi-clip-ai-storyboarding-workflow-guide`
- `oddly-satisfying-ai-video-loops-guide`
- `pre-visualize-slow-motion-product-reveals-instagram-ai`
- `sci-fi-worldbuilding-alien-vistas-dmp`
- `seamless-infinite-fashion-loop-ai-video-guide`
- `slow-burn-kinetic-energy-ai-video-guide`
- `visualizing-unproduced-sci-fi-worldbuilding-ai-video`

### 提示词工程·负向·结构（44 篇）

- `achieving-spatial-coherence-product-spins`
- `ai-video-predictability-coherence`
- `ai-video-standardization-agencies`
- `ai-video-templates-social-media-trends-guide`
- `anti-prompt-cinematic-ai-video-guide`
- `architectural-realism-virtual-backlots-ai-prompting`
- `atmospheric-surrealism-prompting-impossible-weather`
- `b2b-ai-video-prompts-aesthetics`
- `brand-archetypes-ai-video-prompts`
- `brutalist-urban-landscapes-ai-video-prompting`
- `cinematic-ai-video-prompts-guide`
- `cinematic-viral-prompting-brand-safety-b2b`
- `cyberpunk-concept-art-prompting-environments`
- `director-mode-chase-scene-prompting-guide`
- `dreamcore-aesthetics-prompting-surreal-liminality-guide`
- `ecommerce-templates-modular-ai-product-closeups`
- `fan-script-prompt-cinematic-fidelity-guide`
- `found-footage-tropes-prompting-gritty-analog-realism`
- `glitchcore-aesthetics-ai-video-prompting-guide`
- `global-illumination-prompting-ai-video-guide`
- `minimalist-prompt-modules-clean-social-ads`
- `modular-cityscapes-ai-video-prompting`
- `modular-prompt-library-cinematic-broll`
- `modular-prompt-templates-tiktok-reels-2026`
- `modular-prompting-social-media-videos`
- `modular-templates-ai-social-media-stories`
- `negative-prompts-brand-safety-ai-video`
- `negative-prompts-cinematic-ai-video`
- `photometric-film-emulation-prompting-guide`
- `predictable-motion-ai-action-clips`
- `prompt-anamorphic-flares-film-looks`
- `prompt-engineering-cinematic-ai-video-workflow`
- `prompting-biological-iridescence-ai-video-guide`
- `prompting-mediterranean-coastal-b-roll-ai`
- `prompting-subtle-motion-ai-video`
- `prompting-weathered-concrete-urban-decay-ai-video`
- `quiet-luxury-parody-minimalist-wealth-ai-prompting-guide`
- `reusable-ai-video-prompt-library-guide`
- `scale-social-video-production-prompt-recipes`
- `simulating-impact-prompting-debris-gravity`
- `tech-predictable-ai-video-generation`
- `weightless-surrealism-ai-video-guide`
- `wet-look-fashion-prompting-rain-leather-vinyl`
- `x-platform-ai-prompts-clarity`

### POV·第一人称（2 篇）

- `director-mode-first-person-product-pov`
- `immersive-fitness-pov-ai-cinematography-guide`

### 分镜·前期·空间（5 篇）

- `ai-pre-viz-social-media-set-design`
- `ai-urban-scenes-spatial-depth-workflow`
- `cinematic-jogging-plates-parallax-guide`
- `mastering-360-degree-scene-coverage-director-mode`
- `realistic-depth-virtual-backlots-ai`

### UI·遮挡·安全区（1 篇）

- `ai-video-safe-zone-social-ui`

### 画质·伪影·修复（14 篇）

- `aerodynamic-realism-wind-resistance-cinematic-scenes`
- `ai-ads-brand-safety-cultural-artifacts`
- `ai-artifacts-genz-aesthetics-guide`
- `ai-product-artifacts-brand-integrity`
- `fix-ai-video-jitter-cinematic-stability`
- `fix-mascot-limb-artifacts-ai-360-pans`
- `fix-motion-ghosting-ai-video`
- `fix-skyscraper-perspective-warping-ai-video`
- `fix-window-reflection-artifacts-ai-urban-renders`
- `gate-weave-organic-jitter-ai-video`
- `photorealism-vs-lofi-ai-video-guide`
- `stabilize-mascot-motion-ai-video`
- `troubleshooting-structural-warping-ai-architectural-video`
- `vhs-artifacts-lo-fi-retro-social-content`

### 商业·产品·电商（少用）（34 篇）

- `360-degree-product-orbits-ai-guide`
- `ai-cinematic-b-roll-video-production-guide`
- `ai-creative-sprints-ad-production`
- `ai-mascots-3d-animation-tco`
- `ai-mascots-b2b-marketing-governance`
- `ai-product-media-commercial-licensing`
- `ai-video-agile-seasonal-ads`
- `ai-video-director-mode-ad-ctr`
- `ai-video-ecommerce-static-images`
- `ai-video-linkedin-ads-b2b-marketing`
- `ai-video-product-demos-social`
- `ai-video-seasonal-product-variants-ecommerce`
- `ai-video-small-business-social-ads`
- `ai-virtual-influencers-b2b-social-media`
- `bioluminescent-forest-ai-video-sensory-reels-guide`
- `brand-specific-motion-ai-signature-guide`
- `centering-subjects-ai-product-videos-guide`
- `cinematic-b-roll-youtube-shorts-hailuo-ai`
- `commercial-rights-ai-product-videos`
- `dutch-tilt-dramatic-effect-product-photography`
- `hailuo-ai-video-ads-workflow`
- `instagram-reels-ai-video-strategies`
- `instagram-reels-algorithm-ai-video-directing`
- `localize-seasonal-ads-ai`
- `maximize-ad-spend-seasonal-ai-clips`
- `optimizing-ai-video-vertical-ads`
- `product-integration-ai-video-workflow`
- `professional-tiktok-ai-video`
- `rustic-minimalist-food-video-aesthetics-brands`
- `scale-ecommerce-ai-video-ads`
- `scaling-seasonal-ad-campaigns-ai-video`
- `simulating-360-product-orbits-director-mode`
- `tiktok-aesthetic-ai-video-for-social-commerce`
- `virtual-product-photography-ai-video`

### 其他 / 场景美学 / 行业向（79 篇）

- `90s-sitcom-aesthetic-ai-video-guide`
- `aces-pipeline-ai-video-professional-workflows`
- `ai-alternate-movie-endings-visualization-guide`
- `ai-b-roll-culturally-nuanced-global-campaigns`
- `ai-b-roll-vs-stock-footage-cost-analysis`
- `ai-central-asian-b-roll-guide`
- `ai-cinematic-b-roll-creative-directors`
- `ai-city-b-roll-pedestrian-flow-workflow`
- `ai-food-video-heat-transformation-simulation`
- `ai-high-fidelity-historical-urban-reconstruction-guide`
- `ai-horror-script-visualization-guide`
- `ai-matte-painting-game-skybox-generation`
- `ai-photobashing-game-art-workflow`
- `ai-video-agency-client-brief-workflows`
- `ai-video-campaign-mockups-approval`
- `ai-video-copyright-guide-business`
- `ai-video-deleted-script-pages-visualization`
- `ai-video-flash-sale-workflow`
- `ai-video-global-campaigns-localization-roi`
- `ai-video-motion-intensity-control`
- `ai-video-reimagine-classic-films-new-genres`
- `ai-video-urban-greenery-roof-gardens-guide`
- `ai-virtual-studio-seasonal-trends`
- `architectural-metamorphosis-ai-video-guide`
- `architectural-styles-ai-concept-mood-boards-guide`
- `arctic-stock-footage-ai-workflow`
- `atmospheric-distortion-heat-shimmer-mirage-effects`
- `autochrome-look-ai-video-guide`
- `backrooms-high-fidelity-ai-video-guide`
- `biomechanical-accuracy-ai-fitness-video`
- `blue-hour-ai-video-visual-depth-guide`
- `botanical-fidelity-leaf-veins-translucency-ai-video`
- `cinematic-ai-architectural-vistas`
- `cinematic-ai-landscape-mist-depth-guide`
- `controlling-digital-decay-ai-video-guide`
- `crafting-unique-holiday-visuals-ai`
- `cyber-victorian-ai-video-guide-cinematic-workflow`
- `directing-intimate-city-cafe-broll-ai-guide`
- `director-mode-catwalk-zooms-fashion-ai-video`
- `director-mode-cinematic-parody-guide`
- `director-mode-period-film-cinematography`
- `director-mode-precise-b-roll-control`
- `director-mode-yoga-flows-cinematic-ai`
- `film-stock-emulation-ai-video-kodak-fuji-guide`
- `genre-bending-showdown-hailuo-ai-style-parody-guide`
- `graphic-novel-to-screen-ai-video-workflow`
- `grwm-hack-cinematic-video-clips`
- `hailuo-ai-urban-b-roll-crowd-direction`
- `handheld-street-style-urban-vlog-simulation-guide`
- `high-fidelity-electrical-arcs-ai-video-guide`
- `high-fidelity-urban-interiors-rendering-guide`
- `historical-parody-ai-video-guide`
- `indie-handheld-fashion-street-shoot-ai-simulation`
- `mood-board-style-frame-ai-video`
- `nature-plates-ai-landscapes`
- `outerwear-motion-ai-video-textiles`
- `preserve-material-finish-ai-video`
- `realistic-fantasy-armor-ai-video-guide`
- `realistic-hoodie-motion-ai-video-fashion-guide`
- `realistic-pedestrian-motion-ai-urban-scenes`
- `regency-space-opera-ai-video-guide`
- `replicable-style-guide-ai-review-channel`
- `repurpose-ai-clips-marketing-posts`
- `scale-fan-led-social-media-series-guide`
- `scale-perspective-guide-ai-video`
- `seasonal-teaser-ai-b-roll-hype`
- `simulate-city-transit-b-roll-ai-guide`
- `simulating-16mm-film-grain-indie-film-aesthetics`
- `simulating-gravity-ai-fitness-videos`
- `skyscraper-flyby-director-mode-guide`
- `solarpunk-ai-video-guide-hailuo`
- `swap-backgrounds-seasonal-marketing-content`
- `synthwave-fan-scripts-ai-video-cinematic-workflow`
- `tyndall-effects-brutalist-interiors-ai-video-guide`
- `victorian-ai-sets-architectural-accuracy`
- `virtual-studio-ai-creative-fatigue`
- `visualize-canceled-movie-sequels-ai-video`
- `wes-anderson-symmetry-ai-director-mode-guide`
- `x-marketing-professional-tech-visuals`

