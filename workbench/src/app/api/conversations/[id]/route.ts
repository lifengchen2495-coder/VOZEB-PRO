import { recoverPending } from "@/lib/server/generation";
import { fail, ok } from "@/lib/server/http";
import { deleteConversation, getConversation, updateConversation } from "@/lib/server/store";

type Context = { params: Promise<{ id: string }> };

export async function GET(_: Request, { params }: Context) {
    const conversation = await getConversation((await params).id);
    if (!conversation) return fail("会话不存在", 404);
    return ok(await recoverPending(conversation));
}

export async function PATCH(request: Request, { params }: Context) {
    const { title } = (await request.json()) as { title?: string };
    if (!title?.trim()) return fail("标题不能为空");
    try {
        const conversation = await updateConversation((await params).id, (c) => void (c.title = title.trim().slice(0, 60)));
        return ok({ id: conversation.id, title: conversation.title });
    } catch (error) {
        return fail(error, 404);
    }
}

export async function DELETE(_: Request, { params }: Context) {
    await deleteConversation((await params).id);
    return ok(null);
}
