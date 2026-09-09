"use client";
import { Copy, Loader2, Play, RotateCcw, Save } from "lucide-react";
import { Button, Field, Textarea } from "../controls";

type VideoPromptInstructionsProps = {
    text: string;
    source: "default" | "custom";
    ready: boolean;
    loading: boolean;
    loadError: string;
    modePending: boolean;
    disabled: boolean;
    dirty: boolean;
    hasOutput: boolean;
    validationError?: string;
    generationBlockReason?: string;
    onChange: (text: string) => void;
    onSave: () => void;
    onRestoreDefault: () => void;
    onGenerate: () => void;
    onRetry: () => void;
    onSaveMode: () => void;
    onCopy: (text: string) => void;
};

export function VideoPromptInstructions({
    text,
    source,
    ready,
    loading,
    loadError,
    modePending,
    disabled,
    dirty,
    hasOutput,
    validationError,
    generationBlockReason,
    onChange,
    onSave,
    onRestoreDefault,
    onGenerate,
    onRetry,
    onSaveMode,
    onCopy,
}: VideoPromptInstructionsProps) {
    const editable = ready && !modePending && !disabled;
    return (
        <section className="space-y-4 rounded-xl border p-4 md:p-5" aria-label="视频提示词生成指令">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h3 className="font-medium">生成指令</h3>
                    <p className="mt-1 text-xs leading-6 text-muted-foreground">
                        {source === "custom" ? "自定义指令" : "默认指令"}
                        {dirty ? " · 有未保存修改" : ""}
                    </p>
                </div>
                <Button variant="ghost" disabled={!ready || !text.trim()} onClick={() => onCopy(text)}>
                    <Copy className="size-3.5" />
                    复制指令
                </Button>
            </div>
            <p className="text-sm leading-6 text-muted-foreground">以下全文将用于生成视频提示词，可直接修改。分镜顺序、单段时长和六段输出格式仍按项目要求生成。</p>
            {modePending ? (
                <div className="flex flex-wrap items-center gap-3 rounded-lg bg-muted p-3 text-sm">
                    <span>先保存创作方式，再读取对应的默认指令；自定义指令会保留。</span>
                    <Button variant="outline" disabled={disabled} onClick={onSaveMode}>
                        保存创作方式
                    </Button>
                </div>
            ) : loading ? (
                <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    正在读取完整生成指令…
                </p>
            ) : loadError ? (
                <div className="space-y-3">
                    <p role="alert" className="text-sm text-destructive">
                        {loadError}
                    </p>
                    <Button variant="outline" disabled={disabled} onClick={onRetry}>
                        重新加载生成指令
                    </Button>
                </div>
            ) : null}
            <Field label="生成指令全文">
                <Textarea
                    aria-label="生成指令全文"
                    className="min-h-80 font-mono text-[13px] leading-6"
                    value={text}
                    maxLength={50_000}
                    disabled={!editable}
                    placeholder={loading ? "正在读取…" : "完整生成指令将在加载成功后显示"}
                    onChange={(event) => onChange(event.target.value)}
                />
            </Field>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">{text.length.toLocaleString("zh-CN")} / 50,000 字</p>
                {validationError && (
                    <p role="alert" className="text-xs text-destructive">
                        {validationError}
                    </p>
                )}
            </div>
            <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={!editable || !dirty || Boolean(validationError)} onClick={onSave}>
                    <Save className="size-3.5" />
                    保存指令
                </Button>
                <Button variant="outline" disabled={!editable} onClick={onRestoreDefault}>
                    <RotateCcw className="size-3.5" />
                    恢复默认
                </Button>
                <Button disabled={!editable || Boolean(validationError) || Boolean(generationBlockReason)} onClick={onGenerate}>
                    <Play className="size-3.5" />
                    {hasOutput ? "保存并重新生成" : "保存并生成"}
                </Button>
            </div>
            {dirty && <p className="text-xs leading-6 text-amber-700 dark:text-amber-400">{hasOutput ? "指令尚未保存，下方仍是上次生成的结果；保存并重新生成后才会更新。" : "指令尚未保存，生成前会先保存当前全文。"}</p>}
            {!dirty && ready && !hasOutput && <p className="text-xs leading-6 text-muted-foreground">尚未按当前指令生成视频提示词。完成九宫格审核后即可生成。</p>}
            {generationBlockReason && <p className="text-xs leading-6 text-muted-foreground">{generationBlockReason}。你可以先编辑和保存生成指令。</p>}
        </section>
    );
}
