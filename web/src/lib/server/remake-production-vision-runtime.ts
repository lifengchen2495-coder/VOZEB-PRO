import { fileTypeFromBuffer } from "file-type";
import sharp, { type OverlayOptions } from "sharp";

import { toSafeGenerationErrorMessage } from "@/lib/server/generation-errors";
import { fetchInternalApi } from "@/lib/server/internal-origin";
import type { ResolvedLogicalModel } from "@/lib/server/logical-model-router";
import { resolveModelRequestTimeoutMs } from "@/lib/server/model-request-policy";
import { remakeContactSheetDimensionError } from "@/lib/server/remake-contact-sheet-validation";
import { fetchRemakeProductionImage } from "@/lib/server/remake-production-image-fetch";
import { resolveTextProtocol } from "@/lib/server/text-protocol-resolver";

// 源图需先读取后缩放拼板，大小上限独立于压缩后的模型输入限制。
export const REMAKE_PRODUCTION_SOURCE_IMAGE_MAX_BYTES = 32 * 1024 * 1024;
export const REMAKE_PRODUCTION_SOURCE_IMAGES_TOTAL_MAX_BYTES = 128 * 1024 * 1024;
export const REMAKE_PRODUCTION_VISUAL_BOARD_MAX_BYTES = 3_500_000;
export const REMAKE_PRODUCTION_VISUAL_BOARDS_TOTAL_MAX_BYTES = 7_000_000;

const SOURCE_IMAGE_MAX_PIXELS = 40_000_000;
const MODEL_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const REFERENCE_BOARD_WIDTH = 1_200;
const REFERENCE_BOARD_HEIGHT = 720;
const CONTACT_SHEET_BOARD_WIDTH = 1_200;
const CONTACT_SHEET_BOARD_HEIGHT = 1_800;
const LABEL_HEIGHT = 50;
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type RemakeProductionVisionProtocol = "chat" | "responses" | "gemini";

export type RemakeProductionVisionAsset = {
    url: string;
    mimeType: string;
    width?: number;
    height?: number;
};

export type RemakeProductionVisualBoardLayoutItem = {
    order: number;
    role: "character" | "character-supplement" | "product" | "redrawn-contact-sheet";
    label: string;
    position: string;
    provided: boolean;
    groupOrdinal?: number;
    frameOrdinals?: number[];
};

export type RemakeProductionVisualBoard = {
    ordinal: number;
    id: "reference-board" | "redrawn-contact-sheets-board";
    mimeType: "image/jpeg";
    width: number;
    height: number;
    bytes: Buffer;
    description: string;
    layout: RemakeProductionVisualBoardLayoutItem[];
};

export type RemakeProductionVisionCall = {
    text: string;
    headers: Headers;
    protocol: RemakeProductionVisionProtocol;
    elapsedMs: number;
};

type LoadedImage = {
    bytes: Buffer;
    mimeType: string;
    width: number;
    height: number;
};

type ResolvedVisionProtocol = {
    kind: RemakeProductionVisionProtocol;
    path: string;
};

export class RemakeProductionVisionError extends Error {
    constructor(
        message: string,
        readonly status = 502,
        readonly responseHeaders?: Headers,
    ) {
        super(message);
        this.name = "RemakeProductionVisionError";
    }
}

export function resolveRemakeProductionVisionProtocol(candidate: ResolvedLogicalModel): ResolvedVisionProtocol | null {
    if (candidate.capabilityProfile?.supportsReferenceImage !== true) return null;
    if (candidate.capabilityProfile.maxReferenceImages !== undefined && candidate.capabilityProfile.maxReferenceImages < 2) return null;
    try {
        const protocol = resolveTextProtocol({
            model: candidate.upstreamModel,
            apiFormat: candidate.channel.apiFormat,
            advancedConfig: candidate.channel.advancedConfig,
            throughSystemProxy: true,
        });
        if (protocol.providerKind === "gemini") return { kind: "gemini", path: protocol.providerPath };
        if (protocol.kind === "responses" && protocol.providerKind === "responses") return { kind: "responses", path: protocol.path };
        if (protocol.kind === "chat" && protocol.providerKind === "chat") return { kind: "chat", path: protocol.path };
        return null;
    } catch {
        return null;
    }
}

export async function buildRemakeProductionVisualBoards(input: {
    origin: string;
    cookie: string;
    character?: RemakeProductionVisionAsset;
    characterSupplement?: RemakeProductionVisionAsset;
    product: RemakeProductionVisionAsset;
    redrawnContactSheets: Array<{ groupOrdinal: number; frameOrdinals: number[]; asset: RemakeProductionVisionAsset }>;
}): Promise<RemakeProductionVisualBoard[]> {
    const groups = [...input.redrawnContactSheets].sort((left, right) => left.groupOrdinal - right.groupOrdinal);
    if (groups.length !== 4 || groups.some((group, index) => group.groupOrdinal !== index + 1 || group.frameOrdinals.length !== 12 || group.frameOrdinals.some((ordinal, frameIndex) => ordinal !== index * 12 + frameIndex + 1))) {
        throw new RemakeProductionVisionError("生产视觉规划必须读取连续四组重绘十二宫格", 409);
    }

    const budget = { remaining: REMAKE_PRODUCTION_SOURCE_IMAGES_TOTAL_MAX_BYTES };
    const character = input.character ? await readProductionImage(input.character, "人物图", input.origin, input.cookie, budget) : undefined;
    const characterSupplement = input.characterSupplement ? await readProductionImage(input.characterSupplement, "人物补充图", input.origin, input.cookie, budget) : undefined;
    const product = await readProductionImage(input.product, "新产品图", input.origin, input.cookie, budget);
    const redrawnContactSheets: LoadedImage[] = [];
    for (const group of groups) {
        const label = `第 ${group.groupOrdinal} 组重绘十二宫格`;
        const image = await readProductionImage(group.asset, label, input.origin, input.cookie, budget);
        const dimensionError = remakeContactSheetDimensionError(image.width, image.height);
        if (dimensionError) throw new RemakeProductionVisionError(`${label}不满足生产要求：${dimensionError}`, 422);
        redrawnContactSheets.push(image);
    }

    const referenceBoard = await createReferenceBoard(character, characterSupplement, product);
    const contactSheetBoard = await createContactSheetBoard(redrawnContactSheets, groups);
    if (referenceBoard.bytes.length + contactSheetBoard.bytes.length > REMAKE_PRODUCTION_VISUAL_BOARDS_TOTAL_MAX_BYTES) {
        throw new RemakeProductionVisionError("生产视觉板总大小超过模型输入上限，请压缩参考图后重试", 413);
    }
    return [referenceBoard, contactSheetBoard];
}

export async function requestRemakeProductionVisionPrompt(input: {
    origin: string;
    cookie: string;
    candidate: ResolvedLogicalModel;
    messages: Array<{ role: string; content: string }>;
    boards: RemakeProductionVisualBoard[];
    headers?: HeadersInit;
    signal?: AbortSignal;
}): Promise<RemakeProductionVisionCall> {
    const protocol = resolveRemakeProductionVisionProtocol(input.candidate);
    if (!protocol) throw new RemakeProductionVisionError("当前文本候选不支持受信任的多模态图片协议", 503);
    if (
        input.boards.length !== 2 ||
        input.boards.some((board, index) => board.ordinal !== index + 1 || board.id !== (["reference-board", "redrawn-contact-sheets-board"] as const)[index] || !board.bytes.length || board.bytes.length > REMAKE_PRODUCTION_VISUAL_BOARD_MAX_BYTES)
    ) {
        throw new RemakeProductionVisionError("生产视觉板缺失或超过模型输入上限", 413);
    }
    const totalBytes = input.boards.reduce((sum, board) => sum + board.bytes.length, 0);
    if (totalBytes > REMAKE_PRODUCTION_VISUAL_BOARDS_TOTAL_MAX_BYTES) throw new RemakeProductionVisionError("生产视觉板总大小超过模型输入上限", 413);

    const startedAt = Date.now();
    const headers = new Headers(input.headers);
    headers.set("content-type", "application/json");
    if (input.cookie) headers.set("cookie", input.cookie);
    const timeoutSignal = AbortSignal.timeout(resolveModelRequestTimeoutMs(input.candidate, "text"));
    const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
    const response = await fetchInternalApi(modelProxyUrl(input.origin, input.candidate.channelId, protocol.path), {
        method: "POST",
        headers,
        body: JSON.stringify(buildVisionRequest(protocol.kind, input.candidate.upstreamModel, input.messages, input.boards)),
        cache: "no-store",
        signal,
    });
    if (!response.ok) {
        const detail = await readResponseText(response, 64 * 1024).catch(() => "");
        throw new RemakeProductionVisionError(toSafeGenerationErrorMessage(detail, `生产视觉规划模型调用失败（HTTP ${response.status}）`), response.status, response.headers);
    }
    const payload = await readResponseJson(response).catch(() => null);
    if (!payload) throw new RemakeProductionVisionError("生产视觉规划模型返回了无效 JSON", 502, response.headers);
    const prompt = readPromptText(protocol.kind, payload);
    if (!prompt.trim()) {
        throw new RemakeProductionVisionError("模型没有返回视频提示词正文", 502, response.headers);
    }
    return { text: prompt, headers: response.headers, protocol: protocol.kind, elapsedMs: Date.now() - startedAt };
}

function buildVisionRequest(protocol: RemakeProductionVisionProtocol, model: string, messages: Array<{ role: string; content: string }>, boards: RemakeProductionVisualBoard[]) {
    const systemText = messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n");
    const userText = messages
        .filter((message) => message.role !== "system")
        .map((message) => message.content)
        .join("\n\n");
    if (protocol === "responses") {
        return {
            model,
            input: [
                ...(systemText ? [{ role: "system", content: systemText }] : []),
                {
                    role: "user",
                    content: [{ type: "input_text", text: userText }, ...boards.map((board) => ({ type: "input_image", image_url: boardDataUrl(board), detail: "high" }))],
                },
            ],
        };
    }
    if (protocol === "gemini") {
        return {
            contents: [
                {
                    role: "user",
                    parts: [{ text: userText }, ...boards.map((board) => ({ inlineData: { mimeType: board.mimeType, data: board.bytes.toString("base64") } }))],
                },
            ],
            ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
        };
    }
    return {
        model,
        messages: [
            ...(systemText ? [{ role: "system", content: systemText }] : []),
            {
                role: "user",
                content: [{ type: "text", text: userText }, ...boards.map((board) => ({ type: "image_url", image_url: { url: boardDataUrl(board), detail: "high" } }))],
            },
        ],
    };
}

async function readProductionImage(asset: RemakeProductionVisionAsset, label: string, origin: string, cookie: string, budget: { remaining: number }): Promise<LoadedImage> {
    let response: Response;
    try {
        const target = resolveImageTarget(asset.url, origin);
        response = await fetchRemakeProductionImage(target.url, { internal: target.internal, cookie });
    } catch (error) {
        if (error instanceof RemakeProductionVisionError) throw error;
        throw new RemakeProductionVisionError(`${label}读取失败：${toSafeGenerationErrorMessage(error, "参考图片暂时无法读取")}`);
    }
    if (!response.ok || !response.body) throw new RemakeProductionVisionError(`${label}读取失败（HTTP ${response.status}）`, response.status);
    const declaredLength = Number(response.headers.get("content-length") || 0);
    const maximum = Math.min(REMAKE_PRODUCTION_SOURCE_IMAGE_MAX_BYTES, budget.remaining);
    if (maximum <= 0 || (Number.isFinite(declaredLength) && declaredLength > maximum)) {
        await response.body.cancel().catch(() => undefined);
        throw new RemakeProductionVisionError(`${label}超过生产视觉素材大小上限`, 413);
    }
    const bytes = await readBoundedBytes(response.body, maximum, `${label}超过生产视觉素材大小上限`);
    budget.remaining -= bytes.length;
    const detected = await fileTypeFromBuffer(bytes);
    const mimeType = detected?.mime.toLowerCase() || "";
    if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) throw new RemakeProductionVisionError(`${label}不是受支持的 JPEG、PNG 或 WebP 图片`, 422);
    let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
    try {
        metadata = await sharp(bytes, { failOn: "error", limitInputPixels: SOURCE_IMAGE_MAX_PIXELS }).metadata();
    } catch {
        throw new RemakeProductionVisionError(`${label}像素无法解码或尺寸过大`, 422);
    }
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > SOURCE_IMAGE_MAX_PIXELS) {
        throw new RemakeProductionVisionError(`${label}像素无法解码或尺寸过大`, 422);
    }
    const swapsDimensions = metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8;
    const width = swapsDimensions ? metadata.height : metadata.width;
    const height = swapsDimensions ? metadata.width : metadata.height;
    if ((asset.width !== undefined || asset.height !== undefined) && (!Number.isSafeInteger(asset.width) || !Number.isSafeInteger(asset.height) || asset.width !== width || asset.height !== height)) {
        throw new RemakeProductionVisionError(`${label}声明尺寸与实际像素不一致（声明 ${asset.width ?? "?"}x${asset.height ?? "?"}，实际 ${width}x${height}）`, 422);
    }
    return { bytes, mimeType, width, height };
}

function resolveImageTarget(value: string, origin: string) {
    let originUrl: URL;
    try {
        originUrl = new URL(origin);
    } catch {
        throw new RemakeProductionVisionError("站点地址无效，无法读取生产视觉素材", 500);
    }
    if (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") throw new RemakeProductionVisionError("站点地址无效，无法读取生产视觉素材", 500);
    const source = value.trim();
    let parsed: URL;
    try {
        parsed = new URL(source, originUrl.origin);
    } catch {
        throw new RemakeProductionVisionError("生产视觉素材地址不受信任", 422);
    }
    const internal = parsed.origin === originUrl.origin && parsed.pathname.startsWith("/api/");
    if (internal) return { internal: true as const, url: parsed.toString() };
    if (!/^https:\/\//i.test(source) || parsed.protocol !== "https:" || parsed.username || parsed.password) {
        throw new RemakeProductionVisionError("生产视觉素材地址不受信任，仅允许站内 /api/ 或外部 HTTPS 图片", 422);
    }
    return { internal: false as const, url: parsed.toString() };
}

async function createReferenceBoard(character: LoadedImage | undefined, supplement: LoadedImage | undefined, product: LoadedImage): Promise<RemakeProductionVisualBoard> {
    const tileWidth = REFERENCE_BOARD_WIDTH / 3;
    const imageHeight = REFERENCE_BOARD_HEIGHT - LABEL_HEIGHT;
    const assets = [
        { image: character, label: "A | CHARACTER" },
        { image: supplement, label: "B | CHARACTER SUPPLEMENT" },
        { image: product, label: "C | PRODUCT" },
    ];
    const overlays: OverlayOptions[] = [];
    for (const [index, asset] of assets.entries()) {
        if (asset.image) overlays.push({ input: await fitImage(asset.image.bytes, tileWidth, imageHeight), left: index * tileWidth, top: LABEL_HEIGHT });
        else overlays.push({ input: placeholderSvg(tileWidth, imageHeight), left: index * tileWidth, top: LABEL_HEIGHT });
        overlays.push({ input: labelSvg(tileWidth, LABEL_HEIGHT, asset.label), left: index * tileWidth, top: 0 });
    }
    const bytes = await renderBoard(REFERENCE_BOARD_WIDTH, REFERENCE_BOARD_HEIGHT, overlays);
    return {
        ordinal: 1,
        id: "reference-board",
        mimeType: "image/jpeg",
        width: REFERENCE_BOARD_WIDTH,
        height: REFERENCE_BOARD_HEIGHT,
        bytes,
        description: "从左到右依次为可选人物图、可选人物补充图、新产品图；空白位表示未提供该可选素材。",
        layout: [
            { order: 1, role: "character", label: "A | CHARACTER", position: "left", provided: Boolean(character) },
            { order: 2, role: "character-supplement", label: "B | CHARACTER SUPPLEMENT", position: "center", provided: Boolean(supplement) },
            { order: 3, role: "product", label: "C | PRODUCT", position: "right", provided: true },
        ],
    };
}

async function createContactSheetBoard(images: LoadedImage[], groups: Array<{ groupOrdinal: number; frameOrdinals: number[] }>): Promise<RemakeProductionVisualBoard> {
    const tileWidth = CONTACT_SHEET_BOARD_WIDTH / 2;
    const tileHeight = CONTACT_SHEET_BOARD_HEIGHT / 2;
    const imageHeight = tileHeight - LABEL_HEIGHT;
    const overlays: OverlayOptions[] = [];
    for (const [index, image] of images.entries()) {
        const group = groups[index];
        const left = (index % 2) * tileWidth;
        const top = Math.floor(index / 2) * tileHeight;
        const firstFrame = group.frameOrdinals[0];
        const lastFrame = group.frameOrdinals[group.frameOrdinals.length - 1];
        overlays.push({ input: await fitImage(image.bytes, tileWidth, imageHeight), left, top: top + LABEL_HEIGHT });
        overlays.push({ input: labelSvg(tileWidth, LABEL_HEIGHT, `GROUP ${group.groupOrdinal} | FRAMES ${firstFrame}-${lastFrame}`), left, top });
    }
    const bytes = await renderBoard(CONTACT_SHEET_BOARD_WIDTH, CONTACT_SHEET_BOARD_HEIGHT, overlays);
    return {
        ordinal: 2,
        id: "redrawn-contact-sheets-board",
        mimeType: "image/jpeg",
        width: CONTACT_SHEET_BOARD_WIDTH,
        height: CONTACT_SHEET_BOARD_HEIGHT,
        bytes,
        description: "按左上、右上、左下、右下顺序对应第 1 至第 4 组重绘十二宫格，每组内部均按 3×4 从左到右、从上到下对应连续 12 帧。",
        layout: groups.map((group, index) => ({
            order: index + 1,
            role: "redrawn-contact-sheet" as const,
            label: `GROUP ${group.groupOrdinal}`,
            position: ["top-left", "top-right", "bottom-left", "bottom-right"][index],
            provided: true,
            groupOrdinal: group.groupOrdinal,
            frameOrdinals: [...group.frameOrdinals],
        })),
    };
}

async function fitImage(bytes: Buffer, width: number, height: number) {
    return sharp(bytes, { failOn: "error", limitInputPixels: SOURCE_IMAGE_MAX_PIXELS }).rotate().resize(width, height, { fit: "contain", background: "#15171b", withoutEnlargement: false }).jpeg({ quality: 88, chromaSubsampling: "4:4:4" }).toBuffer();
}

async function renderBoard(width: number, height: number, overlays: OverlayOptions[]) {
    const source = await sharp({ create: { width, height, channels: 3, background: "#15171b" } })
        .composite(overlays)
        .png()
        .toBuffer();
    for (const quality of [84, 74, 64, 52, 40]) {
        const bytes = await sharp(source).jpeg({ quality, chromaSubsampling: "4:2:0" }).toBuffer();
        if (bytes.length <= REMAKE_PRODUCTION_VISUAL_BOARD_MAX_BYTES) return bytes;
    }
    throw new RemakeProductionVisionError("生产视觉板压缩后仍超过模型输入上限", 413);
}

function labelSvg(width: number, height: number, label: string) {
    return Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#0b0c0f"/><text x="20" y="32" fill="#ffffff" font-family="Arial,sans-serif" font-size="20" font-weight="700">${label}</text></svg>`,
    );
}

function placeholderSvg(width: number, height: number) {
    return Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#252830"/><text x="50%" y="50%" text-anchor="middle" fill="#aeb4c0" font-family="Arial,sans-serif" font-size="18">OPTIONAL IMAGE NOT PROVIDED</text></svg>`,
    );
}

function boardDataUrl(board: RemakeProductionVisualBoard) {
    return `data:${board.mimeType};base64,${board.bytes.toString("base64")}`;
}

function modelProxyUrl(origin: string, channelId: string, path: string) {
    const normalizedPath = path.trim();
    if (!normalizedPath || /^https?:\/\//i.test(normalizedPath)) throw new RemakeProductionVisionError("多模态文本协议路径无效", 503);
    return `${origin.replace(/\/+$/, "")}/api/ai/system/${encodeURIComponent(channelId)}${normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`}`;
}

function readPromptText(protocol: RemakeProductionVisionProtocol, payload: Record<string, unknown>) {
    if (protocol === "responses") {
        if (payload.status === "incomplete" || payload.status === "failed") return "";
        return records(payload.output)
            .filter((item) => item.type === "message" && item.role === "assistant")
            .flatMap((item) => records(item.content))
            .filter((part) => part.type === "output_text")
            .map((part) => typeof part.text === "string" ? part.text : "")
            .join("");
    }
    if (protocol === "gemini") {
        const candidate = records(payload.candidates)[0];
        if (candidate?.finishReason && candidate.finishReason !== "STOP") return "";
        return records(record(candidate?.content).parts)
            .filter((part) => part.thought !== true && typeof part.text === "string")
            .map((part) => part.text)
            .join("");
    }
    const choice = records(payload.choices)[0];
    if (choice?.finish_reason && choice.finish_reason !== "stop") return "";
    const message = record(choice?.message);
    if (message.refusal) return "";
    return typeof message.content === "string" ? message.content : records(message.content)
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("");
}

async function readResponseJson(response: Response) {
    const text = await readResponseText(response, MODEL_RESPONSE_MAX_BYTES);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

async function readResponseText(response: Response, maximum: number) {
    if (!response.body) return "";
    return (await readBoundedBytes(response.body, maximum, "模型响应超过大小上限")).toString("utf8");
}

async function readBoundedBytes(body: ReadableStream<Uint8Array>, maximum: number, message: string) {
    const reader = body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            total += next.value.byteLength;
            if (total > maximum) {
                await reader.cancel(message).catch(() => undefined);
                throw new RemakeProductionVisionError(message, 413);
            }
            chunks.push(Buffer.from(next.value));
        }
    } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        throw error;
    }
    if (!total) throw new RemakeProductionVisionError("读取到的图片或模型响应为空", 422);
    return Buffer.concat(chunks, total);
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function records(value: unknown) {
    return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}
