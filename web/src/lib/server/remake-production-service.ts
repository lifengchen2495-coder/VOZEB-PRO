import { getAuthSettings, refundUserPoints } from "@/lib/auth/store";
import { toSafeGenerationErrorMessage } from "@/lib/server/generation-errors";
import { resolveLogicalModelCandidates } from "@/lib/server/logical-model-router";
import { isRemakeNoNarrationCopy } from "@/lib/server/remake-project-contract";
import { remakeProductionMessages, remakeProductionTool, parseRemakeProductionPlan, renderRemakeCopyReport, renderRemakeSeedancePrompts } from "@/lib/server/remake-production-prompt";
import { assertRemakeImageGenerationsForUser, completeRemakeProductionForUser, getRemakeProjectForUser, RemakeProjectServiceError } from "@/lib/server/remake-project-service";
import { buildRemakeProductionVisualBoards, RemakeProductionVisionError, requestRemakeProductionVisionPlan, resolveRemakeProductionVisionProtocol } from "@/lib/server/remake-production-vision-runtime";
import { hasSystemAiCharge, readSystemAiBilling, systemAiBillingHeaders, systemAiIdempotencyKey } from "@/lib/server/system-ai-billing";
import { rankTextPlanningCandidates } from "@/lib/server/text-planning-runtime";

export class RemakeProductionError extends Error {
    constructor(
        message: string,
        readonly status = 422,
    ) {
        super(message);
        this.name = "RemakeProductionError";
    }
}

export async function buildRemakeProductionForUser(input: { userId: string; projectId: string; origin: string; cookie: string; expectedRevision?: number }) {
    const project = await getRemakeProjectForUser(input.userId, input.projectId);
    if (input.expectedRevision !== undefined && project.revision !== input.expectedRevision) throw new RemakeProjectServiceError("复刻项目已在其他页面更新，请刷新后重试", 409);
    await assertProductionReady(input.userId, project);
    const hasNarration = !isRemakeNoNarrationCopy(project.sourceCopy);

    const settings = await getAuthSettings();
    const model = project.modelSelection.prompt || settings.defaultModels.textModel;
    const candidates = model ? rankTextPlanningCandidates(resolveLogicalModelCandidates(settings, "text", model)).filter((candidate) => resolveRemakeProductionVisionProtocol(candidate) !== null) : [];
    if (!model) throw new RemakeProductionError("请先选择可用的 Prompt 文本模型", 503);
    if (!candidates.length) throw new RemakeProductionError("所选 Prompt 文本模型没有启用参考图片能力，或未使用 Chat、Responses、Gemini 多模态协议", 503);

    let visualBoards: Awaited<ReturnType<typeof buildRemakeProductionVisualBoards>>;
    try {
        visualBoards = await buildRemakeProductionVisualBoards({
            origin: input.origin,
            cookie: input.cookie,
            character: project.references.character,
            characterSupplement: project.references.characterSupplement,
            product: project.references.product!,
            redrawnContactSheets: project.groups.map((group) => ({
                groupOrdinal: group.ordinal,
                frameOrdinals: group.frameOrdinals,
                asset: group.imageGeneration.result!,
            })),
        });
    } catch (error) {
        if (error instanceof RemakeProductionVisionError) throw new RemakeProductionError(error.message, error.status);
        throw new RemakeProductionError(toSafeGenerationErrorMessage(error, "人物、产品图或最终十二宫格读取失败，无法执行真实视觉规划"), 502);
    }

    const messages = remakeProductionMessages({
        title: project.title,
        hasNarration,
        ...(hasNarration ? { voice: project.voice as "female" | "male" } : {}),
        frames: project.frames.map((frame) => ({
            ordinal: frame.ordinal,
            subtitle: frame.subtitle,
            sellingPoint: frame.sellingPoint,
            shotType: frame.shotType,
            description: frame.description,
        })),
        copyBlocks: project.copyBlocks.map((block) => ({ ordinal: block.ordinal, frameOrdinals: block.frameOrdinals, sourceText: block.sourceText, text: block.text })),
        referenceAssets: {
            character: productionAssetMetadata(project.references.character),
            characterSupplement: productionAssetMetadata(project.references.characterSupplement),
            product: productionAssetMetadata(project.references.product),
            audio: productionAssetMetadata(project.references.audio),
        },
        contactSheets: project.groups.map((group) => ({
            groupOrdinal: group.ordinal,
            frameOrdinals: group.frameOrdinals,
            sourceContactSheet: productionAssetMetadata(group.sourceContactSheet),
            redrawnContactSheet: productionAssetMetadata(group.imageGeneration.result),
        })),
        visualBoards: visualBoards.map((board) => ({
            ordinal: board.ordinal,
            id: board.id,
            description: board.description,
            layout: board.layout,
        })),
    });
    let latestError: unknown;
    for (const candidate of candidates) {
        const idempotencyKey = systemAiIdempotencyKey("remake-production", input.userId, project.id, String(project.revision), candidate.channelId, candidate.upstreamModel);
        let chargedHeaders: Headers | undefined;
        let refunded = false;
        try {
            const call = await requestRemakeProductionVisionPlan({
                origin: input.origin,
                cookie: input.cookie,
                candidate,
                messages,
                boards: visualBoards,
                tool: remakeProductionTool,
                headers: {
                    "Content-Type": "application/json",
                    "Idempotency-Key": idempotencyKey,
                    "X-Client-Request-Id": idempotencyKey,
                    ...systemAiBillingHeaders(model, idempotencyKey, candidate.upstreamModel),
                },
                validateArguments: (value) => Boolean(parseRemakeProductionPlan(value)),
            });
            chargedHeaders = call.headers;
            const plan = parseRemakeProductionPlan(call.arguments);
            if (!plan) {
                await refundInvalidResponse(input.userId, model, call.headers, `${idempotencyKey}:refund`);
                refunded = true;
                throw new RemakeProductionError("文本模型没有返回完整的四组视频结构");
            }
            const prompts = renderRemakeSeedancePrompts({
                plan,
                copyBlocks: project.copyBlocks.map((block) => ({ ordinal: block.ordinal, frameOrdinals: block.frameOrdinals, sourceText: block.sourceText, text: block.text })),
                hasNarration,
            });
            const rawReport = renderRemakeCopyReport({
                sourceCopy: project.sourceCopy,
                blocks: project.copyBlocks.map((block) => ({ ordinal: block.ordinal, frameOrdinals: block.frameOrdinals, sourceText: block.sourceText, text: block.text })),
                optionRaw: project.copy.optionRaw,
                rawReport: project.copy.rawReport,
                paragraphs: project.copy.paragraphs,
                mappings: project.copy.mappings,
                checks: project.copy.checks,
                stats: project.copy.stats,
            });
            return await completeRemakeProductionForUser(input.userId, project.id, {
                expectedRevision: project.revision,
                copy: {
                    ...project.copy,
                    status: "completed",
                    optionRaw: project.copy.optionRaw || (hasNarration ? "A: 保持原文案" : "不需要人物口播"),
                    rawReport,
                    checks: { sequential: true, noDuplicates: true, noSkips: true },
                    error: undefined,
                },
                copyBlocks: project.copyBlocks,
                videoPrompts: prompts.map((prompt) => ({ groupOrdinal: prompt.ordinal, prompt: prompt.text })),
            });
        } catch (error) {
            const responseHeaders = chargedHeaders || (error instanceof RemakeProductionVisionError ? error.responseHeaders : undefined);
            if (responseHeaders && !refunded) await refundInvalidResponse(input.userId, model, responseHeaders, `${idempotencyKey}:refund`);
            if (error instanceof RemakeProjectServiceError) throw error;
            latestError = error;
        }
    }
    throw new RemakeProductionError(toSafeGenerationErrorMessage(latestError, "生产包生成失败，请稍后重试"));
}

async function assertProductionReady(userId: string, project: Awaited<ReturnType<typeof getRemakeProjectForUser>>) {
    if (project.analysis.status !== "completed" || project.analysis.mode !== "video" || project.frames.length !== 48 || project.frames.some((frame, index) => frame.ordinal !== index + 1 || frame.analysisStatus !== "available")) {
        throw new RemakeProductionError("请先使用视频理解完成全部 48 个镜头解析", 409);
    }
    const hasNarration = !isRemakeNoNarrationCopy(project.sourceCopy);
    if (project.copyBlocks.length !== 16 || project.copyBlocks.some((block, index) => block.ordinal !== index + 1 || (hasNarration ? !block.sourceText.trim() || !block.text.trim() : Boolean(block.sourceText.trim() || block.text.trim())))) {
        throw new RemakeProductionError("请先完成 16 个语义文案区间", 409);
    }
    if (project.copy.status !== "completed" || !project.copy.checks.sequential || !project.copy.checks.noDuplicates || !project.copy.checks.noSkips) {
        throw new RemakeProductionError("文案语义切分尚未通过顺序、重复和跳跃检查", 409);
    }
    try {
        renderRemakeCopyReport({
            sourceCopy: project.sourceCopy,
            blocks: project.copyBlocks.map((block) => ({ ordinal: block.ordinal, frameOrdinals: block.frameOrdinals, sourceText: block.sourceText, text: block.text })),
            optionRaw: project.copy.optionRaw,
            rawReport: project.copy.rawReport,
            paragraphs: project.copy.paragraphs,
            mappings: project.copy.mappings,
            checks: project.copy.checks,
            stats: project.copy.stats,
        });
    } catch (error) {
        throw new RemakeProductionError(error instanceof Error ? error.message : "16 个文案区间未完整覆盖原文案", 409);
    }
    if (!project.references.product) {
        throw new RemakeProductionError("请先上传新产品图", 409);
    }
    if (hasNarration && !project.references.audio) throw new RemakeProductionError("原视频音频尚未提取，请重新执行视频理解", 409);
    if (hasNarration && project.voice !== "female" && project.voice !== "male") throw new RemakeProductionError("请选择男性配音或女性配音", 409);
    if (project.groups.length !== 4 || project.groups.some((group) => !group.sourceContactSheet || group.imageGeneration.status !== "completed" || !group.imageGeneration.result)) {
        throw new RemakeProductionError("请先完成四组清理换人和换品十二宫格生图", 409);
    }
    await assertRemakeImageGenerationsForUser(userId, project);
}

async function refundInvalidResponse(userId: string, model: string, headers: Headers, idempotencyKey?: string) {
    const billing = readSystemAiBilling(headers);
    if (hasSystemAiCharge(billing)) await refundUserPoints(userId, model, billing.pointsCost, "text", 1, idempotencyKey, billing.pointsRecordId);
}

function productionAssetMetadata(asset: { mimeType: string; originalName?: string; width?: number; height?: number } | undefined) {
    if (!asset) return { available: false };
    return {
        available: true,
        mimeType: asset.mimeType,
        ...(asset.originalName ? { originalName: asset.originalName } : {}),
        ...(asset.width ? { width: asset.width } : {}),
        ...(asset.height ? { height: asset.height } : {}),
    };
}
