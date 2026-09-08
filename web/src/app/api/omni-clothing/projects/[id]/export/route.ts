import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { requestRuntimeCredential } from "@/lib/server/maintenance-auth";
import { exportOmniClothingBundle } from "@/lib/server/omni-clothing-media-service";

import { withClothingUser } from "../../../route-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    return withClothingUser(request, async (userId) => {
        const result = await exportOmniClothingBundle(userId, (await context.params).id, { origin: resolveInternalOrigin(new URL(request.url).origin), cookie: requestRuntimeCredential(request, userId) });
        return new Response(new Uint8Array(result.bytes), { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.fileName)}`, "Cache-Control": "no-store" } });
    });
}
