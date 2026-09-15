"use client";
import { Button, Drawer, Input, Tabs, Tag } from "antd";
import { useState } from "react";
import { FileText, FileVideo2, Images, ScanSearch } from "lucide-react";
import { FrameGrid, AnalysisRows, CopyBlockRows, type RemakeCopyBlockView, type RemakeWorkspaceTab } from "../../remake15/[id]/remake-analysis-board";
import { RemakeUnitEditor } from "../../remake15/[id]/remake-unit-editor";
import type { RemakeFrame } from "../../remake15/remake-contract";
import { frameRemakeWorkflowReadiness } from "@/lib/frame-remake-steps";
import { frameRemakeTime, type FrameRemakeFrameAnalysis } from "@/lib/frame-remake-contract";
import { Field, ModelControl, UploadControl, type WorkflowProps } from "./workflow-controls";
import { TextOutput } from "./outputs";
const emptyDetail: FrameRemakeFrameAnalysis = { subtitle: "", sellingPoint: "", shotType: "", description: "", subjectRatio: "", hasFace: false };
export function FrameSourceStage(props: WorkflowProps & { sourceOpen: boolean; editorOpen: boolean; onSourceClose: () => void; onEditorClose: () => void }) {
    const { project, display } = props;
    const [tab, setTab] = useState<RemakeWorkspaceTab>("frames"),
        [frameId, setFrameId] = useState(""),
        [blockId, setBlockId] = useState("");
    const frames: RemakeFrame[] = display.groups.flatMap((g) =>
        g.frames.map((f) => ({
            id: `${g.id}:${f.number}`,
            ordinal: f.number,
            time: f.startMs / 1000,
            endTime: f.endMs / 1000,
            frameUrl: f.media?.url || "",
            storageKey: f.media?.storageKey,
            analysisStatus: f.detail ? "available" : "unavailable",
            ...emptyDetail,
            ...f.detail,
        })),
    );
    let n = 0;
    const blocks: RemakeCopyBlockView[] = display.groups.flatMap((g) =>
        (g.copyBlocks || []).map((b) => ({ id: `${g.id}:${b.number}`, ordinal: ++n, frameOrdinals: b.frameNumbers, startTime: b.startMs / 1000, endTime: b.endMs / 1000, sourceText: b.sourceText, text: b.text })),
    );
    const frame = frames.find((f) => f.id === frameId) || frames[0],
        block = blocks.find((b) => b.id === blockId) || blocks[0];
    const select = (kind: "frame" | "copy", id: string) => {
        if (props.groupLocked) return;
        props.onGroup(id.split(":")[0]);
        if (kind === "frame") setFrameId(id);
        else setBlockId(id);
    };
    const editor = (
        <RemakeUnitEditor
            activeTab={tab}
            copyStrategy="manual"
            frame={frame}
            block={block}
            disabled={props.editingDisabled}
            onUpdateFrame={(patch) => {
                if (!frame) return;
                const [groupId, num] = frame.id.split(":");
                const updated = { ...frame, ...patch };
                props.onChange({
                    frame: {
                        groupId,
                        number: Number(num),
                        detail: { subtitle: updated.subtitle, sellingPoint: updated.sellingPoint, shotType: updated.shotType, description: updated.description, subjectRatio: updated.subjectRatio, hasFace: Boolean(updated.hasFace) },
                    },
                });
            }}
            onUpdateBlock={(patch) => {
                if (!block) return;
                const [groupId, num] = block.id.split(":");
                props.onChange({ copyBlock: { groupId, number: Number(num), text: patch.text ?? block.text } });
            }}
        />
    );
    const video = project.sourceVideo,
        ready = frameRemakeWorkflowReadiness(project).analysis;
    const source = (
        <aside className="flex h-full min-h-0 flex-col bg-card" aria-label="来源视频与原文案">
            <div className="flex h-12 shrink-0 items-center justify-between border-b px-3">
                <h2 className="flex items-center gap-2 text-sm font-semibold">
                    <FileVideo2 className="size-4" />
                    来源
                </h2>
                <Tag className="!m-0">{video ? "已上传" : "待上传"}</Tag>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
                <section className="border-b p-3">
                    <div className="relative aspect-video overflow-hidden rounded-md border bg-[#111418]">
                        {video ? (
                            <video key={video.url} src={video.url} className="size-full object-contain" controls preload="metadata" aria-label="来源视频" />
                        ) : (
                            <div className="grid size-full place-items-center text-xs text-white/60">等待来源视频</div>
                        )}
                    </div>
                    <div className="mt-2.5 flex min-w-0 items-center justify-between gap-2">
                        <div className="min-w-0">
                            <p className="truncate text-xs font-medium">{video?.originalName || "MP4 / MOV / WebM"}</p>
                            <p className="mt-0.5 text-[11px] text-muted-foreground">{project.durationMs ? `${frameRemakeTime(project.durationMs)} · ${video?.width} × ${video?.height}` : "最大 200 MB"}</p>
                        </div>
                        <UploadControl label={video ? "替换视频" : "上传视频"} accept="video/mp4,video/quicktime,video/webm" disabled={props.disabled} onFile={(file) => void props.onUpload(file, "video")} />
                    </div>
                </section>
                <section className="border-b p-3">
                    <Field label="原文案">
                        <Input.TextArea
                            rows={7}
                            maxLength={20000}
                            value={display.sourceCopy ?? display.groups.map((g) => g.sourceCopy || "").join("")}
                            disabled={props.editingDisabled}
                            placeholder="可粘贴原文案；留空时由视频理解识别真实口播。"
                            onChange={(e) => props.onChange({ sourceCopy: e.target.value })}
                        />
                    </Field>
                    <p className="mt-2 text-[11px] leading-5 text-muted-foreground">按原顺序分配到每 3 个分镜对应的文案区间；无口播时保留空白。</p>
                </section>
                <section className="space-y-4 p-3">
                    <Field label="复刻要求">
                        <Input.TextArea rows={3} value={display.instructions} disabled={props.editingDisabled} maxLength={20000} onChange={(e) => props.onChange({ instructions: e.target.value })} />
                    </Field>
                    <div className="text-xs">
                        <p className="font-medium">视频理解</p>
                        <p className="mt-1 text-muted-foreground">沿用原复刻的 Doubao 视频理解模型</p>
                    </div>
                    <ModelControl props={props} kind="analysis" label="文案与脚本模型" />
                    <Field label="每组最长秒数">
                        <select value={display.maxSegmentSeconds} disabled={props.editingDisabled} className="rounded-md border bg-background p-2" onChange={(e) => props.onChange({ maxSegmentSeconds: Number(e.target.value) })}>
                            {Array.from({ length: 12 }, (_, i) => (
                                <option key={i} value={i + 4}>
                                    {i + 4} 秒
                                </option>
                            ))}
                        </select>
                    </Field>
                    <p className="text-[11px] leading-5 text-muted-foreground">总时长跟随原片，尾组保留实际余量。</p>
                    <div className="space-y-2 border-t pt-3" aria-label="分组分析进度">
                        {project.groups.map((g) => (
                            <section key={g.id} className="space-y-1 rounded border p-2">
                                <p className="text-xs font-medium">
                                    第 {g.number} 组 · {g.startMs / 1000}–{g.endMs / 1000} 秒
                                </p>
                                <p className="text-[11px] text-muted-foreground">
                                    {g.analysis ? "视频分析已保存" : "等待视频理解"} · {g.frames.filter((f) => f.media).length}/{g.frames.length} 帧
                                </p>
                                {g.analysisSteps?.analysis?.error && <p className="text-xs text-destructive">{g.analysisSteps.analysis.error}</p>}
                                <Button size="small" disabled={props.disabled} onClick={() => void props.onOperation("analyze", g.id, "analysis")}>
                                    {g.analysis ? "重新分析本组" : "分析本组"}
                                </Button>
                            </section>
                        ))}
                    </div>
                </section>
            </div>
        </aside>
    );
    return (
        <section className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b px-3 py-2 sm:px-4">
                <div>
                    <p className="text-xs font-medium text-muted-foreground">阶段 01</p>
                    <h1 className="text-sm font-semibold">来源视频理解与 {frames.length || "全部"} 镜头解析</h1>
                </div>
                <div className="flex items-center gap-2">
                    <Tag className="!m-0" color={ready ? "success" : "default"}>
                        {ready ? "分析就绪" : `${project.groups.filter((g) => g.copy).length}/${project.groups.length} 组就绪`}
                    </Tag>
                    {ready ? (
                        <Button size="small" onClick={() => props.onStage("images")}>
                            进入分镜重绘
                        </Button>
                    ) : (
                        <Button size="small" disabled={props.disabled || !project.sourceVideo} onClick={() => void props.onControl("step")}>
                            只执行下一步
                        </Button>
                    )}
                </div>
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-1 min-[1200px]:grid-cols-[300px_minmax(0,1fr)_340px]" data-remake-desktop-grid>
                <div className="hidden min-h-0 border-r min-[1200px]:block">{source}</div>
                <div className="flex min-h-0 min-w-0 flex-col" aria-label="复刻分析工作台">
                    <Tabs
                        activeKey={tab}
                        onChange={(v) => setTab(v as RemakeWorkspaceTab)}
                        className="remake-workspace-tabs min-h-0 flex-1 [&>.ant-tabs-body-holder]:min-h-0 [&>.ant-tabs-body-holder]:flex-1 [&>.ant-tabs-body-holder]:overflow-hidden [&>.ant-tabs-body-holder>.ant-tabs-body]:h-full [&>.ant-tabs-body-holder>.ant-tabs-body>.ant-tabs-content]:h-full [&>.ant-tabs-content-holder]:min-h-0 [&>.ant-tabs-content-holder]:overflow-hidden [&>.ant-tabs-content-holder>.ant-tabs-content]:h-full [&>.ant-tabs-content-holder>.ant-tabs-content>.ant-tabs-tabpane]:h-full [&>.ant-tabs-nav]:!mb-0 [&>.ant-tabs-nav]:shrink-0 [&>.ant-tabs-nav]:px-3"
                        items={[
                            {
                                key: "frames",
                                label: (
                                    <span className="flex items-center gap-1.5">
                                        <Images className="size-3.5" />
                                        抽帧 {frames.filter((f) => f.frameUrl).length}
                                    </span>
                                ),
                                children: <FrameGrid frames={frames} selectedId={frame?.id} onSelect={(id) => select("frame", id)} />,
                            },
                            {
                                key: "analysis",
                                label: (
                                    <span className="flex items-center gap-1.5">
                                        <ScanSearch className="size-3.5" />
                                        分析结果 {frames.filter((f) => f.analysisStatus === "available").length}
                                    </span>
                                ),
                                children: (
                                    <div className="h-full overflow-y-auto">
                                        <div>
                                            <AnalysisRows frames={frames} selectedId={frame?.id} onSelect={(id) => select("frame", id)} />
                                        </div>
                                        {display.groups.map(
                                            (g) =>
                                                g.analysis && (
                                                    <details key={g.id} className="m-3 rounded border p-3">
                                                        <summary className="cursor-pointer text-xs">第 {g.number} 组完整分析与实际提示词</summary>
                                                        <TextOutput title="视频分析" text={g.analysis} name={`${g.id}-analysis`} />
                                                        {g.analysisSteps?.analysis?.prompt && <TextOutput title="实际视频理解提示词" text={g.analysisSteps.analysis.prompt} name={`${g.id}-source-prompt`} />}
                                                    </details>
                                                ),
                                        )}
                                    </div>
                                ),
                            },
                            {
                                key: "copy",
                                label: (
                                    <span className="flex items-center gap-1.5">
                                        <FileText className="size-3.5" />
                                        文案区间 {blocks.length}
                                    </span>
                                ),
                                children: <CopyBlockRows blocks={blocks} selectedId={block?.id} onSelect={(id) => select("copy", id)} />,
                            },
                        ]}
                    />
                </div>
                <div className="hidden min-h-0 border-l min-[1200px]:block">{editor}</div>
            </div>
            <Drawer title="来源视频与原文案" placement="left" size={340} open={props.sourceOpen} onClose={props.onSourceClose} styles={{ wrapper: { maxWidth: "calc(100vw - 20px)" }, body: { padding: 0 } }}>
                {source}
            </Drawer>
            <Drawer title="镜头与文案校对" placement="right" size={360} open={props.editorOpen} onClose={props.onEditorClose} styles={{ wrapper: { maxWidth: "calc(100vw - 20px)" }, body: { padding: 0 } }}>
                {editor}
            </Drawer>
        </section>
    );
}
