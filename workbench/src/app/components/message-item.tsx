"use client";

import { App, Button, Image, Spin, Tooltip } from "antd";
import { Copy, Download, RotateCcw } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message } from "@/lib/types";

const modeLabel = { chat: "对话", image: "图片", video: "视频" };
const paramLabel: Record<string, string> = { size: "尺寸", quality: "画质", n: "数量", seconds: "时长" };

const time = (value: number) => new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

function useCopy() {
    const { message } = App.useApp();
    return (text: string) => navigator.clipboard.writeText(text).then(() => message.success("已复制"), () => message.error("复制失败"));
}

export function MessageItem({ item, streamText, onRetry }: { item: Message; streamText?: string; onRetry: (id: string) => void }) {
    const copy = useCopy();
    if (item.role === "user") {
        const params = Object.entries(item.params || {}).filter(([, value]) => value && value !== "auto");
        return (
            <div className="flex flex-col items-end gap-1.5">
                {!!item.attachments?.length && (
                    <div className="flex flex-wrap justify-end gap-2">
                        {item.attachments.map((media) => (
                            <Image key={media.id} src={media.url} alt={media.name || "参考图"} width={72} height={72} className="rounded-lg object-cover" />
                        ))}
                    </div>
                )}
                <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-tr-sm px-4 py-2.5" style={{ background: "var(--bubble)" }}>
                    {item.content}
                </div>
                <div className="flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
                    {item.mode !== "chat" && <span>{[modeLabel[item.mode], ...params.map(([key, value]) => `${paramLabel[key] || key} ${value}`)].join(" · ")}</span>}
                    <span>{time(item.createdAt)}</span>
                    <Tooltip title="复制原文">
                        <Button type="text" size="small" icon={<Copy size={14} />} onClick={() => copy(item.content)} aria-label="复制原文" />
                    </Tooltip>
                </div>
            </div>
        );
    }

    const text = item.status === "pending" ? streamText || "" : item.content;
    const seconds = item.finishedAt ? Math.max(1, Math.round((item.finishedAt - item.createdAt) / 1000)) : 0;
    return (
        <div className="flex gap-3">
            <img src="/logo.svg" alt="助手" className="mt-0.5 h-8 w-8 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1">
                <div className="mb-1 text-xs" style={{ color: "var(--muted)" }}>
                    {[item.model, modeLabel[item.mode], seconds ? `耗时 ${seconds} 秒` : ""].filter(Boolean).join(" · ")}
                </div>
                {text && (
                    <div className="markdown break-words leading-7">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
                    </div>
                )}
                {item.status === "pending" && !text && (
                    <div className="flex items-center gap-2 py-2 text-sm" style={{ color: "var(--muted)" }}>
                        <Spin size="small" />
                        {item.mode === "chat" ? "思考中…" : item.mode === "image" ? "图片生成中…" : "视频生成中，通常需要几分钟…"}
                    </div>
                )}
                {!!item.results?.length && (
                    <div className="flex flex-wrap gap-3">
                        {item.results.map((media) =>
                            media.kind === "video" ? (
                                <video key={media.id} src={media.url} controls playsInline className="max-h-[480px] max-w-full rounded-xl" />
                            ) : (
                                <Image key={media.id} src={media.url} alt="生成结果" className="max-h-[420px] max-w-full rounded-xl" style={{ width: "auto", maxWidth: "100%" }} />
                            ),
                        )}
                    </div>
                )}
                {item.status === "failed" && (
                    <div className="mt-1 rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-300">
                        {item.error || "生成失败"}
                    </div>
                )}
                <div className="mt-1 flex gap-1">
                    {item.status === "failed" && (
                        <Button size="small" icon={<RotateCcw size={14} />} onClick={() => onRetry(item.id)}>
                            直接重试
                        </Button>
                    )}
                    {item.status === "done" && item.mode === "chat" && (
                        <Tooltip title="复制">
                            <Button type="text" size="small" icon={<Copy size={14} />} onClick={() => copy(item.content)} aria-label="复制" />
                        </Tooltip>
                    )}
                    {item.results?.map((media, index) => (
                        <Tooltip key={media.id} title={`下载${item.results!.length > 1 ? ` ${index + 1}` : ""}`}>
                            <Button type="text" size="small" icon={<Download size={14} />} href={media.url} download={media.id} aria-label="下载" />
                        </Tooltip>
                    ))}
                </div>
            </div>
        </div>
    );
}
