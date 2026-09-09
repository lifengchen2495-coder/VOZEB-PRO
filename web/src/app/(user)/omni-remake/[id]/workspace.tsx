"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Copy, Download, Loader2, Save, Upload, X } from "lucide-react";
import { Button, Input, Textarea } from "../controls";
import { ModelPicker } from "@/components/model-picker";
import { ReferenceImageGenerator, type GeneratedReferenceImage } from "@/components/reference-image-generator";
import { modelOptionName, selectableModelsByCapability, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { uploadImage } from "@/services/image-storage";
import { OMNI_SOURCE_URL, type OmniProject, type OmniSegment, type OmniWorkflowStage } from "@/lib/omni-remake-contract";
import { OMNI_WORKFLOW_STAGES, omniStageLabel, omniStageOutput, omniStagePrerequisite } from "@/lib/omni-remake-workflow";
import { omniEditable, omniProjectPath, omniRequest, uploadOmniVideo } from "../omni-api";
import { ManualVideoUpload } from "./manual-video-upload";
import { OmniWorkflowStageCard } from "./workflow-stage-card";

const statuses = { idle: "待回传结果", queued: "旧任务待确认", running: "旧任务处理中", completed: "已完成", error: "失败" };
const operationName = (kind: OmniWorkflowStage | "prepare" | "merge") => kind === "prepare" ? "按分析 JSON 切片" : kind === "merge" ? "合并成片" : omniStageLabel(kind);

export function OmniWorkspace({ id }: { id: string }) {
    const [project, setProject] = useState<OmniProject>();
    const [draft, setDraft] = useState<ReturnType<typeof omniEditable>>();
    const [dirty, setDirty] = useState(false);
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [planJson, setPlanJson] = useState("");
    const [editedSegments, setEditedSegments] = useState<string[]>([]);
    const [editedStages, setEditedStages] = useState<OmniWorkflowStage[]>([]);
    const lock = useRef(false);
    const current = useRef<OmniProject | undefined>(undefined);
    const config = useEffectiveConfig();
    const textModels = selectableModelsByCapability(config, "text");
    const defaultTextModel = textModels.find((model) => /doubao/i.test(modelOptionName(model)) && /seed.*2|2[.-]0/i.test(modelOptionName(model))) || (textModels.includes(config.textModel) ? config.textModel : textModels[0]) || "";
    const effectiveModels = { analysis: draft?.modelSelection.analysis || defaultTextModel, prompt: draft?.modelSelection.prompt || defaultTextModel, video: draft?.modelSelection.video || "" };
    const hasUnsavedOutput = Boolean(editedStages.length || editedSegments.length || planJson.trim());
    const openConfig = useConfigStore((state) => state.openConfigDialog);
    const stageEdited = useCallback((stage: OmniWorkflowStage, edited: boolean) => {
        setEditedStages((stages) => stages.includes(stage) === edited ? stages : edited ? [...stages, stage] : stages.filter((value) => value !== stage));
    }, []);
    const segmentEdited = useCallback((segmentId: string, edited: boolean) => {
        setEditedSegments((ids) => ids.includes(segmentId) === edited ? ids : edited ? [...ids, segmentId] : ids.filter((value) => value !== segmentId));
    }, []);
    const accept = useCallback((value: OmniProject) => {
        current.current = value;
        setProject(value);
        setDraft(omniEditable(value));
        setDirty(false);
    }, []);
    const load = useCallback(() => omniRequest<OmniProject>(omniProjectPath(id)), [id]);
    useEffect(() => {
        let active = true;
        load()
            .then((value) => {
                if (active) accept(value);
            })
            .catch((error: Error) => {
                if (active) setError(error.message);
            });
        return () => {
            active = false;
        };
    }, [load, accept]);
    const running = Boolean(project?.operation || project?.segments.some((segment) => segment.video.status === "running" || segment.video.status === "queued"));
    useEffect(() => {
        if (!running) return;
        let active = true;
        let inFlight = false;
        const timer = setInterval(async () => {
            if (lock.current || inFlight) return;
            inFlight = true;
            try {
                const value = await load();
                if (active && !lock.current && value.revision >= (current.current?.revision || 0)) accept(value);
            } catch (error) {
                if (active) setError((error as Error).message);
            } finally {
                inFlight = false;
            }
        }, 4000);
        return () => {
            active = false;
            clearInterval(timer);
        };
    }, [running, load, accept]);
    useEffect(() => {
        const warn = (event: BeforeUnloadEvent) => {
            if (dirty || busy || hasUnsavedOutput) {
                event.preventDefault();
                event.returnValue = "";
            }
        };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [dirty, busy, hasUnsavedOutput]);
    const change = (patch: Partial<ReturnType<typeof omniEditable>>) => {
        if (hasUnsavedOutput) {
            setError("请先采用或放弃修改中的阶段结果和片段提示词，再修改项目素材或设置");
            return;
        }
        setDraft((value) => (value ? { ...value, ...patch } : value));
        setDirty(true);
    };
    const action = async (label: string, run: () => Promise<void>) => {
        if (lock.current) return;
        lock.current = true;
        setBusy(label);
        setError("");
        try {
            await run();
        } catch (error) {
            setError((error as Error).message);
        } finally {
            lock.current = false;
            setBusy("");
        }
    };
    const save = async (patch: Partial<ReturnType<typeof omniEditable>> = {}) => {
        if (!current.current || !draft) throw new Error("项目尚未加载");
        if (!dirty && !Object.keys(patch).length) return current.current;
        const next = await omniRequest<OmniProject>(omniProjectPath(id), { ...draft, ...patch, revision: current.current.revision }, "PATCH");
        accept(next);
        return next;
    };
    const operation = (kind: OmniWorkflowStage | "prepare" | "merge") =>
        action(operationName(kind), async () => {
            if (hasUnsavedOutput) throw new Error("请先采用或放弃修改中的阶段结果和片段提示词");
            const isWorkflowStage = kind !== "prepare" && kind !== "merge";
            const saved = await save(isWorkflowStage ? { modelSelection: effectiveModels } : {});
            if (isWorkflowStage) {
                const missing = omniStagePrerequisite(saved, kind);
                if (missing) throw new Error(missing);
                if (!(kind === "analysis" ? saved.modelSelection.analysis : saved.modelSelection.prompt)) throw new Error("请先选择本阶段使用的模型");
            }
            accept(await omniRequest<OmniProject>(`${omniProjectPath(id)}/operations`, { revision: saved.revision, kind }));
        });
    const uploadSource = (file: File) =>
        action("上传并保存参考视频", async () => {
            if (hasUnsavedOutput) throw new Error("请先采用或放弃修改中的阶段结果和片段提示词，再上传参考视频");
            if (!current.current || !draft) throw new Error("项目尚未加载");
            const sourceVideo = await uploadOmniVideo(id, file);
            setBusy("保存参考视频");
            const saved = await save({ sourceVideo, modelSelection: effectiveModels });
            if (!saved.modelSelection.analysis || !textModels.includes(saved.modelSelection.analysis)) {
                setNotice("参考视频已上传并保存。请先配置并选择视频分析模型，再到第 1 步点击“分析视频，生成 JSON”。");
                return;
            }
            const missing = omniStagePrerequisite(saved, "analysis");
            if (missing) throw new Error(missing);
            setBusy("自动分析视频，生成 JSON");
            setNotice("参考视频已保存。自动分析的结果会显示在第 1 步；若分析失败，可在该步骤重试。");
            accept(await omniRequest<OmniProject>(`${omniProjectPath(id)}/operations`, { revision: saved.revision, kind: "analysis" }));
        });
    const adoptStageOutput = async (stage: OmniWorkflowStage, value: string) => {
        let savedOutput: string | undefined;
        await action(`采用${omniStageLabel(stage)}`, async () => {
            if (dirty || editedSegments.length || planJson.trim() || editedStages.some((item) => item !== stage)) throw new Error("请先保存其他修改，再采用本阶段结果");
            if (!current.current) throw new Error("项目尚未加载");
            const next = await omniRequest<OmniProject>(omniProjectPath(id), { revision: current.current.revision, ...(stage === "analysis" ? { analysisJson: value } : { stageOutput: { stage, value } }) }, "PATCH");
            savedOutput = omniStageOutput(next, stage);
            accept(next);
            setNotice(`已保存${omniStageLabel(stage)}，请按顺序继续后续步骤。`);
        });
        return savedOutput;
    };
    const importPlan = () =>
        action("导入片段提示词", async () => {
            if (editedSegments.length || editedStages.length) throw new Error("请先采用或放弃修改中的阶段结果和片段提示词");
            if (!current.current || !draft) throw new Error("项目尚未加载");
            accept(await omniRequest<OmniProject>(omniProjectPath(id), { ...draft, revision: current.current.revision, planJson }, "PATCH"));
            setPlanJson("");
            setNotice("提示词计划已导入。");
        });
    const acquireUpload = () => {
        if (lock.current || dirty || hasUnsavedOutput || !current.current || current.current.operation || current.current.segments.some((segment) => ["queued", "running"].includes(segment.video.status))) return false;
        lock.current = true;
        setBusy("上传并保存手动结果");
        setError("");
        return true;
    };
    const releaseUpload = () => { lock.current = false; setBusy(""); };
    const importResult = async (segmentId: string, url: string, uploadId: string) => {
        if (!current.current) throw new Error("项目尚未加载");
        try {
            accept(await omniRequest<OmniProject>(`${omniProjectPath(id)}/segments/${segmentId}/video`, { revision: current.current.revision, url }, "PUT"));
        } catch (reason) {
            // 保存响应丢失时先核对项目，避免把已经采用的结果当成失败。
            const refreshed = await load().catch(() => undefined);
            if (refreshed) {
                accept(refreshed);
                const segment = refreshed.segments.find((item) => item.id === segmentId);
                if (segment?.video.manualUploadId === uploadId && segment.video.result) return;
            }
            throw reason;
        }
    };
    const taskAction = (segment: OmniSegment, kind: "recover" | "cancel" | "abandon") =>
        action(kind === "recover" ? "检查原任务" : "结束本次任务", async () => {
            if (kind === "abandon") {
                accept(await omniRequest<OmniProject>(`${omniProjectPath(id)}/segments/${segment.id}/video`, undefined, "DELETE"));
                return;
            }
            if (!segment.video.taskId) throw new Error("没有可检查的原任务");
            if (kind === "cancel" && !window.confirm("取消当前片段任务？已经提交的上游任务会按系统取消规则处理。")) return;
            const response = await fetch(`/api/video-tasks/${encodeURIComponent(segment.video.taskId)}`, { method: kind === "recover" ? "POST" : "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: kind }) });
            const result = await response.json().catch(() => ({}));
            accept(await load());
            if (!response.ok) throw new Error(result.error || "原任务处理失败");
        });
    const download = (format: "zip" | "video" | "analysis" | "workflow") =>
        action("准备下载", async () => {
            if (dirty || hasUnsavedOutput) throw new Error("请先保存项目、阶段结果及片段提示词的修改，再导出当前项目");
            if (current.current?.operation) throw new Error("请等待当前处理步骤完成");
            const response = await fetch(`/api/omni-remake${omniProjectPath(id)}/export?format=${format}`);
            if (!response.ok) {
                const result = await response.json();
                throw new Error(result.msg || "导出失败");
            }
            const url = URL.createObjectURL(await response.blob());
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = format === "analysis" ? "视频分析.json" : format === "workflow" ? "Omni流程结果.json" : `omni-remake.${format === "video" ? "mp4" : "zip"}`;
            anchor.click();
            setTimeout(() => URL.revokeObjectURL(url), 30000);
        });
    if (!project || !draft)
        return (
            <main className="p-8">
                <Link href="/omni-remake">返回全品类项目</Link>
                <p role={error ? "alert" : undefined} className="mt-4">
                    {error || "正在加载项目…"}
                </p>
            </main>
        );
    const disabled = Boolean(busy || running);
    const maximumReferenceImages = 10;
    const activeReferenceCount = draft.references.product.length + (draft.replaceCharacter ? draft.references.character.length : 0) + (draft.replaceBackground ? draft.references.background.length : 0);
    const referenceLimitMessage = "每类最多 5 张，项目合计最多 10 张，请先移除不需要的参考图";
    const complete = project.segments.length > 0 && project.segments.every((segment) => segment.video.status === "completed");
    const prepared = project.segments.length > 0 && project.segments.every((segment) => segment.sourceClip && segment.prompt.trim() && segment.promptZh.trim());
    const applyGeneratedReference = async (role: "character" | "background", asset: GeneratedReferenceImage) => {
        if (disabled || lock.current || !current.current) throw new Error("请等待当前操作完成后再使用参考图");
        if (hasUnsavedOutput) throw new Error("请先采用或放弃修改中的阶段结果和片段提示词，再使用参考图");
        if (draft.references[role].some((reference) => reference.url === asset.url)) return;
        if (draft.references[role].length >= 5 || Object.values(draft.references).flat().length >= 10 || activeReferenceCount >= maximumReferenceImages) throw new Error(referenceLimitMessage);
        lock.current = true;
        setBusy("保存生成的参考图");
        setError("");
        try {
            const references = { ...draft.references, [role]: [...draft.references[role], asset] };
            accept(await omniRequest<OmniProject>(omniProjectPath(id), { ...draft, references, revision: current.current.revision }, "PATCH"));
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "参考图保存失败");
            throw reason;
        } finally {
            lock.current = false;
            setBusy("");
        }
    };
    return (
        <main className="h-full overflow-y-auto bg-background">
            <header className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 border-b bg-background/95 px-5 py-3 backdrop-blur">
                <div className="flex items-center gap-3">
                    <Link href="/omni-remake" aria-label="返回全品类项目">
                        <ArrowLeft className="size-5" />
                    </Link>
                    <div>
                        <h1 className="font-semibold">{project.title}</h1>
                        <p className="text-xs text-muted-foreground">Omni 全品类复刻 · {dirty || hasUnsavedOutput ? "有未保存修改" : "已保存"}</p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <Button variant="outline" disabled={Boolean(busy) || dirty || hasUnsavedOutput} onClick={() => void action("检查状态", async () => accept(await load()))}>
                        检查状态
                    </Button>
                    <Button
                        disabled={disabled || !dirty || hasUnsavedOutput}
                        onClick={() =>
                            void action("保存项目", async () => {
                                await save();
                            })
                        }
                    >
                        <Save className="mr-2 size-4" />
                        保存
                    </Button>
                </div>
            </header>
            <div className="mx-auto max-w-7xl space-y-6 p-5 md:p-8">
                <div className="space-y-2 rounded-xl border bg-muted/30 p-5">
                    <p className="font-medium">上传素材 → 分析视频并生成 JSON → 生成分类提示词 → 外部生成并回传</p>
                    <p className="text-sm leading-6 text-muted-foreground">参考视频上传保存后，系统会调用所选模型自动生成分析 JSON。后续 6 个阶段逐步点击生成，每步保留完整指令和结果；同类片段共用一组提示词，最后下载素材包并回传外部生成的视频。</p>
                </div>
                {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
                {editedSegments.length > 0 && <p role="status" className="text-sm text-muted-foreground">{editedSegments.join("、")} 的提示词尚未保存，请在对应片段保存后再准备或下载素材。</p>}
                {editedStages.length > 0 && <p role="status" className="text-sm text-muted-foreground">{editedStages.map(omniStageLabel).join("、")} 的结果尚未采用，请先保存或放弃修改，再继续生成和下载。</p>}
                {(busy || project.operation) && (
                    <p role="status" className="flex items-center gap-2 rounded-lg bg-muted p-3 text-sm">
                        <Loader2 className="size-4 animate-spin" />
                        {busy || operationName(project.operation!.kind)}…
                    </p>
                )}
                {(error || project.error) && (
                    <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">
                        {error || project.error}
                    </p>
                )}
                <section className="grid gap-6 lg:grid-cols-[1fr_1.3fr]">
                    <div className="space-y-4 rounded-xl border p-5">
                        <h2 className="text-lg font-medium">参考视频</h2>
                        <Input aria-label="项目名称" value={draft.title} maxLength={120} disabled={disabled} onChange={(event) => change({ title: event.target.value })} />
                        {draft.sourceVideo && <video controls preload="metadata" src={draft.sourceVideo.url} className="max-h-72 w-full rounded-lg bg-black" />}
                        <label className={`flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed p-5 text-sm ${disabled || hasUnsavedOutput ? "pointer-events-none opacity-50" : ""}`}>
                            <Upload className="size-4" />
                            {draft.sourceVideo ? "更换参考视频" : "上传参考视频"}
                            <input
                                aria-label="上传参考视频"
                                className="sr-only"
                                type="file"
                                accept="video/*"
                                disabled={disabled || hasUnsavedOutput}
                                onChange={(event) => {
                                    const file = event.target.files?.[0];
                                    event.target.value = "";
                                    if (file) void uploadSource(file);
                                }}
                            />
                        </label>
                        <p className="text-xs text-muted-foreground">支持按原片时长处理。单文件最多 200 MB，每个生成片段不超过 10 秒。</p>
                        <label className="block space-y-2 text-sm">
                            <span>原声音频</span>
                            <select aria-label="原声音频" className="w-full rounded-md border bg-background p-2" value={draft.audioMode} disabled={disabled} onChange={(event) => change({ audioMode: event.target.value as OmniProject["audioMode"] })}>
                                <option value="auto">按分析 JSON 中的音频策略执行</option>
                                <option value="silent">全部静音</option>
                                <option value="source">全部保留原声</option>
                            </select>
                        </label>
                        <p className="text-sm leading-6 text-muted-foreground">上传或更换参考视频会自动保存并开始分析，输出切片时间、人物和音频判断。分析失败或修改生成指令后，可在下方第 1 步重试；该步骤也支持粘贴已有分析 JSON。</p>
                        {draft.sourceVideo && <a href={draft.sourceVideo.url} download className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm"><Download className="size-4" />下载原片</a>}
                    </div>
                    <div className="space-y-4 rounded-xl border p-5">
                        <h2 className="text-lg font-medium">目标素材</h2>
                        <p className="text-xs text-muted-foreground">每类最多 5 张，项目合计最多 10 张，当前使用 {activeReferenceCount} 张。素材包会按产品、人物、背景分类。</p>
                        <div className="flex flex-wrap gap-4 text-sm">
                            <label className="flex items-center gap-2">
                                <input type="checkbox" checked={draft.productStrategy === "replace"} disabled={disabled} onChange={(event) => change({ productStrategy: event.target.checked ? "replace" : "preserve" })} />
                                替换产品
                            </label>
                            <label className="flex items-center gap-2">
                                <input type="checkbox" checked={draft.replaceCharacter} disabled={disabled} onChange={(event) => change({ replaceCharacter: event.target.checked })} />
                                替换人物
                            </label>
                            <label className="flex items-center gap-2">
                                <input type="checkbox" checked={draft.replaceBackground} disabled={disabled} onChange={(event) => change({ replaceBackground: event.target.checked })} />
                                替换背景
                            </label>
                        </div>
                        <Input
                            aria-label="产品名称"
                            placeholder={draft.productStrategy === "replace" ? "新产品名称（换品必填）" : "原产品名称（选填）"}
                            value={draft.productName}
                            disabled={disabled}
                            onChange={(event) => change({ productName: event.target.value })}
                        />
                        {(["product", "character", "background"] as const)
                            .filter((role) => role === "product" || (role === "character" ? draft.replaceCharacter : draft.replaceBackground))
                            .map((role) => (
                                <div key={role} className="space-y-2">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <p className="text-sm">{{ product: draft.productStrategy === "replace" ? "新产品参考图" : "原产品细节图（选填）", character: "人物参考图", background: "背景参考图" }[role]}</p>
                                        {role !== "product" && (
                                            <ReferenceImageGenerator
                                                key={`${id}:${role}`}
                                                projectId={id}
                                                role={role}
                                                context={[draft.productName, draft.instructions, project.analysisSummary].filter(Boolean).join("\n")}
                                                disabled={disabled || draft.references[role].length >= 5 || Object.values(draft.references).flat().length >= 10 || activeReferenceCount >= maximumReferenceImages}
                                                onSelect={(asset) => applyGeneratedReference(role, asset)}
                                            />
                                        )}
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                        {draft.references[role].map((asset, index) => (
                                            <div key={asset.url} className="relative">
                                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                                <img src={asset.url} alt={`${role} 参考图 ${index + 1}`} className="size-20 rounded-lg border object-cover" />
                                                <button
                                                    aria-label={`移除 ${role} 参考图 ${index + 1}`}
                                                    disabled={disabled}
                                                    className="absolute right-0 top-0 rounded-full bg-background p-1"
                                                    onClick={() => change({ references: { ...draft.references, [role]: draft.references[role].filter((_, itemIndex) => itemIndex !== index) } })}
                                                >
                                                    <X className="size-3" />
                                                </button>
                                            </div>
                                        ))}
                                        <label className={`flex size-20 cursor-pointer items-center justify-center rounded-lg border border-dashed ${disabled ? "pointer-events-none opacity-50" : ""}`}>
                                            <Upload className="size-4" />
                                            <input
                                                aria-label={`上传${{ product: "产品", character: "人物", background: "背景" }[role]}图`}
                                                className="sr-only"
                                                type="file"
                                                accept="image/*"
                                                multiple
                                                disabled={disabled}
                                                onChange={(event) => {
                                                    const files = Array.from(event.target.files || []);
                                                    event.target.value = "";
                                                    if (files.length)
                                                        void action("上传参考图", async () => {
                                                            if (files.length + draft.references[role].length > 5 || files.length + Object.values(draft.references).flat().length > 10 || files.length + activeReferenceCount > maximumReferenceImages) throw new Error(referenceLimitMessage);
                                                            const assets = [];
                                                            for (const file of files) assets.push({ ...(await uploadImage(file)), originalName: file.name });
                                                            change({ references: { ...draft.references, [role]: [...draft.references[role], ...assets] } });
                                                        });
                                                }}
                                            />
                                        </label>
                                    </div>
                                </div>
                            ))}
                        <Textarea aria-label="产品人物补充" placeholder="产品特征、人物或背景补充要求" value={draft.instructions} disabled={disabled} onChange={(event) => change({ instructions: event.target.value })} />
                    </div>
                </section>
                <section aria-label="生成模型" className="space-y-4 rounded-xl border p-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <h2 className="text-lg font-medium">生成模型</h2>
                        <a href={OMNI_SOURCE_URL} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground underline">查看飞书原流程</a>
                    </div>
                    <p className="text-sm leading-6 text-muted-foreground">视频分析目前支持 Doubao Seed 2.0 Pro 的整段视频理解渠道。后续阶段可选择其他已配置模型，其中素材分析需要支持图片输入；实际调用使用下方选项。</p>
                    <fieldset disabled={disabled || hasUnsavedOutput} className="grid min-w-0 gap-4 sm:grid-cols-2 disabled:opacity-50">
                        <div className="min-w-0 space-y-2">
                            <p className="text-sm">视频分析模型 · 第 1 步</p>
                            <ModelPicker config={config} capability="text" value={effectiveModels.analysis} onChange={(value) => change({ modelSelection: { ...draft.modelSelection, analysis: value } })} onMissingConfig={() => openConfig(true)} placeholder="选择支持视频理解的模型" fullWidth />
                        </div>
                        <div className="min-w-0 space-y-2">
                            <p className="text-sm">文字与素材分析模型 · 第 2—7 步</p>
                            <ModelPicker config={config} capability="text" value={effectiveModels.prompt} onChange={(value) => change({ modelSelection: { ...draft.modelSelection, prompt: value } })} onMissingConfig={() => openConfig(true)} placeholder="选择支持文字与图片的模型" fullWidth />
                        </div>
                    </fieldset>
                </section>
                <section aria-label="Omni 七阶段流程" className="space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <h2 className="text-lg font-medium">按飞书流程生成</h2>
                        <Button variant="outline" disabled={disabled || dirty || hasUnsavedOutput || !project.analysisRaw} onClick={() => void download("workflow")}><Download className="mr-2 size-4" />下载全部阶段结果</Button>
                    </div>
                    <p className="text-sm leading-6 text-muted-foreground">每步生成完成后自动保存。修改上游指令或结果会清除依赖它的后续结果，人物图、场景图和产品图会保留；请从被清空的步骤继续生成。</p>
                    {OMNI_WORKFLOW_STAGES.map((stage, index) => (
                        <OmniWorkflowStageCard
                            key={`${stage}:${omniStageOutput(project, stage)}`}
                            stage={stage}
                            step={index + 1}
                            project={project}
                            draftProject={{ ...project, ...draft, modelSelection: effectiveModels }}
                            disabled={disabled}
                            settingsDirty={dirty}
                            otherOutputDirty={Boolean(editedSegments.length || planJson.trim() || editedStages.some((value) => value !== stage))}
                            anyOutputDirty={hasUnsavedOutput}
                            onEditedChange={stageEdited}
                            onInstructionsChange={(value) => change({ stageInstructions: { ...draft.stageInstructions, [stage]: value }, ...(stage === "promptSummary" ? { videoPromptInstructions: "" } : {}) })}
                            onSaveInstructions={() => action("保存生成指令", async () => { await save(); })}
                            onGenerate={() => operation(stage)}
                            onSaveOutput={(value) => adoptStageOutput(stage, value)}
                            onDownloadAnalysis={() => download("analysis")}
                        />
                    ))}
                </section>
                <section className="space-y-4 rounded-xl border p-5">
                    <h2 className="text-lg font-medium">按分析 JSON 切片</h2>
                    <p className="text-sm leading-6 text-muted-foreground">第 1 步完成后即可按 JSON 的时间段和音频策略切分原片，无需等待提示词生成。完成第 7 步后，下载各段视频、参考图与中英文提示词。</p>
                    <div className="flex flex-wrap gap-3">
                        <Button disabled={disabled || hasUnsavedOutput || !project.segments.length} onClick={() => void operation("prepare")}>切分参考视频</Button>
                        <Button variant="outline" disabled={disabled || dirty || hasUnsavedOutput || !prepared} onClick={() => void download("zip")}><Download className="mr-2 size-4" />下载手动生成素材包</Button>
                    </div>
                    <p className="text-xs text-muted-foreground">已切片 {project.segments.filter((segment) => segment.sourceClip).length} / {project.segments.length} 段 · 已有双语提示词 {project.segments.filter((segment) => segment.prompt.trim() && segment.promptZh.trim()).length} / {project.segments.length} 段</p>
                    {!!project.promptGroups?.length && <div className="space-y-2 rounded-lg bg-muted/50 p-4 text-sm">
                        <p className="font-medium">提示词分类与片段对应</p>
                        {project.promptGroups.map((group) => <p key={group.id} className="break-words">{group.label || group.id}：{group.segmentIds.join("、")} · {group.audioStrategy === "preserve_audio" ? "保留原声" : "移除音频"}</p>)}
                    </div>}
                    <details className="space-y-3 rounded-lg border p-4">
                        <summary className="cursor-pointer text-sm">可选：导入已有提示词计划</summary>
                        <p className="text-xs leading-6 text-muted-foreground">接受包含 materialAnalysis、plan、segments 的 JSON；每段填写 id、prompt、promptZh，顺序与下方片段一致。导入后会清除旧生成结果。</p>
                        <Textarea aria-label="片段提示词计划" value={planJson} disabled={disabled || Boolean(editedStages.length || editedSegments.length)} onChange={(event) => setPlanJson(event.target.value)} placeholder="粘贴完整提示词计划 JSON" className="min-h-32" />
                        <div className="flex flex-wrap gap-2">
                            <Button variant="outline" disabled={disabled || Boolean(editedStages.length || editedSegments.length) || !project.segments.length || !planJson.trim()} onClick={() => void importPlan()}>导入提示词计划</Button>
                            {planJson && <Button variant="ghost" disabled={disabled} onClick={() => setPlanJson("")}>放弃导入</Button>}
                        </div>
                    </details>
                </section>
                <section className="space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <h2 className="text-lg font-medium">逐段手动生成与回传</h2>
                    </div>
                    {!project.segments.length && <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">分析完成后在这里查看片段。</p>}
                    <div className="grid gap-4 xl:grid-cols-2">
                        {project.segments.map((segment) => (
                            <SegmentCard
                                key={`${segment.id}:${segment.prompt}:${segment.promptZh}`}
                                project={project}
                                segment={segment}
                                disabled={disabled || dirty || Boolean(editedStages.length || planJson.trim()) || Boolean(segment.promptGroupId && project.segments.some((item) => item.id !== segment.id && item.promptGroupId === segment.promptGroupId && editedSegments.includes(item.id)))}
                                canManageTask={!busy}
                                onTaskAction={(kind) => void taskAction(segment, kind)}
                                acquireUpload={acquireUpload}
                                releaseUpload={releaseUpload}
                                onImport={(url, uploadId) => importResult(segment.id, url, uploadId)}
                                onEditedChange={segmentEdited}
                                onSave={(prompt, promptZh) =>
                                    action("保存片段提示词", async () => {
                                        const saved = await save();
                                        accept(await omniRequest<OmniProject>(`${omniProjectPath(id)}/segments/${segment.id}`, { revision: saved.revision, prompt, promptZh }, "PATCH"));
                                    })
                                }
                            />
                        ))}
                    </div>
                </section>
                <section className="space-y-4 rounded-xl border p-5">
                    <h2 className="text-lg font-medium">成片与导出</h2>
                    <div className="flex flex-wrap gap-3">
                        <Button disabled={disabled || !complete || dirty || hasUnsavedOutput} onClick={() => void operation("merge")}>
                            合并全部片段
                        </Button>
                        <Button variant="outline" disabled={Boolean(busy || project.operation) || dirty || hasUnsavedOutput || !prepared} onClick={() => void download("zip")}>
                            <Download className="mr-2 size-4" />
                            下载手动生成素材包
                        </Button>
                        {project.mergedVideo && (
                            <Button variant="outline" disabled={Boolean(busy || project.operation) || dirty || hasUnsavedOutput} onClick={() => void download("video")}>
                                <Download className="mr-2 size-4" />
                                下载成片
                            </Button>
                        )}
                    </div>
                    {project.mergedVideo && <video controls src={project.mergedVideo.url} className="max-h-96 w-full rounded-lg bg-black" />}
                </section>
            </div>
        </main>
    );
}

function SegmentCard({
    project,
    segment,
    disabled,
    canManageTask,
    onTaskAction,
    onSave,
    acquireUpload,
    releaseUpload,
    onImport,
    onEditedChange,
}: {
    project: OmniProject;
    segment: OmniSegment;
    disabled: boolean;
    canManageTask: boolean;
    onTaskAction: (kind: "recover" | "cancel" | "abandon") => void;
    onSave: (prompt: string, promptZh: string) => Promise<void>;
    acquireUpload: () => boolean;
    releaseUpload: () => void;
    onImport: (url: string, uploadId: string) => Promise<void>;
    onEditedChange: (segmentId: string, edited: boolean) => void;
}) {
    const [prompt, setPrompt] = useState(segment.prompt);
    const [promptZh, setPromptZh] = useState(segment.promptZh);
    const [notice, setNotice] = useState("");
    const edited = prompt !== segment.prompt || promptZh !== segment.promptZh;
    useEffect(() => {
        onEditedChange(segment.id, edited);
        return () => onEditedChange(segment.id, false);
    }, [segment.id, edited, onEditedChange]);
    const copy = async (text: string, label: string) => {
        try { await navigator.clipboard.writeText(text); setNotice(`已复制${label}`); }
        catch { setNotice("复制失败，请展开提示词后手动复制。"); }
    };
    return (
        <article className="space-y-3 rounded-xl border p-5">
            <div className="flex items-center justify-between">
                <h3 className="font-medium">
                    {segment.id} · {segment.start}—{segment.end} 秒
                </h3>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    {segment.video.status === "completed" && <Check className="size-3" />}
                    {segment.video.needsReview ? "需要检查原任务" : statuses[segment.video.status]}
                </span>
            </div>
            <p className="text-xs text-muted-foreground">
                {segment.audioStrategy === "preserve_audio" ? "保留原声" : "移除音频"} · {segment.description}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
                {segment.sourceClip && (
                    <figure>
                        <video controls preload="metadata" src={segment.sourceClip.url} className="max-h-56 w-full rounded-lg bg-black" />
                        <figcaption className="mt-1 text-xs text-muted-foreground"><a href={segment.sourceClip.url} download className="underline">下载参考片段 · {segment.audioStrategy === "remove_audio" ? "已静音" : "保留原声"}</a></figcaption>
                    </figure>
                )}
                {segment.video.result && (
                    <figure>
                        <video controls preload="metadata" src={segment.video.result.url} className="max-h-56 w-full rounded-lg bg-black" />
                        <figcaption className="mt-1 text-xs">
                            <a download href={segment.video.result.url} className="underline">
                                下载生成片段
                            </a>
                        </figcaption>
                    </figure>
                )}
            </div>
            <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={disabled || !segment.prompt || edited} onClick={() => void copy(segment.prompt, "英文提示词")}><Copy className="mr-2 size-3" />复制英文提示词</Button>
                <Button size="sm" variant="outline" disabled={disabled || !segment.promptZh || edited} onClick={() => void copy(segment.promptZh, "中文提示词")}><Copy className="mr-2 size-3" />复制中文提示词</Button>
            </div>
            {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
                <details>
                    <summary className="cursor-pointer text-sm">查看和编辑中英文提示词{edited ? "（未保存）" : ""}</summary>
                    <div className="mt-3 space-y-3">
                        {segment.promptGroupId && <p className="text-xs leading-6 text-muted-foreground">本段属于提示词组 {segment.promptGroupId}。保存将同步更新同组片段，并使这些片段已回传的视频结果失效。</p>}
                        <Textarea aria-label={`${segment.id} 中文提示词`} value={promptZh} disabled={disabled} onChange={(event) => setPromptZh(event.target.value)} className="min-h-32" />
                        <Textarea aria-label={`${segment.id} 英文提示词`} value={prompt} disabled={disabled} onChange={(event) => setPrompt(event.target.value)} className="min-h-40" />
                        <Button size="sm" variant="outline" disabled={disabled || !edited || !prompt.trim() || !promptZh.trim()} onClick={() => void onSave(prompt, promptZh)}>
                            保存提示词
                        </Button>
                    </div>
                </details>
            {segment.video.error && (
                <p role="alert" className="text-sm text-destructive">
                    {segment.video.error}
                </p>
            )}
            <ManualVideoUpload project={project} segment={segment} disabled={disabled || edited || !segment.prompt || !segment.sourceClip} acquire={acquireUpload} release={releaseUpload} onImport={onImport} />
            {segment.video.status === "queued" && (
                <Button className="ml-2" size="sm" variant="outline" disabled={!canManageTask} onClick={() => onTaskAction("abandon")}>
                    检查并解除未提交任务
                </Button>
            )}
            {segment.video.status === "running" && segment.video.taskId && (
                <div className="flex gap-2">
                    <Button size="sm" variant="outline" disabled={!canManageTask} onClick={() => onTaskAction("recover")}>
                        检查原任务
                    </Button>
                    <Button size="sm" variant="ghost" disabled={!canManageTask} onClick={() => onTaskAction("cancel")}>
                        取消原任务
                    </Button>
                </div>
            )}
        </article>
    );
}
