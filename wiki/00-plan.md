# Meeting Agent 当前路线图

更新时间：2026-08-12。

## 产品目标

把单份录音、实时流、飞书上下文和本地文件转化为可信的会议理解与可执行办公资产。系统以会议证据为基础，但不把所有任务固化成同一条 workflow。

## 已完成基线

- Pi `0.84.1` 执行内核与项目 package。
- 云端文件 ASR 与实时流 ASR 分端口；完整媒体格式矩阵与 OSS 上传。
- 本地 Qwen3-ASR provider/fallback。
- 文件端 speaker diarization、单录混音双模型一致性复核与 overlap 风险标记。
- Meeting Intelligence：参会人、议题、决策状态、行动项、风险、开放问题和证据映射。
- 参会人稳定代号与非阻塞实名映射。
- `pi-subagents@0.46.0` 与 `pi-dynamic-workflows@3.5.1` 的审计、安装和真实 smoke。
- 简单／单核验轴／复杂会议的自适应 Agentic 编排。
- 父级 segment id reconciliation 与跨会议证据隔离。
- Prompt Registry、section-batched Document Workers、QA Gate、Policy Gate 和飞书发布闭环。
- Host-owned runtime store、ASR/file cache、CAS/retention 与本地 Docker 受限 worker。
- Hermes 学习侧车与 AgentWorkbench 只读观测。

## 当前优先级

1. 用真实多人长会议持续校准 diarization、低置信标注和父级 evidence reconciliation。
2. 修复或更换当前返回 401 的审阅模型凭证，保留主模型显式回退。
3. 将智能眼镜的单路音频输入接入同一文件/实时流 ingestion contract，不另建一套会议 Agent。
4. 提升飞书真实环境中的附件获取、长任务进度和发布恢复体验。
5. 让 Meeting Intelligence 与后续 PRD/架构/行动清单的建议更主动，但仍由用户决定是否继续生成。

## 不做的事

- 不宣称单路混音能完整恢复高重叠同时发言。
- 不把 sub-agent 数量当作 Agentic 能力。
- 不建立常驻多 Agent 组织或第二套独立状态机。
- 不让 Hermes 自动修改生产 prompt/skill。
- 不为未出现的多租户或企业协作需求预建平台。

## 完成定义

一次会议任务只有在以下证据同时成立时才算完成：

- ASR 为 complete、非 partial，且有 transcript segment。
- Meeting Intelligence 与 participant/topic/evidence artifact 已生成。
- 所有委派发现通过当前 transcript segment 集合校验。
- 主要议题、关键决定、行动项、风险和待确认没有被无证据升级。
- QA Gate 与必要的 Policy Gate 通过。
- 用户收到本地文件或飞书交付结果，并能理解失败和恢复方式。
