// 本地模拟的 OpenAI 兼容上游，用于在没有真实 API Key 时体验和回归工作台。
// 启动：npm run mock，然后在设置里把接口地址填成 http://127.0.0.1:3199/v1，API Key 任意填写。
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { crc32, deflateSync } from "node:zlib";

const port = Number(process.env.MOCK_PORT || 3199);

function png(width, height, [r, g, b]) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) row.set([(r + x) % 256, g, (b + x) % 256], 1 + x * 3);
    const chunk = (type, data) => {
        const head = Buffer.alloc(8);
        head.writeUInt32BE(data.length);
        head.write(type, 4);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
        return Buffer.concat([head, data, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width);
    ihdr.writeUInt32BE(height, 4);
    ihdr.set([8, 2, 0, 0, 0], 8);
    const raw = Buffer.concat(Array.from({ length: height }, () => row));
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// VP9 编码的 MP4 在 Chrome 与开源 Chromium 中都能播放
const ffmpeg = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=24", "-t", "2", "-c:v", "libvpx-vp9", "-deadline", "realtime", "-pix_fmt", "yuv420p", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"], { maxBuffer: 64 << 20 });
const video = ffmpeg.status === 0 ? ffmpeg.stdout : Buffer.from("mock-video");
const videos = new Map();

const readBody = (req) => new Promise((resolve) => { const parts = []; req.on("data", (c) => parts.push(c)); req.on("end", () => resolve(Buffer.concat(parts))); });
const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const body = await readBody(req);
    if (!req.headers.authorization?.startsWith("Bearer ")) return send(res, 401, { error: { message: "missing api key" } });
    if (req.headers.authorization === "Bearer bad-key") return send(res, 401, { error: { message: "无效的令牌" } });
    // 部分模型带 supported_endpoint_types，其余只有 ID，覆盖两种归类方式
    if (url.pathname === "/v1/models")
        return send(res, 200, {
            object: "list",
            data: [
                ...["gpt-4o-mini", "gpt-image-1", "sora-2", "text-embedding-3-small"].map((id) => ({ id })),
                { id: "mock-chat", supported_endpoint_types: ["openai"] },
                { id: "mock-painter", supported_endpoint_types: ["image-generation"] },
                { id: "mock-video", supported_endpoint_types: ["openai-video"] },
            ].map((model) => ({ object: "model", created: 0, owned_by: "mock", ...model })),
        });
    if (url.pathname === "/v1/chat/completions") {
        const { messages, stream } = JSON.parse(body.toString("utf8"));
        const last = messages.at(-1).content;
        const text = typeof last === "string" ? last : last.find((p) => p.type === "text").text;
        const images = typeof last === "string" ? 0 : last.filter((p) => p.type === "image_url").length;
        const answer = `收到：**${text}**\n\n- 历史消息 ${messages.length} 条\n- 附带图片 ${images} 张`;
        if (!stream) return send(res, 200, { id: "c1", object: "chat.completion", created: 0, model: "mock-chat", choices: [{ index: 0, message: { role: "assistant", content: `优化后：${text}，细节丰富，光影柔和` }, finish_reason: "stop" }] });
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const piece of answer.match(/.{1,4}/gsu)) res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "mock-chat", choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
        return res.end("data: [DONE]\n\n");
    }
    if (url.pathname === "/v1/images/generations" || url.pathname === "/v1/images/edits") {
        const edit = url.pathname.endsWith("edits");
        const n = edit ? Number(/name="n"\r\n\r\n(\d+)/.exec(body.toString("latin1"))?.[1] || 1) : JSON.parse(body.toString("utf8")).n || 1;
        if (body.toString("utf8").includes("mock-fail")) return send(res, 400, { error: { message: "模拟上游拒绝了这个提示词" } });
        const data = Array.from({ length: n }, (_, i) => ({ b64_json: png(edit ? 384 : 512, 320, [40 * i, edit ? 200 : 90, 220]).toString("base64") }));
        return send(res, 200, { created: 0, output_format: "png", data });
    }
    if (url.pathname === "/v1/videos" && req.method === "POST") {
        const id = `video_${videos.size + 1}`;
        videos.set(id, { polls: 0, reference: body.includes("input_reference") });
        return send(res, 200, { id, object: "video", status: "queued", progress: 0 });
    }
    const match = /^\/v1\/videos\/([\w-]+)(\/content)?$/.exec(url.pathname);
    if (match && videos.has(match[1])) {
        const task = videos.get(match[1]);
        if (match[2]) { res.writeHead(200, { "content-type": "video/mp4" }); return res.end(video); }
        task.polls += 1;
        return send(res, 200, { id: match[1], object: "video", status: task.polls > 1 ? "completed" : "in_progress", progress: task.polls > 1 ? 100 : 50, error: null });
    }
    send(res, 404, { error: { message: `mock 未实现 ${req.method} ${url.pathname}` } });
}).listen(port, "127.0.0.1", () => console.log(`模拟上游已启动：http://127.0.0.1:${port}/v1`));
