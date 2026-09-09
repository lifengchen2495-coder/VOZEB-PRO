import { expect, test } from "@playwright/test";

function check(condition: boolean, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

test("短剧创作稿逐阶段采用并持久保存，异步候选不覆盖编辑", async ({ page, context }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());
    const created = await context.request.post("/api/drama/projects", { data: { title: "六阶段流程浏览器回归", summary: "", style: "现代都市", ratio: "9:16" } });
    check(created.ok(), `测试项目创建失败 ${created.status()} ${await created.text()}`);
    const project = (await created.json()).data.project;
    const projectId = project.id;
    await page.goto(`/drama/${projectId}`, { waitUntil: "domcontentloaded", timeout: 120000 });
    await expect(page.locator('[data-drama-workflow="story"]')).toBeVisible({ timeout: 120000 });
    const adopt = async (stage: string) => {
        const panel = page.locator(`[data-drama-workflow="${stage}"]`);
        const saved = page.waitForResponse((response) => response.url().endsWith("/workflow") && response.request().postDataJSON().action === "save");
        await panel.getByRole("button", { name: "保存为新候选", exact: true }).click();
        const saveResponse = await saved;
        check(saveResponse.ok(), `保存 ${stage} 失败：${await saveResponse.text()}`);
        await expect(panel.getByRole("button", { name: "采用此稿", exact: true })).toBeEnabled();
        const adopted = page.waitForResponse((response) => response.url().endsWith("/workflow") && response.request().postDataJSON().action === "adopt");
        await panel.getByRole("button", { name: "采用此稿", exact: true }).click();
        const adoptResponse = await adopted;
        check(adoptResponse.ok(), `采用 ${stage} 失败：${await adoptResponse.text()}`);
        await expect(panel.getByText("已采用 v1", { exact: true })).toBeVisible();
        await expect(page.locator("[data-drama-workspace]")).not.toHaveAttribute("inert", "");
    };
    await page.getByRole("textbox", { name: "故事梗概", exact: true }).fill("修钟师发现旧钟记录了父亲失踪那天的真相。");
    await page.getByRole("textbox", { name: "核心冲突", exact: true }).fill("寻找真相与保护家人发生冲突。");
    await page.getByRole("textbox", { name: "锁定事实（改编时必须遵守）", exact: true }).fill("父亲没有死亡，旧钟不能穿越时间。");
    await adopt("story");
    await page.getByRole("button", { name: "继续：人物小传", exact: true }).click();
    await page.getByRole("textbox", { name: "姓名", exact: true }).fill("林夏");
    await page.getByRole("textbox", { name: "动机与目标", exact: true }).fill("找到父亲，证明自己的判断。");
    await adopt("characters");
    await page.getByRole("button", { name: "继续：分集节奏", exact: true }).click();
    await page.getByRole("textbox", { name: "本集大纲", exact: true }).fill("林夏修好旧钟，从夹层找到车票。");
    await page.getByRole("textbox", { name: "节拍标题", exact: true }).fill("旧钟里的车票");
    await page.getByRole("textbox", { name: "剧情事件", exact: true }).fill("林夏拆开钟壳，看见一张当天的车票。");
    await adopt("beats");
    await page.getByRole("button", { name: "继续：剧本创作", exact: true }).click();
    await page.getByRole("textbox", { name: "地点 / 内外景", exact: true }).fill("内景 · 修钟铺");
    await page.getByRole("textbox", { name: "第 1 段内容", exact: true }).fill("林夏拆下钟壳，一张车票飘落在柜台。");
    await adopt("script");
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-drama-workflow="script"]')).toBeVisible({ timeout: 60000 });
    const persisted = (await (await context.request.get(`/api/drama/projects/${projectId}`)).json()).data.project;
    check(persisted.workflow.artifacts.filter((item) => item.status === "adopted").length === 4, "四阶段采用稿未持久保存");
    check(persisted.episodes[0].script.includes("车票飘落在柜台"), "采用剧本未同步正文");
    check(persisted.characters[0].name === "林夏", "人物未同步资产");
    // 文本模型结果使用固定数据，实际走页面与项目保存接口。
    await page.route("**/api/drama/analyze", async (route) => {
        const input = route.request().postDataJSON();
        const data =
            input.phase === "content"
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
                              dialogue: "",
                              narration: "",
                              utterances: [],
                              duration: 5,
                              characterNames: ["林夏"],
                              sceneName: "",
                              propNames: [],
                              clueNames: [],
                          },
                      ],
                  }
                : {
                      shots: input.shots.map((shot: { id: string }) => ({
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
        await route.fulfill({ json: { code: 0, data, msg: "OK" } });
    });
    await page
        .locator("[data-drama-script-global-bar]")
        .getByRole("button", { name: /进入内容审核/ })
        .click();
    await expect(page.getByRole("heading", { name: "分镜设计 · 内容审核", exact: true })).toBeVisible({ timeout: 30000 });
    await page.getByRole("button", { name: "确认内容并生成视觉方案", exact: true }).click();
    await expect(page.getByRole("heading", { name: "分镜编辑", exact: true })).toBeVisible({ timeout: 30000 });
    await page.getByRole("button", { name: "进入镜头生成", exact: true }).click();
    await expect(page.locator('[data-drama-stage="generate"]')).toBeVisible();
    await page
        .getByRole("button", { name: /剧本创作/ })
        .first()
        .click();
    // 未保存编辑在阶段切换后仍保留。
    const scriptPanel = page.locator('[data-drama-workflow="script"]');
    await scriptPanel.getByRole("textbox", { name: "第 1 段内容", exact: true }).fill("林夏摊开车票，背面写着一个地址。");
    await page
        .getByRole("button", { name: /故事设定/ })
        .first()
        .click();
    await page
        .getByRole("button", { name: /剧本创作/ })
        .first()
        .click();
    await expect(page.getByRole("textbox", { name: "第 1 段内容", exact: true })).toHaveValue("林夏摊开车票，背面写着一个地址。");
    await expect(page.getByRole("button", { name: "采用此稿", exact: true })).toBeDisabled();
    let releaseGeneration = () => {};
    let generationStarted = () => {};
    const started = new Promise<void>((resolve) => {
        generationStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
        releaseGeneration = resolve;
    });
    await page.route("**/api/drama/projects/*/workflow", async (route) => {
        const input = route.request().postDataJSON();
        if (input.action !== "generate") return route.continue();
        generationStarted();
        await gate;
        const result = await context.request.post(route.request().url(), {
            data: { ...input, action: "save", data: { scenes: [{ id: "scene-ai", title: "新候选", location: "修钟铺", time: "", lighting: "", blocks: [{ id: "block-ai", type: "action", speaker: "", text: "AI 生成的新候选。" }] }] } },
        });
        await route.fulfill({ response: result });
    });
    await page.getByRole("button", { name: "AI 生成候选稿", exact: true }).click();
    await started;
    await page.getByRole("textbox", { name: "第 1 段内容", exact: true }).fill("生成期间继续编辑，不能被候选覆盖。");
    releaseGeneration();
    await expect(page.getByRole("button", { name: "AI 生成候选稿", exact: true })).toBeEnabled({ timeout: 30000 });
    await expect(page.getByRole("textbox", { name: "第 1 段内容", exact: true })).toHaveValue("生成期间继续编辑，不能被候选覆盖。");
    const afterGenerate = (await (await context.request.get(`/api/drama/projects/${projectId}`)).json()).data.project;
    check(afterGenerate.workflow.artifacts.length === 5, "异步候选未保留");
    for (const width of [1024, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), { timeout: 5000, message: `${width} 宽度横向溢出` }).toBe(true);
    }
    expect(errors).toEqual([]);
    await context.request.delete(`/api/drama/projects/${projectId}`);
});
