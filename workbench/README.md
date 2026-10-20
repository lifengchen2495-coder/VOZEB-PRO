# VOZEB 本地工作台

参考 VOZEB PRO 统一创作 Agent 做的单用户本地版：不需要数据库、登录、积分或后台，一条命令在自己电脑上启动，接入任意 OpenAI 兼容接口完成对话、图片和视频创作。

## 功能

- **对话**：流式回复、多轮上下文、Markdown 渲染，可附图片让模型看图（需模型支持视觉）。
- **图片**：文生图（`/images/generations`）；附参考图时走图片编辑（`/images/edits`）；可选尺寸、画质和 1–4 张。
- **视频**：OpenAI 视频接口（`/videos` 创建、查询、下载）；可附一张首帧参考图，可选时长和尺寸。
- **本地保存**：会话、设置、上传的参考图和生成的图片/视频都保存在 `.data/` 目录，刷新或重启后自动恢复；关闭页面不影响后台生成。
- **失败重试**：失败的结果原地「直接重试」，不新增消息；服务重启时已拿到上游任务 ID 的视频会继续查询，不会重复创建。
- 会话重命名、删除（连同媒体文件），复制、下载，浅色/深色主题跟随系统，适配手机宽度。

## 启动

需要 Node.js 20.9 或更高版本。

```bash
cd workbench
npm install
npm run dev        # 开发模式，打开 http://127.0.0.1:3100
# 或者
npm run local      # 构建后以生产模式运行，速度更快
```

首次打开会自动弹出「设置」：填写接口地址（例如 `https://api.openai.com/v1` 或你的中转地址）、API Key 和对话/图片/视频模型。也可以复制 `.env.example` 为 `.env.local` 预先填写，页面里保存的设置优先。

服务只监听 `127.0.0.1`，API Key 只保存在本机 `.data/settings.json`，不会返回给浏览器。

## 没有 Key 时先体验

```bash
npm run mock       # 在 3199 端口启动本地模拟上游
```

然后在设置里把接口地址填成 `http://127.0.0.1:3199/v1`，API Key 随便填，点「从接口读取模型列表」即可。模拟上游会返回假的文字、彩色测试图和 2 秒测试视频（视频需要本机装有 `ffmpeg`）。

## 目录

```
src/app/page.tsx               页面：会话列表、消息流、轮询
src/app/components/            输入框、消息、设置弹窗
src/app/api/                   本地接口（设置、会话、发送/重试、上传、媒体）
src/lib/server/store.ts        JSON 文件存储与媒体落盘
src/lib/server/generation.ts   发送、后台任务、重试与重启恢复
src/lib/server/upstream.ts     通过 openai SDK 调用上游
scripts/mock-upstream.mjs      本地模拟上游
```

数据目录可用环境变量 `WORKBENCH_DATA_DIR` 修改。
