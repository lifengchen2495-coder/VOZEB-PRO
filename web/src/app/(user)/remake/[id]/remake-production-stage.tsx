"use client";

import { useState } from "react";
import { App, Button, Image, Input, Segmented, Tag, Tooltip } from "antd";
import { Check, Copy, Download, FileAudio, FileText, LoaderCircle, Sparkles, Video, VolumeX } from "lucide-react";

import { imagePreviewUrl } from "@/lib/media-image-url";

import { isRemakeNoNarrationCopy, type RemakeProject, type RemakeVoice } from "../remake-contract";
import { downloadRemakeProductionBundle } from "./remake-production-export";
import { remakeImagesReady, remakeProductionReady } from "./remake-production-utils";
import { isRemakeCopyPlanReady } from "./remake-workspace-state";

export function RemakeProductionStage({ project, building, onVoiceChange, onBuild }: { project: RemakeProject; building: boolean; onVoiceChange: (voice: RemakeVoice) => void; onBuild: () => void }) {
    const { message } = App.useApp();
    const [exporting, setExporting] = useState(false);
    const noNarration = isRemakeNoNarrationCopy(project.sourceCopy);
    const prerequisites = productionPrerequisites(project);
    const promptsReady = project.groups.length === 4 && project.groups.every((group) => group.videoPrompt.trim());
    const reportReady = project.copy.status === "completed" && Boolean(project.copy.rawReport.trim());
    const productionReady = remakeProductionReady(project);

    const copyPrompt = async (text: string, success: string) => {
        await copyText(text);
        message.success(success);
    };
    const exportBundle = async () => {
        setExporting(true);
        try {
            await downloadRemakeProductionBundle(project);
            message.success("飞书复刻生产包已下载");
        } catch (reason) {
            message.error(reason instanceof Error ? reason.message : "生产包下载失败");
        } finally {
            setExporting(false);
        }
    };

    return (
        <section className="h-full min-h-0 overflow-y-auto bg-background" aria-label="生产内容">
            <div className="mx-auto w-full max-w-[1480px] px-3 py-4 sm:px-5 sm:py-5">
                <div className="flex min-w-0 flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-end sm:justify-between">
                    <div className="min-w-0">
                        <div className="text-xs font-medium text-muted-foreground">阶段 03</div>
                        <h2 className="mt-1 text-lg font-semibold">生产内容</h2>
                        <p className="mt-1 text-sm text-muted-foreground">生成飞书同结构的文案预处理报告与 4 条 Seedance 视频提示词。</p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                        <Button icon={<Download className="size-4" />} loading={exporting} disabled={!productionReady} onClick={() => void exportBundle()}>
                            下载生产包
                        </Button>
                        <Button type="primary" icon={<Sparkles className="size-4" />} loading={building} disabled={!prerequisites.ready} onClick={onBuild}>
                            {productionReady ? "重新生成" : "生成生产内容"}
                        </Button>
                    </div>
                </div>

                <div className="grid gap-4 border-b border-border py-4 lg:grid-cols-[minmax(0,1fr)_360px]">
                    <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm font-semibold">
                            {noNarration ? <VolumeX className="size-4 text-muted-foreground" /> : <FileAudio className="size-4 text-muted-foreground" />}
                            {noNarration ? "口播设置" : "配音选择"}
                        </div>
                        {noNarration ? (
                            <>
                                <Tag className="!mt-2">不需要人物口播</Tag>
                                <p className="mt-2 text-xs leading-5 text-muted-foreground">视频提示词只保留 12 个连续分镜动作，不生成声音段、口播内容或音频引用。</p>
                            </>
                        ) : (
                            <>
                                <Segmented
                                    className="!mt-2 !w-full sm:!w-auto"
                                    disabled={building}
                                    value={project.voice === "male" ? "male" : project.voice === "female" ? "female" : undefined}
                                    options={[
                                        { label: "女性配音", value: "female" },
                                        { label: "男性配音", value: "male" },
                                    ]}
                                    onChange={(value) => onVoiceChange(value === "male" ? "male" : "female")}
                                />
                                <p className="mt-2 text-xs leading-5 text-muted-foreground">配音选择保存在生产包中，视频提示词引用视频理解阶段提取的音频文件作为音色参考。</p>
                            </>
                        )}
                    </div>
                    <div className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-card p-3">
                        <div className="grid size-10 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">{noNarration ? <VolumeX className="size-4.5" /> : <FileAudio className="size-4.5" />}</div>
                        <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">{noNarration ? "音频引用" : "原视频音频"}</div>
                            <div className="mt-0.5 truncate text-xs text-muted-foreground">{noNarration ? "当前流程无需音频" : project.references.audio?.originalName || (project.references.audio ? "已由视频理解提取" : "尚未提取")}</div>
                        </div>
                        <Tag color={noNarration || project.references.audio ? "success" : "warning"} className="!m-0">
                            {noNarration ? "无需" : project.references.audio ? "就绪" : "缺失"}
                        </Tag>
                    </div>
                </div>

                {!prerequisites.ready ? (
                    <div className="border-b border-amber-300/70 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800 dark:border-amber-800/70 dark:bg-amber-950/20 dark:text-amber-200">
                        尚缺：{prerequisites.missing.join("、")}。补齐后才能按飞书流程生成生产内容。
                    </div>
                ) : null}

                <div className="grid min-w-0 gap-4 py-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                    <section className="min-w-0 rounded-lg border border-border bg-card" aria-label="文案预处理报告">
                        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
                            <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                                <FileText className="size-4 text-muted-foreground" />
                                文案预处理报告
                            </div>
                            <div className="flex shrink-0 items-center gap-1.5">
                                <Tag color={reportReady ? "success" : "default"} className="!m-0">
                                    {reportReady ? "已生成" : "待生成"}
                                </Tag>
                                <Tooltip title="复制报告">
                                    <Button
                                        type="text"
                                        size="small"
                                        className="!size-7 !min-w-0 !p-0"
                                        icon={<Copy className="size-3.5" />}
                                        disabled={!reportReady}
                                        aria-label="复制文案预处理报告"
                                        onClick={() => void copyPrompt(project.copy.rawReport, "文案预处理报告已复制")}
                                    />
                                </Tooltip>
                            </div>
                        </div>
                        <div className="p-3">
                            {building && !reportReady ? (
                                <ProductionLoading text="正在生成语义文案报告" />
                            ) : (
                                <Input.TextArea readOnly value={project.copy.rawReport} placeholder="生成后会显示 16 个区间的顺序填充检查、校对统计和四组字幕分配。" autoSize={{ minRows: 24, maxRows: 42 }} />
                            )}
                        </div>
                    </section>

                    <section className="min-w-0" aria-label="Seedance 视频提示词">
                        <div className="mb-2.5 flex items-center justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                                <Video className="size-4 text-muted-foreground" />
                                Seedance 视频提示词
                            </div>
                            <Button
                                size="small"
                                icon={<Copy className="size-3.5" />}
                                disabled={!promptsReady}
                                onClick={() => void copyPrompt(project.groups.map((group) => `=== 分镜 ${group.id} ===\n\n${group.videoPrompt}`).join("\n\n"), "4 条视频提示词已复制")}
                            >
                                复制全部
                            </Button>
                        </div>
                        <div className="grid gap-3">
                            {project.groups.map((group) => (
                                <article key={group.id} className="min-w-0 overflow-hidden rounded-lg border border-border bg-card">
                                    <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
                                        <div className="min-w-0">
                                            <h3 className="truncate text-sm font-semibold">
                                                第 {group.ordinal} 条 · 分镜 {group.id}
                                            </h3>
                                            <p className="mt-0.5 text-[11px] text-muted-foreground">15 秒 · 12 个连续镜头 · 9:16</p>
                                        </div>
                                        <div className="flex shrink-0 items-center gap-1.5">
                                            <Tag color={group.videoPrompt ? "success" : "default"} className="!m-0">
                                                {group.videoPrompt ? "就绪" : "待生成"}
                                            </Tag>
                                            <Tooltip title="复制视频提示词">
                                                <Button
                                                    type="text"
                                                    size="small"
                                                    className="!size-7 !min-w-0 !p-0"
                                                    icon={<Copy className="size-3.5" />}
                                                    disabled={!group.videoPrompt}
                                                    aria-label={`复制分镜 ${group.id} 视频提示词`}
                                                    onClick={() => void copyPrompt(group.videoPrompt, `分镜 ${group.id} 视频提示词已复制`)}
                                                />
                                            </Tooltip>
                                        </div>
                                    </div>
                                    <div className="grid min-w-0 gap-3 p-3 sm:grid-cols-[110px_minmax(0,1fr)]">
                                        <div className="relative aspect-[9/16] w-[110px] overflow-hidden rounded-md border border-border bg-[#15181c]">
                                            {group.imageGeneration.result?.url ? (
                                                <Image
                                                    className="!size-full !object-contain"
                                                    src={imagePreviewUrl(group.imageGeneration.result.url, 700)}
                                                    alt={`分镜 ${group.id} 重绘十二宫格`}
                                                    preview={{ src: imagePreviewUrl(group.imageGeneration.result.url, 1800) }}
                                                />
                                            ) : null}
                                        </div>
                                        {building && !group.videoPrompt ? (
                                            <ProductionLoading text={`正在生成分镜 ${group.id}`} />
                                        ) : (
                                            <Input.TextArea readOnly value={group.videoPrompt} placeholder="生成后会显示场景、情绪节奏、人物、产品、声音风格和 12 个连续动作。" autoSize={{ minRows: 9, maxRows: 18 }} />
                                        )}
                                    </div>
                                </article>
                            ))}
                        </div>
                    </section>
                </div>

                <div className="flex items-center gap-2 border-t border-border pt-4 text-xs text-muted-foreground">
                    {productionReady ? <Check className="size-4 text-emerald-600" /> : <Sparkles className="size-4" />}
                    {productionReady ? "文案报告和 4 条 Seedance 提示词已就绪" : "完成生成后可下载完整生产包"}
                </div>
            </div>
        </section>
    );
}

function ProductionLoading({ text }: { text: string }) {
    return (
        <div className="grid min-h-52 place-items-center rounded-md border border-dashed border-border bg-muted/15 px-4 text-center">
            <div>
                <LoaderCircle className="mx-auto size-5 animate-spin text-muted-foreground" />
                <p className="mt-2 text-xs text-muted-foreground">{text}</p>
            </div>
        </div>
    );
}

function productionPrerequisites(project: RemakeProject) {
    const missing: string[] = [];
    const noNarration = isRemakeNoNarrationCopy(project.sourceCopy);
    if (!project.sourceVideo?.url || project.analysis.status !== "completed" || project.analysis.mode !== "video" || project.frames.length !== 48 || project.frames.some((frame) => frame.analysisStatus !== "available" || !frame.frameUrl)) {
        missing.push("完整视频理解与 48 镜头解析");
    }
    if (!isRemakeCopyPlanReady(project)) {
        missing.push(noNarration ? "无口播分镜预处理" : "16 个语义文案区间");
    }
    if (!project.references.background) missing.push("背景图");
    if (!noNarration && !project.references.audio) missing.push("原视频音频");
    if (!remakeImagesReady(project)) missing.push("4 组重绘十二宫格");
    if (!noNarration && project.voice !== "female" && project.voice !== "male") missing.push("配音声线");
    return { ready: missing.length === 0, missing };
}

async function copyText(value: string) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
    const input = document.createElement("textarea");
    input.value = value;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
}
