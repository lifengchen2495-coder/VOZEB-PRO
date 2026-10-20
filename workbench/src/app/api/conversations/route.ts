import { ok } from "@/lib/server/http";
import { createConversation, listConversations } from "@/lib/server/store";

export async function GET() {
    return ok(await listConversations());
}

export async function POST() {
    return ok(await createConversation());
}
