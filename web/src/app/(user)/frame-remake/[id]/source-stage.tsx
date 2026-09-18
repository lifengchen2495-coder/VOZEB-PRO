"use client";
import { Button, Drawer, Input, Tabs, Tag } from "antd";
import { useState } from "react";
import { FileText, Images, ScanSearch } from "lucide-react";
import { FrameGrid, AnalysisRows, type RemakeCopyBlockView, type RemakeWorkspaceTab } from "../../remake15/[id]/remake-analysis-board";
import { RemakeUnitEditor } from "../../remake15/[id]/remake-unit-editor";
import { RemakeSourcePanel } from "../../remake15/[id]/remake-source-panel";
import type { RemakeFrame } from "../../remake15/remake-contract";
import { frameRemakeWorkflowReadiness } from "@/lib/frame-remake-steps";
import { frameRemakeIsBasicWorkflow, frameRemakeSourceCopyNeedsReview as transcriptionNeedsReview, type FrameRemakeFrameAnalysis, type FrameRemakeGroup } from "@/lib/frame-remake-contract";
import { frameRemakeMissingPromptFields } from "@/lib/frame-remake-prompt-templates";
import { type WorkflowProps } from "./workflow-controls";
import { TextOutput } from "./outputs";
import { frameRemakeSourceGroupProgress, frameRemakeSourceGroupReady } from "./source-progress";
const emptyDetail: FrameRemakeFrameAnalysis = { subtitle: "", sellingPoint: "", shotType: "", description: "", subjectRatio: "", hasFace: false };
const unverifiedTranscriptionMessage = "转录记录尚未通过校验，请重新转录或人工核对保存";
function transcriptionReviewMessage(group: FrameRemakeGroup) {
    if (group.sourceCopyStep?.error) return "本次转录失败，请重新转录或人工核对保存";
    if (group.sourceCopyStep && !group.sourceCopyStep.completedAt) return "本次转录尚未完成，请重新转录或人工核对保存";
    return unverifiedTranscriptionMessage;
}
export function FrameSourceStage(props: WorkflowProps & { sourceOpen: boolean; editorOpen: boolean; onSourceClose: () => void; onEditorClose: () => void }) {
    const { project, display } = props;
    const basic = frameRemakeIsBasicWorkflow(display),
        missingSource = frameRemakeMissingPromptFields(display).length > 0;
    const isTranscribing = (group: FrameRemakeGroup) => project.operation?.kind === "transcribe" && project.operation.groupId === group.id;
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
    const extractedFrames = frames.filter((f) => f.frameUrl),
        analyzedFrames = frames.filter((f) => f.analysisStatus === "available"),
        visibleFrames = tab === "frames" ? extractedFrames : analyzedFrames;
    const frame = visibleFrames.find((f) => f.id === frameId) || visibleFrames[0],
        block = blocks.find((b) => b.id === blockId) || blocks[0];
    const select = (kind: "frame" | "copy", id: string) => {
        if (props.groupLocked) return;
        props.onGroup(id.split(":")[0]);
        if (kind === "frame") setFrameId(id);
        else setBlockId(id);
    };
    const editor =
        frame?.analysisStatus === "unavailable" ? (
            <p className="p-4 text-xs text-muted-foreground">本镜头已抽帧，等待来源视频分析完成后可校对。</p>
        ) : (
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
            manualGroupCopyDescription="请在“原文案（选填）”标签中逐组转录或填写原文案。完成分镜生图后，在生产内容中执行文案预处理，再生成视频提示词。"
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
                    {video && !ready && <p className="mt-1 text-xs text-muted-foreground">来源视频已保存，按组依次分析和拆帧；每组完成后显示结果。</p>}
                </div>
                <div className="flex items-center gap-2">
                    <Tag className="!m-0" color={ready ? "success" : "default"}>
                        {ready ? "分析就绪" : `${project.groups.filter((g) => frameRemakeSourceGroupReady(g, project)).length}/${project.groups.length} 组就绪`}
                    </Tag>
                    {ready ? (
                        <Button size="small" onClick={() => props.onStage("planning")}>
                            进入十二宫格重绘
                        </Button>
                    ) : null}
                </div>
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-1 min-[1200px]:grid-cols-[300px_minmax(0,1fr)_340px]" data-remake-desktop-grid>
                <div className="hidden min-h-0 border-r min-[1200px]:block">{source}</div>
                <div className="flex min-h-0 min-w-0 flex-col" aria-label="复刻分析工作台">
                    <div className="shrink-0 border-b px-3 py-2" aria-label="来源分析进度">
                        <p className="text-xs tabular-nums">
                            共 {frames.length} 个镜头 · 已分析 {analyzedFrames.length}/{frames.length} · 已抽帧 {extractedFrames.length}/{frames.length}
                        </p>
                        {project.groups.length > 0 && (
                            <ul className="mt-2 flex max-h-44 gap-2 overflow-auto pb-1">
                                {project.groups.map((g) => {
                                    const progress = frameRemakeSourceGroupProgress(project, g);
                                    return (
                                        <li key={g.id} className="w-44 shrink-0 space-y-1 rounded border px-2.5 py-2 text-xs" aria-label={`第 ${g.number} 组处理进度`}>
                                            <div className="flex items-center justify-between gap-2">
                                                <span className="font-medium">第 {g.number} 组</span>
                                                <Tag className="!m-0" color={progress.color}>
                                                    {progress.label}
                                                </Tag>
                                            </div>
                                            <p className="tabular-nums text-muted-foreground">
                                                {g.startMs / 1000}–{g.endMs / 1000} 秒 · {g.frames.length} 镜头
                                            </p>
                                            <p className="tabular-nums text-muted-foreground">
                                                分析 {g.frames.filter((f) => f.detail).length}/{g.frames.length} · 抽帧 {g.frames.filter((f) => f.media?.url).length}/{g.frames.length}
                                            </p>
                                            <p className={`break-words ${progress.color === "error" ? "text-destructive" : "text-muted-foreground"}`}>{progress.detail}</p>
                                            {!isTranscribing(g) && transcriptionNeedsReview(g) && <p role="status" className="break-words text-amber-700">{transcriptionReviewMessage(g)}</p>}
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>
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
                                        抽帧 {extractedFrames.length}/{frames.length}
                                    </span>
                                ),
                                children: extractedFrames.length ? (
                                    <FrameGrid frames={extractedFrames} showAnalysisWarnings={false} queuedThumbnails selectedId={frame?.id} onSelect={(id) => select("frame", id)} />
                                ) : (
                                    <p className="p-4 text-sm text-muted-foreground">{project.groups.length ? "每组先分析视频，再按结果拆帧；完成后会在这里显示画面。" : "上传来源视频后开始分析，结果会逐组显示。"}</p>
                                ),
                            },
                            {
                                key: "analysis",
                                label: (
                                    <span className="flex items-center gap-1.5">
                                        <ScanSearch className="size-3.5" />
                                        分析结果 {analyzedFrames.length}/{frames.length}
                                    </span>
                                ),
                                children: (
                                    <div className="h-full overflow-y-auto">
                                        <div>
                                            {analyzedFrames.length ? (
                                                <AnalysisRows frames={analyzedFrames} selectedId={frame?.id} onSelect={(id) => select("frame", id)} />
                                            ) : (
                                                <p className="p-4 text-sm text-muted-foreground">尚无已完成的分析结果。每组分析完成后会在这里显示，等待状态见上方进度。</p>
                                            )}
                                        </div>
                                        {display.groups.map(
                                            (g) =>
                                                (g.analysis || g.analysisSteps?.analysis?.prompt) && (
                                                    <details key={g.id} className="m-3 rounded border p-3">
                                                        <summary className="cursor-pointer text-xs">第 {g.number} 组完整分析与实际提示词</summary>
                                                        <TextOutput title="视频分析" text={g.analysis} name={`${g.id}-analysis`} />
                                                        {g.sourceAnalysisTiming && <p className="my-2 text-xs text-muted-foreground">模型报告的本组终点为 {g.sourceAnalysisTiming.reportedEndMs / 1000} 秒，拆帧终点已对齐文件实际时长 {g.sourceAnalysisTiming.alignedEndMs / 1000} 秒；原分析正文保留。</p>}
                                                        {g.analysisSteps?.analysis?.rawOutput && <TextOutput title="模型原始分析（未通过校验）" text={g.analysisSteps.analysis.rawOutput} name={`${g.id}-analysis-raw`} />}
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
                                        <p className="text-xs text-muted-foreground">原文案独立于画面分析。可逐组转录视频声音，也可手动填写；完成生图后，在“生产内容”中单独执行飞书文案预处理。</p>
                                        <Button size="small" disabled={props.editingDisabled} onClick={() => props.onChange({ sourceCopy: "不需要人物口播" })}>本项目不需要人物口播</Button>
                                        {display.sourceCopy?.trim() === "不需要人物口播" && (
                                            <div className="space-y-2">
                                                <p role="status" className="text-xs text-muted-foreground">
                                                    当前项目已设置“不需要人物口播”，提取和校对文案仅供查看，不用于生成口播。
                                                </p>
                                                <Button size="small" disabled={props.editingDisabled} onClick={() => props.onChange({ sourceCopy: "" })}>
                                                    恢复使用文案
                                                </Button>
                                            </div>
                                        )}
                                        {display.groups.map((g) => (
                                            <section key={g.id} className="space-y-3 rounded-lg border p-3 text-sm">
                                                <h3 className="font-medium">
                                                    第 {g.number} 组 · {g.startMs / 1000}–{g.endMs / 1000} 秒
                                                </h3>
                                                <div className="flex flex-wrap items-center justify-between gap-2">
                                                    <span role="status" className={`text-xs ${!isTranscribing(g) && transcriptionNeedsReview(g) ? "text-amber-700" : "text-muted-foreground"}`}>{isTranscribing(g) ? "正在转录本组原文案，完成后显示结果" : transcriptionNeedsReview(g) ? transcriptionReviewMessage(g) : g.sourceCopyStatus === "transcribed" ? "已完成语音转录" : g.sourceCopyStatus === "no-audio" ? "原视频无音轨" : g.sourceCopyStatus === "no-speech" ? "语音转录未识别到口播" : g.sourceCopyStatus === "provided" ? g.sourceCopy?.trim() ? "已手动填写原文案" : "已确认本组没有原文案" : g.sourceCopy?.trim() ? "已有原文案" : "尚未转录或填写原文案"}</span>
                                                    {basic && <Button size="small" loading={isTranscribing(g)} disabled={props.disabled || !project.sourceVideo || !g.analysis || missingSource} onClick={() => void props.onOperation("transcribe", g.id)}>{g.sourceCopyStatus ? "重新转录本组" : "转录本组原文案"}</Button>}
                                                </div>
                                                <label className="grid gap-2">
                                                    原文案（可手动填写或校对）
                                                    <Input.TextArea
                                                        aria-label={`第${g.number}组原文案`}
                                                        value={g.sourceCopy || ""}
                                                        rows={5}
                                                        maxLength={30000}
                                                        placeholder="填写本组原视频文案；不需要口播时可在上方设置。"
                                                        disabled={props.editingDisabled}
                                                        onChange={(event) => props.onChange({ group: { id: g.id, sourceCopy: event.target.value } })}
                                                    />
                                                </label>
                                                {!g.sourceCopyStatus && !g.sourceCopy?.trim() && <Button size="small" disabled={props.editingDisabled} onClick={() => props.onChange({ group: { id: g.id, sourceCopy: "" } })}>确认本组没有原文案</Button>}
                                                {!isTranscribing(g) && transcriptionNeedsReview(g) && <Button size="small" disabled={props.editingDisabled} onClick={() => props.onChange({ group: { id: g.id, sourceCopy: g.sourceCopy || "" } })}>已人工核对，保存本组原文案</Button>}
                                                {g.sourceCopy?.trim() && <TextOutput title={isTranscribing(g) ? "已有原文案（转录完成后更新）" : transcriptionNeedsReview(g) ? "原文案结果（待人工核对）" : "本组原文案"} text={g.sourceCopy} name={`${g.id}-source-copy`} />}
                                                {g.sourceCopyStep && (
                                                    <section className="space-y-2 rounded border bg-muted/20 p-3 text-xs" aria-label={`第${g.number}组转录记录`}>
                                                        <h4 className="font-medium">{isTranscribing(g) ? "本次原文案转录（进行中）" : transcriptionNeedsReview(g) ? "转录记录（待核对）" : "最近一次原文案转录"}</h4>
                                                        <p className="break-words text-muted-foreground">
                                                            来源：{g.sourceCopyStep.source === "system-video-transcription" ? "站内模型音视频转文字" : "百炼语音转录"} · 逻辑模型：{g.sourceCopyStep.model || "未记录"} · 实际模型：{g.sourceCopyStep.upstreamModel || "未记录"}
                                                            {g.sourceCopyStep.elapsedMs !== undefined ? ` · 耗时 ${(g.sourceCopyStep.elapsedMs / 1000).toFixed(1)} 秒` : ""}
                                                        </p>
                                                        <p className="text-muted-foreground">
                                                            开始：<time dateTime={g.sourceCopyStep.startedAt}>{new Date(g.sourceCopyStep.startedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</time>
                                                            {g.sourceCopyStep.completedAt && <> · 完成：<time dateTime={g.sourceCopyStep.completedAt}>{new Date(g.sourceCopyStep.completedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</time></>}
                                                        </p>
                                                        {g.sourceCopyStep.error && <p role="alert" className="text-destructive">{g.sourceCopyStep.error}</p>}
                                                        <details>
                                                            <summary className="cursor-pointer">音视频转文字服务适配协议</summary>
                                                            <p className="my-2 leading-5 text-muted-foreground">此处记录提取原文案的服务输入。飞书创作提示词与执行结果在后续“文案预处理”和“视频提示词”中展示。</p>
                                                            <TextOutput title="本次转录输入协议" text={g.sourceCopyStep.prompt || "本次记录未保存输入协议。"} name={`${g.id}-transcription-input`} />
                                                        </details>
                                                    </section>
                                                )}
                                            </section>
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
