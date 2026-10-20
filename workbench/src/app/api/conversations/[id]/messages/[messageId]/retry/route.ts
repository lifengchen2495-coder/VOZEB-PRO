import { retryMessage } from "@/lib/server/generation";
import { fail, generationResponse } from "@/lib/server/http";

export async function POST(_: Request, { params }: { params: Promise<{ id: string; messageId: string }> }) {
    try {
        const { id, messageId } = await params;
        return generationResponse(await retryMessage(id, messageId));
    } catch (error) {
        return fail(error);
    }
}
