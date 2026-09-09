"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Image, Input, Progress, Tag, Tooltip } from "antd";
import { Check, Copy, ImagePlus, Images, LoaderCircle, RefreshCw, Trash2, Upload } from "lucide-react";

import { ModelPicker } from "@/components/model-picker";
import { friendlyAgentError } from "@/components/agent/agent-message-format";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { createImageGenerationTask, isImageGenerationTaskDeferredError, waitForImageGenerationTask } from "@/services/api/image";
import { uploadImage, type UploadedImage } from "@/services/image-storage";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";

import type { RemakeMediaAsset, RemakeProject, RemakeRangeGroup } from "../remake-contract";
import {
    buildRemakeImagePrompt,
    imageGenerationResultAsset,
    remakeGroupReferenceImages,
    remakeImagesReady,
    remakeReferencesReady,
} from "./remake-production-utils";
import {
    isRemakeImageInputCurrent,
    isRemakeImageTaskCurrent,
    remakeGroupInputVersion,
    remakeImageClientRequestId,
    remakeImageCreationFailureDisposition,
    remakeImageGenerationSlotId,
    type RemakeImageTaskSnapshot,
} from "./remake-workspace-state";

type ReferenceKey = "character" | "characterSupplement" | "background";
type ImageStage = "storyboard";

export type RemakeGroupPatch = {
    imageGeneration?: Partial<RemakeRangeGroup["imageGeneration"]>;
    videoPromptInstructions?: string;
    videoPrompt?: string;
    videoGeneration?: Partial<RemakeRangeGroup["videoGeneration"]>;
};

const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const REFERENCE_SLOTS: Array<{ key: ReferenceKey; label: string; detail: string; required: boolean }> = [
    { key: "character", label: "人物图", detail: "可选，只参考外貌与服装款式", required: false },
    { key: "characterSupplement", label: "人物补充", detail: "可选，补充同一人物的外貌细节", required: false },
    { key: "background", label: "背景图", detail: "必需，用于替换背景场景", required: true },
];

export function RemakeImageStage({
    project,
    disabled,
    onReferenceChange,
    onModelChange,
    onGroupChange,
    onFlush,
    onContinue,
}: {
    project: RemakeProject;
    disabled: boolean;
    onReferenceChange: (key: ReferenceKey, asset?: RemakeMediaAsset) => void;
    onModelChange: (model: string) => void;
    onGroupChange: (groupId: string, patch: RemakeGroupPatch) => void;
    onFlush: () => Promise<boolean>;
    onContinue: () => void;
}) {
    const { message } = App.useApp();
    const config = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const selectedImageModel = project.modelSelection.image || config.imageModel || config.model;
    const imageConfig = useMemo(
        () => ({ ...config, model: selectedImageModel, imageModel: selectedImageModel, size: "9:16", count: "1" }),
        [config, selectedImageModel],
    );
    const latestProjectRef = useRef(project);
    latestProjectRef.current = project;
    const inputRefs = useRef<Partial<Record<ReferenceKey, HTMLInputElement | null>>>({});
    const activeTasksRef = useRef(new Map<string, { controller: AbortController; snapshot: RemakeImageTaskSnapshot }>());
    const creationControllersRef = useRef(new Map<string, AbortController>());
    const invalidStagesRef = useRef(new Set<string>());
    const startingStagesRef = useRef(new Set<string>());
    const uploadingKeyRef = useRef<ReferenceKey | undefined>(undefined);
    const [uploadingKey, setUploadingKey] = useState<ReferenceKey>();

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
                              videoGeneration: patch.videoGeneration ? { ...group.videoGeneration, ...patch.videoGeneration } : group.videoGeneration,
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

    const emitModelChange = useCallback(
        (model: string) => {
            latestProjectRef.current = {
                ...latestProjectRef.current,
                modelSelection: { ...latestProjectRef.current.modelSelection, image: model },
            };
            onModelChange(model);
        },
        [onModelChange],
    );

    const waitForGroupTask = useCallback(
        async (stage: ImageStage, groupId: string, taskId: string, prompt: string, inputVersion: string, model: string, announce = false) => {
            const snapshot: RemakeImageTaskSnapshot = { stage, groupId, slotId: remakeImageGenerationSlotId(groupId, stage), taskId, inputVersion };
            if (!isRemakeImageTaskCurrent(latestProjectRef.current, snapshot)) return;
            const groupAtStart = latestProjectRef.current.groups.find((group) => group.id === groupId)!;
            const attemptNo = stageGeneration(groupAtStart).attemptNo ?? 0;
            const existing = activeTasksRef.current.get(taskId);
            if (existing) {
                if (existing.snapshot.stage === snapshot.stage && existing.snapshot.groupId === snapshot.groupId && existing.snapshot.inputVersion === snapshot.inputVersion) return;
                existing.controller.abort();
                activeTasksRef.current.delete(taskId);
            }
            const controller = new AbortController();
            activeTasksRef.current.set(taskId, { controller, snapshot });
            try {
                const currentProject = latestProjectRef.current;
                const taskConfig = { ...imageConfig, model, imageModel: model };
                const result = await waitForImageGenerationTask(taskConfig, { id: taskId, kind: "generation", model }, { signal: controller.signal, logSource: "image-workbench", projectId: currentProject.id });
                if (!isRemakeImageTaskCurrent(latestProjectRef.current, snapshot)) return;
                let asset = imageGenerationResultAsset(result);
                if (!asset && result.dataUrl) asset = uploadedAsset(await uploadImage(result.dataUrl), `remake-${groupId}-${stage}.png`);
                if (!isRemakeImageTaskCurrent(latestProjectRef.current, snapshot)) return;
                if (!asset) throw new Error("图片任务完成，但没有返回可长期保存的图片地址");
                const generationPatch = { status: "completed" as const, taskId, attemptNo, model, prompt, result: asset, error: null };
                emitGroupChange(groupId, { imageGeneration: generationPatch });
                await onFlush();
                if (announce) message.success(`分镜 ${groupId} 换人十二宫格已生成`);
            } catch (reason) {
                if (controller.signal.aborted || !isRemakeImageTaskCurrent(latestProjectRef.current, snapshot)) return;
                const detail = isImageGenerationTaskDeferredError(reason) ? "图片任务查询已超时，系统已停止自动查询，请确认原任务状态后再手动重试。" : friendlyAgentError(reason, "十二宫格生成失败，请稍后重试");
                const generationPatch = { status: "error" as const, taskId, attemptNo, model, prompt, error: detail };
                emitGroupChange(groupId, { imageGeneration: generationPatch });
                await onFlush();
                if (announce) message.error({ key: "remake-image-error", content: `分镜 ${groupId}：${detail}` });
            } finally {
                if (activeTasksRef.current.get(taskId)?.controller === controller) activeTasksRef.current.delete(taskId);
            }
        },
        [emitGroupChange, imageConfig, message, onFlush],
    );

    useEffect(
        () => () => {
            for (const task of activeTasksRef.current.values()) task.controller.abort();
            for (const controller of creationControllersRef.current.values()) controller.abort();
            activeTasksRef.current.clear();
            creationControllersRef.current.clear();
            invalidStagesRef.current.clear();
            startingStagesRef.current.clear();
        },
        [],
    );

    const uploadReference = async (key: ReferenceKey, file?: File) => {
        if (!file) return;
        if (startingStagesRef.current.size || latestProjectRef.current.groups.some(activeGeneration)) return message.warning("图片任务运行期间不能替换参考图");
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

    const startStage = useCallback(
        async (groupId: string, stage: ImageStage, announce = true) => {
            const current = latestProjectRef.current;
            const group = current.groups.find((item) => item.id === groupId);
            if (!group) return;
            const generation = stageGeneration(group);
            const key = stageKey(group.id, stage);
            const awaitingCreation = (generation.status === "queued" || generation.status === "running") && !generation.taskId;
            if ((isGenerationActive(generation) && !awaitingCreation) || startingStagesRef.current.has(key)) return;
            if (uploadingKeyRef.current) return message.warning("请等待参考图上传完成后再生成十二宫格");
            if (!remakeReferencesReady(current)) return message.warning("请先上传背景图");
            if (!group.sourceContactSheet?.url) return message.warning(`分镜 ${group.id} 缺少来源十二宫格，请重新执行视频分析`);
            const model = current.modelSelection.image || selectedImageModel;
            if (!model || !isAiConfigReady({ ...imageConfig, model, imageModel: model }, model)) {
                openConfigDialog(true);
                return message.warning("请先配置可用的生图模型");
            }
            if (!current.modelSelection.image) emitModelChange(model);
            const prompt = buildRemakeImagePrompt(current, group);
            const references = remakeGroupReferenceImages(group, current.references);
            const inputVersion = remakeGroupInputVersion(group, current.references, stage, current.productInfo);
            const clientRequestId = remakeImageClientRequestId(current.id, group, current.references, stage, { model, prompt, quality: imageConfig.quality });
            const previousAttempt = generation.attemptNo ?? 0;
            const attemptNo = generation.status === "error" || generation.status === "completed" ? previousAttempt + 1 : previousAttempt;
            const controller = new AbortController();
            startingStagesRef.current.add(key);
            creationControllersRef.current.set(key, controller);
            const queued = { status: "queued" as const, taskId: null, attemptNo, model, prompt, result: null, error: null };
            emitGroupChange(
                group.id,
                { imageGeneration: queued, videoPrompt: "", videoGeneration: { status: "idle", taskId: null, model: null, result: null, error: null } },
            );
            try {
                if (!(await onFlush())) {
                    const blocked = { ...queued, status: "error" as const, error: "项目尚未保存，生图请求未提交。请先处理保存错误后重试。" };
                    emitGroupChange(group.id, { imageGeneration: blocked });
                    return;
                }
                if (controller.signal.aborted || !isRemakeImageInputCurrent(latestProjectRef.current, group.id, inputVersion, stage)) return;
                const taskConfig = { ...imageConfig, model, imageModel: model };
                const task = await createImageGenerationTask(taskConfig, prompt, references, undefined, {
                    signal: controller.signal,
                    logSource: "image-workbench",
                    logTitle: `${current.title} · 分镜 ${group.id} · 保留产品换人`,
                    projectId: current.id,
                    clientRequestId,
                    ...(attemptNo > 0 ? { attemptNo } : {}),
                    generationSlotId: remakeImageGenerationSlotId(group.id, stage),
                });
                const latestGroup = latestProjectRef.current.groups.find((item) => item.id === group.id);
                const latestGeneration = latestGroup ? stageGeneration(latestGroup) : undefined;
                if (controller.signal.aborted || !isRemakeImageInputCurrent(latestProjectRef.current, group.id, inputVersion, stage) || (latestGeneration?.taskId && latestGeneration.taskId !== task.id)) return;
                const running = { status: "running" as const, taskId: task.id, attemptNo, model, prompt, result: null, error: null };
                emitGroupChange(group.id, { imageGeneration: running });
                await onFlush();
                void waitForGroupTask(stage, group.id, task.id, prompt, inputVersion, model, announce);
            } catch (reason) {
                if (controller.signal.aborted || !isRemakeImageInputCurrent(latestProjectRef.current, group.id, inputVersion, stage)) return;
                const disposition = remakeImageCreationFailureDisposition(reason);
                if (disposition === "aborted") return;
                const detail = friendlyAgentError(reason, "十二宫格任务创建失败，请稍后重试");
                if (disposition === "deferred") {
                    // 创建请求超时后无法确认上游是否已经受理，不能自动创建第二个任务。
                    const failed = { status: "error" as const, taskId: null, attemptNo, model, prompt, result: null, error: detail };
                    emitGroupChange(group.id, { imageGeneration: failed });
                    await onFlush();
                    if (announce) message.error({ key: "remake-image-error", content: `分镜 ${group.id}：${detail}` });
                    return;
                }
                const failed = { status: "error" as const, taskId: null, attemptNo, model, prompt, result: null, error: detail };
                emitGroupChange(group.id, { imageGeneration: failed });
                await onFlush();
                if (announce) message.error({ key: "remake-image-error", content: `分镜 ${group.id}：${detail}` });
            } finally {
                if (creationControllersRef.current.get(key) === controller) creationControllersRef.current.delete(key);
                startingStagesRef.current.delete(key);
            }
        },
        [emitGroupChange, emitModelChange, imageConfig, isAiConfigReady, message, onFlush, openConfigDialog, selectedImageModel, waitForGroupTask],
    );

    useEffect(() => {
        for (const group of project.groups) {
            for (const stage of ["storyboard"] as const) {
                const generation = stageGeneration(group);
                const model = generation.model || selectedImageModel;
                if ((generation.status === "queued" || generation.status === "running") && generation.taskId && model) {
                    const prompt = generation.prompt || buildRemakeImagePrompt(project, group);
                    void waitForGroupTask(stage, group.id, generation.taskId, prompt, remakeGroupInputVersion(group, project.references, stage, project.productInfo), model);
                } else if (generation.status === "queued" || generation.status === "running") {
                    const key = stageKey(group.id, stage);
                    if (startingStagesRef.current.has(key) || invalidStagesRef.current.has(key)) continue;
                    invalidStagesRef.current.add(key);
                    const failed = {
                        ...generation,
                        status: "error" as const,
                        taskId: null,
                        error: "图片任务缺少可查询的任务 ID，系统已停止自动重试，请手动重试。",
                    };
                    emitGroupChange(group.id, { imageGeneration: failed });
                    void onFlush();
                }
            }
        }
    }, [emitGroupChange, onFlush, project, selectedImageModel, startStage, waitForGroupTask]);

    const startGroup = useCallback(
        async (group: RemakeRangeGroup, announce = true) => {
            const latest = latestProjectRef.current.groups.find((item) => item.id === group.id) || group;
            const stage: ImageStage = "storyboard";
            invalidStagesRef.current.delete(stageKey(latest.id, stage));
            await startStage(latest.id, stage, announce);
        },
        [startStage],
    );

    const referencesReady = remakeReferencesReady(project);
    const imagesReady = remakeImagesReady(project);
    const generationActive = startingStagesRef.current.size > 0 || project.groups.some(activeGeneration);
    const completedCount = project.groups.filter(groupComplete).length;

    return (
        <section className="h-full min-h-0 overflow-y-auto bg-background" aria-label="十二宫格重绘">
            <div className="mx-auto w-full max-w-[1480px] px-3 py-4 sm:px-5 sm:py-5">
                <div className="flex min-w-0 flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-end sm:justify-between">
                    <div className="min-w-0">
                        <div className="text-xs font-medium text-muted-foreground">阶段 02</div>
                        <h2 className="mt-1 text-lg font-semibold">更换人物与背景 · 保留原产品</h2>
                        <p className="mt-1 text-sm text-muted-foreground">上传背景图，可选人物图和补充图，按原产品与动作生成 4 组十二宫格。</p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                        <ModelPicker
                            config={config}
                            capability="image"
                            value={selectedImageModel}
                            onChange={emitModelChange}
                            onMissingConfig={() => openConfigDialog(true)}
                            className={generationActive ? "pointer-events-none opacity-60" : ""}
                            placeholder="选择生图模型"
                        />
                        <Tag className="!m-0">{completedCount} / 4 已完成</Tag>
                    </div>
                </div>

                <div className="grid gap-3 border-b border-border py-4 md:grid-cols-2">
                    {REFERENCE_SLOTS.map((slot) => (
                        <ReferenceSlot
                            key={slot.key}
                            label={slot.label}
                            detail={slot.detail}
                            required={slot.required}
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

                <p className="border-b border-border py-3 text-xs leading-5 text-muted-foreground">人物图只参考外貌和服装，原产品、动作、视线与互动保持一致。中间分镜图按源表规则模糊人脸，最终视频结合人物参考恢复清晰外貌。</p>

                {!referencesReady ? (
                    <div className="border-b border-amber-300/70 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800 dark:border-amber-800/70 dark:bg-amber-950/20 dark:text-amber-200">
                        请先上传背景图。更换人物、背景或生图模型后需重新生成。
                    </div>
                ) : null}

                <div className="grid items-start gap-3 py-4">
                    {project.groups.map((group) => (
                        <RemakeGroupCard key={group.id} project={project} group={group} disabled={disabled || Boolean(uploadingKey) || !referencesReady} onGenerate={() => void startGroup(group)} />
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

function ReferenceSlot({ label, detail, required, asset, loading, disabled, onChoose, onRemove, children }: { label: string; detail: string; required: boolean; asset?: RemakeMediaAsset; loading: boolean; disabled: boolean; onChoose: () => void; onRemove: () => void; children: React.ReactNode }) {
    return (
        <div className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-card p-2.5">
            <div className="relative aspect-square w-20 shrink-0 overflow-hidden rounded-md border border-border bg-muted/30">
                {asset?.url ? <Image className="!size-full !object-cover" src={imagePreviewUrl(asset.url, 480)} alt={label} preview={{ src: imagePreviewUrl(asset.url, 1600) }} /> : <ImagePlus className="absolute left-1/2 top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 text-muted-foreground" />}
            </div>
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-semibold">
                    <span className="truncate">{label}</span>
                    <Tag color={required ? "blue" : "default"} className="!m-0 shrink-0">
                        {required ? "必需" : "可选"}
                    </Tag>
                </div>
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

function RemakeGroupCard({ project, group, disabled, onGenerate }: { project: RemakeProject; group: RemakeRangeGroup; disabled: boolean; onGenerate: () => void }) {
    const { message } = App.useApp();
    const active = activeGeneration(group);
    const imageError = group.imageGeneration.error ? friendlyAgentError(group.imageGeneration.error, "图片生成失败，请稍后重试") : "";
    const storyboardPrompt = group.imageGeneration.prompt || buildRemakeImagePrompt(project, group);
    return (
        <article className="min-w-0 overflow-hidden rounded-lg border border-border bg-card" aria-label={`分镜 ${group.id} 十二宫格`}>
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
                <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold">分镜 {group.id} · 十二宫格</h3>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">3 列 × 4 行 · 单次换人生图 · 9:16</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                    <GenerationTag group={group} />
                    <Button
                        size="small"
                        type={groupComplete(group) ? "default" : "primary"}
                        loading={active}
                        disabled={disabled || active || !group.sourceContactSheet}
                        icon={groupComplete(group) || hasGenerationError(group) ? <RefreshCw className="size-3.5" /> : <Images className="size-3.5" />}
                        onClick={onGenerate}
                    >
                        {groupComplete(group) ? "重新生成" : hasGenerationError(group) ? "重试" : "生成"}
                    </Button>
                </div>
            </div>

            <div className="grid grid-cols-1 gap-px bg-border sm:grid-cols-2">
                <ContactSheet label="来源十二宫格" asset={group.sourceContactSheet} />
                <ContactSheet label="保留原产品 · 换人结果" asset={completedAsset(group.imageGeneration)} loading={isGenerationActive(group.imageGeneration)} error={imageError || undefined} />
            </div>

            {imageError ? <div className="border-t border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700 dark:border-rose-900 dark:bg-rose-950/20 dark:text-rose-300">{imageError}</div> : null}

            <PromptDetails title="完整换人提示词" prompt={storyboardPrompt} copyLabel={`分镜 ${group.id} 换人提示词`} onCopied={() => message.success("完整换人提示词已复制")} />
        </article>
    );
}

function PromptDetails({ title, prompt, copyLabel, onCopied }: { title: string; prompt: string; copyLabel: string; onCopied: () => void }) {
    return (
        <details className="border-t border-border">
            <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-xs font-medium hover:bg-muted/30">
                {title}
                <Tooltip title={`复制${title}`}>
                    <Button
                        type="text"
                        size="small"
                        className="!size-7 !min-w-0 !p-0"
                        icon={<Copy className="size-3.5" />}
                        aria-label={`复制${copyLabel}`}
                        onClick={(event) => {
                            event.preventDefault();
                            void copyText(prompt).then(onCopied);
                        }}
                    />
                </Tooltip>
            </summary>
            <div className="px-3 pb-3">
                <Input.TextArea readOnly value={prompt} autoSize={{ minRows: 7, maxRows: 16 }} />
            </div>
        </details>
    );
}

function ContactSheet({ label, asset, loading, error }: { label: string; asset?: RemakeMediaAsset; loading?: boolean; error?: string }) {
    return (
        <div className="min-w-0 bg-card p-2.5">
            <div className="mb-2 min-h-8 text-[11px] font-medium leading-4 text-muted-foreground">{label}</div>
            <div className="relative mx-auto aspect-[9/16] w-full max-w-[240px] overflow-hidden rounded-md border border-border bg-[#15181c]">
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
    const status = groupStatus(group);
    const color = status === "completed" ? "success" : status === "error" ? "error" : status === "queued" || status === "running" ? "processing" : "default";
    const label = status === "completed" ? "已完成" : status === "error" ? "失败" : status === "queued" ? "排队中" : status === "running" ? "生成中" : "未生成";
    return <Tag color={color} className="!m-0">{label}</Tag>;
}

function groupStatus(group: RemakeRangeGroup) {
    if (groupComplete(group)) return "completed";
    if (hasGenerationError(group)) return "error";
    if (group.imageGeneration.status === "running") return "running";
    if (group.imageGeneration.status === "queued") return "queued";
    return "idle";
}

function stageGeneration(group: RemakeRangeGroup) {
    return group.imageGeneration;
}

function stageKey(groupId: string, stage: ImageStage) {
    return `${groupId}:${stage}`;
}

function isGenerationActive(generation: RemakeRangeGroup["imageGeneration"]) {
    return generation.status === "queued" || generation.status === "running";
}

function activeGeneration(group: RemakeRangeGroup) {
    return isGenerationActive(group.imageGeneration);
}

function groupComplete(group: RemakeRangeGroup) {
    return group.imageGeneration.status === "completed" && Boolean(group.imageGeneration.result?.url);
}

function hasGenerationError(group: RemakeRangeGroup) {
    return group.imageGeneration.status === "error";
}

function completedAsset(generation: RemakeRangeGroup["imageGeneration"]) {
    return generation.status === "completed" ? generation.result || undefined : undefined;
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
