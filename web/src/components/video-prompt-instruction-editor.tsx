"use client";

import { Button, Input } from "antd";
import { Copy, Play, RotateCcw, Save } from "lucide-react";
import { useState } from "react";

type VideoPromptInstructionEditorProps = {
    defaultText: string;
    value?: string;
    disabled?: boolean;
    dirty?: boolean;
    hasOutput?: boolean;
    onChange: (value: string) => void;
    onSave: () => void | Promise<void>;
    onGenerate?: () => void | Promise<void>;
    generationDisabled?: boolean;
    label?: string;
};

export function VideoPromptInstructionEditor({ defaultText, value, disabled, dirty, hasOutput, onChange, onSave, onGenerate, generationDisabled, label = "视频提示词生成指令" }: VideoPromptInstructionEditorProps) {
    const [notice, setNotice] = useState("");
    const text = value?.trim() ? value : defaultText;
    const invalid = !text.trim() || text.length > 50_000;
    const run = async (action: () => void | Promise<void>) => {
        setNotice("");
        try {
            await action();
        } catch (error) {
            setNotice(error instanceof Error ? error.message : "操作失败，请重试");
        }
    };
    return (
        <section aria-label={label} className="min-w-0 space-y-3 rounded-lg border border-border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                    <h3 className="text-sm font-medium">{label}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">{value?.trim() ? "自定义指令" : "默认指令"}{dirty ? " · 有未保存修改" : ""}</p>
                </div>
                <Button size="small" icon={<Copy size={14} />} disabled={!text} onClick={() => void run(async () => { await navigator.clipboard.writeText(text); setNotice("已复制生成指令"); })}>复制指令</Button>
            </div>
            <p className="text-xs leading-6 text-muted-foreground">以下全文用于生成视频提示词。修改后保存并重新生成即可生效；清空内容或点击恢复默认，会使用默认指令。</p>
            <Input.TextArea aria-label={`${label}全文`} value={text} onChange={(event) => { setNotice(""); onChange(event.target.value); }} disabled={disabled} maxLength={50_000} autoSize={{ minRows: 7, maxRows: 16 }} className="!font-mono !text-[13px] !leading-6" />
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{text.length.toLocaleString("zh-CN")} / 50,000 字</span>
                {invalid && <span role="alert" className="text-destructive">生成指令未完整加载或超过字数限制</span>}
            </div>
            <div className="flex flex-wrap gap-2">
                <Button size="small" icon={<Save size={14} />} disabled={disabled || invalid || dirty === false} onClick={() => void run(onSave)}>保存生成指令</Button>
                <Button size="small" icon={<RotateCcw size={14} />} disabled={disabled || !value?.trim()} onClick={() => { setNotice(""); onChange(""); }}>恢复默认</Button>
                {onGenerate && <Button size="small" type="primary" icon={<Play size={14} />} disabled={disabled || invalid || generationDisabled} onClick={() => void run(onGenerate)}>{hasOutput ? "保存并重新生成" : "保存并生成"}</Button>}
            </div>
            {notice && <p role="status" className="text-xs leading-6 text-muted-foreground">{notice}</p>}
        </section>
    );
}
