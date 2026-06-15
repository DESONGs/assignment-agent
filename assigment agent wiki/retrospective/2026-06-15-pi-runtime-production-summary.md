# PI Runtime 生产化成果总览

日期：2026-06-15
状态：ready-for-github

## 当前成果

本轮把会议 Agent 从依赖单一本机 ASR，推进到可生产运行的双 ASR provider 架构：

- ASR provider：`MEETING_ASR_PROVIDER=auto|local_qwen3|aliyun_dashscope_paraformer`。
- 生产默认：`auto`，存在百炼/DashScope API key 时优先云端 `aliyun_dashscope_paraformer`，否则回落本机 `local_qwen3`。
- 云端模型：`paraformer-realtime-v2`。
- 粤语场景：默认 `languageHints=["yue","zh","en"]`，面向粤语、普通话、英文夹杂会议。
- 输出契约：云端和本地 ASR 都写回统一的 `summary.json`、`transcripts/transcript.full.json`、`evidence/evidence-index.json`、`evidence/sources.json`。
- 隐私边界：原始音频只允许在 ASR provider 阶段上传；文档生成、QA、Docker、Hermes 和外部 LLM 只消费 transcript/evidence。

## 已落地模块

- `dashscope_asr_client.mjs`：百炼 DashScope WebSocket ASR client，支持真实 provider、mock fixture、事件审计和脱敏 artifact。
- `task_execution_runner.mjs`：统一 `ensureAsrTranscription()`，负责 provider resolve、cache key、cloud/local dispatch、fallback 和分层失败原因。
- `media-tools.ts`：新增 `meeting_transcribe_cloud_asr` runtime tool。
- `policy-gate.ts`：允许 ASR stage 上传 raw audio，同时继续阻断非 ASR raw media 外发。
- `local_runtime_supervisor.py` / `local_runtime_ctl.py`：provider-aware，云端模式下本地 ASR down 不再阻塞 agent。
- `asr-providers.json` / schema：集中声明本地和云端 provider contract。
- `meeting-minutes.md`：会议纪要 prompt 强化粤语、普通话、英文夹杂场景，要求简体中文业务表达、保留关键原词、低置信进入待确认。

## 验证结果

- `python3 src/validate_workspace.py`：通过。
- Node/TS syntax check：核心 runner、runtime CLI、gateway、handler、DashScope client、policy/media/planner extension 通过。
- `python3 meeting-agent-pi-package/tools/local_ci_check.py`：无代码失败，仅剩 Swift SDK 环境 blocker。
- 真实百炼 smoke：`languageHints=["yue","zh","en"]` 完成转写，`transcriptSegments=2`，`failedChunks=0`。
- Runner dry-run：云端 ASR 优先路径完成，`rawMediaExternalUpload=true`，本机 ASR 未启动不再阻塞云端模式。

## 生产默认

推荐 `.env.local`：

```text
MEETING_ASR_PROVIDER=auto
MEETING_ASR_FALLBACK_PROVIDER=local_qwen3
ALIYUN_ASR_MODEL=paraformer-realtime-v2
ALIYUN_ASR_LANGUAGE_HINTS=yue,zh,en
```

说明：

- 有 `ALIYUN_DASHSCOPE_API_KEY` 时，`auto` 会优先云端 ASR。
- 没有云端 key 时，自动回落本机 Qwen3-ASR。
- ASR 失败时，飞书回复应区分鉴权、网络、模型、格式、超时、本机服务未启动和所有 provider 失败。

## 后续关注

- 用真实粤语会议样本持续维护热词和误识别纠错。
- 若某个百炼账号或模型版本拒绝 `yue` hint，可降级为 `zh,en`，但保留粤语优先 prompt 和 QA 策略。
- 长音频可继续评估 OSS/batch ASR，但当前生产链路已可直接 WebSocket 上传原始音频。
