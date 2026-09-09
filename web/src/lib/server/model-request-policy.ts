import type { LogicalModelCapability, LogicalModelCapabilityProfile, SystemChannelProtocol } from "@/lib/auth/store";

const MIN_REQUEST_TIMEOUT_MS = 5_000;
const MAX_REQUEST_TIMEOUT_MS = 30 * 60_000;
export const TEXT_MODEL_REQUEST_TIMEOUT_MS = 3 * 60_000;

export const DEFAULT_MODEL_REQUEST_TIMEOUT_MS: Record<LogicalModelCapability, number> = {
    text: TEXT_MODEL_REQUEST_TIMEOUT_MS,
    image: 10 * 60_000,
    video: 30 * 60_000,
    audio: 3 * 60_000,
};

type ModelRequestPolicyConfig = { capabilityProfile?: Pick<LogicalModelCapabilityProfile, "timeoutMs">; advancedConfig?: { protocol?: SystemChannelProtocol } };

export function resolveModelRequestTimeoutMs(config: ModelRequestPolicyConfig | undefined, capability: LogicalModelCapability) {
    if (capability === "text") return TEXT_MODEL_REQUEST_TIMEOUT_MS;
    const configured = Math.floor(Number(config?.capabilityProfile?.timeoutMs));
    if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_MODEL_REQUEST_TIMEOUT_MS[capability];
    return Math.max(MIN_REQUEST_TIMEOUT_MS, Math.min(MAX_REQUEST_TIMEOUT_MS, configured));
}

export function resolveModelPollingAttempts(config: ModelRequestPolicyConfig | undefined, capability: LogicalModelCapability, intervalMs: number, minimumAttempts: number) {
    return Math.max(minimumAttempts, Math.ceil(resolveModelRequestTimeoutMs(config, capability) / intervalMs));
}

export function resolveModelTaskPollingWindowMs(config: ModelRequestPolicyConfig | undefined, capability: LogicalModelCapability) {
    // 汇风视频文档给出的常见耗时为 5–60 分钟；总轮询窗口与单次 HTTP 超时分别控制。
    return capability === "video" && config?.advancedConfig?.protocol === "huifeng" ? 75 * 60_000 : resolveModelRequestTimeoutMs(config, capability);
}
