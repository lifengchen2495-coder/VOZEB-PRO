import { fail, ok } from "@/lib/server/http";
import { getSettings } from "@/lib/server/store";
import { createClient } from "@/lib/server/upstream";

export async function GET() {
    try {
        const ids: string[] = [];
        for await (const model of createClient(await getSettings()).models.list()) ids.push(model.id);
        return ok(ids.sort());
    } catch (error) {
        return fail(error, 502);
    }
}
