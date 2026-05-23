# 本地数据存储与缓存后端方案

更新时间：2026-05-22

本文基于当前代码状态设计本地数据存储与缓存后端。目标是治理 Feishu 附件下载、本地 ASR、文档 worker、Docker 常驻 worker 和 Hermes proposal 产生的大量本地文件，同时保持现有 `runtime-runs/` artifact contract、Feishu 安全边界和 profile-based runtime 不被重写。

## 1. 当前代码事实

当前实现已经进入本地 artifact 密集阶段：

- `feishu_agent_task_handler.mjs` 是 Host 入口和出口，负责 Feishu event、附件解析、附件下载、file-context、task/state/metrics/manifest、publish/reply。
- `task_execution_runner.mjs` 按 `executionProfile` 执行，短任务走轻路径，音频会议纪要走 Host audio normalize + local ASR，长文档 profile 走 evidence pack、prompt registry、document worker、QA/Policy。
- `local_docker_runtime_queue.mjs` 已落地本地 Redis queue dispatch。只有 `document_generation` 和 `multi_source_synthesis` 可入 Docker；`requiresLocalAsr=true`、`document_revision` 和 review-context 需求均不可入 Docker。
- `local_docker_document_worker.mjs` 消费 bounded job bundle，在 Docker 受限执行面调用同一个 `runTaskExecutionPipeline`，只写 `agent-output.json` 和 runtime artifacts，不调用 `lark-cli`、不 publish、不 reply。
- `docker-compose.local-runtime.yml` 已定义 `runtime-queue`、`pi-document-worker`、`hermes-worker`。Redis 使用 `--save "" --appendonly no`，因此是临时队列，不是长期存储。
- `hermes_queue_worker.py` 消费 sanitized trajectory job，运行 `sidecar.py`，强制 `HERMES_WIKI_AUTO_PUBLISH=0`，输出 proposal artifact。
- `context-offload.ts`、`office-runtime.ts` 已经确立 pointer-only 方向：主上下文只保留 artifact pointer、hash、bounded preview、sourceRun 和 summary。

本地现状也说明需要治理：`runtime-runs/` 已达到 GB 级，其中大头是 Feishu run 里的原始 WAV、normalized WAV、PDF 和重复 runtime result。ASR cache 以 hash key 存在，附件 recent cache 是 30 分钟 JSON 文件，Docker queue result TTL 只有 Redis 级别。2026-05-22 迭代后，长期治理以 Host-owned SQLite `retention_policies` 为准，文件本体通过 CAS/hardlink 去重，清理同时执行 TTL 和 per-kind LRU 容量策略。

## 2. 核心结论

采用 **Filesystem artifact store + Host-owned SQLite metadata index + retention sweeper + Redis ephemeral queue**。

不建议现在上 Postgres、MinIO/S3、向量数据库或 Go 常驻服务：

- 本项目是本机优先，数据和凭证边界都在本机。远端数据库会扩大隐私和运维面。
- 当前主执行面是 Node ESM，ASR 是 Python/MLX，Docker worker 也是 Node/Python。用 Go 重写会新增构建、发布和跨语言接口复杂度。
- SQLite 足够支撑本机 run/artifact/job/cache metadata 查询。高并发写不是当前瓶颈。
- Docker Desktop bind mount 上的 SQLite 多进程写入有锁语义和性能风险。因此 SQLite 必须由 Host 控制面拥有，Docker worker 不直接写 DB。

Go 的合适时机：

- 需要独立后台 daemon，长期 watch 多个 workspace。
- 需要跨进程 API、实时 fsnotify、限额调度和清理服务。
- 需要把存储后端从本项目抽成通用本地平台服务。

本轮不需要。

## 3. 总体架构

```text
Host Feishu control plane
  -> event / attachment / task / publish / reply
  -> Local Artifact Store
       - compatibility run dirs: runtime-runs/{channel}/runs/{runId}
       - content-addressed objects: runtime-runs/_store/objects/sha256/...
       - cache artifacts: runtime-runs/_store/cache/...
  -> Host-owned SQLite metadata
       - runs / artifacts / sources / cache / jobs / retention
  -> Redis ephemeral queues
       - pi:document-worker:jobs
       - pi:hermes-worker:jobs
  -> Local Docker bounded execution plane
       - document worker writes artifacts only
       - Hermes worker writes proposal artifacts only
  -> Host post-run indexer and retention sweeper
```

关键边界：

- Host 才能使用 `lark-cli`、macOS keychain、Feishu 下载、Feishu 发布、Feishu reply、本机 MLX ASR。
- Docker worker 只能读 bounded task、file-context preview、extracted text pointer、evidence/transcript pointer；不能接收 raw audio/video、Feishu token、CLI session、cookie、App Secret。
- Redis 只做临时 queue/result notification，不做长期 metadata、cache index 或 artifact registry。
- SQLite 只存 metadata、hash、路径、bounded preview、状态和 TTL，不存完整原始正文、完整 transcript、raw audio/video 或 credential。
- 文件本体仍在 filesystem；大文件不进 SQLite。

## 4. 目录布局

保留现有 run 目录作为兼容视图：

```text
runtime-runs/
  feishu-agent/
    .feishu-attachment-cache.json        # 现有 recent cache，短期保留
    asr-cache/                           # 现有 ASR cache，迁移期保留
    runs/{runId}/
      event.json
      source-events.ndjson
      task.json
      state.json
      run.metrics.json
      run-manifest.json
      sanitized-trajectory.json
      inputs/
      artifacts/
      runtime-tool-params/
      runtime-tool-results/
      agent-output.json
      publish.json
      reply.json

  _store/
    runtime-store.sqlite                 # Host-owned metadata DB
    runtime-store.sqlite-wal
    objects/
      sha256/aa/bb/{sha256}[.ext]         # immutable content-addressed blobs
    cache/
      asr/{cacheKey}/
      file-text/{sourceHash}-{extractorVersion}/
      docker-jobs/{jobId}/
      hermes/{jobId}/
    tmp/
    retention/
      retention-report-YYYYMMDD.json
```

兼容策略：

- 现有代码仍可使用 `runtime-runs/feishu-agent/runs/{runId}/...`。
- 新存储层在写入大文件后计算 SHA-256，并将内容放入 `_store/objects/sha256/...`。
- run 目录下保留 hardlink 或 symlink，保证现有 `localPath`、ASR 和 file-context helper 不需要一次性改写。
- 如果 hardlink 不可用，退回 copy，并在 SQLite 记录 `linkMode=copy`，由 retention sweeper 后续清理重复副本。
- Docker worker 可以通过 bind mount 读取 run 目录和 `_store/objects`，但不直接写 SQLite。

## 5. 数据分级

| Class | 内容 | 存储方式 | 默认外发 | 默认保留 |
| --- | --- | --- | --- | --- |
| `secret` | Feishu App Secret、token、Authorization、cookie、CLI session、模型 API key | 不入库、不入 artifact | 禁止 | 0 |
| `raw_media` | 用户上传录音、视频、图片原文件 | CAS + run link | 禁止 | 45 天 / 12GB |
| `normalized_audio` | `16k mono s16 WAV` | CAS + run link | 禁止 | 7 天 / 2GB |
| `raw_document_file` | PDF、docx、xlsx、md、txt 等原始附件 | CAS + run link | 文本类按任务允许 | 60 天 / 5GB |
| `extracted_text` | file-context 抽取文本 | cache artifact + bounded preview metadata | 按任务允许 | 30 天 / 2GB |
| `transcript_evidence` | ASR transcript、evidence index | ASR cache artifact + pointer | 文本可按任务给模型 | 60 天 / 2GB |
| `bounded_docker_bundle` | Docker bounded task/job | run artifact | 只给 Docker | 7 天 |
| `generated_document` | 会议纪要、PRD、架构、Checklist | run artifact + publish record | 可发布 | 90 天 / 1GB |
| `observability` | state、metrics、manifest、model-route、QA/Policy | run artifact + SQLite metadata | 不直接给用户 | 60 天 / 512MB |
| `sanitized_learning` | sanitized trajectory、Hermes proposal | artifact + metadata | Hermes only | 180 天 |

任何长期 profile/memory 写入必须通过 Policy Gate。本文只处理 artifact/cache 后端，不把会议原文或附件正文自动变成长期记忆。

## 6. SQLite 元数据表

SQLite 由 Host 控制面读写。Docker worker、Hermes worker 不直接写 DB；它们只写 artifact 和 Redis result，Host 在 worker 完成后做 post-run indexing。

推荐 DB 初始化：

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

### 6.1 runs

```sql
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  execution_profile TEXT,
  task_type TEXT,
  status TEXT NOT NULL,
  source_event_hash TEXT,
  run_dir TEXT NOT NULL,
  manifest_path TEXT,
  metrics_path TEXT,
  trajectory_path TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  total_bytes INTEGER DEFAULT 0,
  retention_class TEXT NOT NULL DEFAULT 'standard',
  expires_at TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);
```

### 6.2 artifacts

```sql
CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT,
  kind TEXT NOT NULL,
  privacy_class TEXT NOT NULL,
  path TEXT NOT NULL,
  object_path TEXT,
  sha256 TEXT,
  size_bytes INTEGER DEFAULT 0,
  mime_type TEXT,
  extension TEXT,
  link_mode TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  bounded_preview TEXT,
  source_run_id TEXT,
  created_at TEXT NOT NULL,
  last_accessed_at TEXT,
  expires_at TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);

CREATE INDEX idx_artifacts_run ON artifacts(run_id);
CREATE INDEX idx_artifacts_sha ON artifacts(sha256);
CREATE INDEX idx_artifacts_kind_expiry ON artifacts(kind, expires_at);
```

规则：

- `bounded_preview` 最多保存 900-1200 字符，且必须经过 secret scan。
- `path` 和 `object_path` 都必须在 workspace 内。
- `privacy_class=secret` 的记录不允许写入。

### 6.3 source_refs

```sql
CREATE TABLE source_refs (
  source_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  channel TEXT NOT NULL,
  message_id_hash TEXT,
  chat_id_hash TEXT,
  thread_id_hash TEXT,
  file_name TEXT,
  mime_type TEXT,
  source_sha256 TEXT,
  artifact_id TEXT,
  resolved_from TEXT,
  explicit_reference INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(run_id),
  FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id)
);
```

`message_id_hash/chat_id_hash/thread_id_hash` 只用于定位和审计，不保存 raw open id、tenant id 或 token。

### 6.4 recent_sources

```sql
CREATE TABLE recent_sources (
  recent_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  chat_id_hash TEXT NOT NULL,
  sender_id_hash TEXT NOT NULL,
  thread_key_hash TEXT,
  source_kind TEXT NOT NULL,
  source_id TEXT,
  artifact_id TEXT,
  message_time_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id)
);
```

迁移期继续写 `.feishu-attachment-cache.json` 兼容旧读取逻辑。后续 handler 可改为优先查 `recent_sources`，再回退 JSON。

### 6.5 file_text_cache

```sql
CREATE TABLE file_text_cache (
  cache_key TEXT PRIMARY KEY,
  source_sha256 TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  method TEXT,
  status TEXT NOT NULL,
  extracted_artifact_id TEXT,
  preview_hash TEXT,
  chars INTEGER DEFAULT 0,
  hit_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  last_hit_at TEXT,
  expires_at TEXT,
  FOREIGN KEY (extracted_artifact_id) REFERENCES artifacts(artifact_id)
);
```

cache key：

```text
sha256(source file) + extractorVersion + file extension + extraction method
```

### 6.6 asr_cache

```sql
CREATE TABLE asr_cache (
  cache_key TEXT PRIMARY KEY,
  source_set_hash TEXT NOT NULL,
  normalizer_version TEXT NOT NULL,
  target_spec_hash TEXT NOT NULL,
  model_id TEXT NOT NULL,
  chunk_seconds INTEGER NOT NULL,
  language TEXT,
  status TEXT NOT NULL,
  transcript_artifact_id TEXT,
  evidence_artifact_id TEXT,
  summary_artifact_id TEXT,
  hit_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  last_hit_at TEXT,
  expires_at TEXT,
  FOREIGN KEY (transcript_artifact_id) REFERENCES artifacts(artifact_id),
  FOREIGN KEY (evidence_artifact_id) REFERENCES artifacts(artifact_id),
  FOREIGN KEY (summary_artifact_id) REFERENCES artifacts(artifact_id)
);
```

cache key 必须覆盖：

- source audio SHA-256、extension、size。
- `audio-normalize-v1` 和 target spec。
- ASR model dir / model id。
- chunk seconds、language、prompt context 版本。

现有 `runtime-runs/feishu-agent/asr-cache/{cacheKey}` 先保留，SQLite 作为可查询索引和 TTL 管理来源。

### 6.7 worker_jobs

```sql
CREATE TABLE worker_jobs (
  job_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  worker_kind TEXT NOT NULL,
  execution_profile TEXT,
  queue_name TEXT,
  result_key TEXT,
  status TEXT NOT NULL,
  attempts INTEGER DEFAULT 0,
  worker_id TEXT,
  job_artifact_id TEXT,
  result_artifact_id TEXT,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  retry_later INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(run_id),
  FOREIGN KEY (job_artifact_id) REFERENCES artifacts(artifact_id),
  FOREIGN KEY (result_artifact_id) REFERENCES artifacts(artifact_id)
);
```

这张表是 Redis queue 的持久 ledger，不替代 Redis queue。

### 6.8 publish_records

```sql
CREATE TABLE publish_records (
  publish_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  document_artifact_id TEXT,
  target_kind TEXT NOT NULL,
  target_pointer_hash TEXT,
  status TEXT NOT NULL,
  publish_artifact_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(run_id),
  FOREIGN KEY (document_artifact_id) REFERENCES artifacts(artifact_id),
  FOREIGN KEY (publish_artifact_id) REFERENCES artifacts(artifact_id)
);
```

`target_pointer_hash` 只保存 token/url 的 hash 或 redacted pointer，不保存 Feishu token。

### 6.9 retention_policies / retention_actions

```sql
CREATE TABLE retention_policies (
  policy_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  privacy_class TEXT NOT NULL,
  ttl_seconds INTEGER,
  max_bytes INTEGER,
  delete_order INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE retention_actions (
  action_id TEXT PRIMARY KEY,
  artifact_id TEXT,
  run_id TEXT,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  bytes_reclaimed INTEGER DEFAULT 0,
  status TEXT NOT NULL,
  executed_at TEXT NOT NULL,
  error TEXT,
  FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);
```

## 7. 默认保留策略

2026-05-22 起，本地 runtime 数据采用三档生命周期，而不是单一保留期：

- 热数据：7-14 天。用于近期重试、问题诊断和 worker 续跑，过期后优先删除。
- 工作复用数据：30-60 天。用于一个月以上的会议追溯、跨会议文档复用和反复修订。
- 长期轻量数据：90-180 天。只保留轻量交付副本、运行账本和已脱敏学习结果。

| Kind | 人话解释 | TTL | LRU 容量上限 | 清理优先级 | 说明 |
| --- | --- | --- | --- | --- | --- |
| Redis result key | worker 结果通知 key | 1 小时 | Redis 自身 | Redis 自身 | 已由 Docker/Hermes worker `EXPIRE` 控制 |
| recent source cache | 最近附件指针 | 30 分钟 | 无 | 最高 | 只用于短窗口复用 |
| normalized audio | ASR 转码后的 16k 单声道 WAV | 7 天 | 2 GB | 最高 | 可从原始音频重新生成，短期保留用于重试 |
| Docker bounded task/job bundle | 给 Docker worker 的受限任务包 | 7 天 | 1 GB | 高 | 不含 raw media 和凭证，只服务近期重试 |
| Docker worker artifact | Docker worker 输出的中间 artifact | 7 天 | 1 GB | 高 | Host publish/reply 后长期价值低 |
| runtime-tool params/results | runtime tool 输入输出 JSON | 14 天 | 1 GB | 高 | 多数是调试链路，不长期保留 |
| model stream trace | LLM 流式响应、attempt、partial 和超时诊断 | 14 天 | 1 GB | 高 | live QA 和故障复盘主要看近期 |
| Hermes artifact | Hermes 原始/中间复盘 artifact | 30 天 | 512 MB | 中高 | 未必完全脱敏，不应按长期知识保存 |
| extracted text | PDF/docx/xlsx 等抽取出的纯文本缓存 | 30 天 | 2 GB | 中 | 可从原始文档重抽，但保留一个月减少重复抽取 |
| raw media | 飞书下载的原始音频/视频/图片 | 45 天 | 12 GB | 中 | 原始会议音频是最终追溯来源，保留比转码音频久 |
| raw document file | 用户上传的 PDF/docx/xlsx/pptx/md/txt | 60 天 | 5 GB | 中低 | 原始文档不在一个月内删除，支持反复修订和重抽取 |
| ASR transcript/evidence | transcript、evidence pack、summary | 60 天 | 2 GB | 中低 | 文档生成和跨会议复用比 normalized audio 更重要 |
| state/metrics/manifest/model-route/QA/Policy | 运行账本和轻量观测文件 | 60 天 | 512 MB | 低 | 保留运行历史，但不按 180 天无限堆积 |
| generated documents | 生成的 Markdown 文档副本 | 90 天 | 1 GB | 低 | 本地交付副本；长期正式版本应在 Feishu/wiki |
| sanitized trajectory/Hermes proposal | 已脱敏、人工可审查的学习结果 | 180 天 | 512 MB | 最低 | 只保留抽象规则，不保留 raw content |
| pinned artifact/run | 被显式 pin 的 run 或 artifact | 不自动删除 | 不参与 LRU | 禁止 | 用户或系统显式 pin |

`cleanup` 的执行顺序：

1. 先删除已过期、未 pinned、已索引、workspace 内的 artifact。
2. 再按 `retention_policies.max_bytes` 检查每类数据的有效占用。
3. 超出容量时按 `pinned=false`、`delete_order`、`last_accessed_at`、`size_bytes` 做 LRU 清理。
4. 每次删除都写入 `retention_actions`，并生成 `retention-report-YYYYMMDD.json`。

注意：`scan/index-run` 计算 artifact `expires_at` 时以文件 mtime 为生命周期基线，避免每次扫描都给历史文件续期。

## 8. 写入流程

### 8.1 Feishu 附件下载

```text
handler receives event
  -> register run
  -> download attachment to run tmp path
  -> sha256 + size + mime detection
  -> put object into runtime-runs/_store/objects/sha256/...
  -> hardlink/symlink/copy to run inputs/attachments for compatibility
  -> insert artifacts + source_refs + recent_sources
  -> build file-context
```

现有 `downloadAttachments` 仍可先写 run 目录；第一阶段用 post-run indexer 扫描并登记。第二阶段再把写入点改成 store-first。

### 8.2 File context 抽取

```text
file-context helper computes source sha
  -> lookup file_text_cache
  -> cache hit: link extracted text into current run
  -> cache miss: extract text, write cache artifact, register file_text_cache
  -> current run gets bounded preview + extractedTextPath
```

短任务 `file_summary` 仍只读 bounded preview/extracted slices，不进入 document worker。

### 8.3 音频 normalize + ASR

```text
Host audio source only
  -> normalize into run artifacts/audio-normalized
  -> register normalized_audio artifact with short TTL
  -> compute ASR cache key
  -> cache hit: link/copy transcript/evidence/summary into current run
  -> cache miss: call local ASR HTTP service
  -> register transcript/evidence/summary artifacts + asr_cache row
```

raw audio 不进 Docker。后续如果 `audio_minutes` 的文档生成阶段要进 Docker，只能传 transcript/evidence pointer 或 bounded evidence pack。

### 8.4 Docker document worker

```text
Host handler
  -> checks eligible profile
  -> writes artifacts/docker-worker/task.json + job.json
  -> inserts worker_jobs queued
  -> RPUSH Redis

Docker worker
  -> BLPOP Redis
  -> reads bounded task from shared workspace
  -> writes state steps + agent-output.json + runtime artifacts
  -> RPUSH result key + EXPIRE

Host handler
  -> BLPOP result key
  -> reads agent-output.json
  -> indexes new artifacts and updates worker_jobs completed/blocked
  -> continues publish/reply
```

Docker worker 不直接写 SQLite，避免 Docker Desktop bind mount 上 SQLite 并发写入风险。

### 8.5 Hermes worker

```text
Host or scheduler
  -> enqueue hermes-local-queue-job-v1 with runDirRelative

Hermes Docker worker
  -> reads sanitized-trajectory.json or run artifact summary
  -> runs sidecar.py with HERMES_WIKI_AUTO_PUBLISH=0
  -> writes artifacts/hermes-docker/*
  -> RPUSH result key + EXPIRE

Host post-indexer
  -> registers hermes proposal artifacts
```

Hermes 只读取 sanitized trajectory，不读取 Feishu/Rokid credentials，不写用户交付 Wiki。

## 9. 读取与查询

第一阶段只需要 CLI 查询，不需要 Web UI：

```text
runtime_store scan --root runtime-runs --db runtime-runs/_store/runtime-store.sqlite
runtime_store status --db runtime-runs/_store/runtime-store.sqlite
runtime_store find --run-id <runId>
runtime_store find --sha256 <sha>
runtime_store cleanup --dry-run
runtime_store cleanup --execute
runtime_store pin --run-id <runId>
runtime_store unpin --artifact-id <artifactId>
```

查询默认只返回：

- run/task/profile/status。
- artifact kind/path/hash/size/TTL。
- bounded preview。
- source pointer hash。
- publish status。
- sanitized error。

不返回 raw audio/video、完整 transcript、完整文件正文或 token。

## 10. 技术选型

推荐实现：

- Host metadata CLI：Python `sqlite3` 标准库优先，文件名建议 `meeting-agent-pi-package/tools/runtime_store_cli.py`。
- Node integration：先通过 child process 调用 runtime store CLI，后续再封装 `runtime_store_helpers.mjs`。
- SQLite DB：`runtime-runs/_store/runtime-store.sqlite`。
- Redis：继续只作为 local Docker queue。
- Filesystem CAS：纯本地目录，无 MinIO/S3。
- FTS：后续可启用 SQLite FTS5，但只索引 `summary`、`boundedPreview`、tag 和 doc title，不索引 raw transcript/full file。

不建议现在用 Go：

- 当前没有跨项目服务化需求。
- SQLite Host-owned 单写即可。
- Go 会让 Node handler、Python ASR/Hermes、Docker worker 之间多一层运行时。

如果未来要升级为 daemon，可用 Go 实现：

- `runtime-store-daemon` 提供 localhost HTTP/Unix socket API。
- Docker worker 通过 API 请求 Host 注册 artifact，而不是直接写 DB。
- daemon 负责 fsnotify、quota、pin、cleanup 和 metrics。

## 11. 实施顺序

### Phase 1：只读扫描与治理报告

- 新增 `runtime_store_cli.py scan/status/cleanup --dry-run`。
- 扫描现有 `runtime-runs/feishu-agent/runs`、`asr-cache`、Docker/Hermes artifact。
- 建立 SQLite schema。
- 生成 `retention-report-YYYYMMDD.json`，列出大文件、重复 SHA、过期候选、可回收空间。
- 不改 handler 写入逻辑。

验收：

- 能正确识别当前重复 WAV、normalized audio、PDF、transcript、runtime-tool-results。
- `cleanup --dry-run` 不删除文件，只写报告。

### Phase 2：Host post-run indexer

- 在 handler 完成 run 后调用 `runtime_store_cli.py index-run --run-dir ...`。
- Docker worker 完成后由 Host 索引 Docker 产物。
- Hermes worker 完成后由 Host 索引 Hermes 产物。
- 写入 `runs/artifacts/source_refs/worker_jobs/publish_records`。

验收：

- `fast_answer/file_summary` 也有 run metadata，但没有长链路 artifact 噪声。
- Docker worker job 能在 `worker_jobs` 查到 queued/completed/blocked。

### Phase 3：ASR 和 file-context cache ledger

- 将现有 ASR cache key 写入 `asr_cache`。
- 将 extracted text 写入 `file_text_cache`。
- cache hit 更新 `hit_count/last_hit_at`。
- 保留现有路径兼容。

验收：

- 同一音频二次提交命中 ASR cache，不重跑 ASR。
- 同一文件二次总结命中文本抽取 cache，不重复大文件抽取。

### Phase 4：CAS 去重

- 新增 `put-object` 能力：hash、move/copy、hardlink/symlink current run path。
- 大文件优先 CAS：raw media、normalized audio、PDF/docx/xlsx、extracted text。
- 对历史重复对象提供 `dedupe --dry-run` 和 `dedupe --execute`。

验收：

- 重复 WAV 不再在每个 run 内完整复制。
- 删除某个 run link 不影响 pinned object。

### Phase 5：Retention sweeper

- 新增 `cleanup --execute`，按 TTL、quota、pin 和 LRU 删除。
- 删除前写 `retention_actions`。
- 删除后更新 `deleted_at/status`。
- 默认只清理 `runtime-runs/_store` 和已索引 run artifact，不能越界。

验收：

- raw media 和 normalized audio 可按 TTL 清理。
- generated documents、manifest、sanitized trajectory 在默认期内保留。
- pinned run/artifact 不删除。

## 12. 实施状态

已完成 Phase 1-5 的本地实现，并在 2026-05-22 增加三档生命周期 + per-kind quota LRU。当前采用混合 CAS + Host-owned SQLite + Redis ephemeral queue：

- 新增 Host-owned store CLI：`meeting-agent-pi-package/tools/runtime_store_cli.py`，支持 `init`、`scan`、`status`、`find`、`index-run`、`put-object`、`dedupe`、`cleanup`、`pin`、`unpin`。
- SQLite 默认路径为 `runtime-runs/_store/runtime-store.sqlite`，初始化启用 WAL、foreign keys、busy timeout，并创建 `runs/artifacts/source_refs/recent_sources/file_text_cache/asr_cache/worker_jobs/publish_records/retention_policies/retention_actions`。
- CAS 路径为 `runtime-runs/_store/objects/sha256/aa/bb/<sha256>[.ext]`。大文件和可缓存产物可进入 CAS；小型 JSON/state/metrics/manifest 继续保留在 run 目录。
- `feishu_agent_task_handler.mjs` 在 run learning artifacts 写完之后调用 `runtime_store_cli.py index-run --run-dir ... --cas`，并把结果写入 `runtime-store-index.json`。失败只影响治理可观测性，不阻断 Feishu reply/publish。
- Docker document worker 和 Hermes worker 仍不直接写 SQLite；Host post-run indexer 负责登记 bounded worker job/result、ASR cache、file text cache、publish record 和 runtime artifacts。
- `dedupe --execute` 和 `cleanup --execute` 已具备真实执行能力；cleanup 采用三档生命周期 + per-kind quota LRU，只作用于 workspace 内、已索引、未 pinned 的 runtime artifact，并写 `retention_actions` 与 `retention-report-YYYYMMDD.json`。
- `status` 会报告 `quotaOverages`；`cleanup --dry-run` 会分别报告 `ttlCandidateCount`、`quotaCandidateCount`、`ttlBytes`、`quotaBytes`。
- `index-run`/`scan` 按文件 mtime 计算 `expires_at`，避免扫描历史 run 时把旧 artifact 重新续期。

2026-05-22 本地 scan/status + dedupe 结果：

- indexed runs：102
- indexed artifacts：2616
- indexed logical bytes：约 2.12GB
- runtime-runs 实际磁盘占用：约 557MB
- `_store/objects` 实际磁盘占用：约 494MB
- raw media logical bytes：约 1.58GB
- normalized audio logical bytes：约 414MB
- `dedupe --execute` 已将重复 artifact hardlink 到 CAS，runtime-runs 实际磁盘占用从约 914MB 降到约 557MB。
- cleanup dry-run 当前 TTL 过期候选：0
- cleanup dry-run 当前 quota overage：0
- `status` 额外报告 `orphanCasObjects/orphanCasBytes` 和 `quotaOverages`，用于识别未被 SQLite artifact 引用的 CAS 对象与 LRU 容量超限；真实删除仍需显式执行清理命令并遵守 workspace-bound / indexed-safe / pinned-safe 边界。

## 13. 验证计划

基础静态检查：

```bash
python3 src/validate_workspace.py
python3 -m py_compile meeting-agent-pi-package/tools/runtime_store_cli.py
node --check meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs
node --check meeting-agent-pi-package/tools/task_execution_runner.mjs
node --check meeting-agent-pi-package/tools/local_docker_runtime_queue.mjs
node --check meeting-agent-pi-package/tools/local_docker_document_worker.mjs
python3 -m py_compile hermes-learning-sidecar/hermes_queue_worker.py
```

新增存储检查：

```bash
python3 meeting-agent-pi-package/tools/runtime_store_cli.py init
python3 meeting-agent-pi-package/tools/runtime_store_cli.py scan --root runtime-runs
python3 meeting-agent-pi-package/tools/runtime_store_cli.py status
python3 meeting-agent-pi-package/tools/runtime_store_cli.py find --run-id <runId>
python3 meeting-agent-pi-package/tools/runtime_store_cli.py dedupe --dry-run
python3 meeting-agent-pi-package/tools/runtime_store_cli.py cleanup --dry-run
```

日常使用建议：

```bash
# 1. 查看当前 indexed artifact、CAS、过期候选和 quota overage
python3 meeting-agent-pi-package/tools/runtime_store_cli.py status

# 2. 刷新历史 run 索引；只更新 metadata，不删除文件
python3 meeting-agent-pi-package/tools/runtime_store_cli.py scan --root runtime-runs

# 3. 查看重复文件可去重空间；不会删除文件
python3 meeting-agent-pi-package/tools/runtime_store_cli.py dedupe --dry-run

# 4. 执行 CAS 去重；保留 run 目录兼容路径，优先 hardlink
python3 meeting-agent-pi-package/tools/runtime_store_cli.py dedupe --execute

# 5. 查看 TTL + LRU 清理候选；不会删除文件
python3 meeting-agent-pi-package/tools/runtime_store_cli.py cleanup --dry-run

# 6. 执行清理；只处理已索引、workspace 内、未 pinned 的 runtime artifact
python3 meeting-agent-pi-package/tools/runtime_store_cli.py cleanup --execute

# 7. 保护重要 run 或 artifact，避免 TTL/LRU 自动清理
python3 meeting-agent-pi-package/tools/runtime_store_cli.py pin --run-id <runId>
python3 meeting-agent-pi-package/tools/runtime_store_cli.py pin --artifact-id <artifactId>
```

结果解读：

- `activeBytes` 是 SQLite indexed artifact 的逻辑大小；CAS/hardlink 后它可能大于磁盘实际占用。
- `casBytes` 是 `_store/objects` 的实际对象大小。
- `quotaOverages=[]` 表示当前没有类型超过 LRU 容量上限。
- `ttlCandidateCount` 是 TTL 到期候选数；`quotaCandidateCount` 是容量超限后 LRU 候选数。
- `cleanup --execute` 不会触碰源码、wiki、models、`.env*`、未索引外部路径、pinned run 或 pinned artifact。

行为回归：

- 普通问答：只登记 run/state/reply，不生成 raw media/cache 记录。
- 文件一句话总结：登记 source/file-context，短 TTL，不进入 Docker。
- 音频会议纪要：Host 完成 raw audio、normalized audio、ASR cache 登记；raw audio 不进 Docker。
- PRD/架构/checklist：启用 Docker 后登记 worker job，Docker 写回 artifact，Host 索引并发布。
- 文档修订：Host 读取 Feishu comment/review-context，不进入 Docker。
- Redis 不可用：worker job 标记 blocked/retryLater，不自动回退 Host 长链路。
- cleanup dry-run：列出可删对象，不删除。
- cleanup execute：先删除过期且未 pinned 的已索引 runtime artifact；若某类数据超过 `max_bytes`，再按 LRU 清理最旧且未 pinned 的已索引 artifact；不触碰源码、wiki、models、外部目录。

## 14. 开放问题

- 是否需要用户级 UI 来 pin/unpin 某个 run 或项目。
- 客户项目级 retention 是否需要独立配置，例如敏感客户 7 天、内部项目 30 天。
- 是否需要对 published Feishu document 做更长期的 local metadata retention。
- 是否需要为 `runtime-runs/_store` 做本地加密卷或 macOS 文件权限收紧。
- 如果后续 WeChat live 接入，是否共用同一个 `_store`，还是按 channel 分库。
- 是否需要项目级或会话级 pin 策略，例如同一客户、同一会议系列、同一 PRD 关联的一组 run 一起保护。
- 是否需要为 raw media 单独增加“已生成 transcript 后降级保留”的策略：原始音频保留 45 天，但在磁盘压力较高时优先保留 transcript/evidence 与已发布文档。

## 15. 当前推荐决策

后续推荐进入小步优化：

1. 保持 Host-owned SQLite，不让 Docker worker 写 DB。
2. 保持三档生命周期：热数据 7-14 天、工作复用数据 30-60 天、长期轻量数据 90-180 天。
3. 定期先跑 `dedupe --dry-run` 和 `cleanup --dry-run`，确认候选后再执行。
4. `cleanup` 同时使用 TTL 和 LRU；容量压力优先释放 normalized audio、runtime tool artifact、model stream trace、Docker/Hermes 中间物。
5. 原始文档默认不在 60 天内删除；原始音频默认保留 45 天，避免频繁重新下载和重新 ASR。
6. 观察 1-2 天新 run 的 `runtime-store-index.json`，确认 post-run indexing 稳定。
7. 后续如要让 file-context 走真正 cache-first，可在 helper 层优先查 `file_text_cache` 后再回退抽取。
8. 暂不引入 Go、Postgres、MinIO 或向量数据库。

这条路径最符合当前架构：保持 Host 原生控制面、Local Docker 受限执行面、pointer-only 上下文和本地优先隐私边界，同时解决文件积累、缓存命中、TTL 和容量治理问题。
