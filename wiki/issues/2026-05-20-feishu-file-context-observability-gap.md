> 历史快照：本文记录当时的问题与修复，不代表当前架构。当前状态见本目录 `README.md`。

# Feishu 文件上下文与运行观测闭环缺口

日期：2026-05-20
状态：fixed
相关模块：tool / runtime / wiki / hermes

## 摘要

真实飞书文件任务中，用户回复文件消息后 bot 只收到文本事件，handler 未稳定关联上一条文件；同时 direct answer 被误套文档发布 Policy，用户侧收到内部诊断文案。Feishu run artifact 也没有稳定生成 Hermes 可读 trajectory。

## 触发场景

- 用户先上传 PDF，再回复或 @bot 发送“总结文件内容”。
- gateway 收到的事件为 `msgType=text`、`attachments=[]`，但存在 `rootId/parentId`。
- 旧 handler 只查最近附件缓存，且“文件内容”未命中文件引用规则。

## 影响范围

- 飞书文件任务无法稳定进入 `file-context`。
- 用户可见回复泄露 `runId`、Policy Gate、QA Gate 等内部状态。
- Hermes 只能读取人工指定 trajectory，不能直接从真实 run artifact 复盘。

## 证据

- `runtime-runs/feishu-agent/runs/*/event.json` 中出现 `attachments=[]` 且 `rootId/parentId` 存在。
- `reply.json` 曾记录包含内部诊断说明的飞书回复。
- `hermes-learning-sidecar/sidecar.py` 原先只支持 `--trajectory`。

## 根因判断

文件关联只覆盖当前消息和缓存，缺少父消息/root 消息资源解析；direct answer 和文档发布共用 Policy 判断；Feishu run artifact 与 Hermes trajectory 没有转换层。

## 修复方案

- 文件引用规则扩展到“文件内容/PDF/Word/Excel/表格”等表达。
- 附件解析顺序固定为当前附件 -> 父消息/root 消息 -> 最近附件缓存。
- direct answer 不再因 `publish_customer_visible` 阻塞用户回复。
- 每个 run 生成 `run.metrics.json`、`run-manifest.json`、`sanitized-trajectory.json`。
- Hermes sidecar 增加 `--run-dir`。

## 验证计划

- fixture：无附件“总结文件内容”返回缺文件提示。
- fixture：父消息附件或缓存附件可进入 `file-context`。
- fixture：direct answer 不暴露 `runId` 或内部 Gate。
- Hermes：`sidecar.py --run-dir <runDir>` 能输出 retrospective/proposals。

## 后续事项

- owner：local agent runtime
- blocked by：无
- follow-up：真实飞书 live smoke 继续确认 bot 是否能收到文件消息本体事件。
