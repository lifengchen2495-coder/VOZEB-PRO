import { fail, ok } from "@/lib/server/http";
import { getSettings, saveSettings, toPublicSettings } from "@/lib/server/store";
import type { SettingsPatch } from "@/lib/types";

export async function GET() {
    return ok(toPublicSettings(await getSettings()));
}

export async function PATCH(request: Request) {
    try {
        return ok(toPublicSettings(await saveSettings((await request.json()) as SettingsPatch)));
    } catch (error) {
        return fail(error);
    }
}
