import { fail, ok } from "@/lib/server/http";
import { getSettings, saveCatalog, toPublicSettings } from "@/lib/server/store";
import { classifyModel, createClient } from "@/lib/server/upstream";

// 用填写的密钥从内置接口读取模型列表，成功后才保存密钥
export async function POST(request: Request) {
    try {
        const settings = await getSettings();
        const { apiKey } = (await request.json()) as { apiKey?: string };
        const key = apiKey?.trim() || settings.apiKey;
        if (!key) return fail("请先填写 API Key");
        const types = new Map<string, string[]>();
        for await (const model of createClient({ ...settings, apiKey: key }).models.list()) {
            types.set(model.id, (model as { supported_endpoint_types?: string[] }).supported_endpoint_types || []);
        }
        const catalog = [...types.keys()].sort();
        return ok(toPublicSettings(await saveCatalog(key, catalog, (id) => classifyModel(id, types.get(id)))));
    } catch (error) {
        return fail(error, 502);
    }
}
