import { fetchInternalApi } from "@/lib/server/internal-origin";
import { maintenanceWorkerContextHeaders } from "@/lib/server/maintenance-auth";
import { fetchSafeOutbound, UnsafeOutboundUrlError } from "@/lib/server/safe-outbound-fetch";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_INTERNAL_REDIRECTS = 3;

export async function fetchRemakeProductionImage(url: string, input: { internal: boolean; cookie: string }): Promise<Response> {
    const signal = AbortSignal.timeout(30_000);
    const init = { cache: "no-store" as const, signal };
    if (!input.internal) return fetchSafeOutbound(url, init);

    const origin = new URL(url).origin;
    const headers = maintenanceWorkerContextHeaders(input.cookie) || (input.cookie ? { cookie: input.cookie } : undefined);
    let current = new URL(url);
    for (let redirects = 0; redirects <= MAX_INTERNAL_REDIRECTS; redirects += 1) {
        const response = await fetchInternalApi(current, { ...init, headers, redirect: "manual" });
        if (!REDIRECT_STATUSES.has(response.status)) return response;
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get("location");
        if (!location || redirects === MAX_INTERNAL_REDIRECTS) throw new UnsafeOutboundUrlError("生产素材重定向地址无效或次数过多");
        let next: URL;
        try {
            next = new URL(location, current);
        } catch {
            throw new UnsafeOutboundUrlError("生产素材重定向地址无效");
        }
        if (next.username || next.password) throw new UnsafeOutboundUrlError("生产素材重定向地址不受信任");
        if (next.origin === origin && next.pathname.startsWith("/api/")) {
            current = next;
            continue;
        }
        if (next.protocol !== "https:" || next.origin === origin) throw new UnsafeOutboundUrlError("生产素材重定向地址不受信任");
        // 站内素材可跳转到对象存储；外部请求重新校验地址，且不携带站内 Cookie。
        return fetchSafeOutbound(next, init);
    }
    throw new UnsafeOutboundUrlError("生产素材重定向次数过多");
}
