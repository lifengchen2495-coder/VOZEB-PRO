export type TokenBillingRule = {
    mode: "token";
    inputPointsPerMillion: number;
    outputPointsPerMillion: number;
    cachedInputPointsPerMillion?: number;
    reservePoints: number;
};

export type ModelBillingRule = { mode: "request" } | TokenBillingRule;
export type ModelBillingRules = Record<string, ModelBillingRule>;

export type TokenUsage = {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
};

export type TokenBillingRecord = {
    rule: TokenBillingRule;
    status: "reserved" | "settled" | "usage-missing" | "refunded";
    reservedPoints: number;
    usageKind?: "api" | "image" | "video" | "audio" | "text";
    usage?: TokenUsage;
    actualPoints?: number;
    settledAt?: string;
    netDailyDebit?: number;
    netPermanentDebit?: number;
};

export function resolveModelBillingRule(rules: ModelBillingRules | undefined, model: string): ModelBillingRule {
    const name = model.trim().replace(/^.*::/, "").toLowerCase();
    const key = Object.keys(rules || {}).find((item) => item.trim().toLowerCase() === name);
    return (key ? rules?.[key] : undefined) || { mode: "request" };
}

export function tokenUsagePoints(rule: TokenBillingRule, usage: TokenUsage) {
    if (![usage.inputTokens, usage.outputTokens, usage.cachedInputTokens].every((value) => Number.isSafeInteger(value) && value >= 0) || usage.cachedInputTokens > usage.inputTokens) {
        throw new Error("上游 Token 用量无效");
    }
    const rates = [rule.inputPointsPerMillion, rule.cachedInputPointsPerMillion ?? rule.inputPointsPerMillion, rule.outputPointsPerMillion];
    if (!rates.every((value) => Number.isFinite(value) && value >= 0 && value <= 1_000_000)) throw new Error("Token 单价无效");
    // 单价保留六位小数，使用整数计算并向上取到 0.01 积分。
    const scaled = rates.map((value) => BigInt(Math.round(value * 1_000_000)));
    const total = BigInt(usage.inputTokens - usage.cachedInputTokens) * scaled[0] + BigInt(usage.cachedInputTokens) * scaled[1] + BigInt(usage.outputTokens) * scaled[2];
    const cents = (total + BigInt(9_999_999_999)) / BigInt(10_000_000_000);
    if (cents > BigInt(100_000_000)) throw new Error("Token 费用超出有效范围");
    return Number(cents) / 100;
}
