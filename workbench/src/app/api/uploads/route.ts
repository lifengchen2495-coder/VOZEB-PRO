import { fail, ok } from "@/lib/server/http";
import { saveMedia } from "@/lib/server/store";

export async function POST(request: Request) {
    try {
        const file = (await request.formData()).get("file");
        if (!(file instanceof File)) return fail("请选择文件");
        if (!file.type.startsWith("image/")) return fail("参考素材只支持图片");
        return ok(await saveMedia(new Uint8Array(await file.arrayBuffer()), file.type, file.name));
    } catch (error) {
        return fail(error);
    }
}
