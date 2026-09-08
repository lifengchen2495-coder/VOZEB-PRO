import type { ModelBillingRules } from "./model-billing";

export const MAX_MODEL_BILLING_POINTS = 1_000_000;

export function normalizeModelBillingRules(value: unknown): ModelBillingRules {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("模型计费规则必须是对象");
    const entries = Object.entries(value);
    if (entries.length > 5000) throw new Error("模型计费规则最多支持 5000 个模型");
    const result: ModelBillingRules = {};
    const names = new Set<string>();
    for (const [rawModel, rawRule] of entries) {
        const model = rawModel.trim();
        if (!model || model.length > 200 || ["__proto__", "constructor", "prototype", "*"].includes(model.toLowerCase()) || model.includes("::")) throw new Error("模型计费规则需要有效的模型 ID");
        if (names.has(model.toLowerCase())) throw new Error(`模型 ${model} 的计费规则重复`);
        names.add(model.toLowerCase());
        if (!rawRule || typeof rawRule !== "object" || Array.isArray(rawRule)) throw new Error(`模型 ${model} 的计费规则无效`);
        const rule = rawRule as Record<string, unknown>;
        if (rule.mode === "request") {
            result[model] = { mode: "request" };
            continue;
        }
        if (rule.mode !== "token") throw new Error(`模型 ${model} 的计费模式必须为按次或按 Token`);
        const inputPointsPerMillion = validPrice(rule.inputPointsPerMillion, `${model} 输入单价`);
        const outputPointsPerMillion = validPrice(rule.outputPointsPerMillion, `${model} 输出单价`);
        const reservePoints = validPrice(rule.reservePoints, `${model} 预扣积分`);
        if (reservePoints < 0.01 || reservePoints !== Number(reservePoints.toFixed(2))) throw new Error(`模型 ${model} 的预扣积分至少为 0.01，且最多保留两位小数`);
        const cachedInputPointsPerMillion = rule.cachedInputPointsPerMillion === undefined ? undefined : validPrice(rule.cachedInputPointsPerMillion, `${model} 缓存输入单价`);
        result[model] = { mode: "token", inputPointsPerMillion, outputPointsPerMillion, reservePoints, ...(cachedInputPointsPerMillion === undefined ? {} : { cachedInputPointsPerMillion }) };
    }
    return result;
}

function validPrice(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_MODEL_BILLING_POINTS) throw new Error(`${label}必须为 0 至 ${MAX_MODEL_BILLING_POINTS} 的有效数字`);
    if (value !== Number(value.toFixed(6)) || (value > 0 && value < 0.000001)) throw new Error(`${label}最多保留六位小数`);
    return value;
}
