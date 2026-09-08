import { randomUUID } from "node:crypto";
import {
    BANGBANG_STEPS, bangbangBusy, bangbangCreationMode, bangbangImageBlockReason, bangbangSceneAnchor, bangbangStepBlockReason, createBangbangProject as newProject, isBangbangStep,
    type BangbangGroup, type BangbangImageState, type BangbangInputPatch, type BangbangMedia, type BangbangProject, type BangbangStep, type BangbangStepResult,
} from "@/lib/bangbang-contract";
import { getAuthSettings } from "@/lib/auth/store";
import { createBangbangProject, deleteBangbangProject, getBangbangProject, mutateBangbangProject } from "./bangbang-project-store";
import { getLocalMediaRegistration, isLocalMediaRegistrationExpired } from "./local-media-registry";
import { collectLocalMediaStorageKeys, localMediaStorageKeyFromValue } from "./local-media-references";
import { deleteUserLocalMediaAssets } from "./local-media-storage";
import { getStoredGenerationTaskByRequest, getStoredGenerationTaskRecord, withGenerationConcurrencyLimit } from "./generation-task-store";
import type { ImageTask } from "./image-task-store";
import { resolveLogicalModelCandidates } from "./logical-model-router";
import { fetchInternalApi } from "./internal-origin";
import { toSafeGenerationErrorMessage } from "./generation-errors";
import { bangbangGridPrompt } from "./bangbang-prompts";
import { maintenanceWorkerContextHeaders } from "./maintenance-auth";

export class BangbangProjectError extends Error {
    constructor(message: string, readonly status = 400) { super(message); this.name = "BangbangProjectError"; }
}
export async function createBangbangProjectForUser(userId: string, title: string) {
    return createBangbangProject(userId, newProject(`bangbang-${randomUUID()}`, text(title, 160)));
}
export async function getBangbangProjectForUser(userId: string, id: string): Promise<BangbangProject> {
    assertId(id);
    let project = await getBangbangProject(id, userId);
    if (!project) throw new BangbangProjectError("带货短剧项目不存在", 404);
    if (project.operation && Date.now() - Date.parse(project.operation.startedAt) > 30 * 60_000) {
        const operationId = project.operation.id;
        project = await mutate(userId, id, (current) => current.operation?.id === operationId ? changed({ ...current, operation: undefined, error: "上次处理已中断，请重新运行该环节" }) : current);
    }
    const updates = new Map<string, BangbangImageState>();
    for (const group of project.groups) {
        if (!["queued", "running"].includes(group.image.status) || !group.image.clientRequestId) continue;
        const task = await getStoredGenerationTaskByRequest<ImageTask>("image", userId, group.image.clientRequestId, group.image.attemptNo);
        if (!task || task.userId !== userId || task.projectId !== id || task.generationSlotId !== `bangbang-image:${group.id}` || task.prompt !== group.image.prompt) continue;
        if (JSON.stringify(task.references.map((reference) => reference.url || reference.serverUrl || reference.dataUrl)) !== JSON.stringify(group.image.referenceUrls)) continue;
        const image = { ...group.image, taskId: task.id };
        if (task.status === "success") {
            const result = task.result;
            const url = result?.serverUrl || result?.dataUrl;
            if (!url || !localMediaStorageKeyFromValue(url)) image.error = "生图结果尚未保存到服务器，请检查原任务";
            else {
                const media = await ownedBangbangMedia(userId, { url }, "image");
                updates.set(group.id, { ...image, status: "review", error: undefined, result: { ...media, width: result?.width, height: result?.height } });
                continue;
            }
        } else if (task.status === "error" || task.status === "cancelled") {
            updates.set(group.id, { ...image, status: "error", error: task.error || "生图任务已取消" });
            continue;
        }
        const record = await getStoredGenerationTaskRecord("image", task.id);
        if (record?.executionPhase === "needs_review") image.error = "上游结果需要检查，请在生成任务中检查原任务";
        if (JSON.stringify({ ...image, status: "running" }) !== JSON.stringify(group.image)) updates.set(group.id, { ...image, status: "running" });
    }
    if (updates.size) project = await mutate(userId, id, (current) => {
        let dirty = false;
        const groups = current.groups.map((group) => {
            const update = updates.get(group.id);
            if (!update || update.clientRequestId !== group.image.clientRequestId || update.attemptNo !== group.image.attemptNo || !["queued", "running"].includes(group.image.status)) return group;
            dirty = true;
            return { ...group, image: update };
        });
        return dirty ? changed({ ...current, groups }) : current;
    });
    return project;
}

export async function saveBangbangProjectForUser(userId: string, id: string, revision: number, raw: unknown) {
    const value = object(raw);
    const patch: BangbangInputPatch = {};
    if (value.creationMode !== undefined) {
        if (value.creationMode !== "product" && value.creationMode !== "reference") throw new BangbangProjectError("请选择产品原创或对标裂变");
        patch.creationMode = value.creationMode;
    }
    for (const key of ["title", "instructions", "selectedDirectionId", "customDirection", "storyboardImport", "transcriptText", "scriptText"] as const) {
        if (value[key] !== undefined) patch[key] = text(value[key], ["storyboardImport", "transcriptText", "scriptText"].includes(key) ? 150_000 : key === "instructions" || key === "customDirection" ? 20_000 : 160);
    }
    if (value.sourceVideo !== undefined) patch.sourceVideo = value.sourceVideo === null ? null : await ownedBangbangMedia(userId, value.sourceVideo, "video");
    if (value.product !== undefined) {
        const product = object(value.product);
        patch.product = { name: text(product.name, 200), appearance: text(product.appearance, 5000), sellingPoints: text(product.sellingPoints, 10000), price: text(product.price, 1000) };
    }
    if (value.references !== undefined) {
        const references = object(value.references);
        patch.references = { product: [], character: [], scene: [] };
        const ids = new Set<string>();
        for (const role of ["product", "character", "scene"] as const) {
            const entries = references[role];
            if (!Array.isArray(entries) || entries.length > 8) throw new BangbangProjectError("每类参考图最多 8 张");
            for (const entry of entries) {
                const ref = object(entry);
                const refId = text(ref.id, 100);
                const label = text(ref.label, 120);
                if (!/^[a-zA-Z0-9_-]+$/.test(refId) || ids.has(refId) || !label) throw new BangbangProjectError("参考图标识必须唯一，且需要填写名称");
                ids.add(refId);
                patch.references[role].push({ id: refId, label, media: await ownedBangbangMedia(userId, ref.media, "image") });
            }
        }
        if (ids.size > 20) throw new BangbangProjectError("参考图合计最多 20 张");
    }
    if (value.modelSelection !== undefined) {
        const models = object(value.modelSelection);
        patch.modelSelection = { analysis: text(models.analysis, 200), prompt: text(models.prompt, 200), image: text(models.image, 200) };
    }
    for (const [key, minimum, maximum] of [["targetDuration", 15, 300], ["maxSegmentSeconds", 5, 30]] as const) {
        if (value[key] !== undefined) {
            const number = value[key];
            if (!Number.isInteger(number) || Number(number) < minimum || Number(number) > maximum) throw new BangbangProjectError(`${key === "targetDuration" ? "目标时长" : "视频单段时长"}应在 ${minimum}–${maximum} 秒之间`);
            patch[key] = Number(number);
        }
    }
    if (value.characterImages !== undefined) {
        if (!Array.isArray(value.characterImages) || value.characterImages.length > 20) throw new BangbangProjectError("人物参考图绑定不正确");
        patch.characterImages = value.characterImages.map((entry) => ({ characterId: text(object(entry).characterId, 100), imageId: text(object(entry).imageId, 100) }));
    }
    if (value.groupPrompt !== undefined) patch.groupPrompt = { groupId: text(object(value.groupPrompt).groupId, 100), text: text(object(value.groupPrompt).text, 50_000) };
    return mutate(userId, id, (current) => {
        assertRevision(current, revision);
        assertIdle(current);
        return changed(applyBangbangInputPatch(current, patch));
    });
}

export function invalidateBangbangFrom(project: BangbangProject, step: BangbangStep): BangbangProject {
    const index = BANGBANG_STEPS.indexOf(step);
    const outputs = { ...project.outputs };
    for (const key of BANGBANG_STEPS.slice(index)) delete outputs[key];
    const before = (target: BangbangStep) => index <= BANGBANG_STEPS.indexOf(target);
    return {
        ...project, outputs, error: undefined, videoSegments: [],
        ...(before("frames") ? { sourceFrames: [] } : {}),
        ...(before("directions") ? { directions: [], selectedDirectionId: "" } : {}),
        ...(before("characters") ? { characters: [] } : {}),
        groups: before("storyboard") ? [] : before("expand") ? project.groups.map((group) => ({ ...group, frames: [], optimizedPrompt: "", image: emptyImage(group) }))
            : before("optimize") ? project.groups.map((group) => ({ ...group, optimizedPrompt: "", image: emptyImage(group) })) : project.groups,
    };
}
export function applyBangbangInputPatch(current: BangbangProject, patch: BangbangInputPatch): BangbangProject {
    const { transcriptText, scriptText, characterImages, groupPrompt, sourceVideo, ...fields } = patch;
    let next: BangbangProject = { ...current, creationMode: bangbangCreationMode(current), ...fields, ...(sourceVideo !== undefined ? { sourceVideo: sourceVideo || undefined } : {}) };
    if (sourceVideo && sourceVideo.url === current.sourceVideo?.url) next.sourceVideo = { ...current.sourceVideo, ...sourceVideo };
    if (bangbangCreationMode(next) !== bangbangCreationMode(current)) next = invalidateBangbangFrom({ ...next, storyboardImport: patch.storyboardImport ?? "", customDirection: patch.customDirection ?? "" }, "transcript");
    else if (next.sourceVideo?.url !== current.sourceVideo?.url) next = invalidateBangbangFrom({ ...next, storyboardImport: "" }, "transcript");
    else if (JSON.stringify(next.product) !== JSON.stringify(current.product) || next.instructions !== current.instructions || next.targetDuration !== current.targetDuration || JSON.stringify(next.references.product) !== JSON.stringify(current.references.product)) next = invalidateBangbangFrom(next, "directions");
    else if (next.selectedDirectionId !== current.selectedDirectionId || next.customDirection !== current.customDirection) next = invalidateBangbangFrom(next, "script");
    else if (next.storyboardImport !== current.storyboardImport || JSON.stringify(next.references.character) !== JSON.stringify(current.references.character) || JSON.stringify(next.references.scene) !== JSON.stringify(current.references.scene)) next = invalidateBangbangFrom(next, "storyboard");
    else if (next.maxSegmentSeconds !== current.maxSegmentSeconds) next = invalidateBangbangFrom(next, next.groups.some((group) => group.end - group.start > next.maxSegmentSeconds) ? "storyboard" : "video-prompts");
    if (next.selectedDirectionId && !next.directions.some((direction) => direction.id === next.selectedDirectionId)) throw new BangbangProjectError("所选裂变方向不存在");
    next.characters = next.characters.map((character) => ({ ...character, imageId: next.references.character.some((ref) => ref.id === character.imageId) ? character.imageId : undefined }));
    if (transcriptText !== undefined) {
        if (bangbangCreationMode(next) === "product") throw new BangbangProjectError("产品原创不需要字幕，请在对标裂变模式导入");
        if (!transcriptText.trim()) throw new BangbangProjectError("导入字幕不能为空");
        next = invalidateBangbangFrom(next, "transcript");
        next.outputs.transcript = { text: transcriptText, source: "import", createdAt: new Date().toISOString() };
    }
    if (scriptText !== undefined) {
        if (!scriptText.trim()) throw new BangbangProjectError("剧本不能为空");
        next = invalidateBangbangFrom(next, "script");
        next.outputs.script = { text: scriptText, source: "import", createdAt: new Date().toISOString() };
    }
    if (characterImages) {
        const mapping = new Map(characterImages.map((entry) => [entry.characterId, entry.imageId]));
        if (mapping.size !== characterImages.length || characterImages.some((entry) => !next.characters.some((character) => character.id === entry.characterId) || (entry.imageId && !next.references.character.some((reference) => reference.id === entry.imageId)))) throw new BangbangProjectError("人物或参考图绑定不存在");
        const characters = next.characters.map((character) => mapping.has(character.id) ? { ...character, imageId: mapping.get(character.id) || undefined } : character);
        if (JSON.stringify(characters) !== JSON.stringify(next.characters)) next = { ...invalidateBangbangFrom(next, "storyboard"), characters };
    }
    if (groupPrompt) {
        const index = next.groups.findIndex((group) => group.id === groupPrompt.groupId);
        if (index < 0 || !groupPrompt.text.trim()) throw new BangbangProjectError("分镜组不存在或提示词为空");
        if (groupPrompt.text !== next.groups[index].optimizedPrompt) next = {
            ...invalidateBangbangFrom(next, "video-prompts"),
            groups: next.groups.map((group, position) => ({ ...group, ...(position === index ? { optimizedPrompt: groupPrompt.text } : {}), ...(position >= index ? { image: emptyImage(group) } : {}) })),
        };
    }
    return next;
}

export async function startBangbangOperation(userId: string, id: string, revision: number, step: BangbangStep) {
    if (!isBangbangStep(step)) throw new BangbangProjectError("处理环节不正确");
    return mutate(userId, id, (current) => {
        assertRevision(current, revision);
        const reason = bangbangStepBlockReason(current, step);
        if (reason) throw new BangbangProjectError(reason, 409);
        return changed({ ...current, operation: { id: randomUUID(), step, startedAt: new Date().toISOString() }, error: undefined });
    });
}
export async function finishBangbangOperation(userId: string, id: string, operationId: string, result: BangbangStepResult | { error: string }) {
    return mutate(userId, id, (current) => {
        if (current.operation?.id !== operationId) throw new BangbangProjectError("项目状态已经变化，未保存旧任务结果", 409);
        if ("error" in result) return changed({ ...current, operation: undefined, error: result.error });
        const step = current.operation.step;
        if (!result.text?.trim() || result.text.length > 1_000_000) throw new BangbangProjectError("模型结果为空或过长");
        const next = invalidateBangbangFrom(current, step);
        for (const key of ["sourceVideo", "sourceFrames", "directions", "characters", "videoSegments"] as const) {
            if (result[key] !== undefined) Object.assign(next, { [key]: result[key] });
        }
        if (result.groups) next.groups = result.groups.map((group) => ({ ...group, image: emptyImage(group), ...(step === "storyboard" ? { frames: [], optimizedPrompt: "" } : step === "expand" ? { optimizedPrompt: "" } : {}) }));
        next.outputs[step] = { text: result.text, createdAt: new Date().toISOString(), source: result.source || "model" };
        return changed({ ...next, operation: undefined, error: undefined });
    });
}
export async function runBangbangOperation(input: { project: BangbangProject; userId: string; origin: string; credential: string }) {
    const operationId = input.project.operation?.id;
    if (!operationId) return;
    let transaction: Awaited<ReturnType<typeof import("./bangbang-runtime").executeBangbangStep>> | undefined;
    let saved = false;
    try {
        const { executeBangbangStep } = await import("./bangbang-runtime");
        transaction = await executeBangbangStep(input);
        await finishBangbangOperation(input.userId, input.project.id, operationId, transaction.result);
        saved = true;
        await transaction.accept();
    } catch (error) {
        if (saved) { console.error("棒棒运行临时文件清理失败", error); return; }
        await transaction?.rollback().catch((rollbackError: unknown) => console.error("棒棒运行回滚失败", rollbackError));
        await finishBangbangOperation(input.userId, input.project.id, operationId, { error: toSafeGenerationErrorMessage(error, "当前环节处理失败，请重试") }).catch((saveError) => console.error("棒棒失败状态保存失败", saveError));
    }
}

export function bangbangImageReferences(project: BangbangProject, group: BangbangGroup): Array<{ name: string; url: string }> {
    const index = project.groups.findIndex((item) => item.id === group.id);
    const anchor = bangbangSceneAnchor(project, group);
    const references: Array<{ name: string; url: string }> = [];
    if (anchor?.image.result) references.push({ name: `第 ${anchor.number} 组九宫格（场景与衔接参考）`, url: anchor.image.result.url });
    else if (index === 0 && bangbangCreationMode(project) === "reference" && project.sourceFrames[0]) references.push({ name: "对标视频关键画面（布局参考）", url: project.sourceFrames[0].url });
    if (index === 0 || project.groups[index - 1].scene !== group.scene) {
        const scene = project.references.scene.find((reference) => reference.label === group.scene);
        if (scene) references.push({ name: `场景：${scene.label}`, url: scene.media.url });
    }
    for (const id of group.characterIds) {
        const character = project.characters.find((item) => item.id === id);
        const reference = project.references.character.find((item) => item.id === character?.imageId);
        if (!reference) throw new BangbangProjectError("本组人物缺少参考图，请先绑定");
        references.push({ name: `${character!.name}人物图`, url: reference.media.url });
    }
    if (group.productVisible) for (const reference of project.references.product) references.push({ name: `产品：${reference.label}`, url: reference.media.url });
    return references;
}
export async function reserveBangbangImage(userId: string, id: string, revision: number, groupId: string) {
    const before = await getBangbangProjectForUser(userId, id);
    const beforeGroup = before.groups.find((group) => group.id === groupId);
    if (!beforeGroup) throw new BangbangProjectError("分镜组不存在", 404);
    const reason = bangbangImageBlockReason(before, groupId);
    if (reason) throw new BangbangProjectError(reason, 409);
    const references = bangbangImageReferences(before, beforeGroup);
    for (const reference of references) await ownedBangbangMedia(userId, reference, "image");
    const settings = await getAuthSettings();
    const model = before.modelSelection.image || settings.defaultModels.imageModel;
    if (!model || !resolveLogicalModelCandidates(settings, "image", model).length) throw new BangbangProjectError("请先选择可用的生图模型");
    return mutate(userId, id, (current) => {
        assertRevision(current, revision);
        const block = bangbangImageBlockReason(current, groupId);
        if (block) throw new BangbangProjectError(block, 409);
        const index = current.groups.findIndex((group) => group.id === groupId);
        const group = current.groups[index];
        if (group.image.status === "queued") return current;
        const anchor = bangbangSceneAnchor(current, group);
        const image: BangbangImageState = {
            status: "queued", attemptNo: group.image.attemptNo + 1, clientRequestId: `bangbang:${id}:${groupId}:${randomUUID()}`,
            prompt: bangbangGridPrompt(current, group, anchor), referenceUrls: references.map((reference) => reference.url), anchorGroupId: anchor?.id,
        };
        return changed({ ...invalidateBangbangFrom(current, "video-prompts"), modelSelection: { ...current.modelSelection, image: model },
            groups: current.groups.map((item, position) => position < index ? item : { ...item, image: position === index ? image : emptyImage(item) }),
        });
    });
}
export async function submitBangbangImage(input: { userId: string; projectId: string; revision: number; groupId: string; origin: string; credential: string }) {
    const project = await reserveBangbangImage(input.userId, input.projectId, input.revision, input.groupId);
    const group = project.groups.find((item) => item.id === input.groupId)!;
    const references = bangbangImageReferences(project, group);
    let response: Response;
    try {
        response = await fetchInternalApi(`${input.origin}/api/image-tasks`, {
            method: "POST", headers: { "Content-Type": "application/json", ...(maintenanceWorkerContextHeaders(input.credential) || { cookie: input.credential }), "x-vozeb-pro-client-request-id": group.image.clientRequestId!, "x-vozeb-pro-attempt-no": String(group.image.attemptNo) },
            body: JSON.stringify({
                kind: references.length ? "edit" : "generation", prompt: group.image.prompt, title: `${project.title} · 第 ${group.number} 组九宫格`, source: "drama",
                config: { apiSource: "system", model: project.modelSelection.image, size: "9:16", quality: "2K" },
                references: references.map((reference) => ({ name: reference.name, url: reference.url, dataUrl: "" })),
                context: { projectId: project.id, generationSlotId: `bangbang-image:${group.id}`, clientRequestId: group.image.clientRequestId, attemptNo: group.image.attemptNo },
            }),
        });
    } catch {
        throw new BangbangProjectError("网络中断，提交结果尚未确认。请继续提交同一组，将复用原请求号", 502);
    }
    if (!response.ok) {
        const payload = object(await response.json().catch(() => ({})));
        const message = typeof payload.error === "string" ? payload.error : "生图任务提交失败";
        if (response.status >= 400 && response.status < 500) await mutate(input.userId, input.projectId, (current) => changed({ ...current, groups: current.groups.map((item) => item.id === group.id && item.image.clientRequestId === group.image.clientRequestId && item.image.status === "queued" ? { ...item, image: { ...item.image, status: "error", error: message } } : item) }));
        throw new BangbangProjectError(message, response.status);
    }
    await response.body?.cancel();
    return getBangbangProjectForUser(input.userId, project.id);
}
export async function validateBangbangImageRequest(input: { userId: string; projectId: string; slotId: string; clientRequestId?: string; attemptNo?: number; prompt: string; references: unknown; model?: string; size?: string }) {
    const project = await getBangbangProjectForUser(input.userId, input.projectId);
    const group = project.groups.find((item) => `bangbang-image:${item.id}` === input.slotId);
    if (!group || project.operation || group.image.status !== "queued" || group.image.clientRequestId !== input.clientRequestId || group.image.attemptNo !== input.attemptNo) throw new BangbangProjectError("这次生图提交已取消或状态已变化，请刷新项目", 409);
    if (input.prompt !== group.image.prompt || input.model !== project.modelSelection.image || input.size !== "9:16") throw new BangbangProjectError("生图参数与当前分镜不一致", 409);
    const references = Array.isArray(input.references) ? input.references.map((value) => { const reference = object(value); return reference.url || reference.serverUrl || reference.dataUrl; }) : [];
    if (JSON.stringify(references) !== JSON.stringify(group.image.referenceUrls)) throw new BangbangProjectError("生图参考素材与当前分镜不一致", 409);
    const reason = bangbangImageBlockReason(project, group.id);
    if (reason) throw new BangbangProjectError(reason, 409);
}
export async function approveBangbangImage(userId: string, id: string, revision: number, groupId: string) {
    const project = await getBangbangProjectForUser(userId, id);
    const target = project.groups.find((group) => group.id === groupId);
    if (target?.image.result) await ownedBangbangMedia(userId, target.image.result, "image");
    return mutate(userId, id, (current) => {
        assertRevision(current, revision);
        assertIdle(current);
        const index = current.groups.findIndex((group) => group.id === groupId);
        if (index < 0 || current.groups[index].image.status !== "review" || !current.groups[index].image.result) throw new BangbangProjectError("这组没有待确认的九宫格", 409);
        if (current.groups.slice(0, index).some((group) => group.image.status !== "approved")) throw new BangbangProjectError("请先确认前面的九宫格", 409);
        return changed({ ...current, groups: current.groups.map((group) => group.id === groupId ? { ...group, image: { ...group.image, status: "approved", approvedAt: new Date().toISOString() } } : group) });
    });
}
export async function abandonBangbangImage(userId: string, id: string, groupId: string) {
    const project = await getBangbangProjectForUser(userId, id);
    const group = project.groups.find((item) => item.id === groupId);
    if (group?.image.status !== "queued" || !group.image.clientRequestId) throw new BangbangProjectError("当前没有待确认的生图提交", 409);
    const settings = await getAuthSettings();
    const result = await withGenerationConcurrencyLimit(userId, "image", 10 * 60_000, settings.generationConcurrency.image, async () => {
        const task = await getStoredGenerationTaskByRequest<ImageTask>("image", userId, group.image.clientRequestId!, group.image.attemptNo);
        if (task) return getBangbangProjectForUser(userId, id);
        return mutate(userId, id, (current) => {
            const target = current.groups.find((item) => item.id === groupId);
            if (!target || target.image.clientRequestId !== group.image.clientRequestId || target.image.status !== "queued") throw new BangbangProjectError("生图状态已变化，请刷新", 409);
            return changed({ ...current, groups: current.groups.map((item) => item.id === groupId ? { ...item, image: emptyImage(item) } : item) });
        });
    }, undefined, group.image.clientRequestId);
    if (!result) throw new BangbangProjectError("生图提交仍在处理中，请稍后检查", 409);
    return result;
}
export async function deleteBangbangProjectForUser(userId: string, id: string) {
    // 先在原子修改中归档，使正在竞争的新操作拒绝启动，再删除记录。
    await mutate(userId, id, (current) => { assertIdle(current); return changed({ ...current, status: "archived" }); });
    const removed = await deleteBangbangProject(userId, id);
    if (removed) await cleanupRemovedMedia(userId, removed, null);
}
export async function ownedBangbangMedia(userId: string, raw: unknown, type: "image" | "video"): Promise<BangbangMedia> {
    const url = text(object(raw).url, 3000);
    // 只允许受本应用管理的相对媒体地址；调用者提供的其他元数据不能替代注册记录。
    if (!/^\/api\/(reference-assets|generation-log-assets)\//.test(url)) throw new BangbangProjectError("请使用本项目上传的素材", 403);
    const key = localMediaStorageKeyFromValue(url);
    const asset = key ? await getLocalMediaRegistration(key) : null;
    if (!asset || asset.ownerUserId !== userId || asset.type !== type || isLocalMediaRegistrationExpired(asset)) throw new BangbangProjectError("素材不存在、已过期或无权访问", 403);
    return { url: `/api/${asset.scope === "reference" ? "reference-assets" : "generation-log-assets"}/${asset.storageKey.split("/").map(encodeURIComponent).join("/")}`, storageKey: asset.storageKey, mimeType: asset.mimeType, originalName: asset.originalName, bytes: asset.bytes };
}
async function mutate(userId: string, id: string, change: (current: BangbangProject) => BangbangProject) {
    assertId(id);
    let previous: BangbangProject | undefined;
    const project = await mutateBangbangProject(userId, id, (current) => {
        if (current.status === "archived") throw new BangbangProjectError("项目已归档或删除", 409);
        previous = current;
        return change(current);
    });
    if (!project) throw new BangbangProjectError("带货短剧项目不存在", 404);
    if (previous) await cleanupRemovedMedia(userId, previous, project);
    return project;
}
async function cleanupRemovedMedia(userId: string, previous: BangbangProject, next: BangbangProject | null) {
    const retained = new Set(collectLocalMediaStorageKeys(next));
    const removed = collectLocalMediaStorageKeys(previous).filter((key) => !retained.has(key));
    if (removed.length) await deleteUserLocalMediaAssets(userId, removed).catch((error) => console.warn("棒棒未引用素材清理失败", error));
}
function emptyImage(group: BangbangGroup): BangbangImageState { return { status: "idle", attemptNo: group.image?.attemptNo || 0 }; }
function changed(project: BangbangProject): BangbangProject { return { ...project, revision: project.revision + 1, updatedAt: new Date(Math.max(Date.now(), Date.parse(project.updatedAt) + 1)).toISOString() }; }
function assertId(id: string) { if (!/^bangbang-[a-zA-Z0-9-]+$/.test(id)) throw new BangbangProjectError("带货短剧项目不存在", 404); }
function assertRevision(project: BangbangProject, revision: number) { if (!Number.isInteger(revision) || project.revision !== revision) throw new BangbangProjectError("项目已在其他页面更新，请刷新后重试", 409); }
function assertIdle(project: BangbangProject) { if (bangbangBusy(project)) throw new BangbangProjectError("请等待当前任务完成后再修改项目", 409); }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown, limit: number): string { if (value === undefined) return ""; if (typeof value !== "string" || value.length > limit) throw new BangbangProjectError("输入内容格式不正确或过长"); return value.trim(); }
