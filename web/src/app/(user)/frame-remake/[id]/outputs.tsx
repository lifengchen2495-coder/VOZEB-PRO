"use client";
import copy from "copy-to-clipboard";
import { Copy, Download } from "lucide-react";
import { useState } from "react";
import type { FrameRemakeMedia } from "@/lib/frame-remake-contract";
import { Button } from "../../bangbang/controls";

export function TextOutput({ title, text, name }: { title: string; text: string; name: string }) {
    const [copied, setCopied] = useState("");
    const [copyFailed, setCopyFailed] = useState(false);
    async function copyOutput() {
        let success = false;
        try {
            success = await copy(text);
        } catch {
            /* Keep the full text available for manual selection. */
        }
        setCopied(success ? text : "");
        setCopyFailed(!success);
    }
    function downloadOutput() {
        const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = `${name}.txt`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return (
        <div className="min-w-0 rounded-lg border bg-background p-4">
            <details open>
                <summary className="cursor-pointer font-medium text-foreground">{title}</summary>
                <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-sm leading-7 text-foreground [overflow-wrap:anywhere]">{text}</pre>
            </details>
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
                <Button variant="ghost" aria-label={`复制${name}`} onClick={copyOutput}>
                    <Copy className="size-3.5" />
                    {copied === text ? "已复制" : "复制全文"}
                </Button>
                <Button variant="ghost" aria-label={`下载${name}`} onClick={downloadOutput}>
                    <Download className="size-3.5" />
                    下载文本
                </Button>
                {copyFailed && (
                    <p role="status" className="text-xs text-destructive">
                        复制失败，请选择正文手动复制，或下载文本。
                    </p>
                )}
            </div>
        </div>
    );
}
export function Media({ media, label, downloadLabel = "下载" }: { media: FrameRemakeMedia; label: string; downloadLabel?: string }) {
    const video = media.mimeType.startsWith("video/");
    return (
        <div className="min-w-0 space-y-2">
            {video ? (
                <video src={media.url} controls preload="metadata" aria-label={label} className="max-h-[520px] w-full rounded-lg bg-black" />
            ) : (
                <a href={media.url} target="_blank" rel="noreferrer">
                    <img src={media.url} alt={label} loading="lazy" className="max-h-96 w-full rounded-lg border object-contain" />
                </a>
            )}
            <div className="flex flex-wrap items-center gap-3 text-xs">
                <a href={media.url} target="_blank" rel="noreferrer" aria-label={`打开${label}`} className="underline underline-offset-4">
                    {video ? "打开视频" : "查看原图"}
                </a>
                <a href={media.url} download={media.originalName || label} aria-label={`下载${label}`} className="inline-flex items-center gap-1 underline underline-offset-4">
                    <Download className="size-3.5" />
                    {downloadLabel}
                </a>
            </div>
        </div>
    );
}
