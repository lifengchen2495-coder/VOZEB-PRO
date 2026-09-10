import { hasInsufficientPointsError } from "@/lib/creative-generation-status";
import { readProviderError } from "@/lib/server/provider-task-config";
import { GenerationSubmissionUncertainError } from "@/lib/server/generation-submission-error";

export const DEFAULT_CHANNEL_CONNECT_ERROR = "生成渠道暂时无法连接，请稍后重试或联系管理员。";
export const UNKNOWN_SUBMISSION_REVIEW_ERROR = "上游提交结果不确定，未取得可查询的任务 ID；为避免重复生成和扣费，系统已停止自动重试。";

type TransportPhase = "request" | "response";
type TransportFailure = { code: string; status: number; message: string };

export function toSafeGenerationErrorMessage(error: unknown, fallback: string, httpStatus?: number) {
    const message = generationErrorMessage(error);
    if (hasInsufficientPointsError(error)) return "积分不足";
    const transport = classifyTransportError(error);
    if (transport) return transport.message;
    if (!message.trim() || isHtmlGatewayError(message)) {
        if (httpStatus === 504) return "生成渠道网关等待响应超时（HTTP 504），请稍后重试或联系管理员。";
        if (httpStatus === 503) return "生成渠道服务暂不可用（HTTP 503），请稍后重试。";
        if (httpStatus === 502) return "生成渠道网关返回异常（HTTP 502），请联系管理员检查上游服务。";
        if (message.trim()) return DEFAULT_CHANNEL_CONNECT_ERROR;
    }
    if (isTimeoutError(error, message)) return "生成接口响应超时，请稍后重试或检查模型服务。";
    if (isFetchNetworkError(error, message)) return DEFAULT_CHANNEL_CONNECT_ERROR;
    if (containsInfrastructureDetails(message)) return /参考|素材|公网/i.test(message) ? "参考素材暂时无法提交给当前生成渠道，请重新上传或稍后重试。" : DEFAULT_CHANNEL_CONNECT_ERROR;
    return message || fallback;
}

export function toSafeGenerationTransportError(error: unknown, phase: TransportPhase): TransportFailure {
    const transport = classifyTransportError(error, phase);
    if (transport) return transport;
    if (isTimeoutError(error, generationErrorMessage(error))) return responseTimeout();
    if (phase === "response" && error instanceof SyntaxError) return { code: "invalid_response_json", status: 502, message: "生成接口返回了无效 JSON，请联系管理员检查渠道响应。" };
    return phase === "response" ? { code: "response_processing_failed", status: 502, message: "生成接口响应处理失败，请联系管理员查看错误记录。" } : { code: "request_failed", status: 502, message: DEFAULT_CHANNEL_CONNECT_ERROR };
}

export function toSafeGenerationReviewReason(error: unknown, fallback: string) {
    if (error instanceof GenerationSubmissionUncertainError) return UNKNOWN_SUBMISSION_REVIEW_ERROR;
    return toSafeGenerationErrorMessage(error, fallback);
}

function generationErrorMessage(error: unknown) {
    const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    if (!raw.trim().startsWith("{")) return raw;
    try {
        return readProviderError(JSON.parse(raw)) || raw;
    } catch {
        return raw;
    }
}

function isHtmlGatewayError(message: string) {
    return /<!doctype\s+html|<html\b|<head>\s*<title>\s*\d{3}\b|<center>\s*<h1>\s*\d{3}\b|\bnginx\b/i.test(message);
}

function containsInfrastructureDetails(message: string) {
    return /https?:\/\/|\blocalhost\b|\b127\.0\.0\.1\b|next_public_site_url|base\s*url|api\s*key|\bdns\b|\beconn\w*\b|\benotfound\b|服务器网络|https\s*证书|代理配置/i.test(message);
}

function isTimeoutError(error: unknown, message: string) {
    const lower = message.toLowerCase();
    if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("aborted due to timeout")) return true;
    if (!(error instanceof Error)) return false;
    return error.name === "TimeoutError";
}

function isFetchNetworkError(error: unknown, message: string) {
    if (message.toLowerCase() === "fetch failed") return true;
    if (!(error instanceof TypeError)) return false;
    const cause = "cause" in error ? error.cause : undefined;
    if (!cause || typeof cause !== "object") return false;
    const code = "code" in cause ? String(cause.code) : "";
    return ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(code);
}

function classifyTransportError(error: unknown, phase?: TransportPhase): TransportFailure | undefined {
    // 只读取有限层 cause 的标准错误代码，避免输出地址、认证信息和原始响应。
    const seen = new Set<object>();
    let current = error;
    let aborted = false;
    let timedOut = false;
    for (let depth = 0; current && typeof current === "object" && depth < 8 && !seen.has(current); depth += 1) {
        seen.add(current);
        const code = "code" in current && typeof current.code === "string" ? current.code : "";
        if (code === "UND_ERR_CONNECT_TIMEOUT") return { code: "connect_timeout", status: 504, message: "生成接口连接超时，请稍后重试或联系管理员检查渠道连接。" };
        if (["ETIMEDOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code)) return responseTimeout();
        if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) return { code: "name_resolution_failed", status: 502, message: "生成接口域名解析失败，请联系管理员检查渠道地址。" };
        if (code === "ECONNREFUSED") return { code: "connection_refused", status: 502, message: "生成接口拒绝连接，请联系管理员检查渠道服务。" };
        if (["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(code)) return { code: "connection_interrupted", status: 502, message: phase === "response" ? "生成接口响应传输中断，请稍后重试。" : "生成接口连接中断，请稍后重试。" };
        if (["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(code))
            return { code: "certificate_validation_failed", status: 502, message: "生成接口证书验证失败，请联系管理员检查渠道证书。" };
        if ("name" in current && current.name === "TimeoutError") timedOut = true;
        if ("name" in current && current.name === "AbortError") aborted = true;
        current = "cause" in current ? current.cause : undefined;
    }
    if (timedOut) return responseTimeout();
    if (aborted) return { code: "request_aborted", status: 499, message: "生成请求已取消或被中止，请检查任务状态。" };
    return undefined;
}

function responseTimeout(): TransportFailure {
    return { code: "response_timeout", status: 504, message: "生成接口响应超时，请稍后重试或检查模型服务。" };
}
