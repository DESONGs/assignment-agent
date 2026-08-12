> 历史快照：本文是已归档计划，不代表当前架构。当前路线图见 `../00-plan.md`。

# 云端方言 ASR 会议纪要接入开发计划

日期：2026-06-12
状态：implemented

## Implementation Result

截至 2026-06-15 已完成本地/云端 ASR provider layer：

- 默认 `MEETING_ASR_PROVIDER=auto`：有百炼/DashScope API key 时优先 `aliyun_dashscope_paraformer`，否则回落 `local_qwen3`。
- 云端默认模型：`paraformer-realtime-v2`。
- 云端默认语言提示：`yue,zh,en`，用于粤语、普通话、英文夹杂会议。
- 已验证真实 DashScope WebSocket smoke：`languageHints=["yue","zh","en"]` 完成转写，`failedChunks=0`。
- 原始音频只允许 ASR provider 阶段上传；后续文档生成、QA、Docker、Hermes 和外部 LLM 只消费 transcript/evidence。
- 2026-08-12 起，录音文件与实时流拆为两个明确端口：
  - 文件：`paraformer-v2` + HTTP 异步任务 + 私有 OSS 短期签名 URL；保留云端支持的 17 种音视频容器。
  - 实时：`paraformer-realtime-v2` + WebSocket；仅使用官方实时编码矩阵和单声道输入。
- `ALIYUN_ASR_INPUT_MODE=auto` 只负责选路，不会把 `.m4a` 容器伪装为 `aac` 实时流；文件端不可用时才进入显式规范化重试。
- 文件端默认启用匿名说话人分离：`diarization_enabled=true`，可选 `speaker_count=2..100` 仅作为提示。能力要求单声道，源文件为双/多声道时只生成派生单声道上传，原文件不修改。
- 文件端 `speaker_id` 与 `channel_id` 会贯通 transcript/evidence/Source Context；实时端明确记录不支持该能力，不能由 system prompt 猜测补齐。
- 该能力是 speaker diarization，不是重叠语音 source separation；鸡尾酒会场景中的同声道同时发言仍属于 best-effort 证据。

## Summary

当前会议 Agent 的音频转文字链路默认依赖本机 Qwen3-ASR MLX HTTP 服务。这个选择保护了 raw audio 不外发，但在生产使用中带来三个稳定性问题：

- 本机 ASR 服务需要常驻，生命周期、Metal/MLX、转码和长音频处理容易成为阻塞点。
- 方言会议，尤其粤语、普通话、英文混合会议，当前本地模型的可靠性和可维护性不足。
- 用户已经希望会议 Agent 具备云端 ASR 能力，而不是每次受本机模型和服务状态影响。

本计划的目标不是直接删除本地 ASR，而是在现有 PI runtime 架构中新增一个受控的 Cloud ASR Provider。默认推荐使用阿里云百炼 DashScope `paraformer-realtime-v2`，原因是官方文档明确说明该模型适用于会议/直播实时语音识别，支持中文普通话和多种中文方言，包括粤语，并支持英文等多语种。

## Source Review

### VoiceInput.app 观察结论

`/Users/chenge/Desktop/VoiceInput.app` 是已编译 macOS app bundle，不是源码目录。通过只读二进制字符串分析，可以确认它内置了以下 ASR 路径：

- 本地 ASR：`libsherpa-onnx-c-api.dylib`、`libonnxruntime`、`sherpa-onnx-sense-voice-zh-en-ja-ko-yue`。
- 阿里云百炼/DashScope 远程 ASR：`DashScopeASREngine`、`DashScopeStreamingSession`、`wss://dashscope.aliyuncs.com/api-ws/v1/inference/`、`run-task`、`task-started`、`finish-task`、`result-generated`。
- 热词能力：`DashScopeVocabularyService`、`create_vocabulary`、`update_vocabulary`、`vocabulary_id`。
- UI/配置痕迹：`Aliyun Fun-ASR`、`Paste sk-... from Bailian console`、`dashscopeApiKey`、`dashscopeModel`、`dashscopeLanguageMode`。

可以借鉴的不是 app 代码本身，而是能力分层：

```text
ASREngine
  -> LocalASREngine
  -> DashScopeASREngine
  -> ElevenLabsASREngine
```

会议 Agent 应采用类似 provider abstraction，但必须落在 PI runtime 的 capability / policy / artifact contract 中。

### 官方文档调研

阿里云百炼官方文档中，当前可作为 P0 默认模型的是：

```text
paraformer-realtime-v2
```

选择依据：

- 官方标注为推荐使用的最新实时语音识别模型。
- 适用于视频直播、会议等实时场景。
- 支持任意采样率音频。
- 支持中文普通话和多种中文方言、英文、日语、韩语。
- 官方列出的中文方言包含粤语。
- 支持 `language_hints`，当前生产默认配置为 `['yue', 'zh', 'en']`，用于粤语、普通话、英文夹杂会议。
- 支持热词 `vocabulary_id`，适合项目名、人名、产品名、业务术语。

官方参考：

- Paraformer 实时语音识别 API：https://help.aliyun.com/zh/model-studio/developer-reference/paraformer-real-time-speech-recognition-api
- Python SDK 参数说明：https://help.aliyun.com/zh/model-studio/paraformer-real-time-speech-recognition-python-sdk
- WebSocket API：https://help.aliyun.com/zh/model-studio/websocket-for-paraformer-real-time-service

VoiceInput.app 中出现的 `fun-asr-realtime-2026-02-28`、`fun-asr-realtime`、`fun-asr-flash-8k-realtime` 可以作为 P1 候选，但本轮不把它们设为默认，因为当前公开官方文档中未稳定检索到这些模型的完整 API contract。后续应在百炼控制台和真实样本 QA 中做对照评估。

## Target Behavior

默认目标：

- 云端 ASR 默认 provider：`aliyun_dashscope_paraformer`。
- 默认模型：`paraformer-realtime-v2`。
- 默认语言提示：`yue,zh,en`。
- 默认方言目标：粤语优先，同时兼容普通话和英文术语。
- 本地 ASR 保留为 fallback/provider option，不再作为唯一生产路径。
- raw audio 只有在 cloud ASR provider 明确启用时允许上传到阿里云百炼，其他模型、Docker worker、Hermes、document worker 仍不得接触 raw audio。

用户体验目标：

- 飞书音频会议纪要不再因为本机 ASR 服务未启动而默认失败。
- 粤语会议能生成可读普通话会议纪要，并保留关键粤语表达、姓名、项目名和英文术语。
- 失败时能清晰说明是云端 ASR 鉴权、网络、服务端错误、音频格式、上传策略还是转写质量问题。

## Architecture

新增 ASR Provider Layer：

```text
audio acquisition
  -> audio validation / local normalize
  -> asr_provider_dispatch
       -> local_qwen3_asr
       -> aliyun_dashscope_paraformer
  -> transcript.full.json
  -> evidence-index.json
  -> source-context-runtime
  -> meeting-minutes / document workers
  -> QA / policy / publish
```

关键原则：

- Runner 只选择 provider 和编排阶段，不直接拼接 transcript 正文。
- ASR provider 产物必须统一成现有 transcript/evidence artifact contract。
- 云端 ASR 上传 raw audio 必须被 policy 和 run artifact 明确记录。
- Source Context 后续只消费 transcript segments，不接触 raw audio。

## Configuration Contract

建议新增环境变量：

```text
MEETING_ASR_PROVIDER=aliyun_dashscope_paraformer
MEETING_ASR_FALLBACK_PROVIDER=local_qwen3
MEETING_RAW_MEDIA_EXTERNAL_UPLOAD_DEFAULT=allow_for_cloud_asr

ALIYUN_DASHSCOPE_API_KEY=...
ALIYUN_DASHSCOPE_WORKSPACE_ID=...
ALIYUN_ASR_MODEL=paraformer-realtime-v2
ALIYUN_ASR_FILE_MODEL=paraformer-v2
ALIYUN_ASR_ENDPOINT=wss://dashscope.aliyuncs.com/api-ws/v1/inference
ALIYUN_ASR_FILE_ENDPOINT=https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription
ALIYUN_ASR_LANGUAGE_HINTS=yue,zh,en
ALIYUN_ASR_DIARIZATION_ENABLED=auto
ALIYUN_ASR_SPEAKER_COUNT=
ALIYUN_ASR_TIMESTAMP_ALIGNMENT_ENABLED=true
ALIYUN_ASR_VOCABULARY_ID=...
ALIYUN_ASR_REGION=cn-beijing
```

说明：

- `MEETING_RAW_MEDIA_EXTERNAL_UPLOAD_DEFAULT=allow_for_cloud_asr` 只允许 ASR stage 上传 raw audio，不允许后续 LLM/document worker 上传 raw media。
- `ALIYUN_DASHSCOPE_API_KEY` 不进入 wiki、run manifest、metrics、Hermes memory 或 Feishu 回复。
- `ALIYUN_DASHSCOPE_WORKSPACE_ID` 可选，对应 WebSocket 请求头 `X-DashScope-WorkSpace`。
- 当前已用真实 DashScope smoke 验证 `language_hints=['yue','zh','en']` 可完成转写；后续如某个账号或模型版本拒绝该 hints，应降级为 `zh,en`，但仍保留粤语优先的 prompt、热词和 QA 策略。

## Artifact Contract

云端 ASR 输出必须兼容当前本地 ASR 产物：

```text
artifacts/
  summary.json
  transcripts/transcript.full.json
  evidence/evidence-index.json
  evidence/sources.json
  asr/cloud-asr-run.json
  asr/cloud-asr-events.ndjson
```

`transcriptSegments` 字段保持现有结构，并增加云端 metadata：

```json
{
  "sourceFile": "...",
  "sourceHashSha256": "...",
  "chunkIndex": 0,
  "startSec": 0,
  "endSec": 12.4,
  "text": "...",
  "provider": "aliyun-dashscope",
  "model": "paraformer-realtime-v2",
  "endpoint": "dashscope-websocket",
  "languageHints": ["yue", "zh", "en"],
  "dialectPriority": ["yue", "mandarin"],
  "externalAudioUpload": true,
  "requestId": "..."
}
```

`summary.json` 增加：

```json
{
  "provider": "aliyun-dashscope",
  "model": "paraformer-realtime-v2",
  "externalAudioUpload": true,
  "rawMediaExternalUploadDefault": "allow_for_cloud_asr",
  "fallbackProvider": "local_qwen3",
  "failedChunks": 0
}
```

ASR cache key 必须包含：

```text
audioSha256 + normalizerVersion + provider + model + languageHints + vocabularyId
```

避免本地 ASR、云端 ASR、不同语言提示、不同热词之间互相污染。

## Code Changes

### Phase 1 - Provider Contract

新增：

```text
meeting-agent-pi-package/runtime/asr-providers.json
meeting-agent-pi-package/runtime/asr-providers.schema.json
```

示例：

```json
{
  "version": "asr-providers-v1",
  "defaultProvider": "aliyun_dashscope_paraformer",
  "providers": {
    "aliyun_dashscope_paraformer": {
      "providerType": "cloud",
      "capabilityId": "cloud-asr",
      "defaultModel": "paraformer-realtime-v2",
      "languageHints": ["yue", "zh", "en"],
      "dialectPriority": ["yue", "mandarin"],
      "rawMediaExternalUpload": true
    },
    "local_qwen3": {
      "providerType": "local",
      "capabilityId": "local-asr",
      "defaultModel": "mlx-community/Qwen3-ASR-1.7B-4bit",
      "rawMediaExternalUpload": false
    }
  }
}
```

### Phase 2 - DashScope Client

新增：

```text
meeting-agent-pi-package/tools/dashscope_asr_client.mjs
```

职责：

- 使用 `ws` WebSocket client，原因是 DashScope WebSocket 需要稳定设置 `Authorization` 和 workspace header。
- 建立 `wss://dashscope.aliyuncs.com/api-ws/v1/inference`。
- 请求头包含 `Authorization: Bearer <apiKey>`。
- 可选传 `X-DashScope-WorkSpace`。
- 发送 `run-task`，等待 `task-started`。
- 分块发送单声道音频 bytes。
- 发送 `finish-task`，等待 `task-finished`。
- 收集 `result-generated`，转成 `transcriptSegments`。
- 将所有非敏感事件写入 `cloud-asr-events.ndjson`。
- 不把 API key、Authorization header、完整 request body 写入 artifact。

### Phase 3 - Media Tool Extension

在 `media-tools.ts` 增加：

```text
meeting_transcribe_cloud_asr
```

参数：

- `paths`
- `meetingId`
- `outputDir`
- `provider`
- `model`
- `languageHints`
- `vocabularyId`
- `dialectPriority`
- `timeoutMs`

返回：

- `status=completed|blocked`
- `provider`
- `model`
- `externalAudioUpload=true`
- `transcriptPath`
- `evidenceIndexPath`
- `summaryPath`
- `failureClass`

### Phase 4 - Runner Dispatch

将 `task_execution_runner.mjs` 中的 `ensureLocalAsr()` 收敛为：

```text
ensureAsrTranscription()
  -> resolveAsrProvider()
  -> cache lookup
  -> provider preflight
  -> normalize audio
  -> provider transcribe
  -> artifact/cache write
```

阶段名调整：

- `asr_provider_resolved`
- `audio_normalized`
- `cloud_asr_started`
- `cloud_asr_completed`
- `local_asr_started`
- `local_asr_completed`

保留兼容：

- 已有 `local_asr_*` state 继续写。
- `summary.json`、`transcript.full.json`、`evidence-index.json` 不改路径。

### Phase 5 - Policy Gate

修改 `policy-gate.ts`：

- 默认继续阻断 raw media 外发。
- 当且仅当以下条件同时满足时允许：
  - `actionIntent=audio_transcription` 或 ASR stage。
  - `capabilityId=cloud-asr`。
  - `provider=aliyun_dashscope_paraformer`。
  - `rawMediaExternalUpload=true`。
  - `rawMediaExternalUploadDefault=allow_for_cloud_asr`。
- 任何后续 document worker / model provider / Docker worker / Hermes payload 仍不得包含 raw audio/base64 audio。

### Phase 6 - Capability Registry And Tool Manifest

新增 capability：

```json
{
  "capabilityId": "cloud-asr",
  "status": "available",
  "description": "Transcribes meeting audio through allowlisted cloud ASR providers with explicit raw media upload policy.",
  "defaultLoad": false,
  "toolPackage": "local-extension",
  "policy": [
    "raw media upload allowed only for ASR stage",
    "provider allowlist required",
    "credentials never written to artifacts"
  ],
  "optionalEnv": [
    "MEETING_ASR_PROVIDER",
    "ALIYUN_DASHSCOPE_API_KEY",
    "ALIYUN_DASHSCOPE_WORKSPACE_ID",
    "ALIYUN_ASR_MODEL",
    "ALIYUN_ASR_LANGUAGE_HINTS",
    "ALIYUN_ASR_VOCABULARY_ID"
  ]
}
```

`tool-load-manifest.json` 中 `audio_minutes` 继续加载 `media-tools.ts`，不让短任务加载 cloud ASR。

### Phase 7 - Meeting Minutes Prompt

会议纪要 prompt 增加方言-aware 要求：

- 输出默认使用简体中文业务书面语。
- 保留粤语中的专有表达、用户原话、产品名、人名和英文术语。
- 对疑似方言误识别的关键词，在纪要中使用“待确认”标注，而不是强行改写。
- 对 ASR low-confidence 或 chunk failure 的段落，在风险/待确认区列出。

## Failure Classes

新增错误分层：

| failureClass | 用户可见说明 |
|---|---|
| `cloud_asr_api_key_missing` | 未配置百炼 API Key |
| `cloud_asr_auth_failed` | 百炼鉴权失败或 key 无权限 |
| `cloud_asr_network_unreachable` | 无法连接百炼 ASR 服务 |
| `cloud_asr_provider_timeout` | 云端 ASR 超时 |
| `cloud_asr_model_unavailable` | 指定 ASR 模型不可用 |
| `cloud_asr_audio_format_rejected` | 云端 ASR 拒绝当前音频格式 |
| `cloud_asr_partial_result` | 部分音频转写失败 |
| `cloud_asr_quality_low` | 转写质量不足，需要人工确认 |
| `raw_media_external_upload_not_allowed` | 当前策略不允许上传原始音频 |

飞书回复必须说明具体原因，不再泛化为“本机 ASR 未启动”。

## QA Plan

### Static

- `python3 src/validate_workspace.py`
- `node --check meeting-agent-pi-package/tools/dashscope_asr_client.mjs`
- `node --check meeting-agent-pi-package/tools/task_execution_runner.mjs`
- `node --experimental-strip-types --check meeting-agent-pi-package/extensions/media-tools.ts`
- `node --experimental-strip-types --check meeting-agent-pi-package/extensions/policy-gate.ts`

### Fixture

- 无 `ALIYUN_DASHSCOPE_API_KEY`：返回 `cloud_asr_api_key_missing`，不进入 document worker。
- policy 未允许 raw media 外发：返回 `raw_media_external_upload_not_allowed`。
- 伪造 DashScope WebSocket：模拟 `task-started/result-generated/task-finished`，验证 transcript artifacts。
- cache 命中：不再次上传音频。
- fallback：云端鉴权失败不自动转本地；云端网络超时可根据配置 fallback 到本地。

### Live QA

准备三组真实样本：

1. 粤语为主会议，夹杂普通话。
2. 普通话为主会议，夹杂英文产品/技术术语。
3. 粤语、普通话、英文三者混合，含项目名、人名、数字和待办。

每组比较：

- 本地 Qwen3-ASR。
- 百炼 `paraformer-realtime-v2`。
- 如果控制台确认可用，再加 `fun-asr-realtime-*`。

评分维度：

- 粤语识别准确度。
- 英文术语保留。
- 人名/项目名/产品名准确度。
- 时间戳和分段稳定性。
- 会议纪要事实覆盖。
- 失败可解释性。
- 端到端耗时。
- 成本。

## Rollout

### Step 1 - Disabled By Default

先实现 cloud ASR provider，但默认仍使用 `local_qwen3`。

### Step 2 - Canary

只对指定 Feishu 群或指定用户启用：

```text
MEETING_ASR_PROVIDER=aliyun_dashscope_paraformer
MEETING_RAW_MEDIA_EXTERNAL_UPLOAD_DEFAULT=allow_for_cloud_asr
```

### Step 3 - Default For Audio Minutes

Live QA 达标后，将 `audio_minutes` 默认 ASR provider 改为 `aliyun_dashscope_paraformer`，本地 ASR 作为 fallback。

### Step 4 - Dialect Optimization

基于真实粤语会议样本维护：

- 项目热词。
- 常见人名。
- 产品/客户名。
- 粤语常见表达纠错词典。

热词通过百炼 vocabulary API 管理，不写死到 prompt。

## Acceptance Criteria

- 飞书音频会议纪要可在本机 ASR 服务关闭时，通过百炼 cloud ASR 完成。
- 默认模型明确为 `paraformer-realtime-v2`。
- 粤语为主、普通话和英文混合会议能生成可读会议纪要。
- transcript/evidence artifact 路径保持兼容。
- 文件转录可生成匿名说话人标签，并在下游纪要中保留分歧但不臆测身份。
- 实时转录不会宣称具备文件端说话人分离；需要最终纪要时允许在会后用文件端重跑。
- cloud ASR cache 与 local ASR cache 不互相污染。
- raw audio 上传只发生在 ASR stage，并写入可审计 artifact。
- API key 不出现在 run artifact、metrics、wiki、Hermes memory 或飞书回复。
- 后续 document worker、QA、publish 只接收 transcript/evidence，不接收 raw audio。
- 失败回复能区分鉴权、网络、模型、格式、策略和低质量问题。

## Non-Goals

- 不把 raw audio 交给外部 LLM。
- 不让 Docker worker 处理 raw audio。
- 不把百炼 API key 放入 Feishu、wiki、runtime store metadata 或 Hermes。
- 不在 P0 引入向量库或新后台 daemon。
- 不在没有官方 contract 的情况下把 `fun-asr-realtime-*` 设为默认。

## Open Questions

- 当前百炼账号是否已开通 `paraformer-realtime-v2`，以及是否需要业务空间 ID。
- 粤语样本是否需要输出粤语原文、普通话转写，还是普通话纪要 + 原话引用。
- 是否启用临时鉴权 Token 替代长期 API Key。
- 是否需要按群组或项目配置不同 vocabulary。
- `fun-asr-realtime-*` 在当前百炼控制台是否可见、是否比 Paraformer v2 对粤语更优。
