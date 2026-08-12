> 历史快照：本文记录当时的定位过程，不代表当前实现。当前状态见 `../issues/README.md`。

# Feishu 文档评论线程读取与正文匹配边界

日期：2026-05-21

## 背景

飞书文档修订类任务中，用户会要求“根据批注/评论/修改内容重新优化文档”。当前系统已经能导出文档正文，也能通过 `lark-cli drive file.comments list`、`drive file.comments batch_query`、`drive file.comment.replys list` 读取独立评论线程。

需要明确的问题是：评论读取是否需要后台常驻线程，是否可以只依赖“导出完整文档含评论”，以及评论线程如何与对应正文和文档正确匹配，避免多文档、多评论场景下事实混淆。

## 问题判断

不应为了“读取评论”单独增加常驻后台线程。

推荐运行方式是：

1. Gateway 常驻，只负责接收飞书消息并转发任务。
2. Handler/Runner 按用户任务启动。
3. 当任务需要“按评论/批注修订”时，Runner 在该次任务内读取正文与评论线程。
4. 评论读取是 on-demand capability，不默认轮询所有文档。

只有当产品需求变成“持续监听某个文档评论变化并自动处理”时，才需要独立 watcher 或定时任务。当前 Office Agent 的任务模型是用户触发式，不应提前加入评论 watcher。

## 正文导出与评论 API 的关系

只导出完整文档不是稳定方案。

- 导出正文适合作为文档主体来源。
- 飞书独立评论线程不一定出现在导出正文中。
- 导出正文中可见的“批注/修改痕迹”只能作为 fallback evidence。
- 系统不能因为导出正文里出现“批注”字样，就声称已经读取了飞书独立评论线程。

主路径应为：

```text
飞书文档 token / link
-> 导出正文
-> 调用评论 API 读取评论线程
-> 调用回复 API 补齐评论回复
-> 生成 review-context.json
-> Prompt Registry + document-revision-overlay
-> Document Worker
-> QA Gate 检查评论覆盖
```

## 评论与文档的匹配原则

评论必须绑定到具体 source，不允许混成全局评论池。

每个来源至少需要记录：

```json
{
  "sourceId": "file-01",
  "fileName": "xxx.docx",
  "fileType": "docx",
  "fileTokenHash": "hash-only",
  "bodyHash": "hash-only",
  "comments": [
    {
      "sourceId": "file-01",
      "commentId": "comment-id",
      "quote": "被评论的正文片段",
      "commentText": "评论短文本",
      "replies": []
    }
  ]
}
```

多文档任务中，Prompt 只能按 `sourceId` 使用评论。PRD、技术文档、Checklist 等输出可以共享 evidence pack，但必须保留评论来源，不得把 `file-01` 的评论应用到 `file-02`。

## 匹配风险

评论 API 通常能提供 `comment_id`、`quote`、回复、是否解决等信息，但不一定提供稳定段落路径或块 ID。因此正文匹配应分级处理：

1. 明确匹配：`quote` 在正文中唯一出现，可作为局部修订依据。
2. 弱匹配：`quote` 出现多次或只能近似匹配，作为全局修订要求处理。
3. 无法匹配：保留为待确认评论，不假装已经完成局部修改。

QA Gate 必须检查：如果用户要求按评论修改，但 `review-context.json` 中 `commentAccess.method` 不是 `cli` 或 `sdk`，输出必须说明“独立评论线程未读取”。如果评论无法匹配正文位置，也必须进入待确认项。

## 当前设计结论

- 保留“正文导出 + 评论 API + 回复 API”的组合。
- 不退回“只导出整文档含评论”。
- 不新增常驻评论 watcher。
- 评论读取属于 `feishu-document-review-context` lazy capability。
- 评论上下文写入 `review-context.json`，只保留 bounded text、hash、source pointer，不记录 file token、Authorization、CLI session 或完整文档正文。
- 文档修订仍走 Prompt Registry 和 Document Worker，不在 Feishu handler 或 runner 中硬编码修订结构。

## 验收标准

- doc/docx/wiki 链接 + “根据批注/评论修改”必须生成 `review-context.json`。
- `review-context.json` 必须包含 `commentAccess.method`、`identityTried`、`requiredScopes`、`commentThreadCount`、`replyCount`、`unresolvedCount`。
- 多文档输入时，每条评论必须带 `sourceId`。
- 每条评论必须带 `matchStatus` 和 `matchReason`；`exact_unique` 才能作为局部修订依据，`exact_multiple`、`fuzzy`、`unmatched`、`exported_body_detected` 必须进入待确认或明确说明处理方式。
- 多文档部分成功时使用 `partial_ready`，并在对应 source 的 `commentAccess` 中记录失败原因。
- 评论 API 权限不足时记录 `comment_api_permission_blocked`。
- 只能导出正文、未读到独立评论线程时记录 `export_body_detected` 或 `body_ready_comments_not_available`。
- 输出不能声称已处理未读取或无法匹配的评论。
