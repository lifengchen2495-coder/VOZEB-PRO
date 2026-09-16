import { saveAs } from "file-saver";
import { safeExportFileName } from "@/lib/export-file";
import { originalMediaDownloadUrl } from "@/lib/media-image-url";
import { mediaFileExtension } from "@/lib/media-file";
import { createZip, type ZipFile } from "@/lib/zip";
import { assertFrameRemakeTimeline, type FrameRemakeProject, type FrameRemakeMedia } from "@/lib/frame-remake-contract";
import { frameRemakeWorkflowReadiness } from "@/lib/frame-remake-steps";
import { frameRemakeTemplates } from "@/lib/frame-remake-prompt-templates";

export async function downloadFrameRemakeProductionBundle(project: FrameRemakeProject) {
    assertFrameRemakeTimeline(project);
    if (!frameRemakeWorkflowReadiness(project).images || !project.sourceVideo || project.groups.some((g) => !g.videoPrompt || g.video.status !== "completed" || !g.video.result)) throw new Error("请先完成全部分镜图、提示词和独立视频");
    const media: Array<{ name: string; asset: FrameRemakeMedia }> = [{ name: "来源/原始视频", asset: project.sourceVideo }];
    if (project.mergedVideo) media.push({ name: "成片/原时长复刻", asset: project.mergedVideo });
    for (const [role, assets] of Object.entries(project.references)) assets.forEach((asset, i) => media.push({ name: `参考素材/${role}-${i + 1}`, asset }));
    const files: ZipFile[] = [
        { name: "文案/原文案.txt", data: project.sourceCopy ?? project.groups.map((g) => g.sourceCopy || "").join("") },
        { name: "分析/新产品信息.txt", data: project.productInfo || "" },
    ];
    for (const g of project.groups) {
        const prefix = `${String(g.number).padStart(3, "0")}-${g.id}`;
        for (const f of g.frames) if (f.media) media.push({ name: `来源/抽帧/分镜-${String(f.number).padStart(4, "0")}`, asset: f.media });
        for (const [name, asset] of [
            ["来源分镜", g.contactSheet],
            ["第一步-清理换人", g.template.result],
            ["第二步-最终换品", g.image.result],
            ["独立视频", g.video.result],
            ["原视频音频", g.sourceAudio],
        ] as const)
            if (asset) media.push({ name: `${name}/${prefix}`, asset });
        for (const [name, text] of [
            ["镜头解析", g.analysis],
            ["文案预处理", g.copy],
            ["新产品脚本", g.productScript],
            ["分镜脚本", g.imagePrompt],
            ["第一步完整提示词", g.template.prompt],
            ["第二步完整提示词", g.image.prompt],
            ["视频生成指令", g.videoPromptInstructions || frameRemakeTemplates(project, g).video],
            ["视频提示词", g.videoPrompt],
        ] as const)
            files.push({ name: `文本/${prefix}/${name}.txt`, data: text || "" });
    }
    const manifest: Array<{ name: string; sourceUrl: string }> = [];
    for (let i = 0; i < media.length; i += 6) {
        const batch = await Promise.all(
            media.slice(i, i + 6).map(async ({ name, asset }) => {
                const response = await fetch(originalMediaDownloadUrl(asset.url));
                if (!response.ok) throw new Error(`生产包读取失败：${name}（HTTP ${response.status}）`);
                const data = await response.blob();
                return { name: `${name}.${mediaFileExtension(data.type || asset.mimeType, asset.url)}`, data, sourceUrl: asset.url };
            }),
        );
        for (const { name, data, sourceUrl } of batch) {
            files.push({ name, data });
            manifest.push({ name, sourceUrl });
        }
    }
    files.push({ name: "manifest.json", data: JSON.stringify({ schema: "vozeb-frame-remake-production/v1", project, media: manifest }, null, 2) });
    saveAs(await createZip(files), `${safeExportFileName(project.title)}-原时长复刻生产包.zip`);
}
