import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("public creator modal", () => {
    it("keeps private likes on the authenticated personal home only", async () => {
        const [personal, publicProfile] = await Promise.all([readFile(resolve(process.cwd(), "src/app/(user)/me/page.tsx"), "utf8"), readFile(resolve(process.cwd(), "src/components/works/public-creator-profile.tsx"), "utf8")]);

        expect(personal).toContain('type ProfileTab = "published" | "likes"');
        expect(personal).toContain('view: "likes"');
        expect(personal).toContain("我的喜欢");
        expect(publicProfile).not.toContain("我的喜欢");
        expect(publicProfile).not.toContain('view: "likes"');
    });

    it("keeps the public URL as an SSR share and metadata surface", async () => {
        const page = await readFile(resolve(process.cwd(), "src/app/u/[username]/page.tsx"), "utf8");

        expect(page).toContain("generateMetadata");
        expect(page).toContain('openGraph: { type: "profile"');
        expect(page).toContain("alternates: { canonical }");
        expect(page).toContain('loadCreatorPage(username, viewer?.id || "")');
        expect(page).not.toContain("profile.email");
    });
});
