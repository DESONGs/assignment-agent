# 开发问题记录规范

`wiki/issues/` 用于沉淀开发中发现的问题、缺陷、架构分歧和回归风险。不要只把问题留在聊天记录或临时 artifact 中；只要问题可能影响后续开发判断，就应整理成 Markdown 文件放到本目录。

## 何时创建 issue 文档

遇到以下情况必须新增 issue：

- 代码和 wiki 不一致，或者文档落后于实现。
- 运行时职责边界不清，例如 Planner、Policy Gate、QA Gate、worker、provider adapter、Feishu/Rokid/ASR 工具职责混在一起。
- 上下文膨胀、raw transcript/full evidence 进入主上下文、secret/raw media 泄漏风险。
- 文档生成质量问题，例如缺 requiredSections、跨文档串事实、unsupported claims、open questions 缺失。
- 模型 provider、fallback、route artifact、QA gate 或 policy gate 的行为不符合预期。
- 飞书机器人、`lark-cli`、Rokid、ASR、本地服务或第三方包审计出现集成问题。
- 测试无法稳定复现，或只在聊天里发现但没有进入回归计划。

## 文件命名

使用日期 + 简短英文 slug：

```text
YYYY-MM-DD-short-problem-slug.md
```

示例：

```text
2026-05-19-document-worker-section-truncation.md
2026-05-19-feishu-bot-gateway-readiness.md
```

## 模板

```markdown
# 问题标题

日期：YYYY-MM-DD
状态：open | investigating | fixed | wontfix
相关模块：extension / skill / prompt / runtime / tool / wiki

## 摘要

一句话说明问题是什么，以及为什么需要记录。

## 触发场景

- 用户任务或测试输入：
- 运行命令或工具链：
- 相关 artifact：

## 影响范围

说明影响文档质量、运行时稳定性、安全边界、飞书/Rokid/ASR 集成、模型 fallback、QA gate 或开发效率中的哪一类。

## 证据

列出可复查的文件、日志、QA artifact、截图或代码位置。不要贴 secret、token、raw request body 或原始音视频内容。

## 根因判断

写当前判断；如果还不确定，明确哪些信息缺失。

## 修复方案

写具体修复方向。若有多个方案，说明取舍。

## 验证计划

列出静态检查、mock 回归、真实 provider 回归、Feishu/Rokid/ASR 回归或人工评估标准。

## 后续事项

- owner：
- blocked by：
- follow-up：
```

## 使用规则

- issue 文档可以先记录不完整事实，但必须标明 `investigating`。
- 修复完成后，把状态改为 `fixed`，并补充验证结果和相关 PR/commit/文件路径。
- 不要在 issue 中写 API key、App Secret、Authorization header、cookie、CLI session、raw request body 或原始媒体。
- 如果 issue 影响架构或流程，修复时还要同步对应 wiki，不得只改代码。
