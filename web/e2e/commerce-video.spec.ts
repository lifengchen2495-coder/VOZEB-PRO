import { readFile } from "node:fs/promises";

import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

import type { CommerceVideoWorkflow, CommerceVideoWorkflowInput } from "../src/lib/commerce-video-workflow";
import type { AgentSkillSummary } from "../src/services/api/agent-skills";

const VIDEO_SKILL: AgentSkillSummary = { id: "ecommerce-video", name: "电商视频流程", description: "根据产品目标规划脚本、分镜和制作流程", workspaces: ["video"] };
const BRIEF = "为蓝色双层随行杯设计产品展示视频，展示通勤场景和杯身细节，最后给出购买引导。";

test("video planning uses the chosen Skill and general production requirements without a media model binding", async ({ page }, testInfo) => {
    const fixture = await mockVideoRuntime(page);
    await openVideoWorkspace(page);
    await expect(page.getByRole("button", { name: "生成视频流程", exact: true })).toBeDisabled();
    await page.getByLabel("产品与视频目标", { exact: false }).fill(BRIEF);
    await selectOption(page, "目标时长", "60 秒");
    await selectOption(page, "目标平台", "TikTok");
    await selectOption(page, "人物安排", "多人 / 对话");
    await selectOption(page, "视频文案语言", "英文");
    await page.getByRole("checkbox", { name: "产品参考图", exact: true }).check();
    await page.getByRole("checkbox", { name: "对标视频", exact: true }).check();
    await page.getByRole("button", { name: "生成视频流程", exact: true }).click();
    await expectResult(page);
    await page.screenshot({ path: testInfo.outputPath("workflow-result.png"), fullPage: true, animations: "disabled" });

    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]).toEqual({ requestId: expect.stringMatching(/^video-workflow-/), brief: BRIEF, platform: "tiktok", durationSeconds: 60, people: "multiple", language: "en", materials: ["product-images", "reference-video"], skillId: VIDEO_SKILL.id });
    expect(fixture.skillWorkspaces).toContain("video");
    await expect(page.getByTestId("commerce-video-workspace")).not.toContainText(/Omni/i);
    await expect(page.getByTestId("commerce-video-workflow-result")).toContainText("60 秒 · 3 个阶段 · 电商视频流程");
    await page.getByRole("tab", { name: "视频分段", exact: true }).click();
    await expect(page.getByRole("heading", { name: /^第 \d 段 ·/ })).toHaveCount(4);
    await expect(page.getByRole("heading", { name: "第 4 段 · 45–60 秒", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "素材与检查", exact: true }).click();
    const result = page.getByTestId("commerce-video-workflow-result");
    await expect(result.getByRole("listitem").filter({ hasText: "产品图片" })).toContainText("已有");
    await expect(result.getByRole("listitem").filter({ hasText: "参考视频" })).toContainText("已有");
    await expect(result).toContainText("具体画面、声音和产品外观将在执行对应阶段时分析。");
    expect(fixture.unexpectedMutations).toEqual([]);
    await expectNoHorizontalOverflow(page);
});

test("stage and segment edits are included in Markdown and JSON downloads", async ({ page }) => {
    const fixture = await mockVideoRuntime(page);
    await openVideoWorkspace(page);
    await page.getByLabel("产品与视频目标", { exact: false }).fill(BRIEF);
    await selectOption(page, "目标时长", "30 秒");
    await page.getByRole("button", { name: "生成视频流程", exact: true }).click();
    await expectResult(page);
    const scriptPrompt = "先展示通勤需求，再演示杯盖开合；只使用真实产品卖点。";
    const imagePrompt = "蓝色随行杯放在木质桌面，保留杯身与包装，不添加文字。";
    const segmentPrompt = "镜头从桌面平稳推进到杯身，杯盖保持闭合。";
    await page.getByRole("textbox", { name: "规划脚本提示词", exact: true }).fill(scriptPrompt);
    await page.getByText("2. 生成分镜图", { exact: true }).click();
    await page.getByRole("textbox", { name: "生成分镜图提示词", exact: true }).fill(imagePrompt);
    await page.getByRole("tab", { name: "视频分段", exact: true }).click();
    await page.getByRole("textbox", { name: "第 1 段视频提示词", exact: true }).fill(segmentPrompt);

    const markdown = await downloadText(page, "下载流程", "视频流程-30秒.md");
    expect(markdown).toContain(scriptPrompt);
    expect(markdown).toContain(imagePrompt);
    expect(markdown).toContain(segmentPrompt);
    expect(markdown).toContain("本文件为待执行流程");
    const exported = JSON.parse(await downloadText(page, "下载 JSON", "视频流程-30秒.json")) as CommerceVideoWorkflow;
    expect(exported.stages[0].prompt).toBe(scriptPrompt);
    expect(exported.stages[1].prompt).toBe(imagePrompt);
    expect(exported.segments[0].visualPrompt).toBe(segmentPrompt);
    expect(exported.segments.at(-1)?.endSeconds).toBe(30);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.unexpectedMutations).toEqual([]);
    await expectNoHorizontalOverflow(page);
});

test("image and video stage links open populated creation drafts without generating media", async ({ page }) => {
    const fixture = await mockVideoRuntime(page);
    await generateDefaultWorkflow(page);
    const imagePrompt = "保留蓝色杯身和包装，展示柔和光线下的桌面场景。";
    await page.getByText("2. 生成分镜图", { exact: true }).click();
    await page.getByRole("textbox", { name: "生成分镜图提示词", exact: true }).fill(imagePrompt);
    await expectCreationDraft(page, page.getByRole("link", { name: "打开图片创作", exact: true }), "image", imagePrompt);

    const videoPrompt = "杯身缓慢转动，镜头平稳，背景和杯身颜色保持一致。";
    await page.getByText("3. 生成视频片段", { exact: true }).click();
    await page.getByRole("textbox", { name: "生成视频片段提示词", exact: true }).fill(videoPrompt);
    await expectCreationDraft(page, page.getByRole("link", { name: "打开视频创作", exact: true }), "video", videoPrompt);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.unexpectedMutations).toEqual([]);
});

test("failed planning retries reuse the request ID until the requirements change", async ({ page }) => {
    const fixture = await mockVideoRuntime(page, { workflowFailures: 2 });
    await openVideoWorkspace(page);
    const brief = page.getByLabel("产品与视频目标", { exact: false });
    const submit = page.getByRole("button", { name: "生成视频流程", exact: true });
    await brief.fill(BRIEF);
    await submit.click();
    await expect(page.getByText("规划服务暂时不可用，请重试。", { exact: true })).toBeVisible();
    await expect(brief).toHaveValue(BRIEF);
    await submit.click();
    await expect.poll(() => fixture.requests.length).toBe(2);
    await expect(page.getByText("规划服务暂时不可用，请重试。", { exact: true })).toBeVisible();
    expect(fixture.requests[1].requestId).toBe(fixture.requests[0].requestId);
    await brief.fill(`${BRIEF} 增加户外场景。`);
    await submit.click();
    await expectResult(page);
    expect(fixture.requests).toHaveLength(3);
    expect(fixture.requests[2].requestId).not.toBe(fixture.requests[0].requestId);
    expect(fixture.requests[2].brief).toContain("增加户外场景");
    await expect(page.getByText("流程未生成", { exact: true })).toHaveCount(0);
    expect(fixture.unexpectedMutations).toEqual([]);
});

test("changing a completed brief marks the result stale and replans with a new request ID", async ({ page }) => {
    const fixture = await mockVideoRuntime(page);
    await generateDefaultWorkflow(page);
    await page.getByRole("textbox", { name: "规划脚本提示词", exact: true }).fill("保留这条已编辑的脚本要求。");
    await selectOption(page, "目标时长", "30 秒");
    await expect(page.getByText("需求已修改", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "规划脚本提示词", exact: true })).toHaveValue("保留这条已编辑的脚本要求。");
    await page.getByRole("button", { name: "重新生成流程", exact: true }).click();
    await expect(page.getByTestId("commerce-video-workflow-result")).toContainText("30 秒 · 3 个阶段");
    await expect(page.getByText("需求已修改", { exact: true })).toHaveCount(0);
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests[1].requestId).not.toBe(fixture.requests[0].requestId);
    expect(fixture.requests[1].durationSeconds).toBe(30);
    expect(fixture.unexpectedMutations).toEqual([]);
});

test("an empty Skill library blocks planning and refresh discovers an imported video Skill", async ({ page }) => {
    const fixture = await mockVideoRuntime(page, { skills: [] });
    await openVideoWorkspace(page);
    await page.getByLabel("产品与视频目标", { exact: false }).fill(BRIEF);
    await expect(page.getByRole("status").filter({ hasText: "暂无可用的视频 Skill" })).toBeVisible();
    await expect(page.getByRole("button", { name: "生成视频流程", exact: true })).toBeDisabled();
    expect(fixture.requests).toEqual([]);

    fixture.state.skills = [{ ...VIDEO_SKILL, id: "private-video-skill", name: "我的视频流程 Skill" }];
    await page.getByRole("button", { name: "刷新视频 Skill", exact: true }).click();
    await expect(page.getByRole("button", { name: "生成视频流程", exact: true })).toBeEnabled();
    await expect(page.getByRole("status").filter({ hasText: "暂无可用的视频 Skill" })).toHaveCount(0);
    await page.getByRole("button", { name: "生成视频流程", exact: true }).click();
    await expectResult(page);
    expect(fixture.requests[0].skillId).toBe("private-video-skill");
    await expect(page.getByTestId("commerce-video-workflow-result")).toContainText("我的视频流程 Skill");
    expect(fixture.skillWorkspaces.filter((workspace) => workspace === "video").length).toBeGreaterThanOrEqual(2);
    expect(fixture.unexpectedMutations).toEqual([]);
    await expectNoHorizontalOverflow(page);
});

test("a failed Skill lookup can be refreshed without losing the video brief", async ({ page }) => {
    const fixture = await mockVideoRuntime(page, { skillFailures: 1 });
    await openVideoWorkspace(page);
    const brief = page.getByLabel("产品与视频目标", { exact: false });
    await brief.fill(BRIEF);
    await expect(page.getByRole("alert").filter({ hasText: "视频 Skill 列表暂时不可用" })).toBeVisible();
    await expect(page.getByRole("button", { name: "生成视频流程", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "刷新视频 Skill", exact: true }).click();
    await expect(page.getByRole("button", { name: "生成视频流程", exact: true })).toBeEnabled();
    await expect(brief).toHaveValue(BRIEF);
    await page.getByRole("button", { name: "生成视频流程", exact: true }).click();
    await expectResult(page);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.unexpectedMutations).toEqual([]);
});

test("missing materials remain preparation tasks and long prompts are not silently truncated into creation links", async ({ page }) => {
    const fixture = await mockVideoRuntime(page);
    await generateDefaultWorkflow(page);
    await page.getByRole("tab", { name: "素材与检查", exact: true }).click();
    const result = page.getByTestId("commerce-video-workflow-result");
    await expect(result.getByRole("listitem").filter({ hasText: "产品图片" })).toContainText("待补充");
    await expect(result.getByRole("listitem").filter({ hasText: "人物图" })).toContainText("可选");
    await expectNoHorizontalOverflow(page);
    await page.getByRole("tab", { name: "阶段与提示词", exact: true }).click();
    await page.getByText("2. 生成分镜图", { exact: true }).click();
    const prompt = page.getByRole("textbox", { name: "生成分镜图提示词", exact: true });
    await prompt.fill("图".repeat(4001));
    await expect(page.getByRole("link", { name: "打开图片创作", exact: true })).toHaveCount(0);
    await expect(page.getByText("提示词较长，请精简后打开创作，或复制后分步执行。", { exact: true })).toBeVisible();
    await prompt.fill("精简后的分镜图提示词");
    await expect(page.getByRole("link", { name: "打开图片创作", exact: true })).toBeVisible();
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.unexpectedMutations).toEqual([]);
    await expectNoHorizontalOverflow(page);
});

async function openVideoWorkspace(page: Page) {
    await page.goto("/commerce/video", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "视频流程生成", exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId("commerce-video-workspace")).toHaveAttribute("data-ready", "true", { timeout: 45_000 });
    await expect(page.getByRole("button", { name: "刷新视频 Skill", exact: true })).toBeEnabled();
}

async function generateDefaultWorkflow(page: Page) {
    await openVideoWorkspace(page);
    await page.getByLabel("产品与视频目标", { exact: false }).fill(BRIEF);
    await page.getByRole("button", { name: "生成视频流程", exact: true }).click();
    await expectResult(page);
}

async function expectResult(page: Page) {
    await expect(page.getByTestId("commerce-video-workflow-result")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "随行杯视频流程", exact: true })).toBeVisible();
}

async function selectOption(page: Page, label: string, option: string) {
    await page.getByRole("combobox", { name: label, exact: true }).click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option-content").filter({ hasText: new RegExp(`^${option}$`) }).click();
}

async function expectNoHorizontalOverflow(page: Page) {
    const overflow = await page.evaluate(() => ({ document: document.documentElement.scrollWidth - document.documentElement.clientWidth, workspace: (() => { const element = document.querySelector('[data-testid="commerce-video-workspace"]'); return element ? element.scrollWidth - element.clientWidth : 0; })() }));
    expect(overflow.document).toBeLessThanOrEqual(1);
    expect(overflow.workspace).toBeLessThanOrEqual(1);
}

async function downloadText(page: Page, buttonName: string, filename: string) {
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: buttonName, exact: true }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe(filename);
    const filePath = await download.path();
    expect(filePath).not.toBeNull();
    return readFile(filePath!, "utf8");
}

async function expectCreationDraft(page: Page, link: Locator, mode: "image" | "video", prompt: string) {
    const href = await link.getAttribute("href");
    expect(href).not.toBeNull();
    const target = new URL(href!, page.url());
    expect(target.pathname).toBe("/create");
    const draft = new URLSearchParams(target.hash.slice(1));
    expect(draft.get("mode")).toBe(mode);
    expect(draft.get("prompt")).toBe(prompt);
    const pending = page.waitForEvent("popup");
    await link.click();
    const popup = await pending;
    await expect(popup.locator('.creative-composer[data-ready="true"]')).toBeVisible({ timeout: 45_000 });
    await expect(popup.getByPlaceholder("输入你的创作想法、脚本或画面要求")).toHaveValue(prompt);
    await expect(popup.getByRole("button", { name: `当前创作类型：${mode === "image" ? "图片生成" : "视频生成"}`, exact: true })).toBeVisible();
    await expect(popup).toHaveURL(/\/create$/);
    await expect(popup.getByTestId("creative-primary-result")).toHaveCount(0);
    await popup.close();
}

async function mockVideoRuntime(page: Page, options: { skills?: AgentSkillSummary[]; workflowFailures?: number; skillFailures?: number } = {}) {
    const requests: CommerceVideoWorkflowInput[] = [];
    const unexpectedMutations: string[] = [];
    const skillWorkspaces: (string | null)[] = [];
    const state = { skills: options.skills ?? [VIDEO_SKILL], workflowFailures: options.workflowFailures ?? 0, skillFailures: options.skillFailures ?? 0 };
    const reply = (route: Route, data: unknown) => route.fulfill({ json: { code: 0, data, msg: "OK" } });

    // 使用 context 级模拟同时保护新开的创作页；任何未声明的写请求都不会到达真实服务。
    await page.context().route("**/api/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        if (path === "/api/commerce/video/workflow" && request.method() === "POST") {
            const input = request.postDataJSON() as CommerceVideoWorkflowInput;
            requests.push(input);
            if (state.workflowFailures > 0) {
                state.workflowFailures -= 1;
                return route.fulfill({ status: 503, json: { code: 503, data: null, msg: "规划服务暂时不可用，请重试。" } });
            }
            const skill = state.skills.find((item) => item.id === input.skillId) || VIDEO_SKILL;
            return reply(route, { workflow: workflowFixture(input), skill: { id: skill.id, name: skill.name }, modelId: "text-planner", generatedAt: "2026-09-09T00:00:00.000Z" });
        }
        if (request.method() !== "GET" || path.startsWith("/api/ai/")) {
            unexpectedMutations.push(`${request.method()} ${path}`);
            return route.fulfill({ status: 501, json: { code: 501, data: null, msg: "浏览器测试禁止调用未模拟的生成或写入接口。" } });
        }
        if (path === "/api/agent/skills") {
            skillWorkspaces.push(url.searchParams.get("workspace"));
            if (state.skillFailures > 0) {
                state.skillFailures -= 1;
                return route.fulfill({ status: 503, json: { code: 503, data: null, msg: "视频 Skill 列表暂时不可用" } });
            }
            return reply(route, { skills: state.skills });
        }
        if (path === "/api/creative/conversations") return reply(route, { conversations: [], hasMore: false });
        if (path === "/api/agent/runs") return reply(route, { runs: [] });
        if (path === "/api/create/overview") return reply(route, { overview: { runningTasks: [], recentAssets: [] } });
        if (path === "/api/public/gallery") return reply(route, { items: [] });
        if (path === "/api/notifications/interactions") return reply(route, { items: [], unreadCount: 0 });
        return route.continue();
    });
    return { requests, unexpectedMutations, skillWorkspaces, state };
}

function workflowFixture(input: CommerceVideoWorkflowInput): CommerceVideoWorkflow {
    const materials: [CommerceVideoWorkflow["materialChecklist"][number]["id"], string, string][] = [
        ["product-images", "产品图片", "保持商品外观一致"],
        ["reference-video", "参考视频", "参考叙事与节奏"],
        ["storyboard", "分镜图", "指导各片段画面"],
        ["character-images", "人物图", "保持人物一致"],
        ["voiceover", "配音素材", "用于剪辑"],
    ];
    return {
        title: "随行杯视频流程",
        summary: "先准备产品资料与脚本，再生成分镜图和视频片段。",
        route: { kind: "original", reason: "根据产品目标规划原创展示" },
        materialChecklist: materials.map(([id, name, purpose]) => ({ id, name, purpose, status: input.materials.includes(id) ? "ready" : id === "product-images" ? "missing" : "optional" })),
        stages: [
            { id: "script", title: "规划脚本", goal: "确定叙事顺序", inputs: ["产品资料"], outputs: ["分段脚本"], dependsOn: [], prompt: "根据真实卖点设计脚本，不虚构功效", execution: "text" },
            { id: "images", title: "生成分镜图", goal: "确定商品画面", inputs: ["脚本", "产品图"], outputs: ["分镜图"], dependsOn: ["script"], prompt: "保持产品颜色与包装，生成干净桌面场景", execution: "image" },
            { id: "video", title: "生成视频片段", goal: "形成连续镜头", inputs: ["分镜图"], outputs: ["视频片段"], dependsOn: ["images"], prompt: "运镜平稳，保持杯身颜色和包装一致", execution: "video" },
        ],
        segments: Array.from({ length: input.durationSeconds / 15 }, (_, index) => ({ id: `segment-${index + 1}`, startSeconds: index * 15, endSeconds: (index + 1) * 15, goal: "展示产品细节", visualPrompt: "杯身缓慢转动，光线自然", voiceover: "", continuityNotes: "保持杯身颜色和背景一致" })),
        checks: ["检查产品颜色、文案与总时长"],
    };
}
