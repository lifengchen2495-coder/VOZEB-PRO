import { randomUUID } from "node:crypto";

import { expect, test, type Page, type Route } from "@playwright/test";

import type { CreativeAsset, CreativeConversation, CreativeMessage, CreativeRunRequest } from "../src/lib/creative-runtime-contract";
import type { CreativeAgentRun } from "../src/services/api/creative";

const INPUT_PLACEHOLDER = "补充画面细节或修改要求（选填）";
const PNG_BUFFER = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4MsAAAAASUVORK5CYII=", "base64");
const IMAGE_URL = `data:image/png;base64,${PNG_BUFFER.toString("base64")}`;

test("commerce showcase submits its form without a free-text prompt and materializes product IDs", async ({ page }) => {
    const fixture = await mockCommerceRuntime(page);
    await openCommerce(page);
    await page.getByLabel("产品名称", { exact: false }).fill("双层随行杯");
    await page.getByRole("button", { name: "生成图片", exact: true }).click();
    await expect(page.getByText("请先选择至少一张产品图，并标注素材用途。", { exact: true })).toBeVisible();
    expect(fixture.requests).toHaveLength(0);

    await addImage(page, "上传产品图", "product.png");
    await expect(page.getByRole("list", { name: "本轮素材角色" }).getByText("产品图", { exact: true })).toBeVisible();
    expect(fixture.uploadAttempts).toHaveLength(0);
    await expect(page.getByPlaceholder(INPUT_PLACEHOLDER)).toHaveValue("");
    await page.getByRole("button", { name: "生成图片", exact: true }).click();

    await expect.poll(() => fixture.requests.length).toBe(1);
    const request = fixture.requests[0];
    expect(fixture.uploadAttempts).toEqual(["product.png"]);
    expect(request.assetIds).toEqual([fixture.uploadedAssets[0].id]);
    expect(request.preferences?.image?.references).toEqual([{ assetId: fixture.uploadedAssets[0].id, role: "product" }]);
    expect(request.assetIds.every((id) => !id.startsWith("draft-"))).toBe(true);
    expect(request.prompt).toContain("产品：双层随行杯");
    expect(request.prompt).toContain("@图片1：产品图");
    expect(request.publicPrompt).not.toContain("生成要求：");
    expect(request.preferences?.mode).toBe("image");
    await expectCompleted(page, 1);
    await expectNoHorizontalOverflow(page);
});

test("reference editing removes an unused draft and preserves reference numbering and roles", async ({ page }) => {
    const fixture = await mockCommerceRuntime(page);
    await openCommerce(page);
    await page.getByRole("button", { name: "参考图改图", exact: true }).click();
    await page.getByLabel("产品名称", { exact: false }).fill("蓝色随行杯");
    await addImage(page, "上传参考图", "discarded.png");
    await addImage(page, "上传产品图", "product.png");
    await addImage(page, "上传参考图", "layout.png");
    await page.getByLabel("改图要求", { exact: true }).fill("用 @图片2 的商品替换 @图片3 中的商品，删除促销文案");
    await page.getByRole("button", { name: "移除 @图片1", exact: true }).click();
    const roleList = page.getByRole("list", { name: "本轮素材角色" });
    await expect(roleList.getByRole("listitem")).toHaveCount(2);
    await expect(roleList.getByRole("listitem").nth(0)).toContainText("@图片1");
    await expect(roleList.getByRole("listitem").nth(0)).toContainText("产品图");
    await expect(roleList.getByRole("listitem").nth(1)).toContainText("@图片2");
    await expect(roleList.getByRole("listitem").nth(1)).toContainText("排版参考");
    await expect(page.getByLabel("改图要求", { exact: true })).toHaveValue("用 @图片1 的商品替换 @图片2 中的商品，删除促销文案");
    await page.getByRole("button", { name: "生成图片", exact: true }).click();

    await expect.poll(() => fixture.requests.length).toBe(1);
    expect(fixture.uploadAttempts).toEqual(["product.png", "layout.png"]);
    const request = fixture.requests[0];
    expect(request.preferences?.image?.references).toEqual([
        { assetId: fixture.uploadedAssets[0].id, role: "product" },
        { assetId: fixture.uploadedAssets[1].id, role: "layout" },
    ]);
    expect(request.prompt).toContain("@图片1：产品图（product.png）");
    expect(request.prompt).toContain("@图片2：排版参考（layout.png）");
    expect(request.prompt).toContain("用 @图片1 的商品替换 @图片2 中的商品");
    expect(request.prompt).not.toContain("discarded.png");
    expect(request.prompt).not.toContain("@图片3");
    await expectCompleted(page, 1);
});

test("partial upload failure retains the successful product and remaps roles on retry", async ({ page }) => {
    const fixture = await mockCommerceRuntime(page, { failUploadOnce: "layout.png" });
    await openCommerce(page);
    await page.getByRole("button", { name: "参考图改图", exact: true }).click();
    await page.getByLabel("产品名称", { exact: false }).fill("随行杯");
    await page.getByLabel("改图要求", { exact: true }).fill("保留构图并替换商品");
    await addImage(page, "上传产品图", "product.png");
    await addImage(page, "上传参考图", "layout.png");
    await page.getByRole("button", { name: "生成图片", exact: true }).click();

    await expect(page.getByText("参考图上传暂时失败，请重试。", { exact: true })).toBeVisible();
    expect(fixture.requests).toHaveLength(0);
    expect(fixture.uploadAttempts).toEqual(["product.png", "layout.png"]);
    const productId = fixture.uploadedAssets[0].id;
    const roleList = page.getByRole("list", { name: "本轮素材角色" });
    await expect(roleList.getByRole("listitem")).toHaveCount(2);
    await expect(roleList.getByRole("listitem").nth(0)).toContainText("产品图");
    await expect(roleList.getByRole("listitem").nth(1)).toContainText("排版参考");
    await page.getByRole("button", { name: "生成图片", exact: true }).click();

    await expect.poll(() => fixture.requests.length).toBe(1);
    expect(fixture.uploadAttempts).toEqual(["product.png", "layout.png", "layout.png"]);
    expect(fixture.uploadedAssets).toHaveLength(2);
    expect(fixture.requests[0].assetIds).toEqual([productId, fixture.uploadedAssets[1].id]);
    expect(fixture.requests[0].preferences?.image?.references).toEqual([
        { assetId: productId, role: "product" },
        { assetId: fixture.uploadedAssets[1].id, role: "layout" },
    ]);
    await expectCompleted(page, 1);
});

test("completed generation retains product data and attachments for another request", async ({ page }) => {
    const fixture = await mockCommerceRuntime(page);
    await openCommerce(page);
    await page.getByLabel("产品名称", { exact: false }).fill("随行杯");
    await addImage(page, "上传产品图", "product.png");
    await page.getByRole("button", { name: "生成图片", exact: true }).click();
    await expectCompleted(page, 1);

    await page.getByPlaceholder(INPUT_PLACEHOLDER).fill("背景改为暖色桌面，不添加文字");
    await page.getByRole("button", { name: "修改需求", exact: false }).click();
    await expect(page.getByLabel("产品名称", { exact: false })).toHaveValue("随行杯");
    await expect(page.getByRole("list", { name: "本轮素材角色" }).getByRole("listitem")).toHaveCount(1);
    await page.getByRole("button", { name: "生成图片", exact: true }).click();

    await expect.poll(() => fixture.requests.length).toBe(2);
    expect(fixture.uploadAttempts).toEqual(["product.png"]);
    expect(fixture.requests[1].assetIds).toEqual(fixture.requests[0].assetIds);
    expect(fixture.requests[1].preferences?.image?.references).toEqual(fixture.requests[0].preferences?.image?.references);
    expect(fixture.requests[1].prompt).toContain("背景改为暖色桌面，不添加文字");
    expect(fixture.requests[1].prompt).toContain("产品：随行杯");
    await expectCompleted(page, 2);
});

test("a failed run submission retries the same request and materialized references", async ({ page }) => {
    const fixture = await mockCommerceRuntime(page, { failRunOnce: true });
    await openCommerce(page);
    await page.getByRole("button", { name: "参考图改图", exact: true }).click();
    await page.getByLabel("产品名称", { exact: false }).fill("随行杯");
    await page.getByLabel("改图要求", { exact: true }).fill("替换商品，保留参考图构图");
    await addImage(page, "上传产品图", "product.png");
    await addImage(page, "上传参考图", "layout.png");
    await page.getByRole("button", { name: "生成图片", exact: true }).click();

    await expect.poll(() => fixture.requests.length).toBe(1);
    await expect(page.getByText("创作提交暂时失败，请直接重试。", { exact: true })).toBeVisible();
    const initialRequest = fixture.requests[0];
    expect(initialRequest.preferences?.image?.references).toEqual([
        { assetId: fixture.uploadedAssets[0].id, role: "product" },
        { assetId: fixture.uploadedAssets[1].id, role: "layout" },
    ]);
    await page.getByRole("button", { name: "直接重试本次创作", exact: true }).click();

    await expect.poll(() => fixture.requests.length).toBe(2);
    expect(fixture.requests[1].clientRequestId).toBe(initialRequest.clientRequestId);
    expect(fixture.requests[1].assetIds).toEqual(initialRequest.assetIds);
    expect(fixture.requests[1].preferences?.image?.references).toEqual(initialRequest.preferences?.image?.references);
    expect(fixture.requests[1].prompt).toBe(initialRequest.prompt);
    expect(fixture.uploadAttempts).toEqual(["product.png", "layout.png"]);
    await expectCompleted(page, 1);
});

test("a draft selected before a historical result keeps its image number and request order", async ({ page }) => {
    const fixture = await mockCommerceRuntime(page);
    await openCommerce(page);
    await page.getByLabel("产品名称", { exact: false }).fill("随行杯");
    await addImage(page, "上传产品图", "original-product.png");
    await page.getByRole("button", { name: "生成图片", exact: true }).click();
    await expectCompleted(page, 1);

    await page.getByPlaceholder(INPUT_PLACEHOLDER).click();
    await page.getByRole("button", { name: "修改需求", exact: false }).click();
    await page.getByRole("button", { name: "移除 @图片1", exact: true }).click();
    await addImage(page, "上传产品图", "new-product.png");
    const requirements = page.getByLabel("画面要求", { exact: true });
    await requirements.fill("保持 @图片1 的杯身外观，采用暖色桌面");
    await page.getByRole("button", { name: "更多本轮创作操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "引用结果", exact: true }).click();

    const roleList = page.getByRole("list", { name: "本轮素材角色" });
    await page.getByPlaceholder(INPUT_PLACEHOLDER).click();
    const modifyButton = page.getByRole("button", { name: "修改需求", exact: false });
    await expect(modifyButton.or(roleList)).toBeVisible();
    if (await modifyButton.isVisible()) await modifyButton.click();
    await expect(roleList.getByRole("listitem")).toHaveCount(2);
    await expect(roleList.getByRole("listitem").nth(0)).toContainText("@图片1");
    await expect(roleList.getByRole("listitem").nth(0)).toContainText("new-product.png");
    await expect(roleList.getByRole("listitem").nth(1)).toContainText("@图片2");
    await expect(roleList.getByRole("listitem").nth(1)).toContainText("生成结果 1");
    await expect(requirements).toHaveValue("保持 @图片1 的杯身外观，采用暖色桌面");
    await page.getByRole("combobox", { name: "@图片2的素材用途", exact: true }).click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option-content").filter({ hasText: /^排版参考$/ }).click();
    await page.getByRole("button", { name: "生成图片", exact: true }).click();

    await expect.poll(() => fixture.requests.length).toBe(2);
    const expectedIds = [fixture.uploadedAssets[1].id, fixture.resultAssets[0].id];
    expect(fixture.requests[1].assetIds).toEqual(expectedIds);
    expect(fixture.requests[1].preferences?.image?.references).toEqual([
        { assetId: expectedIds[0], role: "product" },
        { assetId: expectedIds[1], role: "layout" },
    ]);
    expect(fixture.requests[1].prompt).toContain("@图片1：产品图（new-product.png）");
    expect(fixture.requests[1].prompt).toContain("@图片2：排版参考（生成结果 1）");
    expect(fixture.requests[1].prompt).toContain("保持 @图片1 的杯身外观");
    expect(fixture.uploadAttempts).toEqual(["original-product.png", "new-product.png"]);
    await expectCompleted(page, 2);
});

test("deleting the active conversation clears product details, unsent requirements and references", async ({ page }) => {
    const fixture = await mockCommerceRuntime(page);
    await openCommerce(page);
    await page.getByLabel("产品名称", { exact: false }).fill("旧商品随行杯");
    await page.getByLabel("产品卖点", { exact: false }).fill("双层杯壁");
    await page.getByLabel("画面要求", { exact: true }).fill("旧商品放在暖色桌面");
    await addImage(page, "上传产品图", "old-product.png");
    await page.getByRole("button", { name: "生成图片", exact: true }).click();
    await expectCompleted(page, 1);
    await page.getByPlaceholder(INPUT_PLACEHOLDER).fill("尚未发送的旧商品补充要求");

    await page.getByRole("button", { name: "打开创作历史", exact: true }).click();
    await page.getByRole("button", { name: "管理电商图片测试", exact: true }).click();
    await page.getByRole("menuitem", { name: "删除", exact: true }).click();
    await page.getByRole("dialog", { name: "删除这条对话？", exact: true }).getByRole("button", { name: /^删\s*除$/ }).click();
    await expect.poll(() => fixture.deletedConversationIds.length).toBe(1);
    await expect(page.getByText("对话已删除", { exact: true })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "删除这条对话？", exact: true })).toBeHidden();
    await page.keyboard.press("Escape");

    await expect(page).toHaveURL(/\/commerce\/image$/);
    await expect(page.getByRole("heading", { name: "电商图生成", exact: true })).toBeVisible();
    await expect(page.getByLabel("产品名称", { exact: false })).toHaveValue("");
    await expect(page.getByLabel("产品卖点", { exact: false })).toHaveValue("");
    await expect(page.getByLabel("画面要求", { exact: true })).toHaveValue("");
    await expect(page.getByPlaceholder(INPUT_PLACEHOLDER)).toHaveValue("");
    await expect(page.getByRole("list", { name: "本轮素材角色" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "生成图片", exact: true })).toBeDisabled();
});

test("the normal create workspace still submits without commerce fields or product images", async ({ page }) => {
    const fixture = await mockCommerceRuntime(page);
    await page.goto("/create", { waitUntil: "domcontentloaded" });
    await expect(page.locator('.creative-composer[data-ready="true"]')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByLabel("产品名称", { exact: false })).toHaveCount(0);
    const prompt = page.getByPlaceholder("输入你的创作想法、脚本或画面要求");
    await expect(prompt).toBeVisible({ timeout: 45_000 });
    await prompt.fill("生成一张清晨湖边的风景照片");
    await page.getByRole("button", { name: "发送", exact: true }).click();

    await expect.poll(() => fixture.requests.length).toBe(1);
    expect(fixture.requests[0].prompt).toBe("生成一张清晨湖边的风景照片");
    expect(fixture.requests[0].assetIds).toEqual([]);
    expect(fixture.requests[0].preferences?.image?.references).toBeUndefined();
    expect(fixture.uploadAttempts).toEqual([]);
    await expectCompleted(page, 1);
});

async function openCommerce(page: Page) {
    await page.goto("/commerce/image", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "电商图生成", exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(page.locator('.creative-composer[data-ready="true"]')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole("button", { name: "移除 Skill 电商图片", exact: true })).toBeVisible();
    await expect(page.getByLabel("产品名称", { exact: false })).toBeEnabled();
}

async function addImage(page: Page, buttonName: string, name: string) {
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: buttonName, exact: true }).click();
    const chooser = await chooserPromise;
    await chooser.setFiles({ name, mimeType: "image/png", buffer: PNG_BUFFER });
    await expect(page.getByRole("list", { name: "本轮素材角色" }).getByText(name, { exact: true })).toBeVisible();
}

async function expectCompleted(page: Page, count: number) {
    await expect(page.getByTestId("creative-primary-result")).toHaveCount(count, { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "停止生成", exact: true })).toHaveCount(0);
}

async function expectNoHorizontalOverflow(page: Page) {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
}

async function mockCommerceRuntime(page: Page, options: { failUploadOnce?: string; failRunOnce?: boolean } = {}) {
    const conversationId = `e2e-commerce-${randomUUID()}`;
    const timestamp = Date.now();
    const conversation: CreativeConversation = { id: conversationId, userId: "e2e-user", surface: "chat", source: "agent", title: "电商图片测试", status: "active", contextSummary: "", contextSummaryThroughSequence: 0, createdAt: timestamp, updatedAt: timestamp, lastMessageAt: timestamp };
    const uploadedAssets: CreativeAsset[] = [];
    const resultAssets: CreativeAsset[] = [];
    const messages: CreativeMessage[] = [];
    const runs = new Map<string, CreativeAgentRun>();
    const requests: CreativeRunRequest[] = [];
    const uploadAttempts: string[] = [];
    const deletedConversationIds: string[] = [];
    let failedUpload = false;
    let failedRun = false;
    let conversationCreated = false;
    const reply = (route: Route, data: unknown) => route.fulfill({ json: { code: 0, data, msg: "OK" } });

    // 生成与上传全部在浏览器边界模拟，不访问真实生成服务。
    await page.route(/\/api\/(?:agent|creative)\//, async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path === "/api/agent/skills") return reply(route, { skills: [{ id: "ecommerce-image", name: "电商图片", description: "产品展示和参考图改图", action: "generate", workspaces: ["image"] }] });
        if (path === "/api/creative/conversations") {
            if (request.method() === "DELETE") {
                const ids = (request.postDataJSON() as { ids: string[] }).ids;
                deletedConversationIds.push(...ids);
                if (ids.includes(conversationId)) {
                    conversationCreated = false;
                    messages.splice(0);
                    uploadedAssets.splice(0);
                    resultAssets.splice(0);
                    runs.clear();
                }
                return reply(route, { deleted: ids.length });
            }
            if (request.method() === "POST") {
                conversationCreated = true;
                return reply(route, { conversation });
            }
            return reply(route, { conversations: conversationCreated ? [conversation] : [], hasMore: false });
        }
        if (path === `/api/creative/conversations/${conversationId}`) return reply(route, { conversation });
        if (path === `/api/creative/conversations/${conversationId}/messages`) return reply(route, { messages });
        if (path === `/api/creative/conversations/${conversationId}/assets`) return reply(route, { assets: [...uploadedAssets, ...resultAssets] });
        if (path === "/api/creative/assets" && request.method() === "POST") {
            const contentType = request.headers()["content-type"];
            const form = await new Response(request.postDataBuffer(), { headers: { "content-type": contentType } }).formData();
            const file = form.get("file") as File;
            const title = file.name;
            uploadAttempts.push(title);
            if (options.failUploadOnce === title && !failedUpload) {
                failedUpload = true;
                return route.fulfill({ status: 503, json: { code: 503, data: null, msg: "参考图上传暂时失败，请重试。" } });
            }
            const asset: CreativeAsset = { id: `uploaded-${uploadedAssets.length + 1}-${randomUUID()}`, userId: "e2e-user", conversationId, ordinal: uploadedAssets.length, type: "image", status: "ready", title, serverUrl: IMAGE_URL, mimeType: "image/png", width: 512, height: 512, metadata: {}, createdAt: timestamp, updatedAt: timestamp };
            uploadedAssets.push(asset);
            return reply(route, { asset });
        }
        if (path === "/api/agent/runs") {
            if (request.method() === "GET") return reply(route, { runs: [] });
            const body = request.postDataJSON() as CreativeRunRequest;
            requests.push(body);
            if (options.failRunOnce && !failedRun) {
                failedRun = true;
                return route.fulfill({ status: 503, json: { code: 503, data: null, msg: "创作提交暂时失败，请直接重试。" } });
            }
            conversationCreated = true;
            const id = `e2e-commerce-run-${requests.length}`;
            const inputMessageId = `${id}-user`;
            const assistantMessageId = `${id}-assistant`;
            const taskId = `${id}-task`;
            const asset: CreativeAsset = { id: `${id}-result`, userId: "e2e-user", conversationId, messageId: assistantMessageId, sourceRunId: id, sourceTaskId: taskId, ordinal: requests.length, type: "image", status: "ready", title: `生成结果 ${requests.length}`, serverUrl: IMAGE_URL, mimeType: "image/png", width: 512, height: 512, metadata: { agentTaskId: taskId }, createdAt: timestamp, updatedAt: timestamp + requests.length };
            resultAssets.push(asset);
            const run: CreativeAgentRun = { id, conversationId, inputMessageId, assistantMessageId, status: "completed", prompt: body.publicPrompt || body.prompt, referencedAssetIds: body.assetIds, selectedSkillIds: body.skillIds, requestedModelIds: ["image-gen"], generationPreferences: body.preferences, assetIds: [asset.id], tasks: [{ id: taskId, title: "生成商品图片", type: "image", model: "image-gen", optimizedPrompt: body.prompt, count: 1, status: "completed" }], createdAt: timestamp, updatedAt: timestamp + requests.length * 1000 };
            runs.set(id, run);
            messages.push(
                { id: inputMessageId, conversationId, runId: id, sequence: messages.length + 1, role: "user", status: "completed", content: body.publicPrompt || body.prompt, metadata: { assetIds: body.assetIds }, createdAt: timestamp, updatedAt: timestamp },
                { id: assistantMessageId, conversationId, runId: id, sequence: messages.length + 2, role: "assistant", status: "completed", content: "图片已生成。", metadata: {}, createdAt: timestamp, updatedAt: timestamp + requests.length * 1000 },
            );
            return reply(route, { run: { ...run, status: "running", assetIds: [], tasks: [] }, created: true });
        }
        const runPath = path.match(/^\/api\/agent\/runs\/([^/]+)(\/events)?$/);
        if (runPath) {
            const run = runs.get(runPath[1]);
            if (runPath[2]) return route.fulfill({ contentType: "text/event-stream", body: `event: run.completed\ndata: ${JSON.stringify({ data: { reply: "图片已生成。" } })}\n\n` });
            return reply(route, { run });
        }
        return route.fulfill({ status: 501, json: { code: 501, msg: `未模拟的创作请求：${path}` } });
    });
    await page.route(/\/api\/create\/overview(?:\?.*)?$/, (route) => reply(route, { overview: { runningTasks: [], recentAssets: [] } }));
    await page.route(/\/api\/public\/gallery(?:\?.*)?$/, (route) => reply(route, { items: [] }));
    await page.route(/\/api\/notifications\/interactions(?:\?.*)?$/, (route) => reply(route, { items: [], unreadCount: 0 }));
    return { requests, uploadedAssets, resultAssets, uploadAttempts, deletedConversationIds };
}
