import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("profile coupon pagination", () => {
    it("loads only the active server page and refreshes page one after a claim", async () => {
        const hook = await readFile(resolve(process.cwd(), "src/app/(user)/profile/use-profile-data.ts"), "utf8");

        expect(hook).toContain("pageSize: COUPON_PAGE_SIZE");
        expect(hook).not.toContain("pageSize: 100");
        expect(hook).toContain("loadCoupons(couponsPage)");
        expect(hook).toContain("setCouponsPage(1)");
        expect(hook).toContain("couponsQueuedRequest");
        expect(hook).toContain("couponTemplatesLoaded");
        expect(hook).toContain("templatePageSize: COUPON_PAGE_SIZE");
        expect(hook).toContain("changeCouponTemplatePage");
        expect(hook).toContain("refreshTemplates: true");
        expect(hook).toContain("includeTemplates: currentRequest.refreshTemplates || !couponTemplatesLoaded.current");
    });
});
