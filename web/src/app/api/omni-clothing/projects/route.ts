import { readJsonBody } from "@/lib/auth/request";
import { createOmniClothingProjectForUser } from "@/lib/server/omni-clothing-project-service";
import { listOmniClothingProjectSummaries } from "@/lib/server/omni-clothing-project-store";

import { clothingResponse, withClothingUser } from "../route-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    return withClothingUser(request, async (userId) => {
        const query = new URL(request.url).searchParams;
        return clothingResponse(await listOmniClothingProjectSummaries(userId, { page: Number(query.get("page")), pageSize: Number(query.get("pageSize")) }));
    });
}

export async function POST(request: Request) {
    return withClothingUser(request, async (userId) => {
        const input = await readJsonBody<{ title?: string }>(request, 16 * 1024);
        return clothingResponse({ project: await createOmniClothingProjectForUser(userId, input.title) });
    });
}
