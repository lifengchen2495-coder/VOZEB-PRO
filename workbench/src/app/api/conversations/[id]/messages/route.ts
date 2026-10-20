import { sendMessage } from "@/lib/server/generation";
import { fail, generationResponse } from "@/lib/server/http";
import type { SendBody } from "@/lib/types";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        return generationResponse(await sendMessage((await params).id, (await request.json()) as SendBody));
    } catch (error) {
        return fail(error);
    }
}
