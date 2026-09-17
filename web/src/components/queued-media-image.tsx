"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { MediaImageRedirectError, queueMediaImage, queueNativeMediaImage } from "@/lib/queued-media-image";

type ImageResult = { src: string; attempt: number; url?: string; nativeImage?: HTMLImageElement; error?: string; retrying?: boolean };

export function QueuedMediaImage({ src, alt, sizes, className }: { src: string; alt: string; sizes?: string; className?: string }) {
    const container = useRef<HTMLSpanElement>(null);
    const [visible, setVisible] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const [result, setResult] = useState<ImageResult>();
    const current = result?.src === src && result.attempt === attempt ? result : undefined;

    useEffect(() => {
        const element = container.current;
        if (!element) return;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    setVisible(true);
                    observer.disconnect();
                }
            },
            { rootMargin: "120px" },
        );
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (!visible || !src) return;
        const controller = new AbortController();
        let disposed = false;
        let objectUrl: string | undefined;
        let nativeImage: HTMLImageElement | undefined;
        void queueMediaImage(src, controller.signal, () => {
            if (!disposed) setResult({ src, attempt, retrying: true });
        })
            .then((blob) => {
                if (disposed) return;
                objectUrl = URL.createObjectURL(blob);
                setResult({ src, attempt, url: objectUrl });
            })
            .catch(async (error: unknown) => {
                if (disposed || controller.signal.aborted) return;
                if (error instanceof MediaImageRedirectError || error instanceof TypeError) {
                    try {
                        nativeImage = await queueNativeMediaImage(src, controller.signal);
                        if (disposed) {
                            nativeImage.removeAttribute("src");
                            return;
                        }
                        setResult({ src, attempt, nativeImage });
                        return;
                    } catch (fallbackError) {
                        error = fallbackError;
                    }
                }
                if (!disposed && !controller.signal.aborted) setResult({ src, attempt, error: error instanceof Error ? error.message : "图片加载失败，请重试" });
            });
        return () => {
            disposed = true;
            controller.abort();
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            nativeImage?.removeAttribute("src");
        };
    }, [src, visible, attempt]);

    const retry = () => setAttempt((value) => value + 1);
    return (
        <span ref={container} className="absolute inset-0 block">
            {current?.url ? (
                <Image src={current.url} alt={alt} fill unoptimized sizes={sizes} className={className} onError={() => setResult({ src, attempt, error: "图片无法显示，请重试" })} />
            ) : current?.nativeImage ? (
                <span
                    className="absolute inset-0 block"
                    ref={(element) => {
                        if (element && current.nativeImage) {
                            current.nativeImage.alt = alt;
                            current.nativeImage.className = `absolute inset-0 h-full w-full ${className || ""}`;
                            element.replaceChildren(current.nativeImage);
                        }
                    }}
                />
            ) : current?.error ? (
                <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-muted px-2 text-center text-[10px] text-muted-foreground" role="status">
                    <span>{current.error}</span>
                    <span
                        role="button"
                        tabIndex={0}
                        className="rounded border px-2 py-1 text-foreground"
                        aria-label={`重新加载${alt}`}
                        onClick={(event) => {
                            event.stopPropagation();
                            retry();
                        }}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                event.stopPropagation();
                                retry();
                            }
                        }}
                    >
                        重试加载
                    </span>
                </span>
            ) : (
                <span className="absolute inset-0 flex items-center justify-center bg-muted px-2 text-center text-[10px] text-muted-foreground">{current?.retrying ? "请求繁忙，正在重试…" : visible ? "正在加载画面…" : "等待加载画面"}</span>
            )}
        </span>
    );
}
