"use client";

import { Checkbox, Empty, Input, Tag } from "antd";
import { SlidersHorizontal } from "lucide-react";
import Image from "next/image";

import { formatFrameTime, type RemakeCopyBlock, type RemakeCopyStrategy, type RemakeFrame } from "../remake-contract";
import type { RemakeWorkspaceTab } from "./remake-analysis-board";

export function RemakeUnitEditor({
    activeTab,
    copyStrategy,
    frame,
    block,
    disabled,
    onUpdateFrame,
    onUpdateBlock,
}: {
    activeTab: RemakeWorkspaceTab;
    copyStrategy: RemakeCopyStrategy;
    frame?: RemakeFrame;
    block?: RemakeCopyBlock;
    disabled: boolean;
    onUpdateFrame: (patch: Partial<RemakeFrame>) => void;
    onUpdateBlock: (patch: Partial<RemakeCopyBlock>) => void;
}) {
    const copyMode = activeTab === "copy";
    return (
        <aside className="flex h-full min-h-0 flex-col bg-card text-card-foreground" aria-label="当前单元编辑器">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
                <div className="flex items-center gap-2 text-sm font-semibold">
                    <SlidersHorizontal className="size-4 text-[#4f5d6b] dark:text-[#b8c1cb]" />
                    当前单元
                </div>
                {copyMode && block ? <Tag className="!m-0">区间 {String(block.ordinal).padStart(2, "0")}</Tag> : frame ? <Tag className="!m-0">#{String(frame.ordinal).padStart(2, "0")}</Tag> : null}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
                {copyMode ? <CopyBlockEditor block={block} copyStrategy={copyStrategy} disabled={disabled} onUpdate={onUpdateBlock} /> : <FrameEditor frame={frame} disabled={disabled} onUpdate={onUpdateFrame} />}
            </div>
        </aside>
    );
}

function FrameEditor({ frame, disabled, onUpdate }: { frame?: RemakeFrame; disabled: boolean; onUpdate: (patch: Partial<RemakeFrame>) => void }) {
    if (!frame) return <EditorEmpty text="选择一个抽帧单元" />;
    return (
        <div className="grid gap-4">
            {frame.frameUrl ? (
                <div className="relative aspect-video w-full overflow-hidden rounded-md border border-border bg-[#111418]">
                    <Image src={frame.frameUrl} alt={`抽帧 ${frame.ordinal}`} fill unoptimized sizes="340px" className="object-contain" />
                </div>
            ) : null}
            <TimeRange start={frame.time} end={frame.endTime} label="抽帧时间范围" />
            <Field label="字幕">
                <Input.TextArea value={frame.subtitle} disabled={disabled} autoSize={{ minRows: 2, maxRows: 5 }} placeholder="当前单元字幕" onChange={(event) => onUpdate({ subtitle: event.target.value })} />
            </Field>
            <Field label="卖点">
                <Input.TextArea value={frame.sellingPoint} disabled={disabled} autoSize={{ minRows: 2, maxRows: 4 }} placeholder="商品利益点" onChange={(event) => onUpdate({ sellingPoint: event.target.value })} />
            </Field>
            <Field label="镜头类型">
                <Input value={frame.shotType} disabled={disabled} placeholder="例如：产品特写" onChange={(event) => onUpdate({ shotType: event.target.value })} />
            </Field>
            <Field label="画面描述">
                <Input.TextArea value={frame.description} disabled={disabled} autoSize={{ minRows: 4, maxRows: 9 }} placeholder="主体、构图、动作与环境" onChange={(event) => onUpdate({ description: event.target.value })} />
            </Field>
            <Field label="主体占比">
                <Input value={frame.subjectRatio} disabled={disabled} placeholder="例如：画面约 60%" onChange={(event) => onUpdate({ subjectRatio: event.target.value })} />
            </Field>
            <Checkbox checked={Boolean(frame.hasFace)} disabled={disabled} onChange={(event) => onUpdate({ hasFace: event.target.checked })}>
                检测到人脸
            </Checkbox>
            {frame.analysisStatus === "unavailable" ? <p className="border-l-2 border-amber-400 pl-2.5 text-xs leading-5 text-amber-700 dark:text-amber-300">此单元没有可靠的视觉分析结果，当前内容需要人工复核。</p> : null}
        </div>
    );
}

function CopyBlockEditor({ block, copyStrategy, disabled, onUpdate }: { block?: RemakeCopyBlock; copyStrategy: RemakeCopyStrategy; disabled: boolean; onUpdate: (patch: Partial<RemakeCopyBlock>) => void }) {
    if (!block) return <EditorEmpty text="选择一个文案区间" />;
    return (
        <div className="grid gap-4">
            <TimeRange start={block.startTime} end={block.endTime} label="文案区间时间范围" />
            <Field label="来源文案">
                <Input.TextArea readOnly value={block.sourceText} autoSize={{ minRows: 4, maxRows: 8 }} placeholder="该区间对应的原始文案" />
            </Field>
            <Field label="交接文案">
                <Input.TextArea readOnly={copyStrategy === "keep"} disabled={disabled} value={block.text} autoSize={{ minRows: 6, maxRows: 12 }} placeholder="该区间最终使用的文案" onChange={(event) => onUpdate({ text: event.target.value })} />
            </Field>
            {copyStrategy === "keep" ? <p className="border-l-2 border-border pl-2.5 text-xs leading-5 text-muted-foreground">当前保留原文案；切换到手动改写后可编辑交接文案。</p> : null}
            <div className="text-[11px] leading-5 text-muted-foreground">
                关联单元 {block.frameOrdinals.join("、")} · {formatFrameTime(block.startTime)}–{formatFrameTime(block.endTime)}
            </div>
        </div>
    );
}

function TimeRange({ start, end, label }: { start: number; end: number; label: string }) {
    return (
        <div className="grid grid-cols-2 gap-2" aria-label={label}>
            <div className="rounded-md border border-border px-2.5 py-2">
                <div className="text-[11px] text-muted-foreground">开始时间</div>
                <div className="mt-1 text-sm tabular-nums">{formatFrameTime(start)}</div>
            </div>
            <div className="rounded-md border border-border px-2.5 py-2">
                <div className="text-[11px] text-muted-foreground">结束时间</div>
                <div className="mt-1 text-sm tabular-nums">{formatFrameTime(end)}</div>
            </div>
        </div>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <label className="grid min-w-0 gap-1.5 text-xs font-medium">
            <span>{label}</span>
            {children}
        </label>
    );
}

function EditorEmpty({ text }: { text: string }) {
    return (
        <div className="grid min-h-52 place-items-center">
            <Empty image={<SlidersHorizontal className="size-5" />} description={<span className="text-xs text-muted-foreground">{text}</span>} />
        </div>
    );
}
