"use client";
import { Button, Drawer, Input, Tabs, Tag } from "antd";
import { useState } from "react";
import { FileText, Images, ScanSearch } from "lucide-react";
import { FrameGrid, AnalysisRows, type RemakeCopyBlockView, type RemakeWorkspaceTab } from "../../remake15/[id]/remake-analysis-board";
import { RemakeUnitEditor } from "../../remake15/[id]/remake-unit-editor";
import { RemakeSourcePanel } from "../../remake15/[id]/remake-source-panel";
import type { RemakeFrame } from "../../remake15/remake-contract";
import { frameRemakeWorkflowReadiness } from "@/lib/frame-remake-steps";
import { type FrameRemakeFrameAnalysis } from "@/lib/frame-remake-contract";
import { type WorkflowProps } from "./workflow-controls";
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
            activeTab={tab === "copy" ? "frames" : tab}
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
        <RemakeSourcePanel
            project={{ sourceVideo: video ? { ...video, durationMs: project.durationMs } : undefined, sourceCopy: display.sourceCopy ?? display.groups.map((g) => g.sourceCopy || "").join(""), copy: { optionRaw: "" } }}
            manualGroupCopy
            uploading={props.working && !project.operation}
            uploadProgress={0}
            disabled={props.editingDisabled}
            onUpload={(file) => void props.onUpload(file, "video")}
            onPatch={(patch) => props.onChange({ sourceCopy: patch.sourceCopy })}
        />
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
                        {ready ? "分析就绪" : `${project.groups.filter((g) => g.analysis && g.contactSheet).length}/${project.groups.length} 组就绪`}
                    </Tag>
                    {ready ? (
                        <Button size="small" onClick={() => props.onStage("planning")}>
                            填写产品信息与人物图
                        </Button>
                    ) : null}
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
                                                (g.analysis || g.analysisSteps?.analysis?.prompt) && (
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
                                        原文案（选填）
                                    </span>
                                ),
                                children: (
                                    <div className="h-full space-y-4 overflow-y-auto p-4">
                                        <p className="text-xs text-muted-foreground">文案按原样传入视频提示词步骤。长视频请分别填写每组文案，留空则不指定口播。</p>
                                        {display.groups.map((g) => (
                                            <label key={g.id} className="grid gap-2 text-sm">
                                                第 {g.number} 组 · {g.startMs / 1000}–{g.endMs / 1000} 秒
                                                <Input.TextArea aria-label={`第${g.number}组原文案`} value={g.copy || ""} rows={5} disabled={props.editingDisabled} onChange={(event) => props.onChange({ group: { id: g.id, copy: event.target.value } })} />
                                            </label>
                                        ))}
                                    </div>
                                ),
                            },
                        ]}
                    />
                </div>
                <div className="hidden min-h-0 border-l min-[1200px]:block">{tab === "copy" ? <p className="p-4 text-xs text-muted-foreground">在中间区域填写每组文案，修改会自动保存。</p> : editor}</div>
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
