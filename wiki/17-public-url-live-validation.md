# 公开 URL 真实环境验证

更新时间：2026-08-17。

本页只记录可提交的脱敏证据。完整媒体、完整逐字稿、模型响应和运行日志保存在 git ignored 的 `runtime-runs/`，不进入仓库；Assignment Agent 只生成 source pack，不写入 AI Harness SaaS 或外部 Obsidian。

## 已验证链路

| 来源 | 真实结果 | 获取/转写 | 交付与质量 |
| --- | --- | --- | --- |
| 小宇宙 E248，3834 秒 | 完整运行成功 | 公开 MP3 → OSS + DashScope `fun-asr`；`paraformer-v2` robust review | 652 个时间戳片段、12 章、132 个 claim；每章最多 12 个；Policy/QA pass；40 个 review item（20 个 high）已在 source pack 披露 |
| YouTube `jNQXAC9IVRw`，19 秒 | 完整运行成功 | 发布方手工字幕，跳过媒体下载与 ASR | 6 个字幕片段、1 章、5 个 claim；Policy/QA pass |
| YouTube `S5k9l6Wa93Q`，约 60 秒 | 完整运行成功 | 无手工字幕 → `yt-dlp` 取得 968944 字节音频 → 云端 ASR | 9 个时间戳片段、1 章、6 个 claim；Policy/QA pass；3 个 review item（2 个 high）已披露 |
| 飞书 CLI event consume | 真实 runtime 已启动 | `feishu_event_runner` 与 handler 均健康，EventKey 为 `im.message.receive_v1` | 用户身份缺少发送消息 scope，测试消息未发出；Task Router 到最终回复不能记为线上端到端成功 |

小宇宙和 YouTube 三条完整链路都确认 `knowledgeBaseWritePerformed=false`。小宇宙 ASR 为 `status=complete`、`failedChunks=0`、`partial=false`，检测到 2 个匿名 speaker；robust review 不等同于同时发言的声源分离，产物明确记录 `sourceSeparationPerformed=false`。

## 本地证据路径

- 小宇宙：`runtime-runs/public-url/runs/live_xiaoyuzhou_e248_20260817/`
- YouTube 官方字幕：`runtime-runs/public-url/runs/live_youtube_official_jNQXAC9IVRw_20260817/`
- YouTube 云端 ASR fallback：`runtime-runs/public-url/runs/live_youtube_fallback_S5k9l6Wa93Q_20260817/`
- 成本汇总：`runtime-runs/public-url/live-validation-cost-summary-2026-08-17.json`

关键 artifact SHA-256：

| Run | source pack | provenance | QA Gate | Policy Gate |
| --- | --- | --- | --- | --- |
| 小宇宙 | `26aa176dead87ca495d89226fb8c173aadbe0c615f24d670afcbf77074eefd07` | `7c732b5da13e3626fbd11bfea0221b37cd4cfe10adfc24cc5b5c61fe7a88a8e3` | `ff1f90d8ce2530f57d254adb5d5c90b0c4e9912080bb9460123a41cf0027577b` | `32bc20e2d6ad7d258d2a9d3fe134be483104563acbe47860b119cc15ff5e1232` |
| YouTube 字幕 | `62c88ebcec8f13119d081a22181d917c2a25438ca5c738b0d1806a2ebf8da9b9` | `0a3125edb6aaf296f55f951fbb067f05be641c6d145aed57ddf159902d5be58c` | `ec96c4df880e710666ae0ea53771cb0cbf81d759a4f204d446fd2ced1537a574` | `a7f4488f47726946530b78ebcb820f76e9b990468c51e364e5ccdc36a1f1aac7` |
| YouTube ASR | `3ec5fdb45b1fc7ff6ee184da5f0f6b12612bb70204b1ed37e9803791f113b01e` | `541796b559aa0c2d87fbaf3ceb8a0566fd2ed0f71c258976b326f45c58a6a2e4` | `f145678d2114711b2f19b9ab04b3e5c58f47c82ca8a13058196ba8d5ddd4bddc` | `c56b2dcdc2a5a308c342816675c889668f9f88265aff4a8f4fcac5d838594dfc` |

## 成本

付费调用前分别写入了 ignored runtime 的 preflight estimate。按阿里云北京地域公开单价，`fun-asr` 为 ¥0.00022/秒，`paraformer-v2` 为 ¥0.00008/秒；DeepSeek V4 Pro 按 cache miss 输入 ¥3/百万 tokens、cache hit 输入 ¥0.025/百万 tokens、输出 ¥6/百万 tokens 计算。

| Run | 依据已记录用量计算，不含 OSS |
| --- | ---: |
| 小宇宙完整运行 | 约 ¥1.468 |
| YouTube 官方字幕 | 约 ¥0.0036 |
| YouTube ASR fallback | 约 ¥0.0237 |

小宇宙最初的 preflight ASR 行项目漏列了已启用的 robust review（约 ¥0.307）；修正后 ASR 合计约 ¥1.150。由于实际 LLM 用量低于原保守上限，记录到的总成本仍约 ¥1.468，未超过原 ¥1.50 总上限。以上不是账单控制台对账值，可能受计费取整、税费、OSS 请求/存储和 provider 侧未记录重试影响。价格来源：[Fun-ASR](https://help.aliyun.com/zh/model-studio/fun-asr)、[Paraformer](https://help.aliyun.com/zh/model-studio/paraformer-v2)、[DeepSeek](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。

## 边界验证

- `youtu.be` 重定向和带 `list=` 的 URL 只解析单个视频；命令固定 `--no-playlist`。
- 5 秒时长上限返回 `public_media_duration_limit_exceeded`；1000 字节媒体上限返回 `youtube_media_size_unknown_or_exceeded`。
- 不可访问样例返回可恢复的 `youtube_metadata_failed`；live/private 由稳定 fixture 验证为 blocked。
- resolver 固定 `--no-cookies`、`--no-cookies-from-browser`、`--no-config`；SSRF、私网/保留地址和危险重定向由聚焦测试覆盖。

## 环境与尚未验证

- 实测 `yt-dlp 2026.07.04`，通过 Homebrew 安装；没有自制 YouTube 签名解析器。
- 飞书机器人认证、handler 和 CLI event bus 已可用；用户身份 CLI 缺少 `im:chat:read`、`im:message.send_as_user` 与 `im:message`。这不影响 bot 事件消费，但阻塞了自动发送真实测试消息。需要用户交互运行 `lark-cli auth login` 并授权所需 scope 后重试。
- provider 账单控制台未对账；公开平台内容和字幕可用性会随平台变化。
- 单录混音的双模型 review 能暴露可疑片段，但不能保证恢复高重叠同时发言。

## 仓库验证

- 本轮最终再次运行小宇宙与 YouTube `jNQXAC9IVRw` 的真实 `--resolve-only`，均成功且没有下载媒体、启动 ASR 或写外部知识库。
- `npm test`：67 项通过，并执行包含 model provider 与 QA Gate 的 TypeScript 检查。
- workspace validator、local CI、`npm audit --omit=dev` 均通过；依赖审计为 0 个已知漏洞。
