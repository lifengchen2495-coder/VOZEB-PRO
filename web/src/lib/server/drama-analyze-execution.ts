import { NextResponse } from "next/server";

import { getAuthSettings, refundUserPoints } from "@/lib/auth/store";
import { describeDramaAnalysisCandidate, dramaContentTool, dramaVisualTool, getDramaContentAnalysisIssue, hasUsableDramaToolArguments, normalizeDramaContentAnalysis, normalizeDramaToolArguments } from "@/lib/server/drama-analysis";
import { mergeDramaContentAnalyses } from "@/lib/server/drama-analysis-merge";
import { splitDramaScriptAtBoundary } from "@/lib/server/drama-analysis-segmentation";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { resolveLogicalModelCandidates } from "@/lib/server/logical-model-router";
import { DramaTextModelError, resolveDramaTextModel } from "@/lib/server/drama-text-model";
import { maintenanceWorkerContextHeaders, requestRuntimeCredential } from "@/lib/server/maintenance-auth";
import { hasSystemAiCharge, readSystemAiBilling, systemAiBillingHeaders, systemAiIdempotencyKey, type SystemAiBilling } from "@/lib/server/system-ai-billing";
import { isStructuredTextFailure, rankTextPlanningCandidates, requestStructuredText, type TextPlanningCandidate } from "@/lib/server/text-planning-runtime";
import { dramaAnalysisText, normalizeDramaVisualInput, type DramaAnalyzeBody, type NormalizedDramaVisualInput } from "@/lib/server/drama-analysis-input";
import { dramaShotDurationInstruction, resolveDramaVideoDurationPolicy } from "@/lib/server/drama-shot-config";
import { analyzeDramaVideoPromptBatches, analyzeDramaVisualBatches } from "@/lib/server/drama-visual-analysis-runtime";
import { dramaVideoPromptTool } from "@/lib/server/drama-video-prompt-analysis";
import { dramaVideoPromptInstructions } from "@/lib/drama-video-prompt-instructions";

export async function executeDramaAnalyze(request: Request, userId: string, body: DramaAnalyzeBody): Promise<Response> {
    const requestId = dramaAnalysisText(body.requestId);
    if (!requestId || requestId.length > 200) return NextResponse.json({ code: 400, data: null, msg: "剧本分析请求标识无效" }, { status: 400 });
    const phase = body.phase === "visual" || body.phase === "video-prompts" ? body.phase : "content";
    if (body.videoPromptInstructions !== undefined && (typeof body.videoPromptInstructions !== "string" || body.videoPromptInstructions.length > 50_000))
        return NextResponse.json({ code: 400, data: null, msg: "视频提示词生成指令必须是 50,000 字以内的文本" }, { status: 400 });
    const script = dramaAnalysisText(body.script);
    if (phase === "content" && !script) return NextResponse.json({ code: 400, data: null, msg: "请先填写剧本" }, { status: 400 });

    const visualInput = phase !== "content" ? normalizeDramaVisualInput(body) : null;
    if (phase !== "content" && !visualInput?.shotIds.length) return NextResponse.json({ code: 400, data: null, msg: "请先完成内容审核" }, { status: 400 });
    const credential = requestRuntimeCredential(request, userId);

    const settings = await getAuthSettings();
    let textSelection: ReturnType<typeof resolveDramaTextModel>;
    try {
        textSelection = resolveDramaTextModel(settings, body.textModel);
    } catch (error) {
        if (error instanceof DramaTextModelError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        throw error;
    }
    const { model, candidates } = textSelection;
    const requestedVideoModel = dramaAnalysisText(body.videoModel);
    const defaultVideoModel = settings.defaultModels.videoModel;
    const requestedVideoCandidates = phase === "content" && (requestedVideoModel || defaultVideoModel) ? resolveLogicalModelCandidates(settings, "video", requestedVideoModel || defaultVideoModel) : [];
    const videoCandidates = requestedVideoCandidates.length || !defaultVideoModel || requestedVideoModel === defaultVideoModel ? requestedVideoCandidates : resolveLogicalModelCandidates(settings, "video", defaultVideoModel);
    const durationPolicy = resolveDramaVideoDurationPolicy(videoCandidates, settings.generationDefaults.videoSeconds, settings.generationPointMultipliers?.videoSeconds);
    const durationInstruction = phase === "content" ? dramaShotDurationInstruction(durationPolicy) : "";

    let refundedPointsRemaining: number | undefined;
    try {
        const tool = phase === "video-prompts" ? dramaVideoPromptTool : phase === "visual" ? dramaVisualTool : dramaContentTool;
        const schemaInstruction = `即使渠道没有传递工具定义，也必须只返回符合以下 JSON Schema 的对象，不能返回输入对象，不能把 script 或 summary 作为顶层字段：${JSON.stringify(tool.parameters)}`;
        const messagesFor = (batchInput: unknown) => [
            {
                role: "system",
                content:
                    phase === "video-prompts"
                        ? `${dramaVideoPromptInstructions(body.videoPromptInstructions)}\n逐一返回全部镜头的 shotId 和 videoPrompt，严格保留原始镜头数量与顺序；不得返回或修改图片提示词、首尾帧及其他结构字段。必须调用 design_drama_video_prompts。不要使用 Markdown。${schemaInstruction}`
                        : phase === "visual"
                          ? `你是影视视觉导演。输入内容已经由用户审核，必须严格保留每个 shotId、镜头数量、顺序、人物、场景、对白、旁白、原文和时长。为每个镜头补充图片提示词、视频提示词、起始/结束帧提示词、镜头运动和连续性数据；连续性必须明确景别、机位、构图、人物站位、视线、动作起止、屏幕运动方向和轴线规则。镜头之间要保持人物服装、道具、空间和视线关系连续。\n仅 videoPrompt 字段采用以下生成指令：\n${dramaVideoPromptInstructions(body.videoPromptInstructions)}\n必须调用 design_drama_visuals。不要使用 Markdown。${schemaInstruction}`
                          : `你是影视剧本编辑。只提取剧本明确存在的内容事实和镜头边界，不生成 imagePrompt、videoPrompt、镜头运动或画面风格，不添加无依据的主要情节。必须逐句保留所有角色直接说出的原话和原文明示的旁白，utterances 按原文顺序列出每一句；每条 dialogue 必须根据前后文填写明确说话人姓名或身份，禁止留空、填写“说话人/未知”或只写无法定位的代词。结合语境区分引号内容：短信、通知、作者留言、屏幕文字和物品名称保留在 sourceText 与可观察描述中，不强行改成口头对白；原文明示的内心独白或旁白使用 voiceover，不因为有引号就改成 dialogue。口头对白即使没有句末标点，也必须完整提取。禁止把多句台词压缩成“某人说明/表示/询问”的剧情摘要；说话人转换、明确动作反应或场景变化都应成为可审核的镜头边界，sourceText 必须保留对应连续原文，所有镜头的 sourceText 按顺序拼接必须覆盖整个输入，不得省略通知、叙述或其他非对白文字。${durationInstruction}必须调用 analyze_drama_content。不要使用 Markdown。${schemaInstruction}`,
            },
            { role: "user", content: JSON.stringify(batchInput) },
        ];
        let latestError: unknown;
        for (const candidate of rankTextPlanningCandidates(candidates.map((candidate) => ({ ...candidate, channelId: candidate.channel.id })))) {
            try {
                if (phase !== "content") {
                    const analyzeBatches = phase === "video-prompts" ? analyzeDramaVideoPromptBatches : analyzeDramaVisualBatches;
                    const result = await analyzeBatches({
                        input: visualInput!,
                        requestBatch: async (batch) => {
                            const call = await requestFunctionCall(
                                resolveInternalOrigin(new URL(request.url).origin),
                                credential,
                                candidate,
                                model,
                                messagesFor(batch.payload),
                                userId,
                                tool,
                                visualBatchIdempotencyKey(userId, requestId, candidate, batch, phase),
                                undefined,
                                false,
                                request.signal,
                            );
                            return { value: JSON.parse(call.args), call };
                        },
                        releaseCall: async (call) => {
                            if (hasSystemAiCharge(call)) refundedPointsRemaining = (await refund(userId, model, call))?.pointsBalance;
                        },
                        shouldSplitError: isAdaptiveVisualBatchError,
                    });
                    if (result.data.shots.length !== visualInput!.shotIds.length) throw new Error("模型没有为全部镜头生成视觉结构");
                    const response = NextResponse.json({ code: 0, data: result.data, msg: phase === "video-prompts" ? "视频提示词已生成" : "视觉结构已生成" });
                    const pointsRemaining = result.calls
                        .map((call) => call.pointsRemaining)
                        .filter((value): value is number => typeof value === "number")
                        .at(-1);
                    if (typeof pointsRemaining === "number") response.headers.set("x-vozeb-pro-points-remaining", String(pointsRemaining));
                    return response;
                }
                const result = await analyzeDramaContentCandidate({
                    origin: resolveInternalOrigin(new URL(request.url).origin),
                    credential,
                    candidate,
                    model,
                    tool,
                    requestId,
                    script,
                    summary: dramaAnalysisText(body.summary),
                    userId: userId,
                    durationPolicy,
                    messagesFor,
                    signal: request.signal,
                    onRefund: (pointsBalance) => {
                        if (typeof pointsBalance === "number") refundedPointsRemaining = pointsBalance;
                    },
                });
                const response = NextResponse.json({ code: 0, data: result.data, msg: "内容结构待审核" });
                const pointsRemaining = result.calls
                    .map((call) => call.pointsRemaining)
                    .filter((value): value is number => typeof value === "number")
                    .at(-1);
                if (typeof pointsRemaining === "number") response.headers.set("x-vozeb-pro-points-remaining", String(pointsRemaining));
                return response;
            } catch (error) {
                latestError = error;
                if (!shouldTryAnotherTextCandidate(error)) break;
            }
        }
        throw latestError instanceof Error ? latestError : new Error("没有可用的文本模型渠道");
    } catch (error) {
        const response = NextResponse.json({ code: 502, data: null, msg: error instanceof Error ? error.message : "剧本分析失败" }, { status: 502 });
        if (typeof refundedPointsRemaining === "number") response.headers.set("x-vozeb-pro-points-remaining", String(refundedPointsRemaining));
        return response;
    }
}

function visualBatchIdempotencyKey(userId: string, requestId: string, candidate: TextPlanningCandidate, batch: NormalizedDramaVisualInput, phase = "visual") {
    return systemAiIdempotencyKey("drama-analyze", userId, phase, requestId, batch.shotIds.join("\0"), candidate.channel.id, candidate.upstreamModel);
}

function isAdaptiveVisualBatchError(error: unknown) {
    const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
    const message = error instanceof Error ? error.message : "";
    return status === 413 || isStructuredTextFailure(error) || message === "模型没有返回所需的结构化结果" || message === "模型没有返回结构化剧本结果";
}

function shouldTryAnotherTextCandidate(error: unknown) {
    if (isStructuredTextFailure(error)) return false;
    const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
    return status >= 500 || status === 408 || status === 429;
}

async function requestFunctionCall(
    origin: string,
    credential: string,
    candidate: TextPlanningCandidate,
    billingModel: string,
    messages: Array<{ role: string; content: string }>,
    userId: string,
    tool: { name: string; description: string; parameters: Record<string, unknown> },
    idempotencyKey: string,
    validateArguments = (argumentsText: string) => hasUsableDramaToolArguments(argumentsText, tool.name),
    allowRepair = true,
    signal?: AbortSignal,
) {
    const workerHeaders = maintenanceWorkerContextHeaders(credential);
    const cookie = workerHeaders ? "" : credential;
    const authenticationHeaders: Record<string, string> = workerHeaders || (cookie ? { cookie } : {});
    const headers = { "Content-Type": "application/json", ...authenticationHeaders, ...systemAiBillingHeaders(billingModel, `${idempotencyKey}:tool`, candidate.upstreamModel) };
    const fallbackHeaders = { "Content-Type": "application/json", ...authenticationHeaders, ...systemAiBillingHeaders(billingModel, `${idempotencyKey}:json`, candidate.upstreamModel) };
    const normalizeArguments = (argumentsText: string) => normalizeDramaToolArguments(argumentsText, tool.name);
    const call = await requestStructuredText({
        origin,
        cookie,
        candidate,
        messages,
        tool,
        headers,
        fallbackHeaders,
        preferNativeTools: false,
        allowRepair,
        stream: true,
        streamFallback: true,
        signal,
        validateArguments: (argumentsText) => validateArguments(normalizeArguments(argumentsText)),
        onInvalidResponse: (responseHeaders) => refund(userId, billingModel, responseHeaders),
    });
    const normalizedArguments = normalizeArguments(call.arguments);
    if (!validateArguments(normalizedArguments)) {
        console.error("[drama-analyze] structured output invalid", JSON.stringify({ endpoint: call.protocol, channelId: candidate.channel.id, model: candidate.upstreamModel, argumentShape: describeArgumentsText(call.arguments) }));
        await refund(userId, billingModel, call.headers);
        throw new Error("模型没有返回结构化剧本结果");
    }
    return readCallResult(normalizedArguments, call.headers);
}

type DramaContentCall = Awaited<ReturnType<typeof requestFunctionCall>>;
type DramaTool = { name: string; description: string; parameters: Record<string, unknown> };

async function analyzeDramaContentCandidate(input: {
    origin: string;
    credential: string;
    candidate: TextPlanningCandidate;
    model: string;
    tool: DramaTool;
    requestId: string;
    script: string;
    summary: string;
    userId: string;
    durationPolicy: ReturnType<typeof resolveDramaVideoDurationPolicy>;
    messagesFor: (batchInput: unknown) => Array<{ role: string; content: string }>;
    signal: AbortSignal;
    onRefund: (pointsBalance: unknown) => void;
}) {
    const calls: DramaContentCall[] = [];
    try {
        const data = await analyzeDramaScriptSegment(input, input.script, "full", calls);
        if (!hasCompleteDramaSourceCoverage(data, input.script)) throw new Error("模型分段合并后的剧本结构不完整");
        return { data, calls };
    } catch (error) {
        for (const call of calls) {
            if (!hasSystemAiCharge(call)) continue;
            const result = await refund(input.userId, input.model, call);
            input.onRefund(result && typeof result === "object" && "pointsBalance" in result ? result.pointsBalance : undefined);
        }
        throw error;
    }
}

async function analyzeDramaScriptSegment(input: Parameters<typeof analyzeDramaContentCandidate>[0], script: string, segmentKey: string, calls: DramaContentCall[]): Promise<ReturnType<typeof normalizeDramaContentAnalysis>> {
    try {
        const call = await requestFunctionCall(
            input.origin,
            input.credential,
            input.candidate,
            input.model,
            input.messagesFor({ script, summary: input.summary }),
            input.userId,
            input.tool,
            systemAiIdempotencyKey("drama-analyze", input.userId, "content", input.requestId, segmentKey, script, input.candidate.channel.id, input.candidate.upstreamModel),
            (argumentsText) => hasUsableDramaToolArguments(argumentsText, input.tool.name),
            false,
            input.signal,
        );
        try {
            const parsed = JSON.parse(call.args);
            if (!hasCompleteDramaSourceCoverage(parsed, script)) throw new Error("模型返回的剧本原文不完整");
            const data = normalizeDramaContentAnalysis(parsed, input.durationPolicy, script);
            const issue = getDramaContentAnalysisIssue(data, script);
            if (issue) {
                // 只记录校验类型与数量，不将用户原稿或模型正文写入日志。
                console.error(
                    "[drama-analyze] content validation failed",
                    JSON.stringify({ requestId: input.requestId, channelId: input.candidate.channel.id, model: input.candidate.upstreamModel, segment: segmentKey, sourceLength: script.length, shotCount: data.shots.length, ...issue }),
                );
                throw new DramaContentValidationError(issue);
            }
            calls.push(call);
            return data;
        } catch (error) {
            if (hasSystemAiCharge(call)) await refund(input.userId, input.model, call);
            throw error;
        }
    } catch (error) {
        const split = splitDramaScriptAtBoundary(script);
        if (!split || !isAdaptiveContentError(error)) throw error;
        const left = await analyzeDramaScriptSegment(input, split[0], `${segmentKey}.0`, calls);
        const right = await analyzeDramaScriptSegment(input, split[1], `${segmentKey}.1`, calls);
        return mergeDramaContentAnalyses([left, right]);
    }
}

function isAdaptiveContentError(error: unknown) {
    const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
    const message = error instanceof Error ? error.message : "";
    return status === 413 || isStructuredTextFailure(error) || error instanceof DramaContentValidationError || message === "模型没有返回所需的结构化结果" || message === "模型没有返回结构化剧本结果" || message === "模型返回的剧本原文不完整";
}

class DramaContentValidationError extends Error {
    constructor(issue: NonNullable<ReturnType<typeof getDramaContentAnalysisIssue>>) {
        const messages = {
            "source-coverage": "内容拆镜未完成：镜头原文未完整覆盖剧本",
            "unattributed-dialogue": "内容拆镜未完成：部分对白未明确说话人",
            "missing-dialogue": "内容拆镜未完成：对白存在遗漏或顺序不一致",
            "unexpected-dialogue": "内容拆镜未完成：对白与对应原文不一致",
        };
        super(messages[issue.code]);
        this.name = "DramaContentValidationError";
    }
}

function hasCompleteDramaSourceCoverage(value: unknown, sourceScript: string) {
    const source = sourceScript.trim().replace(/\s/gu, "");
    const output = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const shots = "shots" in output && Array.isArray(output.shots) ? output.shots : [];
    const covered = shots
        .map((shot) => (shot && typeof shot === "object" && !Array.isArray(shot) && "sourceText" in shot && typeof shot.sourceText === "string" ? shot.sourceText : ""))
        .join("")
        .replace(/\s/gu, "");
    return Boolean(source && covered === source);
}

function readCallResult(args: string, headers: Headers) {
    const remaining = Number(headers.get("x-vozeb-pro-points-remaining"));
    return {
        args,
        pointsRemaining: Number.isFinite(remaining) ? remaining : undefined,
        ...readSystemAiBilling(headers),
    };
}

function describeArgumentsText(value: string) {
    if (!value) return { present: false };
    try {
        return { present: true, ...describeDramaAnalysisCandidate(JSON.parse(value)) };
    } catch {
        return { present: true, parseable: false };
    }
}

async function refund(userId: string, model: string, source: Headers | SystemAiBilling) {
    const billing = source instanceof Headers ? readSystemAiBilling(source) : source;
    return hasSystemAiCharge(billing) ? refundUserPoints(userId, model, billing.pointsCost, "text", 1, undefined, billing.pointsRecordId) : null;
}
