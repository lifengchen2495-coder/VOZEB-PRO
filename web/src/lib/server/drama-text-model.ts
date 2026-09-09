import type { AuthSettings } from "@/lib/auth/store";
import { resolveLogicalModelCandidates } from "@/lib/server/logical-model-router";

export class DramaTextModelError extends Error {
    readonly status = 400;
}

export function resolveDramaTextModel(settings: Pick<AuthSettings, "defaultModels" | "logicalModels" | "systemChannels">, requestedModel?: unknown) {
    const explicit = requestedModel !== undefined;
    if (explicit && (typeof requestedModel !== "string" || !requestedModel.trim() || requestedModel.length > 200)) throw new DramaTextModelError("请选择有效的文本模型");
    const model = explicit ? (requestedModel as string).trim() : settings.defaultModels.textModel;
    const candidates = resolveLogicalModelCandidates(settings, "text", model);
    if (!model || !candidates.length) throw new DramaTextModelError(explicit ? "所选文本模型不可用，请重新选择" : "后台尚未配置可用的默认文本模型");
    return { model, candidates };
}
