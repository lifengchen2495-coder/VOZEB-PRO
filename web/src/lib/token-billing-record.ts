import { tokenUsagePoints, type TokenBillingRecord } from "@/lib/model-billing";

export function normalizeTokenBillingRecord(value: unknown): TokenBillingRecord | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as TokenBillingRecord;
    const rule = record.rule;
    if (!rule || rule.mode !== "token" || !["reserved", "settled", "usage-missing", "refunded"].includes(record.status)) return undefined;
    if (![rule.inputPointsPerMillion, rule.outputPointsPerMillion, rule.reservePoints, record.reservedPoints, rule.cachedInputPointsPerMillion ?? 0].every((item) => Number.isFinite(item) && item >= 0)) return undefined;
    if ([record.actualPoints, record.netDailyDebit, record.netPermanentDebit].some((item) => item !== undefined && (!Number.isFinite(item) || item < 0))) return undefined;
    try {
        if (record.usage) tokenUsagePoints(rule, record.usage);
    } catch {
        return undefined;
    }
    return structuredClone(record);
}
