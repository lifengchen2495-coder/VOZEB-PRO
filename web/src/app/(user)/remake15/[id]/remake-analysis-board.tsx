"use client";

import { Alert, Button, Empty, Progress, Tabs, Tag } from "antd";
import { CircleAlert, FileText, Images, RefreshCw, ScanSearch } from "lucide-react";
import Image from "next/image";

import { formatFrameTime, type RemakeCopyBlock, type RemakeFrame, type RemakeProject, type RemakeTask } from "../remake-contract";

export type RemakeWorkspaceTab = "frames" | "analysis" | "copy";

export function RemakeAnalysisBoard({
    project,
    task,
    activeTab,
    selectedFrameId,
    selectedBlockId,
    onTabChange,
    onSelectFrame,
    onSelectBlock,
    onRetry,
}: {
    project: RemakeProject;
    task: RemakeTask | null;
    activeTab: RemakeWorkspaceTab;
    selectedFrameId?: string;
    selectedBlockId?: string;
    onTabChange: (tab: RemakeWorkspaceTab) => void;
    onSelectFrame: (id: string) => void;
    onSelectBlock: (id: string) => void;
    onRetry: () => void;
}) {
    const warning = analysisWarning(project);
    const taskActive = task?.status === "pending" || task?.status === "running";
    const taskError = task?.status === "error" ? task.error || project.analysis.error || "分析失败，请重试。" : project.analysis.status === "error" ? project.analysis.error || "分析失败，请重试。" : "";

    return (
        <section className="flex h-full min-h-0 min-w-0 flex-col bg-background" aria-label="复刻分析工作台">
            {(taskActive || taskError || warning) && (
                <div className="shrink-0 border-b border-border px-3 py-2 sm:px-4">
                    {taskActive ? (
                        <div className="grid grid-cols-[minmax(0,1fr)_minmax(100px,220px)] items-center gap-3">
                            <div className="min-w-0">
                                <div className="truncate text-xs font-medium">{task.stage || "正在分析来源视频"}</div>
                                <div className="mt-0.5 text-[11px] text-muted-foreground">后台任务会在离开页面后继续执行</div>
                            </div>
                            <Progress className="!mb-0" percent={task.progress} size="small" status="active" />
                        </div>
                    ) : taskError ? (
                        <div className="flex items-center justify-between gap-3 text-xs text-rose-700 dark:text-rose-300">
                            <span className="min-w-0 truncate">{taskError}</span>
                            <Button size="small" className="shrink-0" icon={<RefreshCw className="size-3.5" />} onClick={onRetry}>
                                重试分析
                            </Button>
                        </div>
                    ) : warning ? (
                        <Alert showIcon type="warning" className="!py-1.5" title={warning.title} description={warning.detail} />
                    ) : null}
                </div>
            )}

            <Tabs
                activeKey={activeTab}
                className="remake-workspace-tabs min-h-0 flex-1 [&>.ant-tabs-content-holder]:min-h-0 [&>.ant-tabs-content-holder]:overflow-hidden [&>.ant-tabs-content-holder>.ant-tabs-content]:h-full [&>.ant-tabs-content-holder>.ant-tabs-content>.ant-tabs-tabpane]:h-full [&>.ant-tabs-nav]:!mb-0 [&>.ant-tabs-nav]:shrink-0 [&>.ant-tabs-nav]:px-3 sm:[&>.ant-tabs-nav]:px-4"
                onChange={(value) => onTabChange(value as RemakeWorkspaceTab)}
                items={[
                    {
                        key: "frames",
                        label: <TabLabel icon={<Images className="size-3.5" />} text="12 抽帧" count={project.frames.length} />,
                        children: <FrameGrid frames={project.frames} selectedId={selectedFrameId} onSelect={onSelectFrame} />,
                    },
                    {
                        key: "analysis",
                        label: <TabLabel icon={<ScanSearch className="size-3.5" />} text="分析结果" count={project.frames.filter((frame) => frame.analysisStatus === "available").length} />,
                        children: <AnalysisRows frames={project.frames} selectedId={selectedFrameId} onSelect={onSelectFrame} />,
                    },
                    {
                        key: "copy",
                        label: <TabLabel icon={<FileText className="size-3.5" />} text="4 文案区间" count={project.copyBlocks.length} />,
                        children: <CopyBlockRows blocks={project.copyBlocks} selectedId={selectedBlockId} onSelect={onSelectBlock} />,
                    },
                ]}
            />
        </section>
    );
}

export function analysisWarning(project: RemakeProject): { title: string; detail: string } | null {
    if (project.analysis.mode === "frames-only") {
        return { title: "当前结果仅包含抽帧", detail: project.analysis.warning || "视觉分析不可用，字幕、卖点和画面描述没有被标记为 AI 分析成功。" };
    }
    if (project.analysis.mode === "hybrid" || project.frames.some((frame) => frame.analysisStatus === "unavailable")) {
        const unavailable = project.frames.filter((frame) => frame.analysisStatus === "unavailable").length;
        return { title: "当前为混合分析结果", detail: project.analysis.warning || `${unavailable} 个单元缺少可靠视觉分析，请人工复核后再交接。` };
    }
    return null;
}

function TabLabel({ icon, text, count }: { icon: React.ReactNode; text: string; count: number }) {
    return (
        <span className="inline-flex items-center gap-1.5">
            {icon}
            <span>{text}</span>
            <span className="text-[11px] tabular-nums text-muted-foreground">{count}</span>
        </span>
    );
}

function FrameGrid({ frames, selectedId, onSelect }: { frames: RemakeFrame[]; selectedId?: string; onSelect: (id: string) => void }) {
    if (!frames.length) return <WorkspaceEmpty icon={<Images className="size-5" />} title="还没有抽帧" detail="上传来源视频后启动分析。" />;
    return (
        <div className="h-full overflow-y-auto p-2 sm:p-4">
            <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2 sm:gap-3">
                {frames.map((frame) => {
                    const selected = frame.id === selectedId;
                    return (
                        <button
                            key={frame.id}
                            type="button"
                            className={`group min-w-0 overflow-hidden rounded-md border bg-card text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5965ff]/35 ${selected ? "border-[#5965ff] ring-1 ring-[#5965ff]/25" : "border-border hover:border-foreground/30"}`}
                            onClick={() => onSelect(frame.id)}
                            aria-pressed={selected}
                        >
                            <span className="relative block aspect-[9/12] overflow-hidden bg-[#16191d]">
                                {frame.frameUrl ? (
                                    <Image src={frame.frameUrl} alt={`抽帧 ${frame.ordinal}`} fill unoptimized sizes="(min-width: 1200px) 140px, (min-width: 640px) 22vw, 32vw" className="object-cover transition duration-200 group-hover:scale-[1.02]" />
                                ) : (
                                    <Images className="absolute left-3 top-3 size-5 text-white/60" />
                                )}
                                <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white">{String(frame.ordinal).padStart(2, "0")}</span>
                                {frame.analysisStatus === "unavailable" ? <CircleAlert className="absolute bottom-1.5 right-1.5 size-4 text-amber-300" aria-label="分析不可用" /> : null}
                            </span>
                            <span className="block px-2 py-1.5">
                                <span className="block truncate text-[11px] font-medium tabular-nums">{formatFrameTime(frame.time)}</span>
                                <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{frame.shotType || frame.subtitle || "待标注"}</span>
                            </span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

function AnalysisRows({ frames, selectedId, onSelect }: { frames: RemakeFrame[]; selectedId?: string; onSelect: (id: string) => void }) {
    if (!frames.length) return <WorkspaceEmpty icon={<ScanSearch className="size-5" />} title="没有分析结果" detail="完成抽帧后会显示逐单元结果。" />;
    return (
        <div className="h-full overflow-y-auto">
            {frames.map((frame) => (
                <button
                    key={frame.id}
                    type="button"
                    className={`grid w-full min-w-0 grid-cols-[44px_minmax(0,1fr)] gap-3 border-b border-border px-3 py-3 text-left transition hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#5965ff]/35 sm:grid-cols-[56px_minmax(0,1fr)_120px] sm:px-4 ${frame.id === selectedId ? "bg-muted/55" : ""}`}
                    onClick={() => onSelect(frame.id)}
                    aria-pressed={frame.id === selectedId}
                >
                    <span className="text-xs font-semibold tabular-nums text-muted-foreground">#{String(frame.ordinal).padStart(2, "0")}</span>
                    <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{frame.subtitle || "未识别字幕"}</span>
                        <span className="mt-1 block line-clamp-2 text-xs leading-5 text-muted-foreground">{frame.description || frame.sellingPoint || "此单元没有可靠的视觉描述。"}</span>
                    </span>
                    <span className="hidden min-w-0 text-right sm:block">
                        <Tag color={frame.analysisStatus === "available" ? "success" : "warning"} className="!m-0">
                            {frame.analysisStatus === "available" ? "可用" : "待复核"}
                        </Tag>
                        <span className="mt-1 block truncate text-[11px] text-muted-foreground">{frame.shotType || formatFrameTime(frame.time)}</span>
                    </span>
                </button>
            ))}
        </div>
    );
}

function CopyBlockRows({ blocks, selectedId, onSelect }: { blocks: RemakeCopyBlock[]; selectedId?: string; onSelect: (id: string) => void }) {
    if (!blocks.length) return <WorkspaceEmpty icon={<FileText className="size-5" />} title="还没有文案区间" detail="分析完成后会按时间线形成文案区间。" />;
    return (
        <div className="h-full overflow-y-auto">
            {blocks.map((block) => (
                <button
                    key={block.id}
                    type="button"
                    className={`grid w-full min-w-0 grid-cols-[44px_minmax(0,1fr)] gap-3 border-b border-border px-3 py-3 text-left transition hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#5965ff]/35 sm:grid-cols-[56px_minmax(0,1fr)_112px] sm:px-4 ${block.id === selectedId ? "bg-muted/55" : ""}`}
                    onClick={() => onSelect(block.id)}
                    aria-pressed={block.id === selectedId}
                >
                    <span className="text-xs font-semibold tabular-nums text-muted-foreground">{String(block.ordinal).padStart(2, "0")}</span>
                    <span className="min-w-0">
                        <span className="block line-clamp-2 text-sm leading-6">{block.text || block.sourceText || "待填写文案"}</span>
                        {block.sourceText && block.text && block.sourceText !== block.text ? <span className="mt-1 block truncate text-[11px] text-muted-foreground">原文：{block.sourceText}</span> : null}
                    </span>
                    <span className="hidden text-right text-xs tabular-nums text-muted-foreground sm:block">
                        单元 {block.frameOrdinals[0]}–{block.frameOrdinals[2]}
                    </span>
                </button>
            ))}
        </div>
    );
}

function WorkspaceEmpty({ icon, title, detail }: { icon: React.ReactNode; title: string; detail: string }) {
    return (
        <div className="grid h-full min-h-52 place-items-center px-4">
            <Empty image={icon} description={<span className="text-sm font-medium text-foreground">{title}</span>}>
                <p className="text-xs text-muted-foreground">{detail}</p>
            </Empty>
        </div>
    );
}
