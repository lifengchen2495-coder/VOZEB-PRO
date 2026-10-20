"use client";

import { Button, Input, Popover, Tooltip } from "antd";
import { ArrowUp, Check, Clapperboard, ImagePlus, Image as ImageIcon, MessageCircle, Orbit, SlidersHorizontal, Wand2, X } from "lucide-react";
import Link from "next/link";
import { useRef, useState, type ClipboardEvent, type ReactNode } from "react";
import type { Mode } from "@/lib/types";
import { referenceLimit, useWorkbench, workbench } from "@/stores/workbench";

export const modes: { value: Mode; label: string; hint: string; icon: ReactNode; placeholder: string }[] = [
    { value: "chat", label: "对话", hint: "聊天、写作、看图问答", icon: <MessageCircle size={16} />, placeholder: "有什么想聊的？可以附图提问" },
    { value: "image", label: "图片", hint: "文字生成图片，附图可编辑", icon: <ImageIcon size={16} />, placeholder: "描述你想要的画面，附参考图可在原图上修改" },
    { value: "video", label: "视频", hint: "文字生成视频，可附一张首帧", icon: <Clapperboard size={16} />, placeholder: "描述视频的画面、动作和镜头" },
];

const auto = { value: "auto", label: "智能" };
const sizes = (values: string[]) => [auto, ...values.map((value) => ({ value, label: value.replace("x", " × ") }))];
export const paramGroups: Record<Exclude<Mode, "chat">, { key: string; label: string; options: { value: string; label: string }[] }[]> = {
    image: [
        { key: "size", label: "尺寸", options: sizes(["1024x1024", "1536x1024", "1024x1536"]) },
        { key: "quality", label: "画质", options: [auto, { value: "high", label: "高" }, { value: "medium", label: "中" }, { value: "low", label: "低" }] },
        { key: "n", label: "数量", options: ["1", "2", "3", "4"].map((value) => ({ value, label: `${value} 张` })) },
    ],
    video: [
        { key: "seconds", label: "时长", options: [auto, ...["4", "8", "12"].map((value) => ({ value, label: `${value} 秒` }))] },
        { key: "size", label: "尺寸", options: sizes(["1280x720", "720x1280", "1792x1024", "1024x1792"]) },
    ],
};

export function paramSummary(mode: Mode, params: Record<string, string> = {}) {
    if (mode === "chat") return "";
    return paramGroups[mode]
        .map(({ key, options }) => options.find((o) => o.value === params[key]))
        .filter((o) => o && o.value !== "auto")
        .map((o) => o!.label)
        .join(" · ");
}

// 弹层按触发器到可视区域边缘的真实剩余空间限制高度，保证手机上选项不落到屏幕外
function useRoom(placement: "top" | "bottom") {
    const [room, setRoom] = useState(320);
    const measure = (el: HTMLElement | null) => {
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const height = window.visualViewport?.height ?? window.innerHeight;
        setRoom(Math.max(160, (placement === "top" ? rect.top : height - rect.bottom) - 24));
    };
    return [room, measure] as const;
}

function Tool({ id, open, onOpenChange, icon, label, content, placement, title }: { id: string; open: string; onOpenChange: (id: string) => void; icon: ReactNode; label: ReactNode; content: ReactNode; placement: "top" | "bottom"; title: string }) {
    const [room, measure] = useRoom(placement);
    const active = open === id;
    return (
        <Popover
            open={active}
            onOpenChange={(next) => onOpenChange(next ? id : "")}
            trigger="click"
            placement={placement === "top" ? "topLeft" : "bottomLeft"}
            arrow={false}
            // 工具条靠右的入口在窄屏翻转后仍可能越界，允许水平平移贴回视口
            align={{ overflow: { adjustX: true, adjustY: true, shiftX: true } }}
            content={<div style={{ maxHeight: room }} className="overflow-y-auto">{content}</div>}
        >
            <button
                type="button"
                aria-label={title}
                onClick={(event) => measure(event.currentTarget)}
                className={`flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[13px] transition-colors ${active ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--text-2)] hover:bg-[var(--hover)]"}`}
            >
                {icon}
                <span className="max-w-[120px] truncate">{label}</span>
            </button>
        </Popover>
    );
}

function Option({ selected, onClick, children, className = "" }: { selected: boolean; onClick: () => void; children: ReactNode; className?: string }) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={selected}
            className={`rounded-lg border px-2.5 py-1.5 text-left text-[13px] transition-colors ${selected ? "border-[var(--accent)] text-[var(--accent)]" : "border-[var(--line)] hover:bg-[var(--hover)]"} ${className}`}
        >
            {children}
        </button>
    );
}

export function Composer({ placement }: { placement: "top" | "bottom" }) {
    const { mode, prompt, attachments, params, models, settings, busy, optimizing } = useWorkbench();
    const [open, setOpen] = useState("");
    const fileInput = useRef<HTMLInputElement>(null);
    const current = modes.find((m) => m.value === mode)!;
    const modelList = settings?.models[mode] || [];
    const kind = mode === "chat" ? "文本" : current.label;
    const model = models[mode] && modelList.includes(models[mode]!) ? models[mode]! : modelList[0];
    const full = attachments.length >= referenceLimit(mode);
    const summary = paramSummary(mode, params[mode]);

    const onPaste = (event: ClipboardEvent) => {
        const files = Array.from(event.clipboardData.files);
        if (!files.length) return;
        event.preventDefault();
        workbench.addFiles(files);
    };
    const tool = { open, onOpenChange: setOpen, placement };

    return (
        <div className="rounded-3xl border bg-[var(--panel)] p-3 shadow-[0_8px_30px_rgba(15,23,42,0.06)]" style={{ borderColor: "var(--line)" }}>
            <div className="flex gap-2">
                <div className="flex shrink-0 flex-wrap items-start gap-2 pt-0.5">
                    {attachments.map((item) => (
                        <div key={item.key} className="relative h-12 w-12">
                            <img src={item.url} alt={item.name} title={item.name} className="h-12 w-12 rounded-xl object-cover" />
                            <button
                                type="button"
                                aria-label={`移除 ${item.name}`}
                                onClick={() => workbench.removeAttachment(item.key)}
                                className="absolute -right-2.5 -top-2.5 flex h-7 w-7 items-center justify-center"
                            >
                                <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full border-2 border-[var(--panel)] bg-neutral-700 text-white transition-colors hover:bg-rose-500 focus-visible:bg-rose-500">
                                    <X size={12} />
                                </span>
                            </button>
                        </div>
                    ))}
                    {!full && (
                        <Tooltip title={mode === "video" ? "添加首帧参考图" : "添加参考图"}>
                            <button
                                type="button"
                                aria-label="添加参考素材"
                                onClick={() => fileInput.current?.click()}
                                className="flex h-12 w-12 items-center justify-center rounded-xl border border-dashed text-[var(--text-2)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
                                style={{ borderColor: "var(--line-strong)" }}
                            >
                                <ImagePlus size={18} />
                            </button>
                        </Tooltip>
                    )}
                </div>
                <Input.TextArea
                    value={prompt}
                    onChange={(event) => workbench.setPrompt(event.target.value)}
                    onPaste={onPaste}
                    onPressEnter={(event) => {
                        if (event.shiftKey || event.nativeEvent.isComposing) return;
                        event.preventDefault();
                        void workbench.send();
                    }}
                    placeholder={current.placeholder}
                    autoSize={{ minRows: 2, maxRows: 8 }}
                    variant="borderless"
                    className="!px-1 !text-[15px]"
                    aria-label="输入内容"
                />
            </div>
            <div className="mt-2 flex items-center gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                    <Tool
                        {...tool}
                        id="mode"
                        title="创作类型"
                        icon={current.icon}
                        label={current.label}
                        content={
                            <div className="flex w-56 flex-col gap-1">
                                {modes.map((item) => (
                                    <button
                                        key={item.value}
                                        type="button"
                                        onClick={() => {
                                            workbench.setMode(item.value);
                                            setOpen("");
                                        }}
                                        className="flex items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-[var(--hover)]"
                                    >
                                        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--hover)]">{item.icon}</span>
                                        <span className="min-w-0 flex-1">
                                            <span className="block text-sm font-medium">{item.label}</span>
                                            <span className="block text-xs text-[var(--text-2)]">{item.hint}</span>
                                        </span>
                                        {item.value === mode && <Check size={16} className="text-[var(--accent)]" />}
                                    </button>
                                ))}
                            </div>
                        }
                    />
                    <Tool
                        {...tool}
                        id="model"
                        title="模型"
                        icon={<Orbit size={16} />}
                        label={model || (settings ? "暂无模型" : "模型")}
                        content={
                            <div className="flex w-60 flex-col gap-1">
                                <div className="px-2 pb-1 text-xs text-[var(--text-2)]">{kind}模型</div>
                                {!modelList.length && <div className="px-2 py-2 text-sm text-[var(--text-3)]">还没有可用的{kind}模型</div>}
                                {modelList.map((item) => (
                                    <button
                                        key={item}
                                        type="button"
                                        onClick={() => {
                                            workbench.setModel(mode, item);
                                            setOpen("");
                                        }}
                                        className="flex items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-[var(--hover)]"
                                    >
                                        <span className="min-w-0 flex-1 truncate">{item}</span>
                                        {item === model && <Check size={16} className="text-[var(--accent)]" />}
                                    </button>
                                ))}
                                <Link href="/settings" onClick={() => setOpen("")} className="mt-1 border-t border-[var(--line)] px-2 pt-2 text-xs text-[var(--text-2)] hover:text-[var(--accent)]">
                                    在模型设置里管理
                                </Link>
                            </div>
                        }
                    />
                    {mode !== "chat" && (
                        <Tool
                            {...tool}
                            id="params"
                            title="生成参数"
                            icon={<SlidersHorizontal size={16} />}
                            label={summary || "智能参数"}
                            content={
                                <div className="flex w-[min(280px,calc(100vw-56px))] flex-col gap-3">
                                    {paramGroups[mode].map((group) => (
                                        <div key={group.key}>
                                            <div className="mb-1.5 text-xs text-[var(--text-2)]">{group.label}</div>
                                            <div className="grid grid-cols-3 gap-1.5">
                                                {group.options.map((option) => (
                                                    <Option key={option.value} selected={params[mode][group.key] === option.value} onClick={() => workbench.setParam(group.key, option.value)} className="text-center">
                                                        {option.label}
                                                    </Option>
                                                ))}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            }
                        />
                    )}
                    <Tooltip title="用默认对话模型改写提示词，结果可继续编辑">
                        <button
                            type="button"
                            aria-label="优化提示词"
                            disabled={!prompt.trim() || optimizing}
                            onClick={() => void workbench.optimize()}
                            className="flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[13px] text-[var(--text-2)] transition-colors hover:bg-[var(--hover)] disabled:cursor-not-allowed disabled:opacity-40"
                        >
                            <Wand2 size={16} className={optimizing ? "animate-pulse" : ""} />
                            {optimizing ? "优化中" : "优化"}
                        </button>
                    </Tooltip>
                </div>
                <Button type="primary" shape="circle" icon={<ArrowUp size={18} />} onClick={() => void workbench.send()} loading={busy} disabled={!prompt.trim()} aria-label="发送" className="shrink-0" />
            </div>
            <input
                ref={fileInput}
                type="file"
                accept="image/*"
                multiple={mode !== "video"}
                hidden
                onChange={(event) => {
                    workbench.addFiles(Array.from(event.target.files || []));
                    event.target.value = "";
                }}
            />
        </div>
    );
}
