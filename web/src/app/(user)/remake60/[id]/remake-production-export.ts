import { saveAs } from "file-saver";

import { safeExportFileName } from "@/lib/export-file";
import { originalMediaDownloadUrl } from "@/lib/media-image-url";
import { mediaFileExtension } from "@/lib/media-file";
import { createZip, type ZipFile } from "@/lib/zip";

import { isRemakeNoNarrationCopy, type RemakeMediaAsset, type RemakeProject } from "../remake-contract";

type ExportManifestEntry = {
    kind: "source-video" | "frame" | "reference" | "product-reference" | "source-contact-sheet" | "replacement-contact-sheet" | "storyboard-contact-sheet" | "generated-video" | "audio";
    name: string;
    fileName?: string;
    sourceUrl: string;
    status: "exported" | "failed";
};

export type RemakeProductionExportResult = {
    exportedMedia: number;
    failedMedia: number;
};

export async function downloadRemakeProductionBundle(project: RemakeProject): Promise<RemakeProductionExportResult> {
    assertCompleteProductionBundle(project);
    const files: ZipFile[] = [];
    const manifest: ExportManifestEntry[] = [];
    const media = productionMedia(project);
    const mediaBlobCache = new Map<string, Promise<Blob>>();

    for (let offset = 0; offset < media.length; offset += 6) {
        const batch = await Promise.all(
            media.slice(offset, offset + 6).map(async ({ kind, name, asset }) => {
                try {
                    const blob = await cachedMediaBlob(mediaBlobCache, asset.url);
                    const fileName = `${name}.${mediaFileExtension(blob.type || asset.mimeType, asset.url)}`;
                    return { file: { name: fileName, data: blob } satisfies ZipFile, entry: { kind, name, fileName, sourceUrl: asset.url, status: "exported" as const } };
                } catch {
                    return { entry: { kind, name, sourceUrl: asset.url, status: "failed" as const } };
                }
            }),
        );
        files.push(...batch.flatMap((item) => (item.file ? [item.file] : [])));
        manifest.push(...batch.map((item) => item.entry));
    }

    const failed = manifest.filter((entry) => entry.status === "failed");
    if (failed.length) {
        const names = failed
            .slice(0, 3)
            .map((entry) => entry.name)
            .join("、");
        throw new Error(`生产包媒体读取不完整：${failed.length} 个必需文件下载失败${names ? `（${names}${failed.length > 3 ? "等" : ""}）` : ""}，请重试后再下载`);
    }

    const assetBindings = seedanceAssetBindings(project, manifest);

    files.push(
        { name: "文案/原文案.txt", data: project.sourceCopy },
        { name: "文案/文案预处理报告.md", data: project.copy.rawReport },
        { name: "分析/48镜头解析.md", data: project.analysis.raw || "" },
        { name: "分析/新产品信息.txt", data: project.productInfo },
        { name: "分析/新产品-48分镜脚本.md", data: project.productScript },
        { name: "提示词/全部分镜提示词.md", data: project.storyboardScript },
        { name: "分析/抽帧时间点.txt", data: project.analysis.timestamps.map(formatTimestamp).join(",") },
        { name: "分析/48镜头结构.json", data: JSON.stringify(project.frames, null, 2) },
        {
            name: "提示词/生图-全部.txt",
            data: project.groups
                .map((group) => `=== 分镜 ${group.id} · 第一步：清理换人去旧产品 ===\n\n${group.replacementGeneration.prompt}\n\n=== 分镜 ${group.id} · 第二步：放入新产品 ===\n\n${group.imageGeneration.prompt}`)
                .join("\n\n"),
        },
        ...project.groups.flatMap((group) => [
            { name: `提示词/生图-${String(group.ordinal).padStart(2, "0")}-${group.id}-第一步-清理换人去旧产品.txt`, data: group.replacementGeneration.prompt },
            { name: `提示词/生图-${String(group.ordinal).padStart(2, "0")}-${group.id}-第二步-放入新产品.txt`, data: group.imageGeneration.prompt },
        ]),
        {
            name: "提示词/Seedance-全部.txt",
            data: project.groups.map((group) => `=== 分镜 ${group.id} ===\n\n${group.videoPrompt}`).join("\n\n"),
        },
        ...project.groups.map((group) => ({ name: `提示词/Seedance-${String(group.ordinal).padStart(2, "0")}-${group.id}.txt`, data: group.videoPrompt })),
        { name: "提示词/素材绑定.json", data: JSON.stringify({ schema: "vozeb-remake-seedance-bindings/v1", groups: assetBindings }, null, 2) },
        {
            name: "manifest.json",
            data: JSON.stringify(
                {
                    schema: "vozeb-remake-production/v1",
                    projectId: project.id,
                    projectTitle: project.title,
                    revision: project.revision,
                    exportedAt: new Date().toISOString(),
                    voice: project.voice,
                    analysis: { status: project.analysis.status, mode: project.analysis.mode, frameCount: project.frames.length, timestamps: project.analysis.timestamps },
                    modelSelection: project.modelSelection,
                    groups: project.groups.map((group, index) => ({
                        id: group.id,
                        ordinal: group.ordinal,
                        frameOrdinals: group.frameOrdinals,
                        replacementImageTaskId: group.replacementGeneration.taskId || null,
                        storyboardImageTaskId: group.imageGeneration.taskId || null,
                        videoTaskId: group.videoGeneration.taskId || null,
                        assetBindings: assetBindings[index],
                    })),
                    media: manifest,
                },
                null,
                2,
            ),
        },
    );

    const zip = await createZip(files);
    saveAs(zip, `${safeExportFileName(project.title || project.id)}-1分钟换品换人复刻生产包.zip`);
    return { exportedMedia: manifest.filter((entry) => entry.status === "exported").length, failedMedia: manifest.filter((entry) => entry.status === "failed").length };
}

function productionMedia(project: RemakeProject): Array<{ kind: ExportManifestEntry["kind"]; name: string; asset: RemakeMediaAsset }> {
    const noNarration = isRemakeNoNarrationCopy(project.sourceCopy);
    const source = project.sourceVideo ? [{ kind: "source-video" as const, name: "来源/原始视频", asset: project.sourceVideo }] : [];
    const frames = project.frames.map((frame) => ({
        kind: "frame" as const,
        name: `来源/抽帧/分镜-${String(frame.ordinal).padStart(2, "0")}`,
        asset: { url: frame.frameUrl, storageKey: frame.storageKey, mimeType: "image/jpeg", originalName: `frame-${String(frame.ordinal).padStart(2, "0")}.jpg` },
    }));
    const references = [
        project.references.product ? { kind: "product-reference" as const, name: "参考素材/新产品图", asset: project.references.product } : null,
        project.references.character ? { kind: "reference" as const, name: "参考素材/人物图", asset: project.references.character } : null,
        project.references.characterSupplement ? { kind: "reference" as const, name: "参考素材/人物补充图", asset: project.references.characterSupplement } : null,
        project.references.background ? { kind: "reference" as const, name: "参考素材/背景图", asset: project.references.background } : null,
        !noNarration && project.references.audio ? { kind: "audio" as const, name: "参考素材/原视频音频", asset: project.references.audio } : null,
    ];
    const groups = project.groups.flatMap((group) => [
        group.sourceContactSheet ? { kind: "source-contact-sheet" as const, name: `十二宫格/来源-${String(group.ordinal).padStart(2, "0")}-${group.id}`, asset: group.sourceContactSheet } : null,
        group.replacementGeneration.result
            ? { kind: "replacement-contact-sheet" as const, name: `十二宫格/第一步-清理换人-${String(group.ordinal).padStart(2, "0")}-${group.id}`, asset: group.replacementGeneration.result }
            : null,
        group.imageGeneration.result ? { kind: "storyboard-contact-sheet" as const, name: `十二宫格/第二步-最终换品-${String(group.ordinal).padStart(2, "0")}-${group.id}`, asset: group.imageGeneration.result } : null,
        group.videoGeneration.result ? { kind: "generated-video" as const, name: `独立视频/${String(group.ordinal).padStart(2, "0")}-${group.id}-15秒`, asset: group.videoGeneration.result } : null,
    ]);
    const merged = project.mergedVideo ? [{ kind: "generated-video" as const, name: "合并成片/1分钟完整视频", asset: project.mergedVideo }] : [];
    return [...source, ...frames, ...references, ...groups, ...merged].filter((item): item is NonNullable<typeof item> => Boolean(item?.asset.url));
}

function assertCompleteProductionBundle(project: RemakeProject) {
    const missing: string[] = [];
    const noNarration = isRemakeNoNarrationCopy(project.sourceCopy);
    if (!project.sourceVideo?.url) missing.push("原始视频");
    if (project.analysis.status !== "completed" || project.analysis.mode !== "video") missing.push("完整视频分析");
    if (project.frames.length !== 48 || project.frames.some((frame, index) => frame.ordinal !== index + 1 || frame.analysisStatus !== "available" || !frame.frameUrl)) missing.push("48 张抽帧");
    if (!project.references.product?.url) missing.push("新产品图");
    if (!project.productInfo.trim() || !project.productScript.trim() || !project.storyboardScript.trim()) missing.push("新产品信息、脚本与分镜提示词");
    if (!noNarration && !project.references.audio?.url) missing.push("原视频音频");
    if (!project.copy.rawReport.trim()) missing.push("文案预处理报告");
    if (project.copyBlocks.length !== 16 || project.copyBlocks.some((block, index) => block.ordinal !== index + 1 || (noNarration ? Boolean(block.sourceText.trim() || block.text.trim()) : !block.sourceText.trim() || !block.text.trim()))) {
        missing.push(noNarration ? "无口播分镜预处理" : "16 个文案区间");
    }
    if (
        project.groups.length !== 4 ||
        project.groups.some(
            (group, index) =>
                group.ordinal !== index + 1 ||
                !group.sourceContactSheet?.url ||
                group.replacementGeneration.status !== "completed" ||
                !group.replacementGeneration.result?.url ||
                !group.replacementGeneration.prompt.trim() ||
                group.imageGeneration.status !== "completed" ||
                !group.imageGeneration.result?.url ||
                !group.imageGeneration.prompt.trim() ||
                !group.videoPrompt.trim() ||
                group.videoGeneration.status !== "completed" ||
                !group.videoGeneration.result?.url,
        )
    ) {
        missing.push("来源十二宫格、两步生图、视频 Prompt 和 15 秒视频");
    }
    if (missing.length) throw new Error(`生产包不完整：缺少${Array.from(new Set(missing)).join("、")}，请补齐或重新生成后再下载`);
}

function cachedMediaBlob(cache: Map<string, Promise<Blob>>, sourceUrl: string) {
    const existing = cache.get(sourceUrl);
    if (existing) return existing;
    const pending = fetch(originalMediaDownloadUrl(sourceUrl)).then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.blob();
    });
    cache.set(sourceUrl, pending);
    return pending;
}

function seedanceAssetBindings(project: RemakeProject, manifest: ExportManifestEntry[]) {
    const exportedPath = (name: string) => manifest.find((entry) => entry.name === name && entry.status === "exported")?.fileName || null;
    const character = exportedPath("参考素材/人物图");
    const product = exportedPath("参考素材/新产品图");
    const audio = isRemakeNoNarrationCopy(project.sourceCopy) ? null : exportedPath("参考素材/原视频音频");
    return project.groups.map((group) => {
        const suffix = `${String(group.ordinal).padStart(2, "0")}-${group.id}`;
        return {
            groupId: group.id,
            "@人物图": character,
            "@产品图": product,
            "@十二宫格图": exportedPath(`十二宫格/第二步-最终换品-${suffix}`),
            "@音频文件": audio,
            "独立视频": exportedPath(`独立视频/${suffix}-15秒`),
        };
    });
}

function formatTimestamp(seconds: number) {
    const value = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    const minutes = Math.floor(value / 60);
    const remainder = value - minutes * 60;
    const formatted = Number.isInteger(remainder) ? String(remainder).padStart(2, "0") : remainder.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "").padStart(2, "0");
    return `${minutes}:${formatted}`;
}
