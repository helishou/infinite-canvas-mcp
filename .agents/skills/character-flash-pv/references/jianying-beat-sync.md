# 剪映成片踩点重音剪辑（JianYing 5.9 草稿）

适用：Clip 导出/拼接后在剪映做快闪踩点重音成片，或对已有剪映草稿对齐重音、加淡出。CLI、draft schema、编辑器生命周期见 Hermes 侧 `capcut-edit` skill。

## 用户硬规则（违反会被当场纠正）

1. **素材内容一帧都不裁**——时长压力全部靠变速解决。
2. 变速范围克制：**加速上限 ~1.45×**（≥2× 被明确否决为"太多"）；氛围镜（行走/特写）可轻度慢速 0.65–0.9×；**高潮镜不许慢速蓄力**（慢速蓄力被否决），高潮用正常速收刀落在最强锤上。
3. **同一镜头不许在连续动作中被拆成不同速度的两段**——会被看成"同一个动作重复了两遍"。同镜跨拍要么整段一速（拍点在镜内不切），要么只在锤点做 ±0.2 内的轻 ramp。
4. **切点必须落在明显重音上**（spectral-flux 强度 ≥400 量级），弱前奏轻点不切；长镜跨过强锤会被质问。
5. **镜头长短按鼓点间隔分配**：密集连拍给短切片/快切镜（手部、双足等细节镜），宽间隔给主镜。开场放定场长镜，细节特写放中段快切位。
6. 用户手动改过草稿后：**顺序绝对不动**，只移动时间线边界+调速来吸附重音；用户手设 1.0× 的段会把相邻切点锁死，动之前先问。改坏了用 `draft_content.json.bak` 还原。
7. 结尾不许戛然而止：画面+音乐都要淡出。

## 流程

1. `Stop-Process -Name JianYingPro`（剪映在跑会拒写/回写覆盖）。
2. 重音检测：BGM 转 wav → numpy 谱通量（frame 1024/hop 256、Hanning、[1,2,3,2,1] 平滑、24 帧移动均值 +0.35 delta 阈值），取局部峰、强度 ≥400 为"必须切"的重音，边界吸附到 30fps 网格 `round(t*30)/30`。
3. 对每段：`target_timerange` 边界吸附到最近重音（±0.45s、单调、gap ≥0.35），`speed = srcDur/tgtDur` 写进段引用的 speed material（`curve_speed: null`）。源边界必须是整数源帧（24fps 素材用 `round(sec*24)/24`，否则切点有一帧上一场景残留）。
4. 预览验证：手写 ffmpeg trim/setpts/concat 图（不用 CLI render），灰度 rawvideo 逐帧像素差找切点峰（scdet 对相似画面不敏感）；预览 ±1–3f 偏差是 24→30fps 转采样噪声，JSON 才是真值。
5. 淡出（可选）：用户明确要求时才加——尾镜 `capcut image-anim <proj> <seg> --outro 渐隐 --outro-duration 0.8s --jianying`（resource_id 624707，本机缓存已有）；音乐 `capcut audio-fade <proj> <audio-seg> --fade-out 1.4`；音频段保持铺满全曲（视频先结束→黑场+音乐渐弱收尾）。**用户可能说"尾镜渐隐先不做"——此时只保留音乐淡出（或完全不淡出），按用户当轮要求为准，不要默认加。**
6. 重开剪映，让用户手动导出（用户偏好手动导出，CLI render 只出代理预览且每段从 0 trim，不可用于正式成片）。

## 本用户的调色+美颜预设（每条快闪片默认加）

filter 轨道（全时长，两条叠在独立 filter track）：
- **模糊氛围** resource_id `7398486193924623628`，强度 value `0.1`
- **柔光** resource_id `7395596262252334373`，强度 value `0.149`
- 缓存路径在 `%LOCALAPPDATA%/JianyingPro/User Data/Cache/artistEffect/<resource_id>/<hash>`；新建草稿时照 `materials.effects + filter track segments` 结构复制即可。

美颜（段级 `materials.effects` 引用，每个视频段 extra_material_refs 各挂一份）：
- **冷白** resource_id `7148720872105185800`：`face_adjust_skin_ColdWarm=0.0`，`face_adjust_skin_Intensity=0.2296`（肤色冷暖 0 + 强度 ~23%）
- **淡妆公式** resource_id `7296469047846113802`：`face_adjust_whole=0.5`
- 结构照现有草稿 `materials.effects[].face_adjust_params[{face_id:"-1",enable:true,adjust_params:[{name,value}]}]`；用户手动加时走的是"美颜美体"面板，重建草稿时用 `--bind`/段级 effects 引用等价复刻。
- 美颜段可能表现为 nested draft（`materials.drafts` 引用，`materials.videos.path=""`）——正常结构，别当损坏处理。

## 穿帮打码（纯 CLI 方案）

剪映"局部马赛克"资源本机没缓存时，用已缓存的「模糊」场景特效（resource_id `6739752823140913675`，effect_id `634025`，在 `Cache/effect/634025`）代替：
1. `capcut duplicate <proj> <seg> --new-track` 复制穿帮段到上层轨道；
2. JSON 把复制段 `source_timerange` 裁到穿帮窗口（整数源帧）、`target_timerange` 按原速度换算回时间线位置；
3. `capcut mask <proj> <dup> rectangle --center-x --center-y --size --rect-width --round-corner 60 --feather 25`（坐标是半画布单位 [-1,1]：`x/画布宽*2-1`；size 为画布高占比）；重设要先 `--off` 再 apply（同段只允许一个 mask）；
4. `capcut add-effect "模糊" <start> <dur> --bind <dup> --resource-id ...` 实际会建独立特效轨道——要段级贴法：删掉它建的 effect track 段，把返回的 material id 直接 append 进复制段的 `extra_material_refs`（material 存在 `materials.video_effects`，段级引用即剪映的段效果）。
5. 遮罩范围宁大勿小：以检测框外扩 30–80px；用 ffmpeg boxblur 近似渲预览验证覆盖，逐帧像素差证明补丁每帧生效。

## BGM 选择（用户授权自己找）

- 找**重音密度高的 remix 版**。基线参考：客官不可以 remix `cbed8462…mp3`，15.3s，~94BPM 双拍，重音间隔 0.63s，top 锤强度 566。判定：谱通量重音 ≥400 的个数 ≥ 每 1.5s 一个才算"够炸"。
- 剪映音乐库定位法：`key_value.json` 的 searchKeyword/materialName → `downLoadcfg` → `Cache/music/<hash>.mp3` → faster-whisper 转首 45s 对歌词。候选不足时用本地 chatgpt2api 搜"歌名 remix 高潮版"，让用户先导入到剪映音乐库再取缓存文件。
- BGM 从爆点段起播（前奏弱铺垫段不要），整曲铺满时长优先于切尾；切尾只用作压缩总长的最后手段。
