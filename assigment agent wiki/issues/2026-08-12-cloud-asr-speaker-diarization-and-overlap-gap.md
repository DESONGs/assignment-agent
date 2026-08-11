# 云端 ASR 说话人分离与重叠发言能力缺口

日期：2026-08-12
状态：implemented-with-known-limit

## 结论

此前多人录音没有发挥云端 ASR 的说话人分离能力，主要不是 system prompt 写得不够强，而是能力链路在 ASR 请求、媒体条件和证据传递三处同时断开：文件请求没有打开 diarization；源录音为双声道而文件端 diarization 要求单声道；解析出的 `speaker_id` 没有完整进入 Source Context 和纪要提示词。

本次修复后，录音文件与实时流继续使用两个独立端口。文件端 `paraformer-v2` 默认以 `auto` 开启匿名说话人分离，必要时生成派生单声道输入；实时 `paraformer-realtime-v2` 明确记录为不支持文件端 diarization。说话人标签会从云端响应贯通到 transcript、可读转录、evidence、context pack 和纪要规则。

## 根因

1. 文件端请求缺少 `diarization_enabled=true`，云端默认不会返回说话人聚类结果。
2. 文件端说话人分离只接受单声道输入，直接上传双/多声道录音无法获得预期能力。
3. ASR parser 虽可读取 speaker 字段，但 Source Context 原先只保留文本与时间戳，下游模型看不到稳定的 speaker/channel 证据。
4. 纪要 prompt 没有说明匿名 speaker id 的证据边界，容易把“没有标签”和“身份未知”混为一谈。

## 实现边界

- 文件端：支持 provider 格式矩阵、私有 OSS、短期签名 URL、`diarization_enabled`、可选 `speaker_count=2..100` 和时间戳对齐。
- 单声道：直接上传原容器；双/多声道：只为 diarization 生成派生 16 kHz 单声道 M4A/WAV，原文件不修改。
- 建议时长：`auto` 对超过 2 小时的文件不自动开启 diarization；显式开启时保留用户选择并记录元数据。
- 实时端：继续提供低延迟转写，但不伪装成具有文件端说话人分离。若需要最终可审计纪要，会后应把完整录音交给文件端重跑。
- 匿名标签：`speaker_id` 只代表同一录音内的聚类，不自动映射姓名、角色、公司或行动项 owner。

## 鸡尾酒会问题的真实边界

Speaker diarization 回答“这一段更像由哪一位说话人说出”，不等于把同时出现的多个声源分离成各自干净音轨。两人在同一声道同时讲话时，Paraformer 文件端仍可能漏字、串话、错误切分或把片段归给一个 speaker。system prompt 只能约束下游不要过度推断，不能恢复 ASR 没有识别出的声音。

因此下游规则是：不同 speaker 标签不得合并为同一人的观点；标签不能证明身份；重叠发言、语义跳变和频繁换标记为“重叠发言/归属待确认”。如果业务要求准确还原高重叠会议，需要在采集侧使用近讲麦、多轨录音或另行引入专门的 source separation/overlap-aware 模型，这不属于本轮 Paraformer 接口改造。

## 验收证据

- 单元测试覆盖文件/实时端边界、2–100 speaker count、匿名标签落盘和实时端 unsupported 状态。
- 真实云端 smoke 应验证：双声道源生成派生单声道、`summary.status=complete`、`inputModes=["file"]`、`failedChunks=0`，并检查云端是否返回一个以上 speaker id。
- 所有 artifact 做 API Key、OSS 签名 URL 与 credential 字段扫描。
