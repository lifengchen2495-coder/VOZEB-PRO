import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SYSTEM_AI_LOGICAL_MODEL_HEADER = "x-vozeb-pro-logical-model";
export const SYSTEM_AI_POINTS_IDEMPOTENCY_HEADER = "x-vozeb-pro-points-idempotency-key";
export const SYSTEM_AI_POINTS_SIGNATURE_HEADER = "x-vozeb-pro-points-signature";
export const SYSTEM_AI_UPSTREAM_MODEL_HEADER = "x-vozeb-pro-upstream-model";
export const SYSTEM_AI_VIDEO_BILLING_HEADER = "x-vozeb-pro-video-billing";

const SYSTEM_AI_POINTS_SIGNATURE_VERSION = "v1";
const SYSTEM_AI_POINTS_PROCESS_SECRET = "__vozebProSystemAiPointsProcessSecret" as const;

export type SystemAiBilling = {
    pointsCost?: number;
    pointsRecordId?: string;
};

export type SystemAiVideoBillingParameters = { durationSeconds: number; resolution: string };

export function systemAiBillingHeaders(logicalModel: string, idempotencyKey?: string, upstreamModel?: string, videoBilling?: SystemAiVideoBillingParameters) {
    const normalizedLogicalModel = logicalModel.trim();
    const normalizedIdempotencyKey = idempotencyKey?.trim();
    const normalizedUpstreamModel = upstreamModel?.trim();
    const videoPayload = videoBilling ? encodeVideoBillingParameters(videoBilling) : "";
    if (videoPayload && (!normalizedLogicalModel || !normalizedIdempotencyKey || !normalizedUpstreamModel)) throw new Error("视频计费参数缺少任务身份");
    return {
        ...(normalizedLogicalModel ? { [SYSTEM_AI_LOGICAL_MODEL_HEADER]: normalizedLogicalModel } : {}),
        ...(normalizedIdempotencyKey
            ? {
                  [SYSTEM_AI_POINTS_IDEMPOTENCY_HEADER]: normalizedIdempotencyKey,
                  [SYSTEM_AI_POINTS_SIGNATURE_HEADER]: signSystemAiBusinessRequest(normalizedLogicalModel, normalizedIdempotencyKey, normalizedUpstreamModel || "", videoPayload),
              }
            : {}),
        ...(normalizedUpstreamModel ? { [SYSTEM_AI_UPSTREAM_MODEL_HEADER]: normalizedUpstreamModel } : {}),
        ...(videoPayload ? { [SYSTEM_AI_VIDEO_BILLING_HEADER]: videoPayload } : {}),
    };
}

export function readVerifiedSystemAiBusinessRequestId(headers: Headers, logicalModel: string, upstreamModel: string) {
    const businessRequestId = headers.get(SYSTEM_AI_POINTS_IDEMPOTENCY_HEADER)?.trim().slice(0, 200) || "";
    const signature = headers.get(SYSTEM_AI_POINTS_SIGNATURE_HEADER)?.trim() || "";
    if (!businessRequestId || !signature) return undefined;
    const expected = signSystemAiBusinessRequest(logicalModel.trim(), businessRequestId, upstreamModel.trim(), headers.get(SYSTEM_AI_VIDEO_BILLING_HEADER) || "");
    const receivedBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    if (receivedBytes.length !== expectedBytes.length || !timingSafeEqual(receivedBytes, expectedBytes)) return undefined;
    return businessRequestId;
}

export function readVerifiedSystemAiVideoBillingParameters(headers: Headers, logicalModel: string, upstreamModel: string): SystemAiVideoBillingParameters | undefined {
    const payload = headers.get(SYSTEM_AI_VIDEO_BILLING_HEADER);
    if (payload === null) return undefined;
    if (!payload || payload.length > 512 || !/^[A-Za-z0-9_-]+$/.test(payload) || !readVerifiedSystemAiBusinessRequestId(headers, logicalModel, upstreamModel)) throw new Error("视频计费参数签名无效，请从项目重新提交");
    try {
        const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SystemAiVideoBillingParameters;
        if (encodeVideoBillingParameters(parsed) !== payload) throw new Error("invalid");
        return parsed;
    } catch {
        throw new Error("视频计费参数格式无效，请从项目重新提交");
    }
}

function encodeVideoBillingParameters(value: SystemAiVideoBillingParameters) {
    if (!value || !Number.isFinite(value.durationSeconds) || value.durationSeconds <= 0 || typeof value.resolution !== "string" || !/^(?:480|720|1080|2160)p?$|^4k$/i.test(value.resolution.trim())) throw new Error("视频计费参数格式无效");
    return Buffer.from(JSON.stringify({ durationSeconds: value.durationSeconds, resolution: value.resolution.trim().toUpperCase() }), "utf8").toString("base64url");
}

export function systemAiPointsIdempotencyKey(input: { userId: string; businessRequestId: string; logicalModel: string; channelId: string; upstreamModel: string; callType: string }) {
    return `system-ai:${stableDigest([input.userId, input.businessRequestId, input.logicalModel, input.channelId, input.upstreamModel, input.callType])}`;
}

export function systemAiRequestFingerprint(input: { method: string; callType: string; logicalModel: string; channelId: string; upstreamModel: string; usageKind: string; amount: number; bodyDigest: string }) {
    return stableDigest([input.method.toUpperCase(), input.callType, input.logicalModel, input.channelId, input.upstreamModel, input.usageKind, String(input.amount), input.bodyDigest]);
}

export function systemAiIdempotencyKey(scope: string, ...parts: string[]) {
    const prefix =
        scope
            .trim()
            .replace(/[^a-zA-Z0-9._-]+/g, "-")
            .slice(0, 40) || "system-ai";
    const digest = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
    return `${prefix}:${digest}`;
}

function signSystemAiBusinessRequest(logicalModel: string, businessRequestId: string, upstreamModel: string, videoPayload = "") {
    return createHmac("sha256", systemAiPointsSigningSecret())
        .update([videoPayload ? "v2" : SYSTEM_AI_POINTS_SIGNATURE_VERSION, normalizeBillingModel(logicalModel), businessRequestId, normalizeBillingModel(upstreamModel), ...(videoPayload ? [videoPayload] : [])].join("\0"))
        .digest("base64url");
}

function stableDigest(parts: string[]) {
    return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function normalizeBillingModel(value: string) {
    return value
        .trim()
        .replace(/^models\//i, "")
        .toLowerCase();
}

function systemAiPointsSigningSecret() {
    const configured = process.env.VOZEB_PRO_ENCRYPTION_KEY?.trim();
    if (configured) return configured;
    const scope = globalThis as typeof globalThis & { __vozebProSystemAiPointsProcessSecret?: Buffer };
    scope[SYSTEM_AI_POINTS_PROCESS_SECRET] ||= randomBytes(32);
    return scope[SYSTEM_AI_POINTS_PROCESS_SECRET];
}

export function readSystemAiBilling(headers: Headers): SystemAiBilling {
    const rawCost = headers.get("x-vozeb-pro-points-cost");
    const cost = rawCost === null ? undefined : Number(rawCost);
    return {
        pointsCost: cost !== undefined && Number.isFinite(cost) && cost >= 0 ? cost : undefined,
        pointsRecordId: headers.get("x-vozeb-pro-points-record-id") || undefined,
    };
}

export function hasSystemAiCharge(billing: SystemAiBilling): billing is Required<SystemAiBilling> {
    return billing.pointsCost !== undefined && Boolean(billing.pointsRecordId);
}
