> 历史快照：本文记录当时的问题与修复，不代表当前架构。当前状态见本目录 `README.md`。

# Feishu 文档修订批注上下文路由缺失

## 问题摘要

用户在飞书中引用 docx 文档并要求“根据修改内容与批注重新优化”，系统已接受任务，但最终返回“目前暂不支持该功能”。

## 触发场景

- 输入：飞书 docx URL + `根据修改内容与批注重新优化下`
- 期望：读取文档正文与批注/修改上下文，生成修订版文档或覆盖明确目标。
- 实际：任务被识别为 `document_analysis` + `direct_answer`，没有进入 document pipeline。

## 当前证据

- 文件读取成功：`downloadMethod=drive_export`
- file-context 已生成，正文约 12k chars。
- `taskIntent.requestedDocuments=[]`
- `taskIntent.responseMode=direct_answer`
- PI 黑盒超时后 fallback 报 Xiaomi thinking-mode 400。

## 根因判断

`classifyTaskIntent` 没有把“批注/评论/修改内容/重新优化”识别为文档生命周期修订任务；同时旧实现只从导出正文中检测可见批注/修改痕迹，没有调用 Feishu 独立评论线程 API。

## 修复方向

- 新增 lazy capability：`document-revision`。
- 新增 lazy available capability：`feishu-document-review-context`。
- 新增 `review-context.json` artifact，记录正文指针、检测到的评论信号和批注读取状态。
- 优先调用 `lark-cli drive file.comments list`、`drive file.comments batch_query`、`drive file.comment.replys list` 读取真实评论线程；SDK 只作为同 API fallback。
- 缺少 `docs:document.comment:read` 或等价 Drive/Docs scope 时记录 `comment_api_permission_blocked`，不得 fallback 后声称已读取评论线程。
- Prompt Registry 使用 `operationOverlays.document_revision=document-revision-overlay.md`，不复制 PRD/架构/checklist prompt。
- `task_execution_runner` 仍作为薄执行器，复用 Planner / Router / Prompt Registry / Document Worker / QA / Policy。

## 验证方式

- doc/docx/wiki URL + “根据批注/修改内容优化”必须进入 `document_revision`。
- 必须生成 `review-context.json`。
- 必须使用 base docType prompt + `document-revision-overlay.md`。
- 不得落回 `direct_answer`、ASR 或会议纪要固定路径。
- 若评论 API 不可用，必须记录 `body_ready_comments_not_available` 或 `comment_api_permission_blocked`，不得编造批注。

## 当前状态

已实现第二阶段：任务路由、review context artifact、prompt overlay、capability registry、wiki 同步，以及 CLI-first 真实评论线程读取。后续 live 是否可读取取决于飞书应用/用户是否具备 `docs:document.comment:read` 或等价 Drive/Docs scope。
