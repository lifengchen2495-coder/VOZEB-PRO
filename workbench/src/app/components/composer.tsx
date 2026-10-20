"use client";

import { App, Button, Input, Segmented, Select, Spin } from "antd";
import { ArrowUp, ImagePlus, X } from "lucide-react";
import { useRef, useState, type ClipboardEvent } from "react";
import type { Media, Mode, SendBody } from "@/lib/types";
import { api } from "@/services/api";

const auto = { value: "auto", label: "智能" };
const paramOptions: Record<Exclude<Mode, "chat">, Record<string, { label: string; options: { value: string; label: string }[] }>> = {
    image: {
        size: { label: "尺寸", options: [auto, ...["1024x1024", "1536x1024", "1024x1536"].map((value) => ({ value, label: value }))] },
        quality: { label: "画质", options: [auto, { value: "high", label: "高" }, { value: "medium", label: "中" }, { value: "low", label: "低" }] },
        n: { label: "数量", options: ["1", "2", "3", "4"].map((value) => ({ value, label: `${value} 张` })) },
    },
    video: {
        seconds: { label: "时长", options: [auto, ...["4", "8", "12"].map((value) => ({ value, label: `${value} 秒` }))] },
        size: { label: "尺寸", options: [auto, ...["1280x720", "720x1280", "1792x1024", "1024x1792"].map((value) => ({ value, label: value }))] },
    },
};
const defaults: Record<Mode, Record<string, string>> = { chat: {}, image: { size: "auto", quality: "auto", n: "1" }, video: { seconds: "auto", size: "auto" } };
const placeholders: Record<Mode, string> = { chat: "有什么想聊的？", image: "描述你想要的画面，可附参考图进行编辑", video: "描述视频内容，可附一张首帧参考图" };

export function Composer({ busy, onSend }: { busy: boolean; onSend: (body: SendBody) => Promise<boolean> }) {
    const { message } = App.useApp();
    const [mode, setMode] = useState<Mode>("chat");
    const [prompt, setPrompt] = useState("");
    const [params, setParams] = useState(defaults);
    const [attachments, setAttachments] = useState<Media[]>([]);
    const [uploading, setUploading] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);
    const limit = mode === "video" ? 1 : 8;

    const upload = async (files: File[]) => {
        const images = files.filter((file) => file.type.startsWith("image/")).slice(0, limit - attachments.length);
        if (!images.length) return;
        setUploading(true);
        try {
            const saved = await Promise.all(images.map((file) => api.upload(file)));
            setAttachments((current) => [...current, ...saved].slice(0, limit));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "上传失败");
        } finally {
            setUploading(false);
        }
    };

    const send = async () => {
        if (!prompt.trim() || busy || uploading) return;
        const sent = await onSend({ mode, prompt, attachmentIds: attachments.slice(0, limit).map((m) => m.id), params: params[mode] });
        if (!sent) return;
        setPrompt("");
        setAttachments([]);
    };

    const onPaste = (event: ClipboardEvent) => {
        const files = Array.from(event.clipboardData.files);
        if (!files.length) return;
        event.preventDefault();
        void upload(files);
    };

    return (
        <div className="rounded-2xl border p-3 shadow-sm" style={{ background: "var(--panel)", borderColor: "var(--line)" }}>
            {(attachments.length > 0 || uploading) && (
                <div className="mb-2 flex flex-wrap gap-2">
                    {attachments.map((media) => (
                        <div key={media.id} className="relative">
                            <img src={media.url} alt={media.name || "参考图"} title={media.name} className="h-14 w-14 rounded-lg object-cover" />
                            <button
                                type="button"
                                aria-label="移除参考图"
                                onClick={() => setAttachments((current) => current.filter((m) => m.id !== media.id))}
                                className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-700 text-white hover:bg-red-500"
                            >
                                <X size={12} />
                            </button>
                        </div>
                    ))}
                    {uploading && <Spin className="self-center" size="small" />}
                </div>
            )}
            <Input.TextArea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onPaste={onPaste}
                onPressEnter={(event) => {
                    if (event.shiftKey || event.nativeEvent.isComposing) return;
                    event.preventDefault();
                    void send();
                }}
                placeholder={placeholders[mode]}
                autoSize={{ minRows: 2, maxRows: 8 }}
                variant="borderless"
                className="!px-1"
            />
            <div className="mt-2 flex items-center gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
                    <Segmented
                        size="small"
                        value={mode}
                        onChange={(value) => setMode(value as Mode)}
                        options={[
                            { value: "chat", label: "对话" },
                            { value: "image", label: "图片" },
                            { value: "video", label: "视频" },
                        ]}
                    />
                    <Button size="small" type="text" icon={<ImagePlus size={16} />} onClick={() => fileInput.current?.click()} disabled={attachments.length >= limit} aria-label="添加参考图" />
                    {mode !== "chat" &&
                        Object.entries(paramOptions[mode]).map(([key, { label, options }]) => (
                            <Select
                                key={key}
                                size="small"
                                aria-label={label}
                                value={params[mode][key]}
                                onChange={(value) => setParams((current) => ({ ...current, [mode]: { ...current[mode], [key]: value } }))}
                                options={options.map((option) => ({ ...option, label: `${label} ${option.label}` }))}
                                popupMatchSelectWidth={false}
                                variant="filled"
                            />
                        ))}
                </div>
                <Button type="primary" shape="circle" icon={<ArrowUp size={18} />} onClick={send} loading={busy} disabled={!prompt.trim() || uploading} aria-label="发送" />
            </div>
            <input
                ref={fileInput}
                type="file"
                accept="image/*"
                multiple={mode !== "video"}
                hidden
                onChange={(event) => {
                    void upload(Array.from(event.target.files || []));
                    event.target.value = "";
                }}
            />
        </div>
    );
}
