"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Drawer, Dropdown, Input, Modal, Skeleton, Tag, Tooltip } from "antd";
import { ArrowLeft, Check, CircleAlert, CloudCheck, CloudOff, CloudUpload, FileOutput, Images, LoaderCircle, MoreHorizontal, PanelLeft, RefreshCw, Send, SlidersHorizontal, Video, WandSparkles } from "lucide-react";
import { useParams, useRouter } from "next/navigation";

import { UserStatusActions } from "@/components/layout/user-status-actions";

import { buildRemakeProduction, getRemakeProject, getRemakeTask, handoffRemakeProject, RemakeConflictError, saveRemakeProject, startRemakeAnalysis, uploadRemakeVideo } from "../remake-api";
import { isRemakeNoNarrationCopy, type RemakeCopyBlock, type RemakeEditablePatch, type RemakeFrame, type RemakeMediaAsset, type RemakeModelSelection, type RemakeProject, type RemakeTask, type RemakeVoice } from "../remake-contract";
import { RemakeAnalysisBoard, type RemakeWorkspaceTab } from "./remake-analysis-board";
import { RemakeImageStage, type RemakeGroupPatch } from "./remake-image-stage";
import { RemakeProductionStage } from "./remake-production-stage";
import { remakeImagesReady, remakeProductionReady } from "./remake-production-utils";
import { RemakeSourcePanel } from "./remake-source-panel";
import { RemakeUnitEditor } from "./remake-unit-editor";
import { editRemakeCopyBlock, hasRemakePatch, invalidateRemakeProduction, isRemakeAnalysisActive, mergeEditablePatch, mergeSavedProject, rebaseRemakeConflict, type RemakeWorkspacePatch } from "./remake-workspace-state";

type SaveState = "saved" | "pending" | "saving" | "error" | "conflict";
type ConflictState = { local: RemakeProject; remote: RemakeProject; dirty: RemakeWorkspacePatch };
type RemakeFlowStage = "analysis" | "images" | "production";
type ReferenceKey = "product" | "character" | "characterSupplement" | "background";

const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const SUPPORTED_VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);

export function RemakeWorkspace() {
    const params = useParams<{ id: string }>();
    const projectId = String(params.id || "");
    const router = useRouter();
    const { message } = App.useApp();
    const [project, setProject] = useState<RemakeProject | null>(null);
    const [task, setTask] = useState<RemakeTask | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState("");
    const [saveState, setSaveState] = useState<SaveState>("saved");
    const [conflict, setConflict] = useState<ConflictState | null>(null);
    const [flowStage, setFlowStage] = useState<RemakeFlowStage>("analysis");
    const [activeTab, setActiveTab] = useState<RemakeWorkspaceTab>("frames");
    const [selectedFrameId, setSelectedFrameId] = useState<string>();
    const [selectedBlockId, setSelectedBlockId] = useState<string>();
    const [sourceOpen, setSourceOpen] = useState(false);
    const [editorOpen, setEditorOpen] = useState(false);
    const [desktop, setDesktop] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [analyzing, setAnalyzing] = useState(false);
    const [buildingProduction, setBuildingProduction] = useState(false);
    const [handoffPending, setHandoffPending] = useState(false);
    const [resolvingConflict, setResolvingConflict] = useState(false);

    const projectRef = useRef<RemakeProject | null>(null);
    const pendingPatchRef = useRef<RemakeWorkspacePatch>({});
    const saveTimerRef = useRef<number | undefined>(undefined);
    const savingPromiseRef = useRef<Promise<boolean> | null>(null);
    const flushSaveRef = useRef<(() => Promise<boolean>) | null>(null);
    const conflictRef = useRef<ConflictState | null>(null);
    const uploadControllerRef = useRef<AbortController | null>(null);
    const editingLockedRef = useRef(false);
    const editingLocked = isRemakeAnalysisActive(analyzing, task?.status) || buildingProduction || handoffPending;
    editingLockedRef.current = editingLocked;

    const applyServerProject = useCallback((next: RemakeProject) => {
        projectRef.current = next;
        setProject(next);
        setSelectedFrameId((current) => (current && next.frames.some((frame) => frame.id === current) ? current : next.frames[0]?.id));
        setSelectedBlockId((current) => (current && next.copyBlocks.some((block) => block.id === current) ? current : next.copyBlocks[0]?.id));
    }, []);

    const load = useCallback(async () => {
        setLoading(true);
        setLoadError("");
        try {
            const next = await getRemakeProject(projectId);
            pendingPatchRef.current = {};
            conflictRef.current = null;
            setConflict(null);
            applyServerProject(next);
            setFlowStage(recoveredFlowStage(next));
            setSaveState("saved");
            setTask(recoveredTask(next));
        } catch (reason) {
            setLoadError(reason instanceof Error ? reason.message : "复刻项目加载失败");
        } finally {
            setLoading(false);
        }
    }, [applyServerProject, projectId]);

    useEffect(() => {
        void load();
    }, [load]);

    useEffect(() => {
        const media = window.matchMedia("(min-width: 1200px)");
        const update = () => setDesktop(media.matches);
        update();
        media.addEventListener("change", update);
        return () => media.removeEventListener("change", update);
    }, []);

    useEffect(() => {
        const flushPendingSave = () => {
            if (hasRemakePatch(pendingPatchRef.current)) void flushSaveRef.current?.();
        };
        const handleVisibilityChange = () => {
            if (document.visibilityState === "hidden") flushPendingSave();
        };
        const handleBeforeUnload = (event: BeforeUnloadEvent) => {
            if (!hasRemakePatch(pendingPatchRef.current) && !savingPromiseRef.current && !conflictRef.current) return;
            event.preventDefault();
            event.returnValue = "";
        };
        window.addEventListener("pagehide", flushPendingSave);
        window.addEventListener("popstate", flushPendingSave);
        window.addEventListener("beforeunload", handleBeforeUnload);
        document.addEventListener("visibilitychange", handleVisibilityChange);
        return () => {
            window.removeEventListener("pagehide", flushPendingSave);
            window.removeEventListener("popstate", flushPendingSave);
            window.removeEventListener("beforeunload", handleBeforeUnload);
            document.removeEventListener("visibilitychange", handleVisibilityChange);
            flushPendingSave();
            if (saveTimerRef.current !== undefined) window.clearTimeout(saveTimerRef.current);
            uploadControllerRef.current?.abort();
        };
    }, []);

    const flushSave = useCallback(async (): Promise<boolean> => {
        if (saveTimerRef.current !== undefined) {
            window.clearTimeout(saveTimerRef.current);
            saveTimerRef.current = undefined;
        }
        if (conflictRef.current) return false;
        if (savingPromiseRef.current) {
            const saved = await savingPromiseRef.current;
            return saved && Object.keys(pendingPatchRef.current).length ? (flushSaveRef.current?.() ?? Promise.resolve(true)) : saved;
        }
        const base = projectRef.current;
        const patch = pendingPatchRef.current;
        if (!base || !hasRemakePatch(patch)) return true;
        pendingPatchRef.current = {};
        setSaveState("saving");
        const run = (async () => {
            try {
                const saved = await saveRemakeProject(base.id, base.revision, patch);
                const current = projectRef.current;
                if (current) {
                    applyServerProject(mergeSavedProject(saved, current, pendingPatchRef.current));
                }
                setSaveState(hasRemakePatch(pendingPatchRef.current) ? "pending" : "saved");
                return true;
            } catch (reason) {
                if (reason instanceof RemakeConflictError) {
                    try {
                        const remote = await getRemakeProject(base.id);
                        const dirty = { ...patch, ...pendingPatchRef.current };
                        const state = { local: projectRef.current || base, remote, dirty };
                        conflictRef.current = state;
                        pendingPatchRef.current = {};
                        setConflict(state);
                        setSaveState("conflict");
                    } catch {
                        pendingPatchRef.current = { ...patch, ...pendingPatchRef.current };
                        setSaveState("error");
                    }
                    return false;
                }
                pendingPatchRef.current = { ...patch, ...pendingPatchRef.current };
                setSaveState("error");
                message.error({ key: "remake-save-error", content: reason instanceof Error ? reason.message : "项目保存失败" });
                return false;
            }
        })();
        savingPromiseRef.current = run;
        const saved = await run;
        savingPromiseRef.current = null;
        if (saved && hasRemakePatch(pendingPatchRef.current)) return flushSaveRef.current?.() ?? true;
        return saved;
    }, [applyServerProject, message]);
    flushSaveRef.current = flushSave;

    const queuePatch = useCallback((patch: RemakeWorkspacePatch) => {
        if (editingLockedRef.current) return;
        const current = projectRef.current;
        if (!current) return;
        const next = { ...current, ...patch };
        projectRef.current = next;
        setProject(next);
        pendingPatchRef.current = { ...pendingPatchRef.current, ...patch };
        setSaveState(conflictRef.current ? "conflict" : "pending");
        if (conflictRef.current) return;
        if (saveTimerRef.current !== undefined) window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = window.setTimeout(() => void flushSaveRef.current?.(), 700);
    }, []);

    useEffect(() => {
        if (!task?.id) return;
        const controller = new AbortController();
        let timer: number | undefined;
        let active = true;
        const poll = async () => {
            try {
                const next = await getRemakeTask(task.id, controller.signal);
                if (!active) return;
                if (next.status === "success" || next.status === "error") {
                    const refreshed = await getRemakeProject(projectId);
                    if (!active) return;
                    const pending = pendingPatchRef.current;
                    applyServerProject(mergeEditablePatch(refreshed, pending));
                    setSaveState(hasRemakePatch(pending) ? "pending" : "saved");
                    setTask(next);
                    if (hasRemakePatch(pending)) window.setTimeout(() => void flushSaveRef.current?.(), 0);
                    if (next.status === "success") message.success("视频分析已完成");
                    return;
                }
                setTask(next);
                timer = window.setTimeout(poll, 2000);
            } catch (reason) {
                if (controller.signal.aborted || !active) return;
                timer = window.setTimeout(poll, 3000);
                if (reason instanceof Error && /不存在|not found/i.test(reason.message)) setTask((current) => (current ? { ...current, status: "error", error: reason.message } : current));
            }
        };
        void poll();
        return () => {
            active = false;
            controller.abort();
            if (timer !== undefined) window.clearTimeout(timer);
        };
    }, [applyServerProject, message, projectId, task?.id]);

    const selectedFrame = useMemo(() => project?.frames.find((frame) => frame.id === selectedFrameId), [project?.frames, selectedFrameId]);
    const selectedBlock = useMemo(() => project?.copyBlocks.find((block) => block.id === selectedBlockId), [project?.copyBlocks, selectedBlockId]);

    const updateSource = useCallback(
        (patch: RemakeEditablePatch) => {
            const current = projectRef.current;
            if (!current || patch.sourceCopy === undefined || patch.sourceCopy === current.sourceCopy) return;
            queuePatch(invalidateRemakeProduction(current, { ...patch, copyBlocks: [] }));
        },
        [queuePatch],
    );

    const updateFrame = useCallback(
        (patch: Partial<RemakeFrame>) => {
            const current = projectRef.current;
            if (!current || !selectedFrameId) return;
            queuePatch(
                invalidateRemakeProduction(current, {
                    frames: current.frames.map((frame) => (frame.id === selectedFrameId ? { ...frame, ...patch } : frame)),
                }),
            );
        },
        [queuePatch, selectedFrameId],
    );

    const updateBlock = useCallback(
        (patch: Partial<RemakeCopyBlock>) => {
            const current = projectRef.current;
            if (!current || !selectedBlockId) return;
            queuePatch(editRemakeCopyBlock(current, selectedBlockId, patch));
        },
        [queuePatch, selectedBlockId],
    );

    const updateReference = useCallback(
        (key: ReferenceKey, asset?: RemakeMediaAsset) => {
            const current = projectRef.current;
            if (!current) return;
            const references = { ...current.references, [key]: asset };
            const groups = current.groups.map((group) => ({
                ...group,
                replacementGeneration: { status: "idle" as const, taskId: null, model: null, prompt: "", result: null, error: null },
                imageGeneration: { status: "idle" as const, taskId: null, model: null, prompt: "", result: null, error: null },
                videoPrompt: "",
                videoGeneration: { status: "idle" as const, taskId: null, model: null, result: null, error: null },
            }));
            queuePatch({ references, groups });
        },
        [queuePatch],
    );

    const updateGroup = useCallback(
        (groupId: string, patch: RemakeGroupPatch) => {
            const current = projectRef.current;
            if (!current) return;
            const groups = current.groups.map((group) =>
                group.id === groupId
                    ? {
                          ...group,
                          ...patch,
                          replacementGeneration: patch.replacementGeneration ? { ...group.replacementGeneration, ...patch.replacementGeneration } : group.replacementGeneration,
                          imageGeneration: patch.imageGeneration ? { ...group.imageGeneration, ...patch.imageGeneration } : group.imageGeneration,
                          videoGeneration: patch.videoGeneration ? { ...group.videoGeneration, ...patch.videoGeneration } : group.videoGeneration,
                      }
                    : group,
            );
            queuePatch({ groups });
        },
        [queuePatch],
    );

    const updateVoice = useCallback(
        (voice: RemakeVoice) => {
            const current = projectRef.current;
            if (!current || current.voice === voice) return;
            queuePatch({ voice, groups: current.groups.map((group) => ({ ...group, videoPrompt: "", videoGeneration: { status: "idle" as const } })) });
        },
        [queuePatch],
    );

    const updateModelSelection = useCallback(
        (key: keyof RemakeModelSelection, model: string) => {
            const current = projectRef.current;
            if (!current || current.modelSelection[key] === model) return;
            const modelSelection = { ...current.modelSelection, [key]: model };
            const groups = current.groups.map((group) => {
                if (key === "image") {
                    return {
                        ...group,
                        replacementGeneration: { status: "idle" as const, prompt: "" },
                        imageGeneration: { status: "idle" as const, prompt: "" },
                        videoPrompt: "",
                        videoGeneration: { status: "idle" as const },
                    };
                }
                if (key === "prompt") return { ...group, videoPrompt: "", videoGeneration: { status: "idle" as const } };
                return { ...group, videoGeneration: { status: "idle" as const } };
            });
            queuePatch({ modelSelection, groups });
        },
        [queuePatch],
    );

    const upload = async (file: File) => {
        if (editingLockedRef.current) return message.warning("分析期间不能替换来源视频");
        if (!SUPPORTED_VIDEO_TYPES.has(file.type)) return message.warning("仅支持 MP4、MOV 或 WebM 视频");
        if (file.size > MAX_VIDEO_BYTES) return message.warning("来源视频不能超过 200 MiB");
        uploadControllerRef.current?.abort();
        const controller = new AbortController();
        uploadControllerRef.current = controller;
        setUploading(true);
        setUploadProgress(0);
        try {
            const sourceVideo = await uploadRemakeVideo(projectId, file, setUploadProgress, controller.signal);
            queuePatch({ sourceVideo });
            const saved = await flushSaveRef.current?.();
            if (saved) message.success("来源视频已上传并保存");
        } catch (reason) {
            if (!(reason instanceof DOMException && reason.name === "AbortError")) message.error(reason instanceof Error ? reason.message : "视频上传失败");
        } finally {
            if (uploadControllerRef.current === controller) uploadControllerRef.current = null;
            setUploading(false);
        }
    };

    const analyze = async (retry = false) => {
        const current = projectRef.current;
        if (!current?.sourceVideo?.url) return message.warning("请先上传来源视频");
        editingLockedRef.current = true;
        setAnalyzing(true);
        try {
            if (!(await flushSave())) return message.warning("请先处理保存冲突，再启动分析");
            const result = await startRemakeAnalysis(projectId, retry);
            applyServerProject(result.project);
            setTask(result.task);
            message.success(retry ? "分析任务已重新创建" : "分析任务已启动");
        } catch (reason) {
            message.error(reason instanceof Error ? reason.message : "分析任务创建失败");
        } finally {
            setAnalyzing(false);
        }
    };

    const buildProductionContent = async () => {
        setBuildingProduction(true);
        let productionBase: RemakeProject | null = null;
        try {
            if (!(await flushSave())) return message.warning("请先处理保存冲突，再生成生产内容");
            const current = projectRef.current;
            if (!current) return;
            productionBase = current;
            const next = await buildRemakeProduction(projectId, current.revision);
            pendingPatchRef.current = {};
            applyServerProject(next);
            setSaveState("saved");
            message.success("文案报告和 4 条 Seedance 提示词已生成");
        } catch (reason) {
            if (reason instanceof RemakeConflictError && productionBase) {
                try {
                    const remote = await getRemakeProject(projectId);
                    const local = projectRef.current || productionBase;
                    const rebased = rebaseRemakeConflict(pendingPatchRef.current, local, remote);
                    const dirty = rebased.dirty;
                    pendingPatchRef.current = dirty;
                    applyServerProject(rebased.project);
                    setTask(recoveredTask(remote));
                    setSaveState(hasRemakePatch(dirty) ? "pending" : "saved");
                    if (hasRemakePatch(dirty)) saveTimerRef.current = window.setTimeout(() => void flushSaveRef.current?.(), 0);
                    message.warning("项目版本已刷新并合并未保存内容，请确认后重新生成生产内容");
                    return;
                } catch (refreshReason) {
                    message.error(refreshReason instanceof Error ? refreshReason.message : "项目最新版本加载失败");
                    return;
                }
            }
            message.error(reason instanceof Error ? reason.message : "生产内容生成失败");
        } finally {
            setBuildingProduction(false);
        }
    };

    const handoff = async () => {
        setHandoffPending(true);
        try {
            if (!(await flushSave())) return message.warning("请先处理保存冲突，再交接短剧");
            const result = await handoffRemakeProject(projectId);
            message.success("已交接到短剧项目");
            router.push(result.href);
        } catch (reason) {
            message.error(reason instanceof Error ? reason.message : "短剧交接失败");
        } finally {
            setHandoffPending(false);
        }
    };

    const leaveWorkspace = async () => {
        if (!(await flushSave())) return message.warning("请先处理未保存内容，再离开工作区");
        router.push("/remake");
    };

    const acceptRemoteVersion = async () => {
        const currentConflict = conflictRef.current;
        if (!currentConflict) return;
        setResolvingConflict(true);
        try {
            const remote = await getRemakeProject(projectId);
            pendingPatchRef.current = {};
            conflictRef.current = null;
            applyServerProject(remote);
            setTask(recoveredTask(remote));
            setConflict(null);
            setSaveState("saved");
            message.success("已载入最新服务器版本");
        } catch (reason) {
            message.error(reason instanceof Error ? reason.message : "服务器版本加载失败");
        } finally {
            setResolvingConflict(false);
        }
    };

    const retryLocalVersion = async () => {
        const currentConflict = conflictRef.current;
        if (!currentConflict) return;
        setResolvingConflict(true);
        try {
            const remote = await getRemakeProject(projectId);
            const rebased = rebaseRemakeConflict(currentConflict.dirty, currentConflict.local, remote);
            const dirty = rebased.dirty;
            const discardedVersionedChanges = hasRemakePatch(currentConflict.dirty) && Object.keys(dirty).length !== Object.keys(currentConflict.dirty).length;
            pendingPatchRef.current = dirty;
            conflictRef.current = null;
            applyServerProject(rebased.project);
            const remoteTask = recoveredTask(remote);
            setTask(remoteTask);
            setConflict(null);
            if (!hasRemakePatch(dirty)) {
                setSaveState("saved");
            } else if (remoteTask) {
                setSaveState("pending");
            } else {
                setSaveState("pending");
                saveTimerRef.current = window.setTimeout(() => void flushSaveRef.current?.(), 0);
            }
            if (discardedVersionedChanges) message.warning("服务器分析、来源或参考图版本已变化，已保留安全字段并放弃旧版本产物");
        } catch (reason) {
            message.error(reason instanceof Error ? reason.message : "本地版本重试失败");
        } finally {
            setResolvingConflict(false);
        }
    };

    if (loading) return <WorkspaceLoading />;
    if (!project || loadError) return <WorkspaceError message={loadError || "复刻项目不存在"} onBack={() => router.push("/remake")} onRetry={() => void load()} />;

    const sourcePanel = <RemakeSourcePanel project={project} uploading={uploading} uploadProgress={uploadProgress} disabled={editingLocked} onUpload={(file) => void upload(file)} onPatch={updateSource} />;
    const editorPanel = <RemakeUnitEditor activeTab={activeTab} copyStrategy={project.copyStrategy} frame={selectedFrame} block={selectedBlock} disabled={editingLocked} onUpdateFrame={updateFrame} onUpdateBlock={updateBlock} />;
    const board = (
        <RemakeAnalysisBoard
            project={project}
            task={task}
            activeTab={activeTab}
            selectedFrameId={selectedFrameId}
            selectedBlockId={selectedBlockId}
            onTabChange={setActiveTab}
            onSelectFrame={setSelectedFrameId}
            onSelectBlock={setSelectedBlockId}
            onRetry={() => void analyze(true)}
        />
    );
    const analysisActive = editingLocked;
    const analysisLabel = project.analysis.status === "error" ? "重试分析" : project.analysis.status === "completed" ? "重新分析" : "开始分析";
    const noNarration = isRemakeNoNarrationCopy(project.sourceCopy);
    const analysisReady =
        project.analysis.status === "completed" &&
        project.analysis.mode === "video" &&
        project.frames.length === 48 &&
        project.frames.every((frame) => frame.analysisStatus === "available") &&
        project.copyBlocks.length === 16 &&
        project.copy.status === "completed" &&
        project.copy.checks.sequential &&
        project.copy.checks.noDuplicates &&
        project.copy.checks.noSkips &&
        project.copyBlocks.every((block) => (noNarration ? !block.sourceText.trim() && !block.text.trim() : Boolean(block.sourceText.trim() && block.text.trim()))) &&
        (noNarration || Boolean(project.references.audio?.url)) &&
        project.groups.every((group) => group.sourceContactSheet?.url);
    const imagesReady = remakeImagesReady(project);
    const productionReady = remakeProductionReady(project);
    const changeFlowStage = (next: RemakeFlowStage) => {
        setFlowStage(next);
        setSourceOpen(false);
        setEditorOpen(false);
    };

    return (
        <main className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground" data-remake-workspace aria-label="电商视频复刻工作区">
            <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-2 sm:px-3">
                <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
                    <Tooltip title="返回复刻项目">
                        <Button type="text" shape="circle" className="!size-9 !min-w-9" icon={<ArrowLeft className="size-4" />} onClick={() => void leaveWorkspace()} aria-label="返回复刻项目" />
                    </Tooltip>
                    <Input
                        variant="borderless"
                        className="!w-[min(38vw,320px)] !px-1 !text-sm !font-semibold sm:!text-base"
                        maxLength={80}
                        value={project.title}
                        disabled={editingLocked}
                        onChange={(event) => queuePatch({ title: event.target.value })}
                        aria-label="项目名称"
                    />
                    <SaveIndicator state={saveState} onRetry={() => void flushSave()} />
                </div>

                <div className="flex min-w-0 shrink-0 items-center gap-1 sm:gap-1.5">
                    {!desktop && flowStage === "analysis" ? (
                        <>
                            <Tooltip title="来源视频与原文案">
                                <Button type="text" shape="circle" className="!size-9 !min-w-9" icon={<PanelLeft className="size-4" />} onClick={() => setSourceOpen(true)} aria-label="打开来源视频与原文案" />
                            </Tooltip>
                            <Tooltip title="镜头校对">
                                <Button type="text" shape="circle" className="!size-9 !min-w-9" icon={<SlidersHorizontal className="size-4" />} onClick={() => setEditorOpen(true)} aria-label="打开当前单元编辑器" />
                            </Tooltip>
                        </>
                    ) : null}
                    {flowStage === "analysis" ? (
                        <Button type="primary" className="!h-9 !px-2.5 sm:!px-3" loading={analysisActive} icon={<WandSparkles className="size-4" />} onClick={() => void analyze(project.analysis.status === "error")} aria-label={analysisLabel}>
                            <span className="hidden sm:inline">{analysisLabel}</span>
                        </Button>
                    ) : null}
                    <Dropdown
                        trigger={["click"]}
                        menu={{
                            items: [{ key: "handoff", icon: <Send className="size-4" />, label: handoffPending ? "正在交接短剧" : "兼容交接到短剧", disabled: !productionReady || handoffPending }],
                            onClick: ({ key }) => {
                                if (key === "handoff") void handoff();
                            },
                        }}
                    >
                        <Button type="text" shape="circle" className="!size-9 !min-w-9" icon={<MoreHorizontal className="size-4" />} aria-label="更多操作" />
                    </Dropdown>
                    <div className="hidden lg:block">
                        <UserStatusActions />
                    </div>
                </div>
            </header>

            <RemakeFlowNavigation stage={flowStage} analysisReady={analysisReady} imagesReady={imagesReady} productionReady={productionReady} onChange={changeFlowStage} />

            <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
                {flowStage === "analysis" ? (
                    <div className="flex h-full min-h-0 min-w-0 flex-col">
                        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-3 py-2 sm:px-4">
                            <div className="min-w-0">
                                <div className="text-xs font-medium text-muted-foreground">阶段 01</div>
                                <div className="truncate text-sm font-semibold">来源视频理解与 48 镜头解析</div>
                            </div>
                            <Tag color={analysisReady ? "success" : analysisActive ? "processing" : "default"} className="!m-0">
                                {analysisReady ? "分析就绪" : analysisActive ? "分析中" : "等待完成"}
                            </Tag>
                        </div>
                        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
                            {desktop ? (
                                <div className="grid h-full min-h-0 min-w-0 grid-cols-[300px_minmax(0,1fr)_340px]" data-remake-desktop-grid>
                                    <div className="min-h-0 border-r border-border">{sourcePanel}</div>
                                    <div className="min-h-0 min-w-0">{board}</div>
                                    <div className="min-h-0 border-l border-border">{editorPanel}</div>
                                </div>
                            ) : (
                                <>
                                    <div className="h-full min-h-0 min-w-0">{board}</div>
                                    <Drawer title="来源视频与原文案" placement="left" size={340} open={sourceOpen} destroyOnHidden={false} onClose={() => setSourceOpen(false)} styles={{ wrapper: { maxWidth: "calc(100vw - 20px)" }, body: { padding: 0 } }}>
                                        {sourcePanel}
                                    </Drawer>
                                    <Drawer title="镜头与文案校对" placement="right" size={360} open={editorOpen} destroyOnHidden={false} onClose={() => setEditorOpen(false)} styles={{ wrapper: { maxWidth: "calc(100vw - 20px)" }, body: { padding: 0 } }}>
                                        {editorPanel}
                                    </Drawer>
                                </>
                            )}
                        </div>
                    </div>
                ) : null}

                {flowStage === "images" ? (
                    <RemakeImageStage
                        project={project}
                        disabled={editingLocked}
                        onReferenceChange={updateReference}
                        onModelChange={(model) => updateModelSelection("image", model)}
                        onGroupChange={updateGroup}
                        onFlush={flushSave}
                        onContinue={() => changeFlowStage("production")}
                    />
                ) : null}

                {flowStage === "production" ? (
                    <RemakeProductionStage
                        project={project}
                        building={buildingProduction}
                        onVoiceChange={updateVoice}
                        onPromptModelChange={(model) => updateModelSelection("prompt", model)}
                        onVideoModelChange={(model) => updateModelSelection("video", model)}
                        onGroupChange={updateGroup}
                        onFlush={flushSave}
                        onBuild={() => void buildProductionContent()}
                    />
                ) : null}
            </div>

            <Modal
                title="项目已在其他页面更新"
                open={Boolean(conflict)}
                closable={false}
                mask={{ closable: false }}
                keyboard={false}
                okText="保留本地并重试"
                cancelText="使用服务器版本"
                confirmLoading={resolvingConflict}
                cancelButtonProps={{ disabled: resolvingConflict }}
                onOk={() => void retryLocalVersion()}
                onCancel={() => void acceptRemoteVersion()}
            >
                <p className="text-sm leading-6 text-muted-foreground">服务器 Revision {conflict?.remote.revision ?? 0} 比当前编辑版本更新。请选择保留本地编辑并基于新版本重试，或放弃本地未保存内容。</p>
            </Modal>
        </main>
    );
}

function RemakeFlowNavigation({ stage, analysisReady, imagesReady, productionReady, onChange }: { stage: RemakeFlowStage; analysisReady: boolean; imagesReady: boolean; productionReady: boolean; onChange: (stage: RemakeFlowStage) => void }) {
    const steps: Array<{ key: RemakeFlowStage; label: string; icon: React.ReactNode; completed: boolean }> = [
        { key: "analysis", label: "来源分析", icon: <Video className="size-4" />, completed: analysisReady },
        { key: "images", label: "十二宫格重绘", icon: <Images className="size-4" />, completed: imagesReady },
        { key: "production", label: "生产内容", icon: <FileOutput className="size-4" />, completed: productionReady },
    ];
    return (
        <nav className="flex h-12 shrink-0 items-stretch overflow-x-auto border-b border-border bg-card px-1 sm:justify-center sm:px-3" aria-label="飞书复刻流程">
            {steps.map((step, index) => {
                const active = step.key === stage;
                return (
                    <button
                        key={step.key}
                        type="button"
                        className={`relative flex min-w-[132px] items-center justify-center gap-2 border-b-2 px-3 text-xs font-medium transition sm:min-w-[184px] ${active ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:bg-muted/30 hover:text-foreground"}`}
                        aria-current={active ? "step" : undefined}
                        onClick={() => onChange(step.key)}
                    >
                        <span
                            className={`grid size-6 shrink-0 place-items-center rounded-full border ${step.completed ? "border-emerald-600 bg-emerald-600 text-white" : active ? "border-foreground bg-foreground text-background" : "border-border bg-background"}`}
                        >
                            {step.completed ? <Check className="size-3.5" /> : <span className="text-[11px] tabular-nums">{index + 1}</span>}
                        </span>
                        {step.icon}
                        <span className="whitespace-nowrap">{step.label}</span>
                    </button>
                );
            })}
        </nav>
    );
}

function recoveredFlowStage(project: RemakeProject): RemakeFlowStage {
    if (project.pipeline.stage === "copy" || project.pipeline.stage === "prompts" || project.pipeline.stage === "prompts-ready" || project.pipeline.stage === "ready" || remakeImagesReady(project)) return "production";
    if (project.pipeline.stage === "references" || project.pipeline.stage === "images" || project.analysis.status === "completed") return "images";
    return "analysis";
}

function recoveredTask(project: RemakeProject): RemakeTask | null {
    const taskId = project.analysis.taskId;
    if (!taskId || (project.analysis.status !== "queued" && project.analysis.status !== "running")) return null;
    return {
        id: taskId,
        projectId: project.id,
        status: project.analysis.status === "running" ? "running" : "pending",
        progress: 0,
        stage: "恢复分析任务",
        createdAt: "",
        updatedAt: "",
    };
}

function SaveIndicator({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
    const content =
        state === "saving" ? (
            <LoaderCircle className="size-3.5 animate-spin" />
        ) : state === "pending" ? (
            <CloudUpload className="size-3.5" />
        ) : state === "error" ? (
            <CloudOff className="size-3.5" />
        ) : state === "conflict" ? (
            <CircleAlert className="size-3.5" />
        ) : (
            <CloudCheck className="size-3.5" />
        );
    const label = state === "saving" ? "保存中" : state === "pending" ? "待保存" : state === "error" ? "保存失败" : state === "conflict" ? "版本冲突" : "已保存";
    if (state === "error") {
        return (
            <button type="button" className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-rose-600 transition hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-950/30" onClick={onRetry} title="重试保存">
                {content}
                <span className="hidden sm:inline">{label}</span>
                <RefreshCw className="size-3" />
            </button>
        );
    }
    return (
        <span className={`inline-flex h-7 shrink-0 items-center gap-1 px-1 text-[11px] ${state === "conflict" ? "text-amber-600 dark:text-amber-300" : "text-muted-foreground"}`} title={label}>
            {content}
            <span className="hidden sm:inline">{label}</span>
        </span>
    );
}

function WorkspaceLoading() {
    return (
        <main className="flex h-full min-h-0 flex-col bg-background">
            <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-3">
                <Skeleton.Button active size="small" shape="circle" />
                <Skeleton.Input active size="small" />
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-1 min-[1200px]:grid-cols-[300px_minmax(0,1fr)_340px]">
                {Array.from({ length: 3 }, (_, index) => (
                    <div key={index} className="border-r border-border p-4 last:border-r-0">
                        <Skeleton active paragraph={{ rows: 8 }} />
                    </div>
                ))}
            </div>
        </main>
    );
}

function WorkspaceError({ message: detail, onBack, onRetry }: { message: string; onBack: () => void; onRetry: () => void }) {
    return (
        <main className="grid h-full place-items-center bg-background px-4 text-center">
            <div className="max-w-md">
                <CircleAlert className="mx-auto size-7 text-rose-500" />
                <h1 className="mt-3 text-base font-semibold">复刻项目无法打开</h1>
                <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{detail}</p>
                <div className="mt-4 flex justify-center gap-2">
                    <Button onClick={onBack}>返回项目列表</Button>
                    <Button type="primary" icon={<RefreshCw className="size-4" />} onClick={onRetry}>
                        重新加载
                    </Button>
                </div>
            </div>
        </main>
    );
}
