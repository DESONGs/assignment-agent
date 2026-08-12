# 历史问题记录索引

更新时间：2026-08-12。

本目录保存日期化问题、修复证据和当时的环境阻塞。除 2026-08-12 的已知限制记录外，其余文件都不作为当前架构或运行规范；旧状态字段只表示文档写成时的判断。

当前事实请先读：

- [Agent 专项架构](../02-agent-architecture.md)
- [当前代码架构](../11-current-project-architecture.md)
- [测试与发布验收](../07-test-plan.md)

## 当前仍需理解的限制

- [云端 ASR speaker diarization 与 overlap gap](2026-08-12-cloud-asr-speaker-diarization-and-overlap-gap.md)：已实现文件端 diarization 与 robust 双模型复核；单路高重叠语音仍不能保证声源级恢复。
- 当前审阅模型配置在真实 smoke 中出现 401；Agent 会记录 attempt 并显式回退主模型，凭证/权益仍需独立修复。

## 历史分类

- 2026-05：飞书入口、权限、附件、ASR、文档生成与上下文平面的早期缺口。
- 2026-06：稳定性、附件复用和 runtime store 污染治理。
- 2026-08：云端多人 ASR 与 Agentic 迭代的已知能力边界。

## 新问题格式

文件名使用 `YYYY-MM-DD-short-problem-slug.md`，正文包含日期、状态、影响、证据、根因、修复、验证和残余风险。不得写入 API Key、Token、Cookie、Authorization、App Secret、签名 URL、CLI session 或原始认证输出。

问题修复后必须同步当前专题文档和相关回归；只改 issue 状态不代表产品完成。
