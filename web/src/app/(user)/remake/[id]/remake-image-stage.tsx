"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Image, Input, Progress, Tag, Tooltip } from "antd";
import { Check, Copy, ImagePlus, Images, LoaderCircle, Play, RefreshCw, Trash2, Upload } from "lucide-react";

import { imagePreviewUrl } from "@/lib/media-image-url";
import { createImageGenerationTask, isImageGenerationTaskDeferredError, waitForImageGenerationTask } from "@/services/api/image";
import { uploadImage, type UploadedImage } from "@/services/image-storage";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";

import type { RemakeMediaAsset, RemakeProject, RemakeRangeGroup, RemakeReferenceAssets } from "../remake-contract";
import { buildRemakeImagePrompt, imageGenerationResultAsset, remakeGroupReferenceImages, remakeImagesReady, remakeReferencesReady } from "./remake-production-utils";
import { isRemakeImageInputCurrent, isRemakeImageTaskCurrent, remakeGroupInputVersion, remakeImageClientRequestId, remakeImageCreationFailureDisposition, remakeImageGenerationSlotId, type RemakeImageTaskSnapshot } from "./remake-workspace-state";

type ReferenceKey = "character" | "background";
export type RemakeGroupPatch = {
    imageGeneration?: Partial<RemakeRangeGroup["imageGeneration"]>;
    videoPrompt?: string;
};

const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const REFERENCE_SLOTS: Array<{ key: ReferenceKey; label: string; detail: string }> = [
    { key: "character", label: "人物图（可选）", detail: "仅参考外貌和服装款式" },
    { key: "background", label: "背景图", detail: "四组镜头统一的新环境" },
];

export function RemakeImageStage({
    project,
    disabled,
    onReferenceChange,
    onGroupChange,
    onFlush,
    onContinue,
}: {
    project: RemakeProject;
    disabled: boolean;
    onReferenceChange: (key: ReferenceKey, asset?: RemakeMediaAsset) => void;
    onGroupChange: (groupId: string, patch: RemakeGroupPatch) => void;
    onFlush: () => Promise<boolean>;
    onContinue: () => void;
}) {
    const { message } = App.useApp();
    const config = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const latestProjectRef = useRef(project);
    latestProjectRef.current = project;
    const inputRefs = useRef<Partial<Record<ReferenceKey, HTMLInputElement | null>>>({});
    const activeTasksRef = useRef(new Map<string, { controller: AbortController; snapshot: RemakeImageTaskSnapshot }>());
    const creationControllersRef = useRef(new Map<string, AbortController>());
    const resumeTimersRef = useRef(new Set<number>());
    const startingGroupsRef = useRef(new Set<string>());
    const uploadingKeyRef = useRef<ReferenceKey | undefined>(undefined);
    const [uploadingKey, setUploadingKey] = useState<ReferenceKey>();
    const [batchStarting, setBatchStarting] = useState(false);
    const [resumeNonce, setResumeNonce] = useState(0);

    const imageConfig = useMemo(() => ({ ...config, model: config.imageModel || config.model, imageModel: config.imageModel || config.model, size: "9:16", count: "1" }), [config]);

    const emitGroupChange = useCallback(
        (groupId: string, patch: RemakeGroupPatch) => {
            const current = latestProjectRef.current;
            latestProjectRef.current = {
                ...current,
                groups: current.groups.map((group) =>
                    group.id === groupId
                        ? {
                              ...group,
                              ...patch,
                              imageGeneration: patch.imageGeneration ? { ...group.imageGeneration, ...patch.imageGeneration } : group.imageGeneration,
                          }
                        : group,
                ),
            };
            onGroupChange(groupId, patch);
        },
        [onGroupChange],
    );

    const emitReferenceChange = useCallback(
        (key: ReferenceKey, asset?: RemakeMediaAsset) => {
            const current = latestProjectRef.current;
            latestProjectRef.current = { ...current, references: { ...current.references, [key]: asset } };
            onReferenceChange(key, asset);
        },
        [onReferenceChange],
    );

    const scheduleResume = useCallback(() => {
        const timer = window.setTimeout(() => {
            resumeTimersRef.current.delete(timer);
            setResumeNonce((current) => current + 1);
        }, 2500);
        resumeTimersRef.current.add(timer);
    }, []);

    const waitForGroupTask = useCallback(
        async (groupId: string, taskId: string, prompt: string, inputVersion: string, announce = false) => {
            const snapshot = { groupId, slotId: remakeImageGenerationSlotId(groupId), taskId, inputVersion };
            if (!isRemakeImageTaskCurrent(latestProjectRef.current, snapshot)) return;
            const existing = activeTasksRef.current.get(taskId);
            if (existing) {
                if (existing.snapshot.groupId === snapshot.groupId && existing.snapshot.slotId === snapshot.slotId && existing.snapshot.inputVersion === snapshot.inputVersion) return;
                existing.controller.abort();
                activeTasksRef.current.delete(taskId);
            }
            const controller = new AbortController();
            activeTasksRef.current.set(taskId, { controller, snapshot });
            try {
                const currentProject = latestProjectRef.current;
                const result = await waitForImageGenerationTask(imageConfig, { id: taskId, kind: "generation", model: imageConfig.model }, { signal: controller.signal, logSource: "image-workbench", projectId: currentProject.id });
                if (!isRemakeImageTaskCurrent(latestProjectRef.current, snapshot)) return;
                let asset = imageGenerationResultAsset(result);
                if (!asset && result.dataUrl) asset = uploadedAsset(await uploadImage(result.dataUrl), `remake-${groupId}.png`);
                if (!isRemakeImageTaskCurrent(latestProjectRef.current, snapshot)) return;
                if (!asset) throw new Error("图片任务完成，但没有返回可长期保存的图片地址");
                emitGroupChange(groupId, { imageGeneration: { status: "completed", taskId, prompt, result: asset, error: null } });
                await onFlush();
                if (announce) message.success(`分镜 ${groupId} 十二宫格已生成`);
            } catch (reason) {
                if (controller.signal.aborted) return;
                if (!isRemakeImageTaskCurrent(latestProjectRef.current, snapshot)) return;
                const detail = reason instanceof Error ? reason.message : "十二宫格生成失败";
                if (isImageGenerationTaskDeferredError(reason)) {
                    message.info(`分镜 ${groupId}：${detail}`);
                    scheduleResume();
                    return;
                }
                emitGroupChange(groupId, { imageGeneration: { status: "error", taskId, prompt, error: detail } });
                await onFlush();
                message.error(`分镜 ${groupId}：${detail}`);
            } finally {
                if (activeTasksRef.current.get(taskId)?.controller === controller) activeTasksRef.current.delete(taskId);
            }
        },
        [emitGroupChange, imageConfig, message, onFlush, scheduleResume],
    );

    useEffect(
        () => () => {
            for (const task of activeTasksRef.current.values()) task.controller.abort();
            for (const controller of creationControllersRef.current.values()) controller.abort();
            for (const timer of resumeTimersRef.current) window.clearTimeout(timer);
            activeTasksRef.current.clear();
            creationControllersRef.current.clear();
            resumeTimersRef.current.clear();
            startingGroupsRef.current.clear();
        },
        [],
    );

    const uploadReference = async (key: ReferenceKey, file?: File) => {
        if (!file) return;
        if (startingGroupsRef.current.size || latestProjectRef.current.groups.some(activeGeneration)) return message.warning("十二宫格任务运行期间不能替换参考图");
        if (uploadingKeyRef.current) return message.warning("请等待当前参考图上传完成");
        if (!file.type.startsWith("image/")) return message.warning("参考素材必须是图片文件");
        if (file.size > MAX_REFERENCE_BYTES) return message.warning("单张参考图不能超过 20 MiB");
        uploadingKeyRef.current = key;
        setUploadingKey(key);
        try {
            const stored = await uploadImage(file);
            emitReferenceChange(key, uploadedAsset(stored, file.name));
            await onFlush();
            message.success(`${REFERENCE_SLOTS.find((slot) => slot.key === key)?.label || "参考图"}已上传`);
        } catch (reason) {
            message.error(reason instanceof Error ? reason.message : "参考图上传失败");
        } finally {
            if (uploadingKeyRef.current === key) uploadingKeyRef.current = undefined;
            setUploadingKey(undefined);
            const input = inputRefs.current[key];
            if (input) input.value = "";
        }
    };

    const startGroup = useCallback(
        async (group: RemakeRangeGroup) => {
            const current = latestProjectRef.current;
            const latestGroup = current.groups.find((item) => item.id === group.id) || group;
            const awaitingCreation = (latestGroup.imageGeneration.status === "queued" || latestGroup.imageGeneration.status === "running") && !latestGroup.imageGeneration.taskId;
            if ((activeGeneration(latestGroup) && !awaitingCreation) || startingGroupsRef.current.has(latestGroup.id)) return;
            if (uploadingKeyRef.current) {
                message.warning("请等待参考图上传完成后再生成十二宫格");
                return;
            }
            if (!remakeReferencesReady(current)) {
                message.warning("请先上传背景图");
                return;
            }
            if (!latestGroup.sourceContactSheet?.url) {
                message.warning(`分镜 ${latestGroup.id} 缺少来源十二宫格，请重新执行视频分析`);
                return;
            }
            if (!imageConfig.model || !isAiConfigReady(imageConfig, imageConfig.model)) {
                openConfigDialog(true);
                message.warning("请先配置可用的默认生图模型");
                return;
            }
            const prompt = buildRemakeImagePrompt(latestGroup, current.references);
            const inputVersion = remakeGroupInputVersion(latestGroup, current.references);
            const clientRequestId = remakeImageClientRequestId(current.id, latestGroup, current.references);
            const controller = new AbortController();
            startingGroupsRef.current.add(latestGroup.id);
            creationControllersRef.current.set(latestGroup.id, controller);
            emitGroupChange(latestGroup.id, { imageGeneration: { status: "queued", taskId: null, prompt, result: null, error: null }, videoPrompt: "" });
            try {
                const task = await createImageGenerationTask(imageConfig, prompt, remakeGroupReferenceImages(latestGroup, current.references), undefined, {
                    signal: controller.signal,
                    logSource: "image-workbench",
                    logTitle: `${current.title} · 分镜 ${latestGroup.id} 十二宫格`,
                    projectId: current.id,
                    clientRequestId,
                    generationSlotId: remakeImageGenerationSlotId(latestGroup.id),
                });
                const currentGroup = latestProjectRef.current.groups.find((item) => item.id === latestGroup.id);
                if (controller.signal.aborted || !isRemakeImageInputCurrent(latestProjectRef.current, latestGroup.id, inputVersion) || (currentGroup?.imageGeneration.taskId && currentGroup.imageGeneration.taskId !== task.id)) return;
                emitGroupChange(latestGroup.id, { imageGeneration: { status: "running", taskId: task.id, prompt, result: null, error: null }, videoPrompt: "" });
                await onFlush();
                void waitForGroupTask(latestGroup.id, task.id, prompt, inputVersion, true);
            } catch (reason) {
                if (controller.signal.aborted || !isRemakeImageInputCurrent(latestProjectRef.current, latestGroup.id, inputVersion)) return;
                const detail = reason instanceof Error ? reason.message : "十二宫格任务创建失败";
                const disposition = remakeImageCreationFailureDisposition(reason);
                if (disposition === "aborted") return;
                if (disposition === "deferred") {
                    emitGroupChange(latestGroup.id, { imageGeneration: { status: "queued", taskId: null, prompt, result: null, error: null }, videoPrompt: "" });
                    await onFlush();
                    message.info(`分镜 ${latestGroup.id}：任务创建结果待确认，正在恢复原请求`);
                    scheduleResume();
                    return;
                }
                emitGroupChange(latestGroup.id, { imageGeneration: { status: "error", taskId: null, prompt, result: null, error: detail }, videoPrompt: "" });
                await onFlush();
                message.error(`分镜 ${latestGroup.id}：${detail}`);
            } finally {
                if (creationControllersRef.current.get(latestGroup.id) === controller) creationControllersRef.current.delete(latestGroup.id);
                startingGroupsRef.current.delete(latestGroup.id);
            }
        },
        [emitGroupChange, imageConfig, isAiConfigReady, message, onFlush, openConfigDialog, scheduleResume, waitForGroupTask],
    );

    useEffect(() => {
        for (const group of project.groups) {
            const generation = group.imageGeneration;
            if ((generation.status === "queued" || generation.status === "running") && generation.taskId) {
                void waitForGroupTask(group.id, generation.taskId, generation.prompt || buildRemakeImagePrompt(group, project.references), remakeGroupInputVersion(group, project.references));
            } else if ((generation.status === "queued" || generation.status === "running") && !startingGroupsRef.current.has(group.id) && !uploadingKeyRef.current) {
                void startGroup(group);
            }
        }
    }, [project.groups, project.references, resumeNonce, startGroup, waitForGroupTask]);

    const startAll = async () => {
        if (uploadingKeyRef.current) return message.warning("请等待参考图上传完成后再生成十二宫格");
        const candidates = latestProjectRef.current.groups.filter((group) => group.sourceContactSheet && group.imageGeneration.status !== "completed" && !activeGeneration(group));
        if (!candidates.length) return message.info(remakeImagesReady(latestProjectRef.current) ? "四组十二宫格已经全部生成" : "当前没有可启动的十二宫格任务");
        setBatchStarting(true);
        try {
            await Promise.all(candidates.map(startGroup));
        } finally {
            setBatchStarting(false);
        }
    };

    const referencesReady = remakeReferencesReady(project);
    const imagesReady = remakeImagesReady(project);
    const generationActive = startingGroupsRef.current.size > 0 || project.groups.some(activeGeneration);
    const completedCount = project.groups.filter((group) => group.imageGeneration.status === "completed" && group.imageGeneration.result?.url).length;

    return (
        <section className="h-full min-h-0 overflow-y-auto bg-background" aria-label="十二宫格重绘">
            <div className="mx-auto w-full max-w-[1480px] px-3 py-4 sm:px-5 sm:py-5">
                <div className="flex min-w-0 flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-end sm:justify-between">
                    <div className="min-w-0">
                        <div className="text-xs font-medium text-muted-foreground">阶段 02</div>
                        <h2 className="mt-1 text-lg font-semibold">十二宫格重绘</h2>
                        <p className="mt-1 text-sm text-muted-foreground">按本组来源拼图、可选人物图、背景图的顺序，逐组重绘十二宫格。</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        <Tag className="!m-0">{completedCount} / 4 已完成</Tag>
                        <Button type="primary" icon={<Play className="size-4" />} loading={batchStarting} disabled={disabled || Boolean(uploadingKey) || !referencesReady || imagesReady} onClick={() => void startAll()}>
                            生成全部
                        </Button>
                    </div>
                </div>

                <div className="grid gap-3 border-b border-border py-4 md:grid-cols-3">
                    {REFERENCE_SLOTS.map((slot) => (
                        <ReferenceSlot
                            key={slot.key}
                            label={slot.label}
                            detail={slot.detail}
                            asset={project.references[slot.key]}
                            loading={uploadingKey === slot.key}
                            disabled={disabled || Boolean(uploadingKey) || generationActive}
                            onChoose={() => inputRefs.current[slot.key]?.click()}
                            onRemove={() => emitReferenceChange(slot.key, undefined)}
                        >
                            <input
                                ref={(node) => {
                                    inputRefs.current[slot.key] = node;
                                }}
                                className="hidden"
                                type="file"
                                accept="image/*"
                                disabled={disabled || Boolean(uploadingKey) || generationActive}
                                onChange={(event) => void uploadReference(slot.key, event.target.files?.[0])}
                            />
                        </ReferenceSlot>
                    ))}
                </div>

                {!referencesReady ? (
                    <div className="border-b border-amber-300/70 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800 dark:border-amber-800/70 dark:bg-amber-950/20 dark:text-amber-200">
                        请上传背景图；人物图可选，仅用于外貌和服装款式参考。更换生图使用的参考图会使已有重绘图和视频提示词失效。
                    </div>
                ) : null}

                <div className="grid items-start gap-3 py-4 xl:grid-cols-2">
                    {project.groups.map((group) => (
                        <RemakeGroupCard key={group.id} group={group} references={project.references} disabled={disabled || Boolean(uploadingKey) || !referencesReady} onGenerate={() => void startGroup(group)} />
                    ))}
                </div>

                <div className="flex justify-end border-t border-border pt-4">
                    <Button type="primary" icon={<Check className="size-4" />} disabled={!imagesReady} onClick={onContinue}>
                        进入生产内容
                    </Button>
                </div>
            </div>
        </section>
    );
}

function ReferenceSlot({
    label,
    detail,
    asset,
    loading,
    disabled,
    onChoose,
    onRemove,
    children,
}: {
    label: string;
    detail: string;
    asset?: RemakeMediaAsset;
    loading: boolean;
    disabled: boolean;
    onChoose: () => void;
    onRemove: () => void;
    children: React.ReactNode;
}) {
    return (
        <div className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-card p-2.5">
            <div className="relative aspect-square w-20 shrink-0 overflow-hidden rounded-md border border-border bg-muted/30">
                {asset?.url ? (
                    <Image className="!size-full !object-cover" src={imagePreviewUrl(asset.url, 480)} alt={label} preview={{ src: imagePreviewUrl(asset.url, 1600) }} />
                ) : (
                    <ImagePlus className="absolute left-1/2 top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 text-muted-foreground" />
                )}
            </div>
            <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{label}</div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">{asset?.originalName || detail}</div>
                <div className="mt-1.5 flex items-center gap-1">
                    <Button size="small" type="text" className="!h-7 !px-1.5" icon={<Upload className="size-3.5" />} loading={loading} disabled={disabled} onClick={onChoose}>
                        {asset ? "替换" : "上传"}
                    </Button>
                    {asset ? <Button size="small" type="text" danger className="!size-7 !min-w-0 !p-0" icon={<Trash2 className="size-3.5" />} disabled={disabled} aria-label={`移除${label}`} onClick={onRemove} /> : null}
                </div>
            </div>
            {children}
        </div>
    );
}

function RemakeGroupCard({ group, references, disabled, onGenerate }: { group: RemakeRangeGroup; references: RemakeReferenceAssets; disabled: boolean; onGenerate: () => void }) {
    const { message } = App.useApp();
    const generation = group.imageGeneration;
    const active = activeGeneration(group);
    const prompt = generation.prompt || buildRemakeImagePrompt(group, references);
    return (
        <article className="min-w-0 overflow-hidden rounded-lg border border-border bg-card" aria-label={`分镜 ${group.id} 十二宫格`}>
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
                <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold">
                        第 {group.ordinal} 组 · 分镜 {group.id}
                    </h3>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">3 列 × 4 行 · 9:16 竖版</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                    <GenerationTag group={group} />
                    <Button
                        size="small"
                        type={generation.status === "completed" ? "default" : "primary"}
                        loading={active}
                        disabled={disabled || active || !group.sourceContactSheet}
                        icon={generation.status === "completed" || generation.status === "error" ? <RefreshCw className="size-3.5" /> : <Images className="size-3.5" />}
                        onClick={onGenerate}
                    >
                        {generation.status === "completed" ? "重新生成" : generation.status === "error" ? "重试" : "生成"}
                    </Button>
                </div>
            </div>

            <div className="grid grid-cols-2 gap-px bg-border">
                <ContactSheet label="来源十二宫格" asset={group.sourceContactSheet} />
                <ContactSheet label="重绘结果" asset={generation.status === "completed" ? generation.result || undefined : undefined} loading={active} error={generation.status === "error" ? generation.error || undefined : undefined} />
            </div>

            {generation.error ? <div className="border-t border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700 dark:border-rose-900 dark:bg-rose-950/20 dark:text-rose-300">{generation.error}</div> : null}

            <details className="border-t border-border">
                <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-xs font-medium hover:bg-muted/30">
                    生图提示词
                    <Tooltip title="复制生图提示词">
                        <Button
                            type="text"
                            size="small"
                            className="!size-7 !min-w-0 !p-0"
                            icon={<Copy className="size-3.5" />}
                            aria-label={`复制分镜 ${group.id} 生图提示词`}
                            onClick={(event) => {
                                event.preventDefault();
                                void copyText(prompt).then(() => message.success("生图提示词已复制"));
                            }}
                        />
                    </Tooltip>
                </summary>
                <div className="px-3 pb-3">
                    <Input.TextArea readOnly value={prompt} autoSize={{ minRows: 6, maxRows: 12 }} />
                </div>
            </details>
        </article>
    );
}

function ContactSheet({ label, asset, loading, error }: { label: string; asset?: RemakeMediaAsset; loading?: boolean; error?: string }) {
    return (
        <div className="min-w-0 bg-card p-2.5">
            <div className="mb-2 text-[11px] font-medium text-muted-foreground">{label}</div>
            <div className="relative mx-auto aspect-[9/16] w-full max-w-[260px] overflow-hidden rounded-md border border-border bg-[#15181c]">
                {asset?.url ? <Image className="!size-full !object-contain" src={imagePreviewUrl(asset.url, 1000)} alt={label} preview={{ src: imagePreviewUrl(asset.url, 2000) }} /> : null}
                {!asset && loading ? (
                    <div className="absolute inset-0 grid place-items-center text-center text-white/75">
                        <div>
                            <LoaderCircle className="mx-auto size-5 animate-spin" />
                            <div className="mt-2 text-xs">后台生成中</div>
                        </div>
                    </div>
                ) : null}
                {!asset && !loading ? (
                    <div className="absolute inset-0 grid place-items-center px-4 text-center text-white/55">
                        <div>
                            <Images className="mx-auto size-5" />
                            <div className="mt-2 text-xs">{error ? "生成失败" : "等待图片"}</div>
                        </div>
                    </div>
                ) : null}
            </div>
            {loading ? <Progress className="!mb-0 !mt-2" percent={50} showInfo={false} status="active" size="small" /> : null}
        </div>
    );
}

function GenerationTag({ group }: { group: RemakeRangeGroup }) {
    const status = group.imageGeneration.status;
    const color = status === "completed" ? "success" : status === "error" ? "error" : status === "queued" || status === "running" ? "processing" : "default";
    const label = status === "completed" ? "已完成" : status === "error" ? "失败" : status === "queued" ? "排队中" : status === "running" ? "生成中" : "未生成";
    return (
        <Tag color={color} className="!m-0">
            {label}
        </Tag>
    );
}

function activeGeneration(group: RemakeRangeGroup) {
    return group.imageGeneration.status === "queued" || group.imageGeneration.status === "running";
}

function uploadedAsset(stored: UploadedImage, originalName: string): RemakeMediaAsset {
    return {
        url: stored.serverUrl || stored.url,
        storageKey: stored.storageKey,
        mimeType: stored.mimeType,
        originalName,
        bytes: stored.bytes,
        width: stored.width,
        height: stored.height,
    };
}

async function copyText(value: string) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
    const input = document.createElement("textarea");
    input.value = value;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
}
