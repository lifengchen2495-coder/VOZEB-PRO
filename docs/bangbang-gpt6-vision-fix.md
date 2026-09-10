# GPT-6 XHigh 产品原创看图兼容修复

2026-09-10，用户已上传产品图片，进入“创作方向”后提示“当前提示词模型没有可用的图片理解能力”。该提示来自 `web/src/lib/server/bangbang-runtime.ts` 的 `resolveCandidate`，发生在上游模型调用之前。

此前保存的 GPT-6 配置使用模型级 `custom` 协议、`/v1/chat/completions` 路径及 `reasoning_effort: xhigh`。产品原创调用的 `resolveRemakeProductionVisionProtocol` 原来会排除所有自定义协议，即使打开“参考图片”也不能通过。本地测试已复现此问题。

本次修复位于 `web/src/lib/server/remake15-production-vision-runtime.ts`：允许使用标准 Chat 路径、标准正文结果字段、完整 `{{model}}` 和 `{{messages}}` 占位符的自定义模板；将实际图片作为 `image_url` 内容项传入，并保留 XHigh 等模板参数。仍需显式启用图片能力；不接入会丢失图片的纯文本模板，不接受截断或拒绝结果。现有图片数量与大小限制继续生效。

## 线上生效步骤

1. 部署上述运行时代码，更新运行带货短剧任务的 Web／Worker 实例。
2. 后台 → 模型渠道 → 欢聚AI GPT 文本 → 渠道配置 → 高级设置 → 模型级路由，选择 `gpt-6`。
3. 展开“请求模板与参考素材”，勾选“参考图片”。保留模型级 `custom` 协议、`/v1/chat/completions` 路径及 `choices[0].message.content` 结果字段。
4. 请求模板保留如下结构。如果其他任务已将 `stream` 改为 `{{stream}}`，不必改回，本次视觉调用也能处理该占位符。

```json
{
  "model": "{{model}}",
  "messages": "{{messages}}",
  "reasoning_effort": "xhigh",
  "stream": false
}
```

5. 检查“逻辑模型”中 `gpt-6` 的渠道绑定：如果该绑定显式关闭了“参考图片”，也需启用，因为绑定配置优先于模型配置。保存模型渠道配置。
6. 回到“清洁剂”项目，重新生成创作方向，核对结果已保存及中转实际模型。此次错误发生在生成前，不需要重新上传已保存的产品图。

## 验证与限制

定向回归覆盖 GPT-6 XHigh 的多模态请求、布尔与占位符 stream、未声明图片能力的拒绝、错误模板拒绝、图片数量限制、上游错误及计费头保留、截断／拒绝结果和原生 Chat 请求。请求使用模拟响应，没有调用付费模型。

实际验证：3 个测试文件共 40 项通过；全项目 TypeScript 检查、两个变更 TypeScript 文件的 ESLint 和 `git diff --check` 通过。

当前浏览器连接报 `unsupported Codex auth method: apikey`，无法读取或保存线上后台配置。本次未部署、未修改线上渠道、未重新提交该项目的付费任务。修复不能据此视为线上验收通过。未执行 Git 暂存、提交或推送。

当前视觉流程仍使用同步 JSON 响应；其他任务正在处理的长响应超时／流式改造不属于本次修复范围。
