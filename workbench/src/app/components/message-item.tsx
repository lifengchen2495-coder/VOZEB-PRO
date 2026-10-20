"use client";

import { Button, Image, Spin, Tooltip } from "antd";
import { Copy, Download, Paperclip, RotateCcw, User } from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Media, Message } from "@/lib/types";
import { useWorkbench, workbench } from "@/stores/workbench";
import { modes, paramSummary } from "./composer";

const clock = (value: number) => new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

function copy(text: string, label = "已复制") {
    navigator.clipboard.writeText(text).then(
        () => workbench.notify(label),
        () => workbench.notify("复制失败", "error"),
    );
}

// 主媒体按真实宽高在有界范围内等比缩放；尚未加载时用请求尺寸或常见比例占位
function fit([width, height]: [number, number], maxWidth = 520, maxHeight = 440) {
    const scale = Math.min(maxWidth / width, maxHeight / height, 1);
    return { width: Math.round(width * scale), aspectRatio: `${width} / ${height}` };
}

function requestedSize(message: Message, request?: Message): [number, number] {
    const match = /^(\d+)x(\d+)$/.exec(request?.params?.size || "");
    if (match) return [Number(match[1]), Number(match[2])];
    return message.mode === "video" ? [1280, 720] : [1024, 1024];
}

function MediaResult({ message, request }: { message: Message; request?: Message }) {
    const attachments = useWorkbench((s) => s.attachments);
    const [index, setIndex] = useState(0);
    const [sizes, setSizes] = useState<Record<string, [number, number]>>({});
    const [preview, setPreview] = useState(false);
    const results = message.results || [];
    const main = results[Math.min(index, results.length - 1)];
    const box = fit((main && sizes[main.id]) || requestedSize(message, request));
    const measured = (media: Media, width: number, height: number) => width && height && setSizes((s) => ({ ...s, [media.id]: [width, height] }));

    if (message.status === "pending") {
        return (
            <div className="relative flex items-center justify-center overflow-hidden rounded-2xl border bg-[var(--panel)]" style={{ ...box, maxWidth: "100%", borderColor: "var(--line)" }}>
                <div className="wb-flow" />
                <span className="relative text-sm text-[var(--text-2)]">{message.mode === "image" ? "图片生成中…" : "视频生成中，通常需要几分钟…"}</span>
            </div>
        );
    }
    if (!main) return null;
    const referenced = attachments.some((item) => item.media?.id === main.id);
    return (
        <div className="flex w-fit max-w-full flex-col gap-2">
            <div className="flex max-w-full items-start gap-2">
                <div className="overflow-hidden rounded-2xl border" style={{ ...box, maxWidth: "100%", borderColor: "var(--line)" }}>
                    {main.kind === "video" ? (
                        <video
                            key={main.id}
                            src={main.url}
                            controls
                            playsInline
                            onLoadedMetadata={(event) => measured(main, event.currentTarget.videoWidth, event.currentTarget.videoHeight)}
                            className="block h-full w-full bg-black"
                        />
                    ) : (
                        <button type="button" aria-label="预览大图" onClick={() => setPreview(true)} className="block h-full w-full cursor-zoom-in">
                            <img
                                key={main.id}
                                src={main.url}
                                alt="生成结果"
                                onLoad={(event) => measured(main, event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)}
                                className="block h-full w-full object-contain"
                            />
                        </button>
                    )}
                </div>
                {results.length > 1 && (
                    <div className="flex flex-col gap-2">
                        {results.map((media, i) => (
                            <button
                                key={media.id}
                                type="button"
                                aria-label={`查看第 ${i + 1} 张`}
                                onClick={() => setIndex(i)}
                                className={`h-14 w-14 overflow-hidden rounded-xl border-2 ${media.id === main.id ? "border-[var(--accent)]" : "border-transparent opacity-70 hover:opacity-100"}`}
                            >
                                <img src={media.url} alt={`结果 ${i + 1}`} className="h-full w-full object-cover" />
                            </button>
                        ))}
                    </div>
                )}
            </div>
            {main.kind === "image" && (
                <Image.PreviewGroup
                    items={results.map((media) => media.url)}
                    preview={{ open: preview, current: index, onOpenChange: setPreview, onChange: setIndex }}
                />
            )}
            <div className="flex flex-wrap items-center gap-1">
                <Button size="small" type="text" icon={<Download size={14} />} href={main.url} download={main.id}>
                    下载
                </Button>
                {main.kind === "image" && (
                    <Button size="small" type="text" icon={<Paperclip size={14} />} onClick={() => workbench.reference(main)} className={referenced ? "!text-[var(--accent)]" : ""}>
                        {referenced ? "已引用" : "引用"}
                    </Button>
                )}
                {request && (
                    <Button size="small" type="text" icon={<Copy size={14} />} onClick={() => copy(request.content, "提示词已复制")}>
                        复制提示词
                    </Button>
                )}
            </div>
        </div>
    );
}

export function MessageItem({ item, request }: { item: Message; request?: Message }) {
    const streamText = useWorkbench((s) => s.stream[item.id]);
    const mode = modes.find((m) => m.value === item.mode)!;

    if (item.role === "user") {
        const summary = paramSummary(item.mode, item.params);
        return (
            <div className="flex justify-end gap-3 pl-11">
                <div className="flex min-w-0 flex-col items-end gap-1.5">
                    {!!item.attachments?.length && (
                        <div className="flex flex-wrap justify-end gap-2">
                            {item.attachments.map((media) => (
                                <Image key={media.id} src={media.url} alt={media.name || "参考图"} width={64} height={64} className="rounded-xl object-cover" />
                            ))}
                        </div>
                    )}
                    <div className="max-w-full whitespace-pre-wrap break-words rounded-2xl rounded-tr-md bg-[var(--bubble)] px-4 py-2.5 leading-7 max-w-[560px]">{item.content}</div>
                    <div className="flex items-center gap-2 text-xs text-[var(--text-2)]">
                        {item.mode !== "chat" && <span>{[mode.label, summary].filter(Boolean).join(" · ")}</span>}
                        <span>{clock(item.createdAt)}</span>
                        <Tooltip title="复制原文">
                            <Button type="text" size="small" icon={<Copy size={13} />} onClick={() => copy(item.content)} aria-label="复制原文" />
                        </Tooltip>
                    </div>
                </div>
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--accent)]" aria-label="我">
                    <User size={16} />
                </span>
            </div>
        );
    }

    const text = item.status === "pending" ? streamText || "" : item.content;
    const seconds = item.finishedAt ? Math.max(1, Math.round((item.finishedAt - item.createdAt) / 1000)) : 0;
    return (
        <div className="flex gap-3">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-[var(--panel)]" style={{ borderColor: "var(--line)" }}>
                <img src="/logo.svg" alt="助手" className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
                <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 text-xs text-[var(--text-2)]">
                    <span className="font-medium text-[color:inherit]">{item.mode === "chat" ? item.model : `${mode.label} · ${item.model}`}</span>
                    {item.finishedAt && item.status === "done" && <span className="opacity-80">{`${clock(item.finishedAt)} 完成 · 耗时 ${seconds} 秒`}</span>}
                </div>
                {item.mode === "chat" ? (
                    <>
                        {text && (
                            <div className="markdown break-words leading-7">
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
                            </div>
                        )}
                        {item.status === "pending" && !text && (
                            <div className="flex items-center gap-2 py-1 text-sm text-[var(--text-2)]">
                                <Spin size="small" />
                                思考中…
                            </div>
                        )}
                        {item.status === "done" && (
                            <Tooltip title="复制">
                                <Button type="text" size="small" icon={<Copy size={13} />} onClick={() => copy(item.content)} aria-label="复制回复" className="mt-1" />
                            </Tooltip>
                        )}
                    </>
                ) : (
                    item.status !== "failed" && <MediaResult message={item} request={request} />
                )}
                {item.status === "failed" && (
                    <div className="mt-1 flex flex-col items-start gap-2">
                        <div className="rounded-xl border border-[var(--coral)]/30 bg-[var(--coral-soft)] px-3 py-2 text-sm text-[var(--coral)]">{item.error || "生成失败"}</div>
                        <Button size="small" icon={<RotateCcw size={14} />} onClick={() => workbench.retry(item.id)}>
                            直接重试
                        </Button>
                    </div>
                )}
            </div>
        </div>
    );
}
