import { getAuthSettings, refundUserPoints } from "@/lib/auth/store";
import { REMAKE_FEISHU_PRODUCT_SCRIPT_PROMPT, REMAKE_FEISHU_STORYBOARD_SCRIPT_PROMPTS } from "@/lib/remake60-feishu-prompts";
import { toSafeGenerationErrorMessage } from "@/lib/server/generation-errors";
import { resolveLogicalModelCandidates } from "@/lib/server/logical-model-router";
import { completeRemakeProductScriptsForUser, getRemakeProjectForUser, RemakeProjectServiceError } from "@/lib/server/remake60-project-service";
import { buildRemakeScriptVisualBoards, RemakeProductionVisionError, requestRemakeProductionVisionPrompt, resolveRemakeProductionVisionProtocol } from "@/lib/server/remake60-production-vision-runtime";
import { hasSystemAiCharge, readSystemAiBilling, systemAiBillingHeaders, systemAiIdempotencyKey } from "@/lib/server/system-ai-billing";
import { rankTextPlanningCandidates } from "@/lib/server/text-planning-runtime";

type ScriptRequest = { userId: string; projectId: string; origin: string; cookie: string; expectedRevision?: number };
const pending = new Map<string, Promise<Awaited<ReturnType<typeof getRemakeProjectForUser>>>>();

export async function buildRemakeProductScriptsForUser(input: ScriptRequest) {
    const project = await getRemakeProjectForUser(input.userId, input.projectId);
    if (input.expectedRevision !== undefined && input.expectedRevision !== project.revision) throw new RemakeProjectServiceError("项目版本已变化，请刷新后重试", 409);
    if (project.analysis.status !== "completed" || project.analysis.mode !== "video" || project.frames.length !== 48 || project.frames.some((frame, index) => frame.ordinal !== index + 1 || frame.analysisStatus !== "available")) throw new RemakeProjectServiceError("请先完成 48 镜头解析", 409);
    if (!project.productInfo.trim() || !project.references.product?.url) throw new RemakeProjectServiceError("请先填写新产品信息并上传产品图", 409);
    if (project.groups.length !== 4 || project.groups.some((group) => !group.sourceContactSheet?.url)) throw new RemakeProjectServiceError("原视频四组十二宫格尚未完成", 409);
    if (project.groups.some((group) => [group.replacementGeneration.status, group.imageGeneration.status, group.videoGeneration.status].some((status) => status === "running" || status === "queued"))) throw new RemakeProjectServiceError("请等待当前图片或视频任务完成后再更新脚本", 409);
    const key = JSON.stringify([input.userId, project.id, project.revision]);
    const existing = pending.get(key);
    if (existing) return existing;
    const operation = generateScripts(input, project).finally(() => pending.delete(key));
    pending.set(key, operation);
    return operation;
}

async function generateScripts(input: ScriptRequest, project: Awaited<ReturnType<typeof getRemakeProjectForUser>>) {
    const settings = await getAuthSettings();
    const model = project.modelSelection.prompt || settings.defaultModels.textModel;
    const requiredImages = project.references.character ? 2 : 1;
    const candidates = model ? rankTextPlanningCandidates(resolveLogicalModelCandidates(settings, "text", model)).filter((candidate) => resolveRemakeProductionVisionProtocol(candidate, requiredImages) !== null) : [];
    if (!candidates.length) throw new RemakeProjectServiceError("请先选择支持参考图片的 Prompt 文本模型", 503);
    const completedCharges: Array<{ headers: Headers; key: string }> = [];
    async function refund(headers: Headers, key: string) {
        const billing = readSystemAiBilling(headers);
        if (hasSystemAiCharge(billing)) await refundUserPoints(input.userId, model, billing.pointsCost, "text", 1, `${key}:refund`, billing.pointsRecordId);
    }
    async function generate(stage: string, systemPrompt: string, context: Record<string, unknown>, references: Parameters<typeof buildRemakeScriptVisualBoards>[0]["references"], start = 1, end = 48) {
        const boards = await buildRemakeScriptVisualBoards({ origin: input.origin, cookie: input.cookie, references });
        let latestError: unknown;
        for (const candidate of candidates) {
            const key = systemAiIdempotencyKey("remake60-script", input.userId, project.id, String(project.revision), stage, candidate.channelId, candidate.upstreamModel);
            let headers: Headers | undefined;
            try {
                const call = await requestRemakeProductionVisionPrompt({
                    origin: input.origin,
                    cookie: input.cookie,
                    candidate,
                    boards,
                    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: JSON.stringify({ ...context, "图片附件位置": boards.map(({ ordinal, description }) => ({ ordinal, description })) }) }],
                    headers: { "Content-Type": "application/json", "Idempotency-Key": key, "X-Client-Request-Id": key, ...systemAiBillingHeaders(model, key, candidate.upstreamModel) },
                });
                headers = call.headers;
                assertRemakeShotScript(call.text, start, end);
                completedCharges.push({ headers, key });
                return call.text;
            } catch (error) {
                const chargedHeaders = headers || (error instanceof RemakeProductionVisionError ? error.responseHeaders : undefined);
                if (chargedHeaders) await refund(chargedHeaders, key);
                latestError = error;
            }
        }
        throw new RemakeProjectServiceError(toSafeGenerationErrorMessage(latestError, "未能生成完整的分镜脚本"), 422);
    }
    try {
        const productScript = await generate("product-script", REMAKE_FEISHU_PRODUCT_SCRIPT_PROMPT, {
            "产品信息": project.productInfo,
            "48镜头解析": project.frames,
            "人物图是否提供": Boolean(project.references.character?.url),
        }, [
            ...(project.references.character ? [{ role: "character" as const, label: "人物图", asset: project.references.character }] : []),
            { role: "product", label: "产品图", asset: project.references.product! },
        ]);
        const scripts: string[] = [];
        for (const group of project.groups) {
            const [start, end] = group.id.split("-").map(Number);
            scripts.push(await generate(`storyboard-script:${group.id}`, REMAKE_FEISHU_STORYBOARD_SCRIPT_PROMPTS[group.id], { "新产品-48分镜脚本": productScript, "当前分镜范围": group.id }, [], start, end));
        }
        const storyboardScript = scripts.join("\n\n---\n\n");
        return await completeRemakeProductScriptsForUser(input.userId, project.id, { expectedRevision: project.revision, productScript, storyboardScript });
    } catch (error) {
        // 全片产品脚本与四组分镜脚本一起交付，失败或素材被替换时退回本次已完成调用的费用。
        for (const charge of completedCharges) await refund(charge.headers, charge.key);
        if (error instanceof RemakeProjectServiceError) throw error;
        throw new RemakeProjectServiceError(toSafeGenerationErrorMessage(error, "产品脚本生成失败"), error instanceof RemakeProductionVisionError ? error.status : 502);
    }
}

export function assertRemakeShotScript(value: string, start = 1, end = 48) {
    if (!value.trim() || value.length > 100_000) throw new Error("分镜脚本为空或超过长度上限");
    const ordinals = Array.from(value.matchAll(/(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?分镜\s*(\d+)\s*(?:\*\*)?\s*[:：]/gu), (match) => Number(match[1]));
    if (ordinals.length !== end - start + 1 || ordinals.some((ordinal, index) => ordinal !== index + start)) throw new Error(`分镜脚本必须依次包含分镜 ${start} 至分镜 ${end}，不能缺失、重复或乱序`);
}
