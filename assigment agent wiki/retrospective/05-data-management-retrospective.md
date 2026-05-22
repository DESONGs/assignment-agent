# 数据管理复盘

更新时间：2026-05-22

## 复盘结论

本项目已经从“每个 run 自己堆文件”的阶段，进入需要本地 artifact store、metadata index、CAS 去重、cache ledger 和 retention sweeper 的阶段。数据管理的核心结论是：文件本体留在本地 filesystem，SQLite 只存 metadata，Redis 只做临时队列，长上下文走 pointer-only 和 bounded context pack。

推荐架构已经收敛为：

```text
Filesystem artifact store
  + Host-owned SQLite metadata index
  + content-addressed objects
  + retention sweeper
  + Redis ephemeral queue
```

不建议当前引入 Postgres、MinIO/S3、向量数据库或 Go 常驻服务。

## 数据边界

数据管理分为五类：

- raw source files：飞书附件、本地文件、Rokid 导出文件。
- derived processing artifacts：normalized audio、text extraction、ASR transcript/evidence、context packs。
- generated deliverables：会议纪要、PRD、技术架构、运营方案、客户需求清单。
- runtime observability：state、metrics、manifest、model route、QA/Policy、stream trace、checkpoint。
- learning artifacts：sanitized trajectory、Hermes proposal。

管理原则：

- SQLite 只保存 metadata、hash、路径、bounded preview、状态、TTL 和 source pointer。
- 大文件不进 SQLite。
- 完整文件正文、完整转写正文、原始音视频和凭据不进入长期 memory。
- Docker worker 只能消费 bounded job 和 pointer，不接收原始音视频或飞书登录态。
- Hermes 只读取 sanitized trajectory，不读取高权限运行环境。

## Runtime Store 复盘

本地 store 使用 `runtime-runs/_store/`：

```text
runtime-runs/_store/
  runtime-store.sqlite
  objects/sha256/...
  cache/asr/...
  cache/file-text/...
  cache/docker-jobs/...
  cache/hermes/...
  retention/
```

兼容策略是保留原有 run 目录：

```text
runtime-runs/feishu-agent/runs/{runId}/...
```

run 目录继续作为 handler、ASR、file-context、publish/reply 的兼容视图；大文件进入 CAS 后，run 目录中保留 hardlink、symlink 或 copy。

已落地工具：

- `runtime_store_cli.py init`
- `scan`
- `status`
- `find`
- `index-run`
- `put-object`
- `dedupe`
- `cleanup`
- `pin`
- `unpin`

## CAS 与去重

CAS 的价值不是只节省最终磁盘空间，也用于跨 run 识别同一文件。

音频重复下载问题暴露了两层治理差异：

- 事后 CAS/hardlink 可以压缩物理重复。
- 下载前复用才能避免重复网络下载、临时文件膨胀和状态误报。

因此修复方向是：

- 下载前检查当前 run 目标文件是否已存在且可 hash。
- 附件缓存记录本地 artifact pointer、sha、size 和 path。
- 回复父消息时优先复用 parent/root run 的已下载 artifact。
- CLI 下载失败但本地完整文件可用时，记录为本地复用，不把整个附件解析打成异常。

## Cache 复盘

### Recent source cache

用于短窗口内把“该文件”“这段录音”“总结文件内容”等纯文本指令关联到最近附件。

规则：

- 当前消息附件优先。
- 显式 URL 或文件标识优先。
- 父消息/root 消息资源次之。
- recent cache 最后使用。
- cache 必须按模态过滤，文本任务不能拿旧音频，音频任务不能拿旧文本。

### File text cache

用于 PDF、Word、Excel、Markdown、TXT、CSV 等文本抽取。

目标：

- 同一文件二次总结不重复抽取。
- 短任务只读取 bounded preview 或 extracted slices。
- 长文档任务只通过 source context 消费 bounded context pack。

### ASR cache

用于同一音频的转写结果复用。

规则：

- 以音频 hash 和 ASR 配置作为 cache key。
- 已有完整 transcript/evidence 时直接复用。
- cache hit 不需要启动 ASR health check。
- cache miss 才检查本地 ASR 服务。

## Retention 复盘

2026-05-22 后，默认策略从“单一 TTL”升级为“三档生命周期 + per-kind quota LRU”。核心判断是：可重建的中间产物短保留，反复修订会用到的工作源保留 30-60 天，长期只保留轻量、脱敏或正式交付副本。

| Kind | 人话解释 | 默认保留 | LRU 上限 |
| --- | --- | --- | --- |
| recent source cache | 最近附件指针 | 30 分钟 | 无 |
| normalized audio | ASR 转码后的中间 WAV | 7 天 | 2GB |
| Docker bounded job bundle / worker artifact | Docker 长文档任务包和中间结果 | 7 天 | 1GB |
| runtime tool params/results | 工具输入输出 JSON | 14 天 | 1GB |
| model stream trace | LLM 流式响应、attempt、partial、超时诊断 | 14 天 | 1GB |
| Hermes artifact | Hermes 原始/中间复盘 artifact | 30 天 | 512MB |
| extracted text | PDF/docx/xlsx 抽取出的文本缓存 | 30 天 | 2GB |
| raw media | 飞书下载的原始音频/视频/图片 | 45 天 | 12GB |
| raw document file | 用户上传的原始 PDF/docx/xlsx/pptx/md/txt | 60 天 | 5GB |
| ASR transcript/evidence | transcript、evidence pack、summary | 60 天 | 2GB |
| state/metrics/manifest/model-route/QA/Policy | 运行账本和轻量观测文件 | 60 天 | 512MB |
| generated documents | 生成的 Markdown 文档副本 | 90 天 | 1GB |
| sanitized trajectory/Hermes proposal | 已脱敏、人工可审查的学习结果 | 180 天 | 512MB |
| pinned artifact/run | 被显式保护的 run 或 artifact | 不自动删除 | 不参与 LRU |

清理执行规则：

- `cleanup` 先处理 TTL 过期，再检查 `retention_policies.max_bytes`。
- 超出容量时按 LRU 清理：未 pinned、最久未访问、同优先级下大文件优先。
- `scan/index-run` 以文件 mtime 计算 `expires_at`，避免扫描历史 run 时给旧 artifact 续期。
- 真实删除只作用于 workspace 内、已索引、未 pinned 的 runtime artifact，并写 `retention_actions`。
- `status` 报告 `quotaOverages`；`cleanup --dry-run` 报告 `ttlCandidateCount` 和 `quotaCandidateCount`。

2026-05-22 已执行历史去重：

- indexed runs：102
- indexed artifacts：2616
- indexed logical bytes：约 2.12GB
- `dedupe --execute` 将重复 artifact hardlink 到 CAS。
- `runtime-runs` 实际磁盘占用从约 914MB 降到约 557MB。
- 当前 TTL 过期候选和 quota overage 均为 0。

## Pointer-only 与 Source Context

数据管理和上下文管理必须配合。

早期问题是：file-context 抽出 preview，context-offload 写了 artifact，但 prompt rendering 仍可能把大段 source input 合并进 rendered prompt。Document Worker 虽然按章节分 batch，每批仍反复携带完整大上下文。

Runtime Context Plane 修复后的规则：

- `evidence-pack.json` 是 pointer-only 兼容视图。
- source records 和 source segments 单独存储。
- 每个 work unit 拿 context pack ref 和 hash。
- 每个 section worker 记录 contextPackId、sourceSegmentIds、promptBudgetChars、retrievalReasons。
- QA 和 Hermes 基于 provenance 与 manifest 复盘，不读取未脱敏大正文。

## 已修复事项

- Host-owned SQLite runtime store 已落地。
- Post-run indexer 将 run artifacts 登记到 metadata DB。
- CAS 路径和 hardlink/copy 兼容策略落地。
- Dedupe 与 cleanup 具备 dry-run 和 execute 能力。
- Retention sweeper 已支持三档生命周期、TTL 清理和 per-kind quota LRU。
- ASR cache 和 file text cache 进入 ledger 设计。
- 附件下载前本地复用已补齐。
- ASR health preflight 与 cache hit 顺序已收敛。
- Hermes worker 默认只生成 proposal artifact。

## 遗留风险

- 用户级 pin/unpin UI 尚未实现。
- 客户项目级 retention 仍需配置能力，例如敏感项目 7 天、内部项目 30 天。
- 项目级/会话级 pin 尚未实现，无法一键保护同一客户或同一会议系列的所有关联 run。
- 本地 store 是否需要加密卷或更严格 macOS 文件权限仍未决。
- WeChat live 接入后，是否共用同一个 `_store` 需要再次评估。
- Runtime Context Plane 需要更多数据量下的检索质量和预算回归。

## 后续建议

- 保持 Host-owned SQLite，不让 Docker worker 直接写 DB。
- 先用 `dedupe --dry-run` 和 `cleanup --dry-run` 报告人工确认，再执行真实清理。
- 保持原始音频 45 天、原始文档 60 天的工作复用窗口；容量压力优先清理 normalized audio、runtime tool artifact、model stream trace 和 Docker/Hermes 中间物。
- 观察新 run 的 `runtime-store-index.json`，确认 post-run indexing 不影响 publish/reply。
- 让 file-context helper 优先查 file text cache，再回退抽取。
- 让 ASR cache 命中情况进入用户不可见 metrics，作为重复任务成本优化指标。
- 不在当前阶段引入远端数据库、对象存储或向量数据库，除非项目从本机工具升级为多用户服务。
