"use client";

import { App, Button, Popconfirm, Tag, Tooltip } from "antd";
import { ArrowUpRight, Film, Trash2 } from "lucide-react";
import Link from "next/link";

import type { RemakeProjectSummary } from "./remake-contract";

const dateFormatter = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

export function RemakeProjectCard({ project, deleting, onDelete }: { project: RemakeProjectSummary; deleting: boolean; onDelete: (id: string) => Promise<void> }) {
    const { message } = App.useApp();
    const analysis = analysisLabel(project);
    const updatedAt = Date.parse(project.updatedAt);

    return (
        <article className="group relative overflow-hidden rounded-lg border border-border bg-card text-card-foreground transition hover:-translate-y-px hover:border-foreground/25 hover:shadow-sm focus-within:border-foreground/35 focus-within:ring-2 focus-within:ring-ring/20">
            <Link href={`/remake-person/${encodeURIComponent(project.id)}`} className="absolute inset-0 z-10 rounded-lg outline-none" aria-label={`进入复刻项目：${project.title}`}>
                <span className="sr-only">进入复刻项目：{project.title}</span>
            </Link>
            <div className="relative aspect-[16/8] overflow-hidden border-b border-border bg-[#16191d]">
                {project.sourceVideoUrl ? (
                    <video src={project.sourceVideoUrl} className="size-full object-cover opacity-90" muted preload="metadata" aria-label={`${project.title} 来源视频`} />
                ) : (
                    <Film className="absolute left-4 top-4 size-6 text-white/75" />
                )}
                <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent px-3 pb-2.5 pt-8 text-white">
                    <span className="text-xs tabular-nums">{project.frameCount ? `${project.frameCount} 个分析单元` : "等待分析"}</span>
                    <ArrowUpRight className="size-4 shrink-0" />
                </div>
            </div>
            <div className="p-3.5">
                <div className="flex min-w-0 items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                        <h2 className="truncate text-[15px] font-semibold">{project.title}</h2>
                        <p className="mt-1 truncate text-xs text-muted-foreground">{project.sourceVideoUrl ? "来源视频已就绪" : "尚未上传来源视频"}</p>
                    </div>
                    <Tag color={analysis.color} className="!m-0 shrink-0">
                        {analysis.text}
                    </Tag>
                </div>
                <div className="relative z-20 mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
                    <span className="min-w-0 truncate text-xs text-muted-foreground">{Number.isFinite(updatedAt) ? `${dateFormatter.format(updatedAt)} 更新` : `Revision ${project.revision}`}</span>
                    <Popconfirm
                        title="删除这个复刻项目？"
                        description="项目记录会被移除，已被其他项目引用的媒体仍受引用保护。"
                        okText="删除"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => onDelete(project.id).catch((error) => message.error(error instanceof Error ? error.message : "项目删除失败"))}
                    >
                        <Tooltip title="删除项目">
                            <Button
                                type="text"
                                shape="circle"
                                loading={deleting}
                                className="!size-8 !text-muted-foreground hover:!bg-rose-50 hover:!text-rose-600 dark:hover:!bg-rose-950/30 dark:hover:!text-rose-300"
                                icon={<Trash2 className="size-3.5" />}
                                aria-label="删除项目"
                            />
                        </Tooltip>
                    </Popconfirm>
                </div>
            </div>
        </article>
    );
}

function analysisLabel(project: RemakeProjectSummary): { text: string; color?: string } {
    if (project.analysisStatus === "completed") return { text: project.analysisMode === "frames-only" ? "仅抽帧" : project.analysisMode === "hybrid" ? "部分分析" : "分析完成", color: project.analysisMode === "frames-only" ? "warning" : "success" };
    if (project.analysisStatus === "running" || project.analysisStatus === "queued") return { text: "分析中", color: "processing" };
    if (project.analysisStatus === "error") return { text: "分析失败", color: "error" };
    return { text: "未分析" };
}
