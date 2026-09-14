import { beforeEach, describe, expect, it, vi } from "vitest";
import { bangbangBusy, bangbangCharacterImageBlockReason, bangbangStepBlockReason, createBangbangProject, type BangbangProject } from "@/lib/bangbang-contract";
import { abandonBangbangCharacterImage, applyBangbangInputPatch, getBangbangProjectForUser, reserveBangbangCharacterImage, saveBangbangProjectForUser, submitBangbangCharacterImage, validateBangbangImageRequest } from "./bangbang-project-service";
import { cleanBangbangMediaReferences } from "./bangbang-media-cleanup";
import { resumeBangbangStage } from "@/app/(user)/bangbang/[id]/workspace-state";

const mocks = vi.hoisted(() => ({ get: vi.fn(), mutate: vi.fn(), task: vi.fn(), record: vi.fn(), fetch: vi.fn(), media: vi.fn(), remove: vi.fn(), candidates: vi.fn() }));
vi.mock("./bangbang-project-store", () => ({ getBangbangProject: mocks.get, mutateBangbangProject: mocks.mutate }));
vi.mock("@/lib/auth/store", () => ({ getAuthSettings: async () => ({ defaultModels: { imageModel: "portrait-model" }, generationConcurrency: { image: 2 } }) }));
vi.mock("./generation-task-store", () => ({ getStoredGenerationTaskByRequest: mocks.task, getStoredGenerationTaskRecord: mocks.record, withGenerationConcurrencyLimit: async (_user: string, _kind: string, _ttl: number, _limit: number, callback: () => Promise<unknown>) => callback() }));
vi.mock("./logical-model-router", () => ({ resolveLogicalModelCandidates: mocks.candidates }));
vi.mock("./internal-origin", () => ({ fetchInternalApi: mocks.fetch }));
vi.mock("./local-media-registry", () => ({ getLocalMediaRegistration: mocks.media, isLocalMediaRegistrationExpired: () => false }));
vi.mock("./local-media-storage", () => ({ deleteUserLocalMediaAssets: mocks.remove }));

let project: BangbangProject;
const userId = "portrait-owner";
const characterId = "C01";
const assetKey = "permanent/2026/09/14/images/portrait.png";
const assetUrl = `/api/generation-log-assets/${assetKey}`;
const output = (text: string) => ({ text, source: "model" as const, createdAt: new Date().toISOString() });
const input = () => ({ userId, projectId: project.id, revision: project.revision, characterId, origin: "http://app.test", credential: "test-cookie" });
const completedTask = () => ({ id: "portrait-task", userId, projectId: project.id, generationSlotId: `bangbang-character:${characterId}`, prompt: project.characters[0].image?.prompt, references: [], status: "success", result: { serverUrl: assetUrl, width: 1024, height: 1792 } });

beforeEach(() => {
    vi.clearAllMocks();
    project = createBangbangProject("bangbang-portrait-test", "清洁剂");
    project.outputs.script = output("已保存剧本");
    project.outputs.characters = output("两名角色");
    project.characters = [
        { id: characterId, name: "林宁", gender: "女", age: "30–33岁", role: "姐姐", appearance: "低马尾，米白针织衫、深灰长裤" },
        { id: "C02", name: "林川", gender: "男", age: "25–28岁", role: "弟弟", appearance: "短发，深蓝卫衣、卡其长裤" },
    ];
    mocks.get.mockImplementation(async (_id, owner) => owner === userId ? structuredClone(project) : null);
    mocks.mutate.mockImplementation(async (owner, _id, change) => {
        if (owner !== userId) return null;
        project = change(structuredClone(project));
        return structuredClone(project);
    });
    mocks.task.mockResolvedValue(null);
    mocks.record.mockResolvedValue(null);
    mocks.fetch.mockImplementation(async () => new Response("{}", { status: 202 }));
    mocks.candidates.mockReturnValue([{}]);
    mocks.remove.mockResolvedValue(undefined);
    mocks.media.mockResolvedValue({ ownerUserId: userId, type: "image", scope: "generation", storageKey: assetKey, mimeType: "image/png", bytes: 100 });
});

describe("人物图生成和自动绑定", () => {
    it("素材已达上限时不提交付费请求，明确失败的提交解除生成锁", async () => {
        project.references.character = Array.from({ length: 8 }, (_, index) => ({ id: `ref-${index}`, label: "人物图", media: { url: assetUrl, mimeType: "image/png" } }));
        await expect(submitBangbangCharacterImage(input())).rejects.toThrow("最多 8 张");
        expect(mocks.fetch).not.toHaveBeenCalled();
        project.references.character = [];
        mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "模型不支持此尺寸" }), { status: 400 }));
        await expect(submitBangbangCharacterImage(input())).rejects.toThrow("模型不支持此尺寸");
        expect(bangbangBusy(project)).toBe(false);
    });
    it("使用已选生图模型及角色外观提交，任务期间阻止分镜和素材修改", async () => {
        project.modelSelection.image = "chosen-model";
        await submitBangbangCharacterImage(input());
        const body = JSON.parse(mocks.fetch.mock.calls[0][1].body);
        expect(body).toMatchObject({ kind: "generation", references: [], config: { model: "chosen-model", size: "9:16", quality: "2K" }, context: { generationSlotId: "bangbang-character:C01", attemptNo: 1 } });
        expect(body.prompt).toContain("低马尾，米白针织衫、深灰长裤");
        expect(body.prompt).not.toContain("深蓝卫衣");
        expect(bangbangBusy(project)).toBe(true);
        expect(bangbangStepBlockReason(project, "storyboard")).toContain("处理中");
        expect(bangbangCharacterImageBlockReason(project, "C02")).toContain("等待");
        expect(resumeBangbangStage(project)).toBe("characters");
        await expect(saveBangbangProjectForUser(userId, project.id, project.revision, { title: "不能并发修改" })).rejects.toThrow("等待当前任务");
    });

    it("网络中断后复用请求号和尝试次数，允许检查并撤销未创建的任务", async () => {
        mocks.fetch.mockRejectedValueOnce(new Error("connection reset"));
        await expect(submitBangbangCharacterImage(input())).rejects.toThrow("继续提交");
        const reserved = structuredClone(project.characters[0].image);
        await submitBangbangCharacterImage(input());
        expect(project.characters[0].image).toEqual(reserved);
        expect(mocks.fetch.mock.calls[0][1].headers["x-vozeb-pro-client-request-id"]).toBe(mocks.fetch.mock.calls[1][1].headers["x-vozeb-pro-client-request-id"]);
        await abandonBangbangCharacterImage(userId, project.id, characterId);
        expect(bangbangBusy(project)).toBe(false);
        await reserveBangbangCharacterImage(userId, project.id, project.revision, characterId);
        expect(project.characters[0].image?.attemptNo).toBe(2);
    });

    it("刷新读取成功任务时保存图片并只绑定对应角色，重复读取不重复追加", async () => {
        project.outputs.storyboard = output("需要失效的旧分镜");
        await submitBangbangCharacterImage(input());
        mocks.task.mockResolvedValue(completedTask());
        const value = await getBangbangProjectForUser(userId, project.id);
        expect(value.characters[0]).toMatchObject({ imageId: "character-portrait-task", image: { status: "approved", result: { url: assetUrl } } });
        expect(value.characters[1].imageId).toBeUndefined();
        expect(value.references.character).toHaveLength(1);
        expect(value.outputs.script?.text).toBe("已保存剧本");
        expect(value.outputs.storyboard).toBeUndefined();
        const again = await getBangbangProjectForUser(userId, project.id);
        expect(again.revision).toBe(value.revision);
        expect(again.references.character).toEqual(value.references.character);
    });

    it.each(["userId", "projectId", "generationSlotId", "prompt"])("不绑定 %s 不匹配的任务结果", async (field) => {
        await submitBangbangCharacterImage(input());
        mocks.task.mockResolvedValue({ ...completedTask(), [field]: "wrong" });
        await getBangbangProjectForUser(userId, project.id);
        expect(project.references.character).toHaveLength(0);
        expect(project.characters[0].imageId).toBeUndefined();
    });

    it("在原子保存前角色请求已改变时，不写回迟到的图片", async () => {
        await submitBangbangCharacterImage(input());
        mocks.task.mockResolvedValue(completedTask());
        mocks.mutate.mockImplementationOnce(async (_owner, _id, change) => {
            project.characters[0].image!.clientRequestId = "new-request";
            project = change(structuredClone(project));
            return project;
        });
        await getBangbangProjectForUser(userId, project.id);
        expect(project.references.character).toHaveLength(0);
    });

    it("拒绝伪造、已撤销的预留以及其他用户访问", async () => {
        await submitBangbangCharacterImage(input());
        const image = project.characters[0].image!;
        const request = { userId, projectId: project.id, slotId: "bangbang-character:C01", clientRequestId: image.clientRequestId, attemptNo: image.attemptNo, prompt: image.prompt!, model: project.modelSelection.image, size: "9:16", references: [] };
        await expect(validateBangbangImageRequest(request)).resolves.toBeUndefined();
        await expect(validateBangbangImageRequest({ ...request, prompt: "tampered" })).rejects.toThrow("参数");
        await expect(validateBangbangImageRequest({ ...request, references: [{ url: assetUrl }] })).rejects.toThrow("参数");
        await expect(getBangbangProjectForUser("other-user", project.id)).rejects.toThrow("不存在");
        await abandonBangbangCharacterImage(userId, project.id, characterId);
        await expect(validateBangbangImageRequest(request)).rejects.toThrow("已取消");
    });

    it("生成失败保留旧参考图，重试需要新请求", async () => {
        project.references.character = [{ id: "existing", label: "已有定妆照", media: { url: assetUrl, mimeType: "image/png" } }];
        project.characters[0].imageId = "existing";
        await submitBangbangCharacterImage(input());
        const first = project.characters[0].image?.clientRequestId;
        mocks.task.mockResolvedValue({ ...completedTask(), status: "error", error: "上游失败" });
        await getBangbangProjectForUser(userId, project.id);
        expect(project.characters[0]).toMatchObject({ imageId: "existing", image: { status: "error", error: "上游失败" } });
        expect(bangbangBusy(project)).toBe(false);
        mocks.task.mockResolvedValue(null);
        await submitBangbangCharacterImage(input());
        expect(project.characters[0].image?.clientRequestId).not.toBe(first);
    });

    it("拒绝不归当前用户所有的生成图片", async () => {
        await submitBangbangCharacterImage(input());
        mocks.task.mockResolvedValue(completedTask());
        mocks.media.mockResolvedValue({ ownerUserId: "other-user", type: "image" });
        await getBangbangProjectForUser(userId, project.id);
        expect(project.references.character).toHaveLength(0);
        expect(project.characters[0].image?.status).toBe("error");
    });

    it("人物图片被移除时清除绑定和图片状态，不恢复已删除素材", async () => {
        await submitBangbangCharacterImage(input());
        mocks.task.mockResolvedValue(completedTask());
        await getBangbangProjectForUser(userId, project.id);
        const patched = applyBangbangInputPatch(project, { references: { ...project.references, character: [] } });
        expect(patched.characters[0].imageId).toBeUndefined();
        expect(patched.characters[0].image?.result).toBeUndefined();
        const cleaned = cleanBangbangMediaReferences(project, [assetKey]);
        expect(cleaned.changed).toBe(true);
        expect(cleaned.value.characters[0].image?.status).toBe("idle");
        expect(cleaned.value.characters[0].imageId).toBeUndefined();
    });
});
