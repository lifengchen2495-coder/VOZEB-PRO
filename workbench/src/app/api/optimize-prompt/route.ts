import { fail, ok } from "@/lib/server/http";
import { getSettings } from "@/lib/server/store";
import { optimizePrompt } from "@/lib/server/upstream";
import type { Mode } from "@/lib/types";

export async function POST(request: Request) {
    const { mode, prompt } = (await request.json()) as { mode?: Mode; prompt?: string };
    if (!mode || !["chat", "image", "video"].includes(mode)) return fail("不支持的创作类型");
    if (!prompt?.trim()) return fail("请先输入内容");
    try {
        return ok(await optimizePrompt(await getSettings(), mode, prompt.trim()));
    } catch (error) {
        return fail(error, 502);
    }
}
