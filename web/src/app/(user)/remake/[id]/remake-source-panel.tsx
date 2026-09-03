"use client";

import { useRef } from "react";
import { Button, Input, Progress, Tag } from "antd";
import { FileText, FileVideo2, Upload } from "lucide-react";

import { REMAKE_NO_NARRATION_TEXT, type RemakeEditablePatch, type RemakeProject } from "../remake-contract";

export function RemakeSourcePanel({
    project,
    uploading,
    uploadProgress,
    disabled,
    onUpload,
    onPatch,
}: {
    project: RemakeProject;
    uploading: boolean;
    uploadProgress: number;
    disabled: boolean;
    onUpload: (file: File) => void;
    onPatch: (patch: RemakeEditablePatch) => void;
}) {
    const inputRef = useRef<HTMLInputElement>(null);
    const video = project.sourceVideo;
    const duration = video?.durationMs ? `${(video.durationMs / 1000).toFixed(1)} 秒` : "";
    const dimensions = video?.width && video?.height ? `${video.width} × ${video.height}` : video?.ratio || "";

    return (
        <aside className="flex h-full min-h-0 flex-col bg-card text-card-foreground" aria-label="来源视频与原文案">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
                <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                    <FileVideo2 className="size-4 text-[#4f5d6b] dark:text-[#b8c1cb]" />
                    来源
                </div>
                {video ? <Tag className="!m-0">已上传</Tag> : <Tag className="!m-0">待上传</Tag>}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
                <section className="border-b border-border p-3">
                    <div className="relative aspect-video overflow-hidden rounded-md border border-border bg-[#111418]">
                        {video?.url ? (
                            <video key={video.url} src={video.url} className="size-full object-contain" controls preload="metadata" />
                        ) : (
                            <div className="grid size-full place-items-center text-center text-white/65">
                                <div>
                                    <FileVideo2 className="mx-auto size-7" />
                                    <div className="mt-2 text-xs">等待来源视频</div>
                                </div>
                            </div>
                        )}
                    </div>
                    <div className="mt-2.5 flex min-w-0 items-center justify-between gap-2">
                        <div className="min-w-0">
                            <div className="truncate text-xs font-medium">{video?.originalName || "MP4 / MOV / WebM"}</div>
                            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{[duration, dimensions].filter(Boolean).join(" · ") || "最大 200 MiB"}</div>
                        </div>
                        <Button size="small" className="shrink-0" loading={uploading} disabled={disabled} icon={<Upload className="size-3.5" />} onClick={() => inputRef.current?.click()}>
                            {video ? "替换" : "上传"}
                        </Button>
                    </div>
                    {uploading ? <Progress className="!mb-0 !mt-2" percent={uploadProgress} size="small" status="active" /> : null}
                    <input
                        ref={inputRef}
                        className="hidden"
                        type="file"
                        disabled={disabled}
                        accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
                        onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.currentTarget.value = "";
                            if (file) onUpload(file);
                        }}
                    />
                </section>

                <section className="border-b border-border p-3">
                    <label htmlFor="remake-source-copy" className="flex items-center gap-2 text-xs font-semibold">
                        <FileText className="size-3.5 text-muted-foreground" />
                        原文案
                    </label>
                    <Input.TextArea
                        id="remake-source-copy"
                        className="!mt-2"
                        value={project.sourceCopy}
                        disabled={disabled}
                        autoSize={{ minRows: 7, maxRows: 14 }}
                        placeholder={`粘贴来源视频文案；无口播时输入“${REMAKE_NO_NARRATION_TEXT}”`}
                        onChange={(event) => onPatch({ sourceCopy: event.target.value })}
                    />
                    <div className="mt-1 text-right text-[11px] tabular-nums text-muted-foreground">{project.sourceCopy.length.toLocaleString("zh-CN")} 字</div>
                </section>
                <section className="p-3">
                    <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-semibold">文案处理方式</span>
                        <Tag className="!m-0">{project.sourceCopy.trim() === REMAKE_NO_NARRATION_TEXT ? REMAKE_NO_NARRATION_TEXT : "A：保持原文案"}</Tag>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">有口播时按原顺序分配到 16 个三帧区间并完成补全校对；无口播时只保留分镜描述。</p>
                </section>
            </div>
        </aside>
    );
}
