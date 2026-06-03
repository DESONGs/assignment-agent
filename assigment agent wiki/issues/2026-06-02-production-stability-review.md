# 2026-06-02 Production Stability Review

Status: implemented in code; supervisor takeover completed; full Feishu end-to-end Live QA still needs a real inbound Feishu trigger after this report.

## Scope

本次 review 覆盖 Feishu handler/gateway、本地 ASR、task runner、runtime tool CLI、source context、document worker、QA/Policy、Wiki/Drive publish、Docker worker、runtime store 和本地 CI。目标是让 Feishu/ASR/文档生成运行时从临时可用变成可持续生产运行。

## P0/P1 Findings

### 1. Feishu handler/gateway 缺少统一 supervisor

现象：handler/gateway 曾依赖 `screen` 或 launchd plist 分散启动。出现阻塞或进程退出时，用户侧只看到机器人无回应或 gateway 返回处理服务不可用。

根因：生产入口没有单一控制面，`feishu-handler` 的 HTTP health、`feishu-gateway` 的长连接进程状态、ASR health 和日志没有被统一采集、重启和落盘。

修复：新增：

- `meeting-agent-pi-package/tools/local_runtime_supervisor.py`
- `meeting-agent-pi-package/tools/local_runtime_ctl.py`

supervisor 直接管理 `feishu-handler` 和 `feishu-gateway` 子进程，ASR 保持 Host-owned，通过 `local_asr_service_ctl.py status` 检查并可恢复。状态写入：

- `runtime-runs/_services/supervisor/status.json`
- `runtime-runs/_services/supervisor/events.ndjson`
- `runtime-runs/_services/supervisor/health-report.json`

安全边界：状态文件不写 secret；ASR 不外发 raw audio；Docker worker 不接 Feishu token/cookie/App Secret。

### 2. ASR MLX worker 线程错误

现象：真实音频 run 中所有 ASR chunk 失败，错误为 `There is no Stream(gpu, 1) in current thread.`，导致飞书回复“本机 ASR 服务未运行”或“转写未完成”。

根因：HTTP 服务使用 threaded server 后，MLX session 初始化和实际转写可能在不同请求线程执行。MLX/Metal stream 绑定线程，跨线程复用 session 失败。

修复：`local_asr_http_service.py` 已引入 dedicated `local-asr-mlx-worker`，模型初始化和转写都进入同一 worker queue；HTTP health 仍保持轻量响应。

验证：`limitChunks=1` ASR smoke 已生成 transcript segment，`failedChunks=0`，不再出现 GPU stream 错误。

### 3. Docker CLI PATH 不稳定

现象：`docker compose -f docker-compose.local-runtime.yml config` 在普通 shell 中可能报 `docker: command not found`，但 Docker Desktop 的 CLI 实际存在。

根因：本机 PATH 与 Docker Desktop 安装路径未统一。

修复：新增 `local_ci_check.py`，Docker compose config 使用 `/Applications/Docker.app/Contents/Resources/bin/docker` fallback。

### 4. 缺少统一本地 CI 报告

现象：每次回归依赖人工记忆多条 validator、Python、Node、TS、Docker、Swift 命令，容易漏掉某一类检查。

修复：新增 `meeting-agent-pi-package/tools/local_ci_check.py`。报告写入：

- `runtime-runs/_services/ci/latest.json`
- `runtime-runs/_services/ci/local-ci-report-YYYYMMDD-HHMMSS.json`

覆盖项：

- `python3 src/validate_workspace.py`
- Python runtime tool compile
- Node ESM syntax checks
- TypeScript strip checks
- runtime/schema JSON parse
- Docker compose config with Docker.app fallback
- `swift test` in `AgentWorkbench`

## Production Runbook

Start:

```bash
python3 meeting-agent-pi-package/tools/local_runtime_ctl.py start
```

Status:

```bash
python3 meeting-agent-pi-package/tools/local_runtime_ctl.py status
python3 meeting-agent-pi-package/tools/local_runtime_ctl.py doctor
```

Stop:

```bash
python3 meeting-agent-pi-package/tools/local_runtime_ctl.py stop
```

Local CI:

```bash
python3 meeting-agent-pi-package/tools/local_ci_check.py
```

ASR direct check:

```bash
python3 meeting-agent-pi-package/tools/local_asr_service_ctl.py status
```

## Live QA Checklist

- P2P 普通问答：收到最终回复，无文档长链路。
- 文件/音频 ACK：默认静默或明确符合配置，无重复 ACK。
- 音频会议纪要：真实转写、生成会议纪要、QA/Policy 通过、发布到 Wiki/Drive、飞书回复 URL。
- PRD/技术架构/checklist：按项目 taxonomy 归档，不创建新的 `feishu-chat-*` 文件夹。
- 失败场景：ASR unavailable 或 QA blocked 时，飞书回复必须说明具体失败原因。

## Validation Log

Initial static checks:

- `env PYTHONPYCACHEPREFIX=/tmp/assignment-agent-pycache python3 -m py_compile meeting-agent-pi-package/tools/local_runtime_supervisor.py meeting-agent-pi-package/tools/local_runtime_ctl.py meeting-agent-pi-package/tools/local_ci_check.py` passed.
- `python3 src/validate_workspace.py` passed.

Final local checks on 2026-06-02:

- `python3 src/validate_workspace.py` passed.
- `env PYTHONPYCACHEPREFIX=/tmp/assignment-agent-pycache python3 -m py_compile meeting-agent-pi-package/tools/local_runtime_supervisor.py meeting-agent-pi-package/tools/local_runtime_ctl.py meeting-agent-pi-package/tools/local_ci_check.py meeting-agent-pi-package/tools/local_asr_http_service.py meeting-agent-pi-package/tools/local_asr_service_ctl.py` passed.
- `node --check meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs` passed.
- `node --check meeting-agent-pi-package/tools/feishu_bot_event_gateway.mjs` passed.
- `python3 meeting-agent-pi-package/tools/local_ci_check.py` wrote `runtime-runs/_services/ci/local-ci-report-20260602-154401.json`; result `passed_with_environment_blockers`, `failedCount=0`, `blockedCount=1`.
- Blocked CI item: `swift-test-agent-workbench` due `swift_toolchain_sdk_mismatch`; this is local Xcode CommandLineTools SDK/compiler mismatch, not a Feishu runtime code failure.
- Docker compose local runtime check passed via `/Applications/Docker.app/Contents/Resources/bin/docker`.
- Docker services were already running: `runtime-queue`, `pi-document-worker`, `hermes-worker`.

Supervisor takeover:

- `python3 meeting-agent-pi-package/tools/local_runtime_ctl.py start` started supervisor PID `14131`.
- Old `screen` fallback handler/gateway processes were terminated by takeover.
- `feishu-handler` started in live mode: `executionMode=execute`, `publishMode=live`, `replyMode=live`, `asyncMode=true`.
- `feishu-gateway` long connection started with `client ready`, `event-dispatch is ready`, `replyMode=http`, and loopback handler URL allowed.
- `local-asr` health was `ok`, `modelLoaded=true`, `loadedModelDir=models/Qwen3-ASR-1.7B-MLX-4bit`, `rawMediaExternalUpload=false`.

Supervisor restart tests:

- Killed handler PID `14132`; supervisor restarted handler as PID `15806`, `restartCount=1`, health returned `ok`.
- Killed gateway PID `14133`; supervisor restarted gateway as PID `16681`, `restartCount=1`, process health returned `ok`.

ASR:

- Prior `limitChunks=1` smoke artifact `runtime-runs/feishu-agent/asr-smoke-20260602/summary.json` shows `status=partial`, `transcriptSegments=1`, `failedChunks=0`.
- A second ASR smoke POST through loopback was not executed because the sandbox escalation request was rejected by the automatic approval reviewer; no workaround was attempted.

Feishu Live QA:

- Gateway and handler are now live and ready for real inbound Feishu messages.
- Full publish/reply end-to-end QA was not completed inside this turn because the sandbox cannot directly connect to the loopback handler/ASR ports, and the ASR POST escalation was rejected. The next product QA step is to send a real Feishu message to the group and verify the run artifacts plus final reply URL.

## Residual Risks

- Full Live QA still depends on active Feishu long connection, local credentials, external LLM provider latency, and real publish permissions.
- `feishu-gateway` has no native HTTP health endpoint; supervisor v1 uses process liveness plus timeout log detection.
- ASR recovery can start the host-owned service, but MLX/Metal failures caused by OS/GPU state may still require manual process restart.
- Long document quality is now guarded by context plane and deadline/retry contracts, but still needs continuous live QA across multi-file tasks.
