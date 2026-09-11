import type { ResolvedLogicalModel } from "@/lib/server/logical-model-router";
import { RemakeProductionVisionError, requestRemakeProductionVisionPrompt, resolveRemakeProductionVisionProtocol } from "@/lib/server/remake15-production-vision-runtime";
import { strictJsonObjectText } from "@/lib/server/structured-model-output";
import { requestStructuredText, TextPlanningRequestError, type StructuredTextRequest, type TextPlanningCall } from "@/lib/server/text-planning-runtime";

type RemakeCopyPlanningRequest = StructuredTextRequest & { candidate: ResolvedLogicalModel };

export async function requestRemakeCopyPlanning(input: RemakeCopyPlanningRequest): Promise<TextPlanningCall> {
    const protocol = resolveRemakeProductionVisionProtocol(input.candidate, true)?.kind;
    if (!/^gpt-6(?:[.-]|$)/i.test(input.candidate.upstreamModel) || (protocol !== "chat" && protocol !== "responses")) return requestStructuredText(input);

    // 复用完整 Chat／Responses 流读取与结算，保留所选模型、原文与文案校验。
    const instruction = `本次以 JSON 正文返回 ${input.tool.name} 的参数，不发起工具调用。任务用途：${input.tool.description}。只返回一个严格 JSON 对象，不要使用 Markdown、解释或额外文字。JSON 必须符合以下 Schema：${JSON.stringify(input.tool.parameters)}`;
    let response;
    try {
        response = await requestRemakeProductionVisionPrompt({
            origin: input.origin,
            cookie: input.cookie,
            candidate: input.candidate,
            messages: [...input.messages, { role: "system", content: instruction }],
            boards: [],
            headers: input.fallbackHeaders || input.headers,
            signal: input.signal,
            allowTextOnly: true,
            stream: true,
            jsonMode: true,
        });
    } catch (error) {
        if (error instanceof RemakeProductionVisionError && error.responseHeaders) await input.onInvalidResponse?.(error.responseHeaders);
        throw error;
    }

    const argumentsText = strictJsonObjectText(response.text);
    if (!argumentsText || (input.validateArguments && !input.validateArguments(argumentsText))) {
        await input.onInvalidResponse?.(response.headers);
        throw new TextPlanningRequestError("文案模型未返回完整、连续覆盖原文的结构化结果", 502, false, "invalid-structure", "invalid-structured-result");
    }
    return { arguments: argumentsText, headers: response.headers, protocol: response.protocol, elapsedMs: response.elapsedMs, transport: "stream" };
}
