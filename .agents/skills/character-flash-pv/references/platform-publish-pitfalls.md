# 四平台发布实测坑（2026-10-28）

适用：快闪 PV 投小红书、B站、抖音、视频号时，账号、参数、回执与落库核对。
平台入口、账号别名与安装说明见 [`../../social-auto-upload/SKILL.md`](../../social-auto-upload/SKILL.md)；本文只记录会导致「看起来发了、其实没落库或落错分区」的具体坑。

## 先定位 CLI，不要假设可用

`sau` 通常不在 PATH 上。按顺序确认：

1. `command -v sau` 成功则直接用。
2. 失败时找本机 social-auto-upload 仓库副本，用它的虚拟环境：`<repo>/.venv/Scripts/sau.exe`（Windows）或 `<repo>/.venv/bin/sau`；也可用该仓库的解释器执行 `<repo>/sau_cli.py`。仓库侧另有 `skills/<平台>-upload/SKILL.md`，平台细节以它为准。
3. 两处都没有就停下，报告「发布 CLI 未安装」并保留待发布素材包；不尝试全局 pip 安装、不模拟登录绕过平台权限。

发布前先 `sau <平台> --help` 核对当次参数，并确认该账号授权状态。参数名与分区 ID 会随 fork 变化，不凭记忆传值。

## 抖音

- 点发布时平台会弹短信验证码弹窗。CLI 会自动点「获取验证码」，把用户提供的码写进 `verify_code.txt`（填完自动删）。
- 填码后弹窗仍不消失 = 本次验证失败，进程会空转循环。处理：kill 该进程后重跑同一条 `upload-video`。未发布成功不会留重复作品；重跑会重新点「获取验证码」触发新短信，短信冷却约 6 分钟。
- 成功回执是「🥳 视频发布成功」。作品先标「审核中」，去 `creator.douyin.com` 内容管理页核对标题与条数增量确认落库。

## B站

- `--tid 172` 实际是「游戏→手机游戏」，不是手书/动画。分区必须显式核对，不能凭记忆猜 tid。
- 竖屏快闪 PV 实测可用「影视→短片」`--tid 85`。发布后用 `api.bilibili.com/x/web-interface/view?bvid=<bvid>` 读回 tid 验证。
- 分区发错**无法程序化纠正**：biliup CLI 无删稿/改分区命令，创作中心删除接口（`member.*` / `vupre.*`）实测全部 404。只能让用户在 App「创作中心-稿件管理」手动删除后重发——所以宁可在提交前多核对一次分区。
- `sau bilibili login` 必须 PTY 交互扫码。搜索/稿件列表 API 有 412 风控，验证落库优先用无 cookie 的 view API 按 bvid 查。

## 小红书

- 本 fork 的 `xiaohongshu_uploader` 对每条视频默认声明「来源转载」，原创内容会被误标。已在 `main.py` 的 `check_original_declaration` 加 `if not source: return`（无 `repost_source` 就不声明）；换机器或更新 fork 后先确认这处补丁还在。
- 误标声明不能改，只能重发。重发前删旧笔记：创作中心 `creator.xiaohongshu.com/new/note-manager`，笔记卡片 hover 后有 `.note-card__action-btn--del` 删除按钮（patchright + 有效 cookie 可直接删），删后确认标题消失。

## 视频号

- `sau tencent login` 用**微信**扫码，不是浏览器账号密码。约 5 分钟超时；二维码过期后必须 kill 重跑 login 拿新码（新码写 `cookies/tencent_neko_tencent_login_qrcode_<ts>.png`）。
- 发布时平台强制勾选「含 AI 生成内容」标注（sau 已自动勾选）。这是平台规则，与文案是否提 AI 无关，不要在文案里为此额外解释。

## 失败处理

失败只影响该平台：保留其可重试发布包并报告原因，不重复发布已成功的平台。只有收到平台成功回执才标记「已发布」；结果未知时先按标题查创作者后台，再决定是否重发，不盲目重提。
