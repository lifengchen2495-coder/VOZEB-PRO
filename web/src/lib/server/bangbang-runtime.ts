import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import { getAuthSettings, refundUserPoints } from "@/lib/auth/store";
import { bangbangCreationMode, type BangbangGroup, type BangbangMedia, type BangbangProject, type BangbangStep, type BangbangStepResult } from "@/lib/bangbang-contract";
import { probeBangbangVideo, transcribeBangbangVideo } from "./bangbang-asr";
import { bangbangResultShape, bangbangStageMessages } from "./bangbang-prompts";
import { parseBangbangSourceFrameTimes, parseBangbangStepOutput } from "./bangbang-runtime-output";
import { BANGBANG_VIDEO_MODEL, requestBangbangFullVideo, supportsBangbangFullVideo } from "./bangbang-runtime-video";
import { ownedBangbangMedia } from "./bangbang-project-service";
import { runFfmpeg } from "./ffmpeg";
import { downloadMediaToFile } from "./media-download";
import { deleteUserLocalMediaAssets } from "./local-media-storage";
import { writePersistentMediaDataUrl } from "./reference-asset-store";
import { resolveLogicalModelCandidates, type ResolvedLogicalModel } from "./logical-model-router";
import { maintenanceWorkerContextHeaders } from "./maintenance-auth";
import { rankTextPlanningCandidates, requestStructuredText } from "./text-planning-runtime";
import { requestRemakeProductionVisionPrompt, resolveRemakeProductionVisionProtocol, RemakeProductionVisionError, type RemakeProductionVisualBoard } from "./remake15-production-vision-runtime";
import { hasSystemAiCharge, readSystemAiBilling, systemAiBillingHeaders, systemAiIdempotencyKey } from "./system-ai-billing";

type OperationInput = { project: BangbangProject; userId: string; origin: string; credential: string };
type Charge = { model: string; headers: Headers; refunded?: boolean };
type VisualReference = { label: string; media: BangbangMedia; role: "character" | "product" | "redrawn-contact-sheet" };
const OPERATION_TIMEOUT_MS = 25 * 60_000;

export async function executeBangbangStep(input: OperationInput): Promise<{ result: BangbangStepResult; accept: () => Promise<void>; rollback: () => Promise<void> }> {
    const operation = input.project.operation;
    if (!operation) throw new Error("项目没有待执行的环节");
    const productOriginal = bangbangCreationMode(input.project) === "product";
    if (productOriginal && ["transcript", "understanding", "traffic", "frames"].includes(operation.step)) throw new Error("产品原创模式从创意方向开始，不执行对标视频分析环节");
    if (productOriginal && ["directions", "script"].includes(operation.step) && !input.project.references.product.length) throw new Error("请先上传产品图片，再创作产品短剧");
    const directory = await mkdtemp(join(tmpdir(), "vozeb-bangbang-"));
    const created: string[] = [];
    const charges = new Map<string, Charge>();
    const signal = AbortSignal.timeout(OPERATION_TIMEOUT_MS);
    let accepted = false;
    const trackCharge = (model: string, headers: Headers) => {
        const billing = readSystemAiBilling(headers);
        if (hasSystemAiCharge(billing) && !charges.has(billing.pointsRecordId)) charges.set(billing.pointsRecordId, { model, headers });
    };
    const rollback = async () => {
        if (accepted) return;
        const errors: unknown[] = [];
        for (const charge of charges.values()) {
            if (charge.refunded) continue;
            const billing = readSystemAiBilling(charge.headers);
            if (hasSystemAiCharge(billing)) {
                try { await refundUserPoints(input.userId, charge.model, billing.pointsCost, "text", 1, undefined, billing.pointsRecordId); charge.refunded = true; }
                catch (error) { errors.push(error); }
            }
        }
        try { if (created.length) await deleteUserLocalMediaAssets(input.userId, created); } catch (error) { errors.push(error); }
        try { await rm(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, "当前环节结果回滚未全部完成，请管理员核对积分记录");
    };
    try {
        const step = operation.step;
        let project = input.project;
        let sourcePath: string | undefined;
        let probe: Awaited<ReturnType<typeof probeBangbangVideo>> | undefined;
        if (["transcript", "understanding", "frames"].includes(step)) {
            if (!project.sourceVideo) throw new Error("此环节需要完整的对标视频");
            const media = await ownedBangbangMedia(input.userId, project.sourceVideo, "video");
            sourcePath = join(directory, "source-video");
            await download(media.url, sourcePath, input, 200 * 1024 * 1024);
            probe = await probeBangbangVideo(sourcePath);
            project = { ...project, sourceVideo: { ...media, duration: probe.duration, width: probe.width, height: probe.height } };
        }
        let result: BangbangStepResult;
        if (step === "transcript") {
            const transcript = await transcribeBangbangVideo({ sourcePath: sourcePath!, workDirectory: directory, hasAudio: probe!.hasAudio, signal });
            result = { source: "media", sourceVideo: project.sourceVideo, text: `转写状态：${transcript.status === "no-audio" ? "视频无音轨，无对白" : transcript.status === "no-speech" ? "完整音轨无可识别对白" : `完整音轨已转写，共 ${transcript.sentences.length} 句`}\n\n${transcript.srt ? `完整字幕（SRT）：\n\n${transcript.srt}\n\n完整文案：\n\n` : ""}${transcript.text}` };
        } else {
            const fullVideo = step === "understanding" || step === "frames";
            const referenceCache = new Map<string, RemakeProductionVisualBoard>();
            const initialReferences = fullVideo ? [] : stepReferences(project, step);
            const candidate = await resolveCandidate(project, fullVideo, initialReferences.length > 0);
            const streamChat = /^gpt-6(?:[.-]|$)/i.test(candidate.upstreamModel) && resolveRemakeProductionVisionProtocol(candidate, true)?.kind === "chat";
            const call = async (current: BangbangProject, scope: string) => {
                signal.throwIfAborted();
                const key = systemAiIdempotencyKey("bangbang", input.userId, project.id, operation.id, step, scope, candidate.channelId, candidate.upstreamModel);
                const headers = runtimeHeaders(input.credential, candidate, key);
                const messages = bangbangStageMessages(current, step);
                let raw: string;
                if (fullVideo) {
                    raw = await requestBangbangFullVideo({ sourcePath: sourcePath!, workDirectory: directory, duration: probe!.duration, candidate, origin: input.origin, messages, headers, signal, onResponse: (responseHeaders) => trackCharge(candidate.logicalModelId, responseHeaders) });
                } else {
                    const references = stepReferences(current, step);
                    if (references.length || streamChat) {
                        const boards = await loadBoards(references, input, directory, referenceCache);
                        if (boards.length) messages[1].content += `\n\n实际附图顺序：${JSON.stringify(boards.map((board) => ({ number: board.ordinal, label: board.description })))}`;
                        try {
                            // GPT-6 后台环节持续消费流式响应，避免同步等待触发中转网关 504。
                            const response = await requestRemakeProductionVisionPrompt({ origin: input.origin, cookie: cookie(input.credential), candidate, messages, boards, headers, signal, stream: streamChat, allowTextOnly: boards.length === 0, jsonMode: boards.length === 0 });
                            trackCharge(candidate.logicalModelId, response.headers);
                            raw = response.text;
                        } catch (error) {
                            if (error instanceof RemakeProductionVisionError && error.responseHeaders) trackCharge(candidate.logicalModelId, error.responseHeaders);
                            throw error;
                        }
                    } else {
                        const shape = bangbangResultShape(step);
                        const response = await requestStructuredText({
                            origin: input.origin, cookie: cookie(input.credential), candidate, messages, headers, signal,
                            tool: { name: "bangbang_result", description: "返回当前环节完整正文和结构化结果", parameters: { type: "object", required: Object.keys(shape), properties: Object.fromEntries(Object.entries(shape).map(([name, value]) => [name, { type: typeof value === "string" ? "string" : "array" }])) } },
                            allowRepair: false, preferNativeTools: false, stream: false, streamFallback: false,
                            onInvalidResponse: async (responseHeaders) => { trackCharge(candidate.logicalModelId, responseHeaders); },
                        });
                        trackCharge(candidate.logicalModelId, response.headers);
                        raw = response.arguments;
                    }
                }
                return { raw, result: parseBangbangStepOutput(step, raw, current) };
            };
            if (step === "expand" || step === "optimize") {
                if (!project.groups.length || project.groups.length > 40) throw new Error("逐组执行需要 1 至 40 个已规划分镜组");
                const groups: BangbangGroup[] = [];
                const texts: string[] = [];
                // 每组独立调用，保留完整上游计划；任一组失败时退回本阶段全部未交付费用。
                for (const group of project.groups) {
                    const part = await call({ ...project, groups: [group] }, group.id);
                    groups.push(...part.result.groups!);
                    texts.push(part.result.text);
                }
                result = { text: texts.join("\n\n---\n\n"), groups };
            } else if (step === "video-prompts") {
                const segments = planBangbangVideoSegments(project);
                const videoSegments = [];
                const texts = [];
                for (const [index, groups] of segments.entries()) {
                    const part = await call({ ...project, groups }, groups.map((group) => group.id).join(","));
                    if (part.result.videoSegments!.length !== 1) throw new Error("当前视频片段被模型拆成多段，未保存不一致结果");
                    const id = `V${String(index + 1).padStart(2, "0")}`;
                    videoSegments.push({ ...part.result.videoSegments![0], id });
                    texts.push(`${id}｜${groups.map((group) => `第 ${group.number} 组`).join("、")}\n\n${part.result.text}`);
                }
                result = { text: texts.join("\n\n---\n\n"), videoSegments };
            } else {
                const response = await call(project, "complete");
                result = response.result;
                if (step === "frames") {
                    const frameGroups = parseBangbangSourceFrameTimes(response.raw, probe!.duration);
                    const sourceFrames: BangbangMedia[] = [];
                    for (const group of frameGroups) {
                        signal.throwIfAborted();
                        const bytes = await renderBangbangSourceGrid(sourcePath!, group.timestamps, directory, signal);
                        const name = `源视频拆帧第${group.number}组.jpg`;
                        const stored = await writePersistentMediaDataUrl(`data:image/jpeg;base64,${bytes.toString("base64")}`, "image", { ownerUserId: input.userId, projectId: project.id, source: "drama", originalName: name });
                        created.push(stored.token);
                        sourceFrames.push({ url: `/api/reference-assets/${stored.token.split("/").map(encodeURIComponent).join("/")}`, storageKey: stored.token, mimeType: stored.mimeType, bytes: stored.bytes, originalName: name, width: 1080, height: 1920 });
                    }
                    result.sourceFrames = sourceFrames;
                }
                if (probe) result.sourceVideo = project.sourceVideo;
            }
        }
        return { result, rollback, accept: async () => { accepted = true; await rm(directory, { recursive: true, force: true }); } };
    } catch (error) {
        try { await rollback(); } catch (rollbackError) { throw new AggregateError([error, rollbackError], `${error instanceof Error ? error.message : "当前环节失败"}；积分回滚未全部完成，请管理员核对`); }
        if (signal.aborted) throw new Error(`当前环节超过 25 分钟处理上限，已回滚未交付结果及平台积分，请${productOriginal ? "缩短目标时长" : "缩短视频"}或减少分镜组后重试`);
        throw error;
    }
}

export function planBangbangVideoSegments(project: BangbangProject): BangbangGroup[][] {
    if (!project.groups.length || project.groups.some((group) => group.image.status !== "approved" || !group.image.result)) throw new Error("请先逐张批准所有九宫格图片");
    const result: BangbangGroup[][] = [];
    for (const group of project.groups) {
        const duration = group.end - group.start;
        if (duration <= 0 || duration > project.maxSegmentSeconds) throw new Error(`第 ${group.number} 组超过视频模型时长上限，请调整规划表`);
        const last = result.at(-1);
        if (last && last.length < 2 && last[0].scene === group.scene && last.reduce((sum, item) => sum + item.end - item.start, duration) <= project.maxSegmentSeconds && Math.abs(last.at(-1)!.end - group.start) < 0.001) last.push(group);
        else result.push([group]);
    }
    return result;
}

export async function renderBangbangSourceGrid(sourcePath: string, timestamps: number[], directory: string, signal: AbortSignal) {
    if (timestamps.length !== 9 || timestamps.some((value, index) => !Number.isFinite(value) || value < 0 || (index > 0 && value <= timestamps[index - 1]))) throw new Error("源视频九宫格需要 9 个递增时间码");
    const overlays: OverlayOptions[] = [];
    for (const [index, time] of timestamps.entries()) {
        const target = join(directory, `frame-${index + 1}.jpg`);
        await runFfmpeg(["-hide_banner", "-loglevel", "error", "-ss", String(time), "-i", sourcePath, "-map", "0:v:0", "-frames:v", "1", "-q:v", "2", "-y", target], { timeoutMs: 60_000, signal });
        const tile = await sharp(await readFile(target), { limitInputPixels: 40_000_000 }).resize(360, 640, { fit: "contain", background: "#111111" }).jpeg({ quality: 90 }).toBuffer();
        overlays.push({ input: tile, left: (index % 3) * 360, top: Math.floor(index / 3) * 640 });
        const label = Buffer.from(`<svg width="360" height="30"><rect width="360" height="30" fill="#111"/><text x="12" y="22" fill="white" font-family="sans-serif" font-size="17">${index + 1} | ${time.toFixed(3)}s</text></svg>`);
        overlays.push({ input: label, left: (index % 3) * 360, top: Math.floor(index / 3) * 640 + 610 });
    }
    return sharp({ create: { width: 1080, height: 1920, channels: 3, background: "#111111" } }).composite(overlays).jpeg({ quality: 92 }).toBuffer();
}

async function resolveCandidate(project: BangbangProject, video: boolean, vision: boolean): Promise<ResolvedLogicalModel> {
    const settings = await getAuthSettings();
    const requested = (video ? project.modelSelection.analysis : project.modelSelection.prompt) || settings.defaultModels.textModel;
    const fallbackVideoIds = video && !project.modelSelection.analysis ? settings.logicalModels.filter((model) => model.enabled && model.capability === "text").map((model) => model.id) : [];
    const ids = [...new Set([requested, ...fallbackVideoIds].filter(Boolean))];
    const candidates = rankTextPlanningCandidates(ids.flatMap((id) => resolveLogicalModelCandidates(settings, "text", id)));
    const selected = candidates.find((candidate) => video ? supportsBangbangFullVideo(candidate) : vision ? Boolean(resolveRemakeProductionVisionProtocol(candidate)) : true);
    if (!selected) throw new Error(video ? `请在后台配置支持完整视频文件理解的 ${BANGBANG_VIDEO_MODEL} 文本渠道，并选择对应分析模型` : vision ? "当前提示词模型没有可用的图片理解能力，请选择已配置参考图能力的文本模型" : "后台尚未配置可用的提示词文本模型");
    return selected;
}
function stepReferences(project: BangbangProject, step: BangbangStep): VisualReference[] {
    if (["traffic", "understanding", "frames"].includes(step)) return [];
    const groupStage = ["expand", "optimize", "video-prompts"].includes(step);
    const visibleIds = new Set(groupStage ? project.groups.flatMap((group) => group.characterIds) : project.characters.map((character) => character.id));
    const references: VisualReference[] = [];
    if (!["directions"].includes(step)) {
        for (const character of project.characters.filter((item) => visibleIds.has(item.id))) {
            const reference = project.references.character.find((item) => item.id === character.imageId);
            if (reference) references.push({ label: `${character.name}人物图`, media: reference.media, role: "character" });
        }
    }
    if (!groupStage || project.groups.some((group) => group.productVisible)) project.references.product.forEach((reference) => references.push({ label: `产品照片：${reference.label || project.product.name}`, media: reference.media, role: "product" }));
    if (step === "video-prompts") project.groups.forEach((group) => { if (group.image.result) references.push({ label: `九宫格图第${group.number}组`, media: group.image.result, role: "redrawn-contact-sheet" }); });
    return references;
}
async function loadBoards(references: VisualReference[], input: OperationInput, directory: string, cache: Map<string, RemakeProductionVisualBoard>) {
    const boards: RemakeProductionVisualBoard[] = [];
    for (const reference of references) {
        let cached = cache.get(reference.media.url);
        if (!cached) {
            const owned = await ownedBangbangMedia(input.userId, reference.media, "image");
            const path = join(directory, `reference-${cache.size}`);
            await download(owned.url, path, input, 20 * 1024 * 1024);
            const bytes = await sharp(await readFile(path), { limitInputPixels: 40_000_000 }).rotate().resize(1080, 1920, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
            const metadata = await sharp(bytes).metadata();
            cached = { ordinal: 0, id: "reference-board", mimeType: "image/jpeg", width: metadata.width!, height: metadata.height!, bytes, description: "", layout: [] };
            cache.set(reference.media.url, cached);
        }
        boards.push({ ...cached, ordinal: boards.length + 1, description: reference.label, id: reference.role === "redrawn-contact-sheet" ? "redrawn-contact-sheets-board" : "reference-board", layout: [{ order: boards.length + 1, role: reference.role, label: reference.label, position: "center", provided: true }] });
    }
    return boards;
}
function cookie(credential: string) { return maintenanceWorkerContextHeaders(credential) ? "" : credential; }
function runtimeHeaders(credential: string, candidate: ResolvedLogicalModel, key: string) {
    const headers = new Headers({ "Content-Type": "application/json", "Idempotency-Key": key, "X-Client-Request-Id": key, ...systemAiBillingHeaders(candidate.logicalModelId, key, candidate.upstreamModel) });
    const worker = maintenanceWorkerContextHeaders(credential);
    if (worker) Object.entries(worker).forEach(([name, value]) => headers.set(name, value));
    else if (credential) headers.set("cookie", credential);
    return headers;
}
async function download(url: string, target: string, input: OperationInput, maxBytes: number) {
    const worker = maintenanceWorkerContextHeaders(input.credential);
    return downloadMediaToFile(url, target, { origin: input.origin, cookie: worker ? undefined : input.credential, internalHeaders: worker || undefined, maxBytes, timeoutMs: 90_000 });
}
