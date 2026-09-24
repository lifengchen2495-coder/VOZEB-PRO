"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Button, Image, Input, Modal, Select } from "antd";
import { Sparkles } from "lucide-react";

import { ModelPicker } from "@/components/model-picker";
import { createFreshGenerationTaskContext } from "@/lib/generation-request-context";
import { GenerationTaskRequestError, isDefinitiveGenerationTaskRequestFailure } from "@/services/api/generation-task-request-error";
import { createImageGenerationTask, ImageGenerationTaskTerminalError, recoverImageGenerationTask, waitForImageGenerationTask, type ImageGenerationTask } from "@/services/api/image";
import { optimizePrompt } from "@/services/api/prompt-optimization";
import { parseServerMediaUrl } from "@/services/server-media-storage";
import { selectableModelsByCapability, useEffectiveConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

export type GeneratedReferenceImage = {
    url: string;
    mimeType: string;
    originalName: string;
    storageKey?: string;
    bytes?: number;
    width?: number;
    height?: number;
};

type ReferenceImageGeneratorProps = {
    projectId: string;
    role: "product" | "character" | "background";
    characterLayout?: "single" | "six-grid";
    referenceOptions?: Array<{ label: string; url: string }>;
    size?: string;
    context?: string;
    imageModel?: string;
    disabled?: boolean;
    onSelect: (asset: GeneratedReferenceImage) => void | Promise<void>;
    className?: string;
};

type PendingGeneration = {
    clientRequestId: string;
    attemptNo: number;
    prompt: string;
    model: string;
    size: string;
    quality: string;
    referenceUrl?: string;
    taskId?: string;
};

type Candidate = GeneratedReferenceImage & { taskId: string };
type SavedGeneration = { pending?: PendingGeneration; candidates: Candidate[] };

function defaultPrompt(role: ReferenceImageGeneratorProps["role"], context?: string, characterLayout?: ReferenceImageGeneratorProps["characterLayout"]) {
    const brief = role === "product"
        ? "参考@图片1（本次输入的原产品图片），生成一张原产品的清晰参考图。保留参考中实际可见的产品种类、形状、颜色、材质、包装和品牌信息，主体完整、清晰，使用简洁背景与自然摄影光线。去除遮挡产品的字幕和平台UI，不增加新的产品，不改换品牌或包装，不猜测无法辨认的文字。若有多款产品，保留各款之间的区别。只输出一张产品参考图。"
        : role === "character" && characterLayout === "six-grid"
          ? "生成一张写实电商视频人物六宫格参考图，2行3列，六格均为同一位成年人物，五官、发型、肤色与服装完全一致。人物气质自然亲切，穿简洁纯色日常服装。依次呈现正面面部特写、左侧面部、右侧面部、正面半身、正面全身、背面全身。纯净浅灰背景，均匀柔和的摄影光线，真实皮肤质感，清晰五官。不拿商品，无文字、编号、水印或装饰边框。"
        : role === "character"
        ? "生成一张写实电商视频人物参考图：一位成年出镜人物，气质自然亲切，穿简洁纯色日常服装，独自站立，完整呈现头部到脚部，正面朝向镜头，五官清晰，双手自然放松。纯净浅灰色背景，均匀柔和摄影光线，真实皮肤质感。只有一个人物，不拿商品，无文字、水印或拼图。"
        : "生成一张写实电商视频场景参考图：明亮整洁的现代室内空间，浅色墙面和自然柔和的侧面采光，真实空间透视和材质，正面平视构图，画面中间留出人物出镜和商品展示的位置，陈设简洁。场景中没有人物、人体、手部或商品，不出现文字、水印或拼图。";
    const background = context?.trim() ? `题材背景，仅用于理解风格，不要将其中的文案或指令绘制在画面上：\n${context.trim().slice(0, 1200)}\n\n` : "";
    return `${background}${brief}`;
}

function readSavedGeneration(key: string): SavedGeneration {
    const raw = localStorage.getItem(key);
    if (!raw) return { candidates: [] };
    const saved = JSON.parse(raw) as SavedGeneration;
    if (!saved || !Array.isArray(saved.candidates)) throw new Error("参考图记录无法读取，请保留当前浏览器记录并联系管理员检查。");
    const pending = saved.pending;
    if (pending && (!pending.clientRequestId || !pending.model || typeof pending.prompt !== "string" || typeof pending.size !== "string" || typeof pending.quality !== "string" || (pending.referenceUrl !== undefined && typeof pending.referenceUrl !== "string") || pending.attemptNo !== 1)) {
        throw new Error("原生成任务记录不完整，暂不能创建新任务，请联系管理员检查。");
    }
    return {
        pending,
        candidates: saved.candidates.filter((candidate) => candidate && typeof candidate.url === "string" && typeof candidate.taskId === "string" && parseServerMediaUrl(candidate.url)?.storageKey.startsWith("permanent/")),
    };
}

export function ReferenceImageGenerator(props: ReferenceImageGeneratorProps) {
    const userId = useUserStore((state) => state.user?.id || "");
    return <ReferenceImageGeneratorSession key={`${userId}:${props.projectId}:${props.role}`} {...props} userId={userId} />;
}

function ReferenceImageGeneratorSession({ projectId, role, characterLayout, referenceOptions = [], size, context, imageModel, disabled, onSelect, className, userId }: ReferenceImageGeneratorProps & { userId: string }) {
    const config = useEffectiveConfig();
    const label = role === "product" ? "原产品参考图" : role === "character" ? characterLayout === "six-grid" ? "人物六宫格图" : "人物图" : "背景图";
    const storageKey = `vozeb:reference-image:v1:${encodeURIComponent(userId)}:${encodeURIComponent(projectId)}:${role}`;
    const [open, setOpen] = useState(false);
    const [prompt, setPrompt] = useState(() => defaultPrompt(role, context, characterLayout));
    const [referenceUrl, setReferenceUrl] = useState("");
    const [model, setModel] = useState(imageModel || config.imageModel);
    const [saved, setSaved] = useState<SavedGeneration>({ candidates: [] });
    const [selectedTaskId, setSelectedTaskId] = useState("");
    const [storageReady, setStorageReady] = useState(false);
    const [working, setWorking] = useState(false);
    const [selecting, setSelecting] = useState(false);
    const [optimizing, setOptimizing] = useState(false);
    const [beforeOptimization, setBeforeOptimization] = useState<string>();
    const [error, setError] = useState("");
    const controllerRef = useRef<AbortController | null>(null);
    const selectingRef = useRef(false);
    const optimizingRef = useRef(false);
    const promptEditedRef = useRef(false);
    const mountedRef = useRef(true);
    const models = selectableModelsByCapability(config, "image");
    const activeModel = models.includes(model) ? model : models.includes(imageModel || "") ? imageModel! : models.includes(config.imageModel) ? config.imageModel : models[0] || "";
    const selected = saved.candidates.find((candidate) => candidate.taskId === selectedTaskId) || saved.candidates[0];
    const sourceReferenceUrl = saved.pending?.referenceUrl || referenceUrl;
    const referenceReady = role !== "product" || referenceOptions.some((option) => option.url === referenceUrl);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            controllerRef.current?.abort();
        };
    }, []);

    async function persist(update: (latest: SavedGeneration) => SavedGeneration) {
        const write = () => {
            const next = update(readSavedGeneration(storageKey));
            // 仅保存恢复任务所需的公开参数，不能持久化完整模型配置或密钥。
            localStorage.setItem(storageKey, JSON.stringify(next));
            if (mountedRef.current) {
                setSaved(next);
                if (next.pending) {
                    setPrompt(next.pending.prompt);
                    setModel(next.pending.model);
                }
            }
            return next;
        };
        return navigator.locks ? navigator.locks.request(storageKey, write) : write();
    }

    async function run(pending: PendingGeneration, checkOriginal = false) {
        if (controllerRef.current || optimizingRef.current) return;
        const controller = new AbortController();
        controllerRef.current = controller;
        setWorking(true);
        setError("");
        let current = pending;
        const taskConfig = { ...config, model: pending.model, imageModel: pending.model, size: pending.size, quality: pending.quality, count: "1" };
        try {
            let task: ImageGenerationTask;
            if (current.taskId) {
                task = { id: current.taskId, kind: "generation", model: current.model };
                if (checkOriginal) {
                    try {
                        await recoverImageGenerationTask(current.taskId, { signal: controller.signal });
                    } catch (reason) {
                        // 待执行或已结束任务可能拒绝恢复；继续查询，由实际状态判断是否结束。
                        if (!(reason instanceof GenerationTaskRequestError && reason.status === 409)) throw reason;
                    }
                }
            } else {
                // 创建响应丢失时，重放同一个请求标识，让服务端返回已存在的任务。
                const references = current.referenceUrl ? [{ id: "original-product", name: "原产品画面", type: "image", dataUrl: current.referenceUrl, serverUrl: current.referenceUrl }] : [];
                task = await createImageGenerationTask(taskConfig, current.prompt, references, undefined, {
                    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
                    projectId,
                    generationSlotId: `reference-image:${projectId}:${role}`,
                    clientRequestId: current.clientRequestId,
                    attemptNo: current.attemptNo,
                    logSource: "image-workbench",
                    logTitle: `生成${label}`,
                });
                if (controller.signal.aborted) return;
                current = { ...current, taskId: task.id };
                await persist((latest) => latest.pending?.clientRequestId === current.clientRequestId ? { ...latest, pending: current } : latest);
            }
            const result = await waitForImageGenerationTask(taskConfig, task, { signal: controller.signal });
            if (controller.signal.aborted) return;
            const media = [result.serverUrl, result.dataUrl].map((url) => parseServerMediaUrl(url || "")).find((value) => value?.storageKey.startsWith("permanent/"));
            if (!media) throw new Error("图片已生成，但尚未取得可保存的素材地址，请检查原任务获取结果。");
            const mimeType = result.mimeType || "image/png";
            const candidate: Candidate = {
                taskId: task.id,
                url: media.url,
                storageKey: media.storageKey,
                mimeType,
                originalName: `AI-${label}.${mimeType.split("/")[1]?.replace("jpeg", "jpg") || "png"}`,
                bytes: result.bytes,
                width: result.width,
                height: result.height,
            };
            await persist((latest) => ({
                pending: latest.pending?.clientRequestId === current.clientRequestId ? undefined : latest.pending,
                candidates: [candidate, ...latest.candidates.filter((item) => item.taskId !== task.id)].slice(0, 8),
            }));
            setSelectedTaskId(task.id);
        } catch (reason) {
            if (controller.signal.aborted) return;
            if ((reason instanceof ImageGenerationTaskTerminalError && reason.terminalStatus) || (!current.taskId && isDefinitiveGenerationTaskRequestFailure(reason))) {
                try {
                    await persist((latest) => latest.pending?.clientRequestId === current.clientRequestId ? { candidates: latest.candidates } : latest);
                } catch {
                    // 保存失败时保留原任务记录，避免刷新后丢失任务身份。
                }
            }
            setError(reason instanceof Error ? reason.message : "生成失败，请检查原任务。");
        } finally {
            if (!controller.signal.aborted) setWorking(false);
            controllerRef.current = null;
        }
    }

    function showGenerator() {
        setOpen(true);
        if (controllerRef.current || optimizingRef.current) return;
        try {
            const stored = readSavedGeneration(storageKey);
            setSaved(stored);
            setStorageReady(true);
            setError("");
            if (stored.pending) {
                setPrompt(stored.pending.prompt);
                promptEditedRef.current = true;
                setModel(stored.pending.model);
                if (stored.pending.taskId) void run(stored.pending);
            } else if (!promptEditedRef.current) {
                setPrompt(defaultPrompt(role, context, characterLayout));
            }
        } catch (reason) {
            setStorageReady(false);
            setError(reason instanceof Error ? reason.message : "浏览器无法保存生成记录，请启用浏览器存储后重试。");
        }
    }

    async function generate() {
        if (disabled || working || optimizingRef.current || selectingRef.current || !storageReady || !prompt.trim() || !activeModel || !referenceReady) return;
        try {
            if (!navigator.locks) throw new Error("当前浏览器无法保护生成记录，请使用最新版 Chrome 或 Edge 后重试。");
            // 仅锁定请求身份的保存，防止多个标签页同时创建不同的付费任务。
            let restoring = false;
            const next = await persist((latest) => {
                if (latest.pending) {
                    restoring = true;
                    return latest;
                }
                return {
                    ...latest,
                    pending: {
                        ...createFreshGenerationTaskContext("reference-image", [projectId, role]),
                        prompt: prompt.trim(),
                        model: activeModel,
                        size: size || config.size,
                        quality: config.quality,
                        ...(role === "product" ? { referenceUrl } : {}),
                    },
                };
            });
            if (!mountedRef.current || !next.pending) return;
            setPrompt(next.pending.prompt);
            setModel(next.pending.model);
            void run(next.pending, restoring);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "生成记录保存失败，请启用浏览器存储后重试。");
        }
    }

    async function optimizeDescription() {
        const source = prompt.trim();
        if (!source || disabled || working || saved.pending || selectingRef.current || optimizingRef.current) return;
        optimizingRef.current = true;
        promptEditedRef.current = true;
        setOptimizing(true);
        setError("");
        try {
            const optimized = await optimizePrompt({ requestId: `reference-prompt-${crypto.randomUUID()}`, prompt: source, mode: "image", ...(role !== "product" ? { referenceRole: role } : {}) });
            if (!mountedRef.current) return;
            setBeforeOptimization(prompt);
            setPrompt(optimized);
        } catch (reason) {
            if (mountedRef.current) setError(reason instanceof Error ? reason.message : "优化失败，原描述已保留。");
        } finally {
            optimizingRef.current = false;
            if (mountedRef.current) setOptimizing(false);
        }
    }

    async function selectCandidate() {
        if (!selected || disabled || working || optimizingRef.current || selectingRef.current) return;
        selectingRef.current = true;
        setSelecting(true);
        setError("");
        try {
            const { url, mimeType, originalName, storageKey: assetStorageKey, bytes, width, height } = selected;
            const asset: GeneratedReferenceImage = { url, mimeType, originalName, storageKey: assetStorageKey, bytes, width, height };
            await onSelect(asset);
            setOpen(false);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "参考图保存失败，请重试。");
        } finally {
            selectingRef.current = false;
            setSelecting(false);
        }
    }

    return (
        <>
            <Button className={className} size="small" icon={<Sparkles size={14} />} disabled={disabled || !projectId || !userId} onClick={showGenerator} aria-label={`AI 生成${label}`}>
                AI 生成
            </Button>
            <Modal title={`AI 生成${label}`} open={open} onCancel={() => !selecting && setOpen(false)} footer={null} width={680} centered>
                <div className="space-y-4 py-2">
                    <p className="text-sm text-muted-foreground">{role === "product" ? "选择清楚展示原产品的画面作为参考，生成后核对产品外观，再用于当前项目。" : `没有现成的${label}也可以直接生成。修改下面的描述，生成后选一张用于当前项目。`}</p>
                    {role === "product" && (
                        <div className="space-y-2">
                            <label htmlFor="original-product-reference" className="text-sm">原产品画面</label>
                            <Select id="original-product-reference" className="w-full" value={sourceReferenceUrl || undefined} onChange={setReferenceUrl} options={referenceOptions.map((option) => ({ label: option.label, value: option.url }))} showSearch optionFilterProp="label" placeholder="选择一帧清晰展示原产品的画面" disabled={disabled || working || Boolean(saved.pending) || selecting} />
                            {!referenceOptions.length && <p className="text-xs text-muted-foreground">请先完成视频抽帧，或上传原产品参考图。</p>}
                            {sourceReferenceUrl && <Image src={sourceReferenceUrl} alt="生成所用的原产品画面" height={120} styles={{ image: { objectFit: "contain" } }} />}
                        </div>
                    )}
                    {projectId.startsWith("frame-remake-") && <p className="text-xs text-muted-foreground">此处的默认描述是系统提供的参考图示例，AI 优化会改写此处描述；两者均非飞书原文，不修改后续分镜流程的飞书提示词。</p>}
                    <label className="block space-y-2 text-sm">
                        <span>{label}描述</span>
                        <Input.TextArea value={prompt} onChange={(event) => { promptEditedRef.current = true; setBeforeOptimization(undefined); setPrompt(event.target.value); }} autoSize={{ minRows: 5, maxRows: 10 }} maxLength={6000} disabled={working || optimizing || Boolean(saved.pending) || selecting || disabled} />
                    </label>
                    <div className="flex flex-wrap items-center gap-2">
                        <Button size="small" icon={<Sparkles size={14} />} loading={optimizing} disabled={disabled || working || Boolean(saved.pending) || selecting || !prompt.trim()} onClick={() => void optimizeDescription()}>AI 优化提示词</Button>
                        {beforeOptimization !== undefined && <Button size="small" disabled={disabled || working || optimizing || Boolean(saved.pending) || selecting} onClick={() => { setPrompt(beforeOptimization); setBeforeOptimization(undefined); }}>撤销优化</Button>}
                        <span className="text-xs text-muted-foreground">使用系统文字模型，按模型规则计费；优化后可继续修改。</span>
                    </div>
                    <fieldset disabled={working || Boolean(saved.pending) || selecting || disabled} className="space-y-2">
                        <legend className="mb-2 text-sm">图片模型</legend>
                        <ModelPicker config={config} value={saved.pending?.model || activeModel} onChange={setModel} capability="image" fullWidth />
                    </fieldset>
                    {!models.length && <Alert type="warning" showIcon title="暂无可用图片模型，请联系管理员配置。" />}
                    {error && <Alert type="error" showIcon title={error} />}
                    {saved.pending && <Alert type="info" showIcon title={working ? "正在生成，可关闭窗口稍后回来查看。" : "原任务尚未确认结束，请先检查原任务。"} />}
                    <div className="flex flex-wrap items-center gap-3">
                        <Button type="primary" icon={<Sparkles size={14} />} loading={working} disabled={disabled || optimizing || selecting || !storageReady || (!saved.pending && (!activeModel || !prompt.trim() || !referenceReady))} onClick={() => saved.pending ? void run(saved.pending, true) : void generate()}>
                            {working ? "正在生成" : saved.pending ? "检查原任务" : saved.candidates.length ? "再生成一张" : "生成一张"}
                        </Button>
                        <span className="text-xs text-muted-foreground">生成按所选模型扣积分，采用图片不再扣费。</span>
                    </div>
                    {selected && (
                        <div className="space-y-3 border-t pt-4">
                            <div className="flex justify-center rounded-lg bg-muted/30 p-2">
                                <Image src={selected.url} alt={`生成的${label}`} styles={{ image: { maxHeight: 300, objectFit: "contain" } }} />
                            </div>
                            {saved.candidates.length > 1 && (
                                <div className="flex flex-wrap gap-2" aria-label={`${label}候选`}>
                                    {saved.candidates.map((candidate, index) => (
                                        <button key={candidate.taskId} type="button" aria-label={`选择候选 ${index + 1}`} aria-pressed={candidate.taskId === selected.taskId} onClick={() => setSelectedTaskId(candidate.taskId)} className={`overflow-hidden rounded-md border-2 ${candidate.taskId === selected.taskId ? "border-primary" : "border-transparent"}`}>
                                            <Image src={candidate.url} alt={`候选 ${index + 1}`} width={64} height={64} preview={false} styles={{ image: { objectFit: "cover" } }} />
                                        </button>
                                    ))}
                                </div>
                            )}
                            <Button type="primary" block loading={selecting} disabled={disabled || working || optimizing} onClick={() => void selectCandidate()}>用作{label}</Button>
                        </div>
                    )}
                </div>
            </Modal>
        </>
    );
}
