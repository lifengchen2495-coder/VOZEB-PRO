// 视觉流程只接收完整的 Chat 正文；心跳、推理片段和计费事件不属于生成结果。
export function readVisionChatStream(raw: string): Record<string, unknown> {
    let content = "";
    let finishReason = "";
    let done = false;
    for (const frame of raw
        .replace(/^\uFEFF/u, "")
        .replace(/\r\n|\r/g, "\n")
        .split("\n\n")) {
        const lines = frame.split("\n");
        const event = lines
            .find((line) => line.startsWith("event:"))
            ?.slice(6)
            .trim();
        if (event === "error") throw new Error("生成接口在流式响应中返回错误，请检查渠道状态。");
        const data = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");
        if (!data.trim()) continue;
        if (data.trim() === "[DONE]") {
            done = true;
            continue;
        }
        let payload: Record<string, unknown>;
        try {
            const parsed: unknown = JSON.parse(data);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
            payload = parsed as Record<string, unknown>;
        } catch {
            throw new Error("生成接口流式响应格式无效，请联系管理员检查渠道响应。");
        }
        if (payload.error || payload.type === "error") throw new Error("生成接口在流式响应中返回错误，请检查渠道状态。");
        if (payload.type === "vozeb.billing") continue;
        const choices = Array.isArray(payload.choices) ? payload.choices : [];
        const choice = choices.find((item) => item && typeof item === "object" && (item.index === undefined || item.index === 0));
        if (!choice) continue;
        const message = choice.delta || choice.message || {};
        if (message.refusal) throw new Error("模型拒绝了本次生成请求，请调整输入内容。");
        if (message.tool_calls?.length) throw new Error("模型返回了工具调用，未返回完整创作正文。");
        if (typeof message.content === "string") content += message.content;
        else if (Array.isArray(message.content)) {
            for (const part of message.content) {
                if (part?.type === "refusal") throw new Error("模型拒绝了本次生成请求，请调整输入内容。");
                if (part?.type === "text" && typeof part.text === "string") content += part.text;
            }
        }
        if (choice.finish_reason) {
            finishReason = choice.finish_reason;
            if (finishReason === "length") throw new Error("模型输出达到长度上限，未生成完整结果，请缩短当前生成内容。");
            if (finishReason !== "stop") throw new Error("模型未正常完成创作结果，请检查输入内容或渠道状态。");
        }
    }
    if (!done || finishReason !== "stop") throw new Error("生成接口流式响应中断，未收到完整结束标记，请稍后重试。");
    return { choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] };
}
