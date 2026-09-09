import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

const originalScript = "内景 · 修钟铺。林夏拆下钟壳，一张车票飘落在柜台。林夏说：“这是父亲失踪那天的车票。”她翻过车票，背面写着一个陌生地址。";
const revisedScript = `${originalScript}林夏把车票收进口袋，决定先去寻找母亲。`;
const workflowFixtures = {
    story: {
        logline: "修钟师林夏从旧钟找到父亲失踪当日的车票。",
        genre: "悬疑",
        audience: "",
        worldRules: "现代都市",
        coreConflict: "父亲失踪的真相藏在旧物之中。",
        adaptationMode: "faithful",
        lockedFacts: "林夏找到车票，车票背面有陌生地址。",
        targetDuration: null,
        episodeCount: 1,
    },
    characters: {
        characters: [
            {
                id: "character-linxia",
                name: "林夏",
                aliases: [],
                role: "主角",
                background: "修钟师",
                motivation: "查明父亲失踪的真相",
                personality: "细心",
                relationships: "失踪者的女儿",
                arc: "从发现线索到决定追查",
                visualIdentity: "原稿未明确",
                voiceStyle: "原稿未明确",
                signatureAction: "拆开钟壳",
            },
        ],
    },
    beats: {
        outline: "林夏修钟时找到车票和陌生地址。",
        hook: "地址指向父亲失踪的真相。",
        nextPreview: "",
        beats: [{ id: "beat-ticket", title: "旧钟里的车票", duration: null, description: "林夏拆下钟壳，找到失踪当日的车票。", emotion: "惊讶", payoff: "车票背面的地址" }],
    },
} as const;

type AnalysisStage = keyof typeof workflowFixtures;
type ModelMocks = { calls: string[]; textModels?: string[]; beforeWorkflow?: (stage: AnalysisStage, route: Route) => Promise<boolean>; beforeContent?: () => Promise<void> };

test.beforeEach(async ({ page }) => {
    // 只为浏览器提供模型目录，所有生成仍由下方 fixture 拦截。
    await page.route("**/api/auth/session", async (route) => {
        const response = await route.fetch();
        const payload = await response.json();
        payload.settings = {
            ...payload.settings,
            systemChannels: [{ id: "drama-test", name: "测试渠道", enabled: true, hasApiKey: true, models: ["gpt-analysis-a", "gpt-analysis-b"], apiFormat: "openai" }],
            logicalModels: ["a", "b"].map((id) => ({
                id: `drama-model-${id}`,
                name: `分析模型 ${id.toUpperCase()}`,
                capability: "text",
                enabled: true,
                bindings: [{ id, channelId: "drama-test", upstreamModel: `gpt-analysis-${id}`, enabled: true, priority: 1 }],
            })),
            defaultModels: { textModel: "drama-model-a" },
        };
        await route.fulfill({ json: payload });
    });
});

function check(condition: boolean, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function deferred() {
    let resolve = () => {};
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function readProject(context: BrowserContext, projectId: string) {
    const response = await context.request.get(`/api/drama/projects/${projectId}`);
    check(response.ok(), `读取测试项目失败：${response.status()} ${await response.text()}`);
    return (await response.json()).data.project;
}

async function withProject(page: Page, context: BrowserContext, title: string, run: (projectId: string) => Promise<void>) {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const created = await context.request.post("/api/drama/projects", { data: { title, summary: "", style: "现代都市", ratio: "9:16" } });
    check(created.ok(), `测试项目创建失败：${created.status()} ${await created.text()}`);
    const projectId = (await created.json()).data.project.id;
    try {
        await page.goto(`/drama/${projectId}`, { waitUntil: "domcontentloaded", timeout: 120000 });
        await expect(page.locator('[aria-label="本集剧本编辑器"][contenteditable="true"]')).toBeVisible({ timeout: 120000 });
        await expect(page.locator('[data-drama-workflow="script"]')).toHaveCount(0);
        await run(projectId);
        expect(errors).toEqual([]);
    } finally {
        await page.unrouteAll({ behavior: "wait" });
        await context.request.delete(`/api/drama/projects/${projectId}`);
    }
}

async function mockModels(page: Page, context: BrowserContext, mocks: ModelMocks) {
    await page.route("**/api/drama/projects/*/workflow", async (route) => {
        const input = route.request().postDataJSON();
        if (input.action !== "analyze") return route.continue();
        const stage = input.stage as AnalysisStage;
        check(stage in workflowFixtures, `意外的分析阶段：${stage}`);
        mocks.calls.push(stage);
        mocks.textModels?.push(input.textModel);
        if (await mocks.beforeWorkflow?.(stage, route)) return;
        // 只替代模型产物，保留请求指纹并走真实的校验、保存和自动采用接口。
        const response = await context.request.post(route.request().url(), { data: { ...input, action: "save", intent: "analysis", data: workflowFixtures[stage] } });
        await route.fulfill({ response });
    });
    await page.route("**/api/drama/analyze", async (route) => {
        const input = route.request().postDataJSON();
        mocks.calls.push(input.phase);
        mocks.textModels?.push(input.textModel);
        if (input.phase === "content") await mocks.beforeContent?.();
        const data = analysisFixture(input);
        await route.fulfill({ json: { code: 0, data, msg: "OK" } });
    });
}

function analysisFixture(input: { phase: string; script?: string; shots?: Array<{ id: string }> }) {
    if (input.phase === "video-prompts") return { shots: (input.shots || []).map((shot) => ({ shotId: shot.id, videoPrompt: "林夏缓缓拆下钟壳，车票飘落在柜台上。" })) };
    return input.phase === "content"
        ? {
              episode: { outline: "修钟发现车票", hook: "车票来自父亲", nextPreview: "", sourceRange: "第一集" },
              characters: [],
              scenes: [],
              props: [],
              clues: [],
              shots: [
                  {
                      title: "车票掉落",
                      description: "林夏拆下钟壳，一张车票飘落在柜台。",
                      sourceText: input.script,
                      shotBoundary: "车票落定",
                      dialogue: "这是父亲失踪那天的车票。",
                      narration: "",
                      utterances: [{ id: "utterance-one", order: 1, type: "dialogue", speaker: "林夏", text: "这是父亲失踪那天的车票。" }],
                      duration: 5,
                      characterNames: ["林夏"],
                      sceneName: "",
                      propNames: [],
                      clueNames: [],
                  },
              ],
          }
        : {
              shots: (input.shots || []).map((shot: { id: string }) => ({
                  shotId: shot.id,
                  imagePrompt: "林夏站在修钟柜台前",
                  videoPrompt: "林夏拆下钟壳，车票飘落",
                  cameraMotion: "固定镜头",
                  startFramePrompt: "手持钟壳",
                  endFramePrompt: "车票落在柜台",
                  negativePrompt: "",
                  continuity: {
                      shotSize: "近景",
                      cameraAngle: "平视",
                      composition: "中央",
                      characterBlocking: "柜台前",
                      gazeDirection: "向下",
                      actionStart: "拆钟壳",
                      actionEnd: "看向车票",
                      screenDirection: "右",
                      axisRule: "同侧",
                      continuityNotes: "保持人物和钟表一致",
                  },
              })),
          };
}

async function fillScript(page: Page, script = originalScript) {
    await page.locator('[aria-label="本集剧本编辑器"][contenteditable="true"]').fill(script);
}

async function analyze(page: Page) {
    await page.locator("[data-drama-script-global-bar]").getByRole("button", { name: "AI 一键分析剧本", exact: true }).click();
}

async function openStage(page: Page, label: string) {
    await page.getByRole("button", { name: `切换到${label}`, exact: true }).click();
}

test("只提供剧本即可一键分析，结果自动采用且原稿保持不变", async ({ page, context }) => {
    const mocks: ModelMocks = { calls: [] };
    await mockModels(page, context, mocks);
    await withProject(page, context, "原稿一键分析浏览器回归", async (projectId) => {
        await openStage(page, "故事分析");
        const emptyReport = page.locator('[data-drama-workflow="story"]');
        await expect(emptyReport.locator("[data-drama-analysis-empty]")).toBeVisible();
        await expect(emptyReport.getByRole("textbox", { name: "故事梗概", exact: true })).toHaveCount(0);
        await expect(emptyReport.getByRole("button", { name: "编辑分析结果", exact: true })).toHaveCount(0);
        await openStage(page, "剧本输入");
        await fillScript(page);
        await analyze(page);
        await expect(page.getByRole("heading", { name: "分镜编辑", exact: true })).toBeVisible({ timeout: 60000 });
        expect(mocks.calls).toEqual(["story", "characters", "beats", "content", "visual"]);
        const persisted = await readProject(context, projectId);
        expect(persisted.episodes[0].script).toBe(originalScript);
        expect(persisted.episodes[0].reviewStatus).toBe("visual_ready");
        expect(persisted.workflow.artifacts.map((item: { stage: string; status: string; intent: string }) => [item.stage, item.status, item.intent])).toEqual([
            ["story", "adopted", "analysis"],
            ["characters", "adopted", "analysis"],
            ["beats", "adopted", "analysis"],
        ]);
        expect(persisted.characters[0].name).toBe("林夏");
        expect(persisted.episodes[0].outline).toBe(workflowFixtures.beats.outline);

        for (const [stage, label, field] of [
            ["story", "故事分析", "故事梗概"],
            ["characters", "人物分析", "姓名"],
            ["beats", "节奏分析", "本集大纲"],
        ]) {
            await openStage(page, label);
            const panel = page.locator(`[data-drama-workflow="${stage}"]`);
            await expect(panel.getByText("已应用 v1", { exact: true })).toBeVisible();
            await expect(panel.getByRole("textbox", { name: field, exact: true })).toHaveCount(0);
            for (const width of [390, 1024, 1440]) {
                await page.setViewportSize({ width, height: 1000 });
                await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), { message: `${stage} 报告在 ${width} 宽度横向溢出` }).toBe(true);
            }
            await panel.getByRole("button", { name: "编辑分析结果", exact: true }).click();
            await expect(panel.getByRole("textbox", { name: field, exact: true })).toBeVisible();
            await panel.getByRole("button", { name: "取消编辑", exact: true }).click();
            await expect(panel.getByRole("textbox", { name: field, exact: true })).toHaveCount(0);
        }
        await openStage(page, "分镜设计");
        await page.getByRole("button", { name: "进入镜头生成", exact: true }).click();
        await expect(page.locator('[data-drama-stage="generate"]')).toBeVisible();
        for (const width of [390, 1024, 1440]) {
            await page.setViewportSize({ width, height: 1000 });
            await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), { message: `视频制作在 ${width} 宽度横向溢出` }).toBe(true);
        }
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.locator('[aria-label="本集剧本编辑器"][contenteditable="true"]')).toHaveText(originalScript, { timeout: 60000 });
        const reloaded = await readProject(context, projectId);
        expect(reloaded.workflow.artifacts.map((item: { id: string }) => item.id)).toEqual(persisted.workflow.artifacts.map((item: { id: string }) => item.id));
        expect(reloaded.episodes[0].script).toBe(originalScript);
    });
});

test("文本模型可选并随项目保存，完整分析和单步重分析使用所选模型", async ({ page, context }) => {
    const mocks: ModelMocks = { calls: [], textModels: [] };
    await mockModels(page, context, mocks);
    await withProject(page, context, "短剧文本模型浏览器回归", async (projectId) => {
        const control = page.locator("[data-drama-text-model]");
        await expect(control).toContainText("分析模型 A");
        await control.getByRole("combobox", { name: "短剧文本模型" }).click();
        await page.getByText("分析模型 B", { exact: true }).click();
        await expect(control).toContainText("分析模型 B");
        await fillScript(page);
        await analyze(page);
        await expect(page.getByRole("heading", { name: "分镜编辑", exact: true })).toBeVisible({ timeout: 60000 });
        expect(mocks.calls).toEqual(["story", "characters", "beats", "content", "visual"]);
        expect(mocks.textModels).toEqual(Array(5).fill("drama-model-b"));
        expect((await readProject(context, projectId)).textModel).toBe("drama-model-b");
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(control).toContainText("分析模型 B", { timeout: 60000 });
        await openStage(page, "分镜设计");
        await page.getByRole("button", { name: "保存并重新生成", exact: true }).click();
        await expect.poll(() => mocks.calls.at(-1)).toBe("video-prompts");
        await expect(control.getByRole("combobox", { name: "短剧文本模型" })).toBeEnabled();
        await openStage(page, "故事分析");
        await page.getByRole("button", { name: "AI 重新分析", exact: true }).click();
        await expect.poll(() => mocks.calls.filter((stage) => stage === "story").length).toBe(2);
        await expect(control.getByRole("combobox", { name: "短剧文本模型" })).toBeEnabled();
        expect(mocks.textModels).toEqual(Array(7).fill("drama-model-b"));
        expect((await readProject(context, projectId)).episodes[0].script).toBe(originalScript);
        for (const width of [390, 1024, 1440]) {
            await page.setViewportSize({ width, height: 1000 });
            await expect(control).toBeVisible();
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        }
    });
});

test("分析失败后重试会复用已完成的故事结果", async ({ page, context }) => {
    let failed = false;
    const mocks: ModelMocks = {
        calls: [],
        beforeWorkflow: async (stage, route) => {
            if (stage !== "characters" || failed) return false;
            failed = true;
            await route.fulfill({ status: 400, json: { code: 400, data: null, msg: "测试人物分析暂时失败" } });
            return true;
        },
    };
    await mockModels(page, context, mocks);
    await withProject(page, context, "分析失败重试浏览器回归", async (projectId) => {
        await fillScript(page);
        await analyze(page);
        await expect(page.getByText("测试人物分析暂时失败", { exact: true }).first()).toBeVisible({ timeout: 60000 });
        const partial = await readProject(context, projectId);
        expect(partial.workflow.artifacts).toHaveLength(1);
        expect(partial.workflow.artifacts[0]).toMatchObject({ stage: "story", status: "adopted", intent: "analysis" });
        expect(partial.episodes[0].script).toBe(originalScript);
        await analyze(page);
        await expect(page.getByRole("heading", { name: "分镜编辑", exact: true })).toBeVisible({ timeout: 60000 });
        const completed = await readProject(context, projectId);
        expect(completed.workflow.artifacts).toHaveLength(3);
        expect(completed.workflow.artifacts[0].id).toBe(partial.workflow.artifacts[0].id);
        expect(mocks.calls).toEqual(["story", "characters", "characters", "beats", "content", "visual"]);
        expect(completed.episodes[0].script).toBe(originalScript);
    });
});

test("长请求期间修改原稿会停止旧分析，保留原稿和已完成结果", async ({ page, context }) => {
    const started = deferred();
    const release = deferred();
    const mocks: ModelMocks = {
        calls: [],
        beforeContent: async () => {
            started.resolve();
            await release.promise;
        },
    };
    await mockModels(page, context, mocks);
    await withProject(page, context, "分析期间编辑浏览器回归", async (projectId) => {
        try {
            await fillScript(page);
            await analyze(page);
            await started.promise;
            await fillScript(page, revisedScript);
        } finally {
            release.resolve();
        }
        await expect(page.getByText("分析期间剧本已修改，已完成的结果已保留，请重新点击 AI 一键分析", { exact: true }).first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('[aria-label="本集剧本编辑器"][contenteditable="true"]')).toHaveText(revisedScript);
        await expect.poll(async () => (await readProject(context, projectId)).episodes[0].script).toBe(revisedScript);
        const persisted = await readProject(context, projectId);
        expect(persisted.workflow.artifacts).toHaveLength(3);
        expect(persisted.workflow.artifacts.every((item: { intent: string }) => item.intent === "analysis")).toBe(true);
        expect(persisted.episodes[0].shots).toHaveLength(0);
        expect(mocks.calls).toEqual(["story", "characters", "beats", "content"]);
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.locator('[aria-label="本集剧本编辑器"][contenteditable="true"]')).toHaveText(revisedScript, { timeout: 60000 });
    });
});

test("已受理的分析遇到网关超时和轮询失败后自动恢复，一次点击完成分镜", async ({ page, context }) => {
    type MockTask = { id: string; stage: string; requestId: string; result: unknown; createdAt: string; updatedAt: string; polls: number };
    const tasks = new Map<string, MockTask>();
    const submissions: Array<{ stage: string; requestId: string; taskId: string }> = [];
    const modelSteps: string[] = [];
    const storyPolls: string[] = [];
    let droppedStoryResponse = false;

    const submit = async (route: Route, stage: string, makeResult: () => Promise<unknown>) => {
        const input = route.request().postDataJSON();
        check(typeof input.requestId === "string" && input.requestId.length > 0, "异步分析必须携带请求标识");
        const key = `${route.request().url()}:${input.requestId}`;
        let task = tasks.get(key);
        if (!task) {
            modelSteps.push(stage);
            const now = new Date().toISOString();
            task = { id: `analysis-task-${tasks.size + 1}`, stage, requestId: input.requestId, result: await makeResult(), createdAt: now, updatedAt: now, polls: 0 };
            tasks.set(key, task);
        }
        submissions.push({ stage, requestId: input.requestId, taskId: task.id });
        if (stage === "story" && !droppedStoryResponse) {
            droppedStoryResponse = true;
            await route.fulfill({ status: 504, contentType: "text/html", body: "<html><title>504 Gateway Time-out</title><body>openresty</body></html>" });
            return;
        }
        await route.fulfill({ status: 202, json: { code: 0, data: { task: { id: task.id, status: "pending", createdAt: task.createdAt, updatedAt: task.updatedAt } }, msg: "分析任务已提交" } });
    };

    await page.route("**/api/drama/projects/*/workflow", async (route) => {
        const input = route.request().postDataJSON();
        if (input.action !== "analyze") return route.continue();
        const stage = input.stage as AnalysisStage;
        check(stage in workflowFixtures, `意外的分析阶段：${stage}`);
        await submit(route, stage, async () => {
            // 后台任务仅替代模型调用，分析产物仍由真实接口校验并采用。
            const response = await context.request.post(route.request().url(), { data: { ...input, action: "save", intent: "analysis", data: workflowFixtures[stage] } });
            check(response.ok(), `异步任务产物保存失败：${response.status()} ${await response.text()}`);
            return (await response.json()).data;
        });
    });
    await page.route("**/api/drama/analyze", async (route) => {
        const input = route.request().postDataJSON();
        await submit(route, input.phase, async () => analysisFixture(input));
    });
    await page.route("**/api/drama/analysis-tasks/*", async (route) => {
        expect(route.request().method()).toBe("GET");
        const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
        const task = [...tasks.values()].find((item) => item.id === id);
        check(task, `轮询了未知任务：${id}`);
        task.polls++;
        if (task.stage === "story" && task.polls <= 2) {
            storyPolls.push("503");
            await route.fulfill({ status: 503, json: { code: 503, data: null, msg: "任务状态暂时不可用" } });
            return;
        }
        const successfulPoll = task.polls - (task.stage === "story" ? 2 : 0);
        const status = successfulPoll === 1 ? "pending" : successfulPoll === 2 ? "running" : "success";
        if (task.stage === "story") storyPolls.push(status);
        await route.fulfill({ json: { code: 0, data: { task: { id, status, createdAt: task.createdAt, updatedAt: new Date().toISOString(), ...(status === "success" ? { result: task.result } : {}) } }, msg: "OK" } });
    });

    await withProject(page, context, "后台任务超时恢复浏览器回归", async (projectId) => {
        await fillScript(page);
        await analyze(page);
        await expect(page.getByRole("heading", { name: "分镜编辑", exact: true })).toBeVisible({ timeout: 90000 });
        await expect(page.getByText("创作请求失败", { exact: false })).toHaveCount(0);
        await expect(page.getByText("任务状态暂时不可用", { exact: true })).toHaveCount(0);
        expect(modelSteps).toEqual(["story", "characters", "beats", "content", "visual"]);
        expect(tasks.size).toBe(5);
        const storySubmissions = submissions.filter((item) => item.stage === "story");
        expect(storySubmissions).toHaveLength(2);
        expect(new Set(storySubmissions.map((item) => item.requestId)).size).toBe(1);
        expect(new Set(storySubmissions.map((item) => item.taskId)).size).toBe(1);
        expect(storyPolls).toEqual(["503", "503", "pending", "running", "success"]);
        expect(submissions.filter((item) => item.stage !== "story").map((item) => item.stage)).toEqual(["characters", "beats", "content", "visual"]);
        const persisted = await readProject(context, projectId);
        expect(persisted.episodes[0].script).toBe(originalScript);
        expect(persisted.episodes[0].reviewStatus).toBe("visual_ready");
        expect(persisted.episodes[0].shots).toHaveLength(1);
        expect(persisted.workflow.artifacts.map((item: { stage: string; status: string; intent: string }) => [item.stage, item.status, item.intent])).toEqual([
            ["story", "adopted", "analysis"],
            ["characters", "adopted", "analysis"],
            ["beats", "adopted", "analysis"],
        ]);
    });
});
