# 复刻流程长请求排查与修复

截图中的 HTTP 504 说明请求被网关超时终止，截图本身不能确定具体模型或失败阶段。项目存在两层长时间无响应的等待：模型同步返回完整正文，以及页面接口等待多个模型调用全部完成后才返回 JSON。

## 流程覆盖

| 流程 | 视频理解 | 文案／脚本／提示词 | 页面长操作 |
| --- | --- | --- | --- |
| 原版复刻 | Doubao Responses 流式 | 文案切分及生产提示词共享传输 | production 心跳 |
| 15 秒复刻 | Doubao Responses 流式 | 文案切分、产品／分镜脚本、生产提示词共享传输 | product-script、production 心跳 |
| 60 秒复刻 | Doubao Responses 流式 | 文案切分、产品／分镜脚本、生产提示词共享传输 | product-script、production、merge 心跳 |
| 换品复刻 | Doubao Responses 流式 | 文案切分及生产提示词共享传输 | production、merge 心跳 |
| 换人复刻 | Doubao Responses 流式 | 文案切分及生产提示词共享传输 | production、merge 心跳 |
| Omni | Doubao Responses 流式 | 后续六个文本／视觉阶段复用共享传输 | 已有后台 operation 与项目轮询 |
| 棒棒对标 | 理解／关键帧接入 Responses 流式 | 已有 GPT-6 Chat 流式复用共享传输 | 已有后台 operation 与项目轮询 |

五版来源分析本身已有后台任务轮询。图片重绘已有 image-tasks；视频生成提交上游任务后轮询成片，提交请求仍需等待上游返回任务号。文案报告为本地渲染。Omni 自动视频接口已停用，使用外部成片上传。

## 实现与验证重点

- `web/src/lib/server/remake-vision-request.ts`：统一五版模型请求，标准 Chat 与原生 Responses 默认流式；保留候选模型、参考图片和标准自定义 Chat 模板的 `reasoning_effort`。各版图片板生成、数量、顺序和尺寸校验仍在原模块中。
- `web/src/lib/server/remake-copy-planning-runtime.ts`：GPT-6 Chat／Responses 文案切分流式接收，继续严格校验 JSON 与原文完整覆盖。
- `web/src/lib/server/doubao-video-response.ts`、`responses-stream.ts`：七条视频理解链路共用完整终态校验、响应大小限制、流尾结算与失败退款信息。
- `web/src/lib/server/long-operation-response.ts`、`web/src/services/api/long-operation-response.ts`：页面协商 SSE 后立即响应，每 10 秒心跳，最终事件包含真实业务状态。客户端以最终状态判断成功或失败；断流不能当成成功。
- 回归覆盖同步 504／流式成功、UTF-8 分包、全部图片、模板参数、原文覆盖、截断／拒绝／错误、计费尾帧、取消、版本冲突和认证。

验证结果：9 个测试文件的 137 项测试全部通过；41 个相关文件的 ESLint、全项目 TypeScript 检查及修改差异空白检查通过。使用现有 Codex bundled Node 运行，没有安装或修改系统 Node。

## 使用边界

本次不更换项目选中的模型，也不修改系统配置。Gemini 和不兼容的自定义协议沿用原协议；非 GPT-6 的文案结构化调用及棒棒显式关闭流式的分支保留原行为。旧客户端未发送 `Accept: text/event-stream` 时，仍返回兼容的同步 JSON。

心跳减少页面前置网关因空闲等待导致的超时，不能绕过网关总时长限制或解决上游不可用。项目的模型请求时限仍生效。改动尚未部署，未以真实付费模型或线上网关验证。
