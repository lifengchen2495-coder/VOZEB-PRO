import { ok } from "@/lib/server/http";
import { getWorkspace } from "@/lib/server/store";

export async function GET() {
    return ok(await getWorkspace());
}
