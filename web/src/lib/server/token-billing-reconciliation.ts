import { toPublicPointRecord } from "@/lib/auth/store-actions";
import { AuthInputError } from "@/lib/auth/store-foundation";
import { readAuthDb } from "@/lib/auth/store-repository";
import type { StoredPointRecord } from "@/lib/auth/store-types";
import { tokenUsagePoints, type TokenUsage } from "@/lib/model-billing";
import { createPostgresRepositories, ensurePostgresSchema, isPostgresDatabaseEnabled, postgresQuery } from "@/lib/server/database";
import { mapPointRecord } from "@/lib/server/database/repository-record-mappers";
import { settleTokenPoints } from "@/lib/server/points-wallet-service";

const STALE_RESERVATION_MS = 60 * 60 * 1000;

export function parseTokenReconciliation(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AuthInputError("核对内容必须是对象");
    const input = value as Record<string, unknown>;
    if (typeof input.recordId !== "string" || !input.recordId.trim() || input.recordId.length > 200) throw new AuthInputError("请选择有效的 Token 消费流水");
    if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1000) throw new AuthInputError("请填写核对依据，最多 1000 字");
    const usage: TokenUsage = { inputTokens: input.inputTokens as number, outputTokens: input.outputTokens as number, cachedInputTokens: input.cachedInputTokens as number };
    if (!Object.values(usage).every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0) || usage.cachedInputTokens > usage.inputTokens) throw new AuthInputError("Token 用量必须是非负整数，缓存用量不能超过总输入");
    return { recordId: input.recordId.trim(), reason: input.reason.trim(), usage };
}

export async function listPendingTokenSettlements() {
    let records: StoredPointRecord[];
    const staleBefore = new Date(Date.now() - STALE_RESERVATION_MS).toISOString();
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        const result = await postgresQuery("SELECT * FROM point_records WHERE type = 'consume' AND (token_billing->>'status' = 'usage-missing' OR (token_billing->>'status' = 'reserved' AND created_at < $1)) ORDER BY created_at ASC, id ASC LIMIT 50", [
            staleBefore,
        ]);
        records = result.rows.map(mapPointRecord);
    } else {
        records = (await readAuthDb()).pointRecords
            .filter((record) => record.type === "consume" && (record.tokenBilling?.status === "usage-missing" || (record.tokenBilling?.status === "reserved" && record.createdAt < staleBefore)))
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
            .slice(0, 50);
    }
    return records.map(toPublicPointRecord);
}

export async function reconcileTokenSettlement(input: ReturnType<typeof parseTokenReconciliation>) {
    let source: StoredPointRecord | null | undefined;
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        source = await createPostgresRepositories().points.getRecordById(input.recordId);
    } else source = (await readAuthDb()).pointRecords.find((record) => record.id === input.recordId);
    if (!source || source.type !== "consume" || source.sourceRecordId || !source.tokenBilling) throw new AuthInputError("Token 消费流水不存在");
    const billing = source.tokenBilling;
    const staleReservation = billing.status === "reserved" && Date.parse(source.createdAt) < Date.now() - STALE_RESERVATION_MS;
    if (billing.status !== "usage-missing" && !staleReservation) {
        const previous = billing.usage;
        if (billing.status !== "settled" || !previous || previous.inputTokens !== input.usage.inputTokens || previous.outputTokens !== input.usage.outputTokens || previous.cachedInputTokens !== input.usage.cachedInputTokens) {
            throw new AuthInputError("仅可补录待核对流水，已结算或已退款记录不能修改");
        }
    }
    try {
        tokenUsagePoints(billing.rule, input.usage);
    } catch (error) {
        throw new AuthInputError(error instanceof Error ? error.message : "Token 费用无效");
    }
    const settled = await settleTokenPoints({ userId: source.userId, sourceRecordId: source.id, usage: input.usage });
    return { record: toPublicPointRecord(settled.record), applied: settled.applied };
}
