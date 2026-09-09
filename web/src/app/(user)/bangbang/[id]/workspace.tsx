"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Download, Loader2, Play, Save } from "lucide-react";
import { BANGBANG_STEP_LABELS, bangbangCreationMode, bangbangBusy, bangbangStepBlockReason, type BangbangInputPatch, type BangbangProject, type BangbangStep } from "@/lib/bangbang-contract";
import { acceptsBangbangRefresh, bangbangProjectPath, bangbangRequest, bangbangResponse, loadBangbangVideoPromptTemplate, uploadBangbangMedia, type BangbangVideoPromptTemplate } from "../bangbang-api";
import { Button, Field, Textarea } from "../controls";
import { bangbangWorkspaceStages, bangbangStageComplete, resumeBangbangStage, withBangbangDraft, type BangbangStage } from "./workspace-state";
import { CharactersPanel, DirectionPanel, FullOutput, GroupPanel, InputPanel } from "./workspace-panels";
import { VideoPromptInstructions } from "./video-prompt-instructions";

const stepActions: Record<BangbangStep, string> = {
    transcript: "提取字幕",
    understanding: "理解视频",
    traffic: "分析流量逻辑",
    frames: "提取关键帧",
    directions: "生成裂变方向",
    script: "生成完整剧本",
    characters: "生成人物清单",
    storyboard: "生成分镜规划表",
    expand: "展开九格分镜",
    optimize: "优化生图提示词",
    "video-prompts": "生成视频提示词",
};

export function BangbangWorkspace({ id }: { id: string }) {
    const [project, setProject] = useState<BangbangProject>();
    const [patch, setPatch] = useState<BangbangInputPatch>({});
    const [prompts, setPrompts] = useState<Record<string, string>>({});
    const [requestedStage, setStage] = useState<BangbangStage>("input");
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [asr, setAsr] = useState<boolean>();
    const [autoSteps, setAutoSteps] = useState<BangbangStep[]>([]);
    const [orphanedPrompts, setOrphanedPrompts] = useState<Record<string, string>>({});
    const [videoTemplate, setVideoTemplate] = useState<BangbangVideoPromptTemplate & { mode: "product" | "reference" }>();
    const [videoTemplateLoading, setVideoTemplateLoading] = useState(false);
    const [videoTemplateError, setVideoTemplateError] = useState("");
    const [videoDefaultPreview, setVideoDefaultPreview] = useState(false);
    const videoTemplateRequest = useRef(0);
    const current = useRef<BangbangProject | undefined>(undefined);
    const lock = useRef(false);
    const autoProductScript = useRef(false);
    const dirty = Object.keys(patch).length > 0 || Object.keys(prompts).length > 0;
    const accept = useCallback((value: BangbangProject) => {
        current.current = value;
        setProject(value);
        setPatch({});
        setPrompts({});
        setVideoDefaultPreview(false);
    }, []);
    const load = useCallback(() => bangbangRequest<BangbangProject>(bangbangProjectPath(id)), [id]);
    const savedCreationMode = project ? bangbangCreationMode(project) : undefined;
    const reloadVideoTemplate = useCallback(async () => {
        if (!savedCreationMode) return;
        const request = ++videoTemplateRequest.current;
        setVideoTemplateLoading(true);
        setVideoTemplateError("");
        setVideoTemplate(undefined);
        try {
            const template = await loadBangbangVideoPromptTemplate(id);
            if (request === videoTemplateRequest.current) setVideoTemplate({ ...template, mode: savedCreationMode });
        } catch (error) {
            if (request === videoTemplateRequest.current) setVideoTemplateError((error as Error).message);
        } finally {
            if (request === videoTemplateRequest.current) setVideoTemplateLoading(false);
        }
    }, [id, savedCreationMode]);
    const invalidateVideoTemplate = useCallback(() => {
        videoTemplateRequest.current++;
    }, []);
    useEffect(() => {
        if (requestedStage !== "video-prompts" || !savedCreationMode) return;
        void reloadVideoTemplate();
        return invalidateVideoTemplate;
    }, [requestedStage, savedCreationMode, reloadVideoTemplate, invalidateVideoTemplate]);
    useEffect(() => {
        let active = true;
        load()
            .then((value) => {
                if (active) {
                    accept(value);
                    setStage(resumeBangbangStage(value));
                }
            })
            .catch((error: Error) => {
                if (active) setError(error.message);
            });
        bangbangRequest<{ asrConfigured: boolean }>("/capabilities")
            .then((value) => {
                if (active) setAsr(value.asrConfigured);
            })
            .catch(() => {
                if (active) setAsr(undefined);
            });
        return () => {
            active = false;
        };
    }, [load, accept]);
    const running = Boolean(project && bangbangBusy(project));
    useEffect(() => {
        if (!running) return;
        let active = true;
        let inFlight = false;
        const timer = setInterval(async () => {
            if (lock.current || inFlight) return;
            inFlight = true;
            try {
                const value = await load();
                if (active && !lock.current && acceptsBangbangRefresh(current.current, value)) accept(value);
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
    }, [running, accept, load]);
    useEffect(() => {
        const warn = (event: BeforeUnloadEvent) => {
            if (dirty) {
                event.preventDefault();
                event.returnValue = "";
            }
        };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [dirty]);
    const action = async (label: string, task: () => Promise<void>) => {
        if (lock.current) return;
        lock.current = true;
        setBusy(label);
        setError("");
        setNotice("");
        try {
            await task();
        } catch (error) {
            setError((error as Error).message);
            setAutoSteps([]);
            autoProductScript.current = false;
        } finally {
            lock.current = false;
            setBusy("");
        }
    };
    const change = (value: BangbangInputPatch) =>
        setPatch((previous) => {
            const next = { ...previous, ...value };
            if (value.creationMode !== undefined) {
                // 切换创作方式时，旧流程的内容草稿不能带入新流程。
                delete next.transcriptText;
                delete next.scriptText;
                delete next.characterImages;
                delete next.selectedDirectionId;
                delete next.customDirection;
                delete next.storyboardImport;
            }
            return next;
        });
    const save = async () => {
        if (!current.current) throw new Error("项目尚未加载");
        if (patch.videoPromptInstructions !== undefined) {
            if (!videoTemplate || videoTemplate.mode !== bangbangCreationMode(current.current)) throw new Error("请先完整加载生成指令，再保存修改");
            if (!patch.videoPromptInstructions.trim() && !videoDefaultPreview) throw new Error("生成指令不能为空；如需使用默认指令，请点击恢复默认");
            if (patch.videoPromptInstructions.length > 50_000) throw new Error("生成指令不能超过 50000 字");
        }
        let value = current.current;
        if (Object.keys(patch).length) {
            value = await bangbangRequest<BangbangProject>(bangbangProjectPath(id), { revision: value.revision, ...patch }, "PATCH");
            current.current = value;
            setProject(value);
            setPatch({});
            setVideoDefaultPreview(false);
        }
        for (const [groupId, text] of Object.entries(prompts)) {
            if (!value.groups.some((group) => group.id === groupId)) {
                setOrphanedPrompts((previous) => ({ ...previous, [groupId]: text }));
                setPrompts((previous) => {
                    const next = { ...previous };
                    delete next[groupId];
                    return next;
                });
                continue;
            }
            value = await bangbangRequest<BangbangProject>(bangbangProjectPath(id), { revision: value.revision, groupPrompt: { groupId, text } }, "PATCH");
            current.current = value;
            setProject(value);
            setPrompts((previous) => {
                const next = { ...previous };
                delete next[groupId];
                return next;
            });
        }
        return value;
    };
    const startOperation = async (step: BangbangStep, value: BangbangProject) => {
        const reason = bangbangStepBlockReason(value, step);
        if (reason) throw new Error(reason);
        setStage(step);
        try {
            accept(await bangbangRequest<BangbangProject>(`${bangbangProjectPath(id)}/operations`, { revision: value.revision, step }));
        } catch (error) {
            try {
                accept(await load());
            } catch {
                /* 保留原始提交错误，稍后可检查状态。 */
            }
            throw error;
        }
    };
    const operation = (step: BangbangStep) => action(step === "directions" && current.current && bangbangCreationMode(current.current) === "product" ? "创作方向" : BANGBANG_STEP_LABELS[step], async () => startOperation(step, await save()));
    const saveVideoInstructions = () =>
        void action("保存生成指令", async () => {
            await save();
            setNotice("生成指令已保存，请按当前指令生成视频提示词");
        });
    const createProductScript = () =>
        action("根据产品生成剧本", async () => {
            const value = await save();
            if (bangbangCreationMode(value) !== "product") throw new Error("请先选择产品原创方式");
            await startOperation("directions", value);
            autoProductScript.current = true;
            setAutoSteps(["script"]);
        });
    const analyze = () =>
        action("开始连续分析", async () => {
            const value = await save();
            const steps = (["transcript", "understanding", "traffic", "frames", "directions"] as BangbangStep[]).filter((step) => !value.outputs[step]?.text);
            if (!steps.length) {
                setStage("directions");
                return;
            }
            if (steps[0] === "transcript" && asr === false) throw new Error("请先导入已有字幕，或联系管理员配置语音转写，再继续分析");
            await startOperation(steps[0], value);
            setAutoSteps(steps.slice(1));
        });
    useEffect(() => {
        if (!project || running || busy || !autoSteps.length || lock.current) return;
        if (project.error) {
            setAutoSteps([]);
            autoProductScript.current = false;
            return;
        }
        const [next, ...remaining] = autoSteps;
        setAutoSteps(remaining);
        if (next === "script" && autoProductScript.current) {
            autoProductScript.current = false;
            void action("采用推荐方向生成剧本", async () => {
                const value = await save();
                const recommended = value.directions[0];
                if (!recommended) throw new Error("未生成可用的创作方向，请重新生成或填写自定义方向");
                const selected = await bangbangRequest<BangbangProject>(bangbangProjectPath(id), { revision: value.revision, selectedDirectionId: recommended.id, customDirection: "" }, "PATCH");
                accept(selected);
                await startOperation("script", selected);
            });
        } else void operation(next);
        // 队列只在当前环节结束后前进；产品原创停在剧本，视频分析停在方向选择。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [project, running, busy, autoSteps]);
    const upload = (file: File, category: "video" | "product" | "character" | "scene") =>
        void action("上传素材", async () => {
            const value = await save();
            const media = await uploadBangbangMedia(id, file);
            const input: BangbangInputPatch =
                category === "video" ? { sourceVideo: media } : { references: { ...value.references, [category]: [...value.references[category], { id: crypto.randomUUID(), label: file.name.replace(/\.[^.]+$/, ""), media }] } };
            accept(await bangbangRequest<BangbangProject>(bangbangProjectPath(id), { revision: value.revision, ...input }, "PATCH"));
        });
    const imageAction = (groupId: string, kind: "image" | "approve") =>
        void action(kind === "image" ? "提交九宫格" : "确认九宫格", async () => {
            const value = await save();
            try {
                accept(await bangbangRequest<BangbangProject>(`${bangbangProjectPath(id)}/groups/${encodeURIComponent(groupId)}/${kind}`, { revision: value.revision }));
            } catch (error) {
                try {
                    accept(await load());
                } catch {
                    /* 状态检查失败时仍显示原始操作错误。 */
                }
                throw error;
            }
        });
    const cancelImage = (groupId: string) =>
        void action("检查并撤销未确认提交", async () => {
            accept(await bangbangRequest<BangbangProject>(`${bangbangProjectPath(id)}/groups/${encodeURIComponent(groupId)}/image`, undefined, "DELETE"));
        });
    const copy = (text: string) => {
        void navigator.clipboard
            .writeText(text)
            .then(() => setNotice("已复制全文"))
            .catch(() => setError("复制失败，请选中完整输出后手动复制"));
    };
    const download = (mode: "text" | "production") =>
        void action("准备导出", async () => {
            await save();
            const response = await fetch(`/api/bangbang${bangbangProjectPath(id)}/export?mode=${mode}`, { cache: "no-store" });
            if (!response.ok) await bangbangResponse(response);
            const url = URL.createObjectURL(await response.blob());
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = `bangbang-${id}-${mode}.zip`;
            anchor.click();
            setTimeout(() => URL.revokeObjectURL(url), 30000);
        });
    if (!project)
        return (
            <main className="p-8">
                <Link href="/bangbang" className="text-sm underline">
                    返回短剧项目
                </Link>
                <p role={error ? "alert" : "status"} className="mt-5 text-sm">
                    {error || "正在恢复项目…"}
                </p>
                {error && (
                    <Button
                        className="mt-4"
                        variant="outline"
                        disabled={Boolean(busy)}
                        onClick={() =>
                            void action("重新加载", async () => {
                                const value = await load();
                                accept(value);
                                setStage(resumeBangbangStage(value));
                            })
                        }
                    >
                        重新加载
                    </Button>
                )}
            </main>
        );
    const view = withBangbangDraft(project, patch, prompts);
    const productMode = bangbangCreationMode(view) === "product";
    const stages = bangbangWorkspaceStages(view);
    const stage = stages.some((item) => item.id === requestedStage) ? requestedStage : "input";
    const disabled = Boolean(busy || running || autoSteps.length);
    const stageIndex = stages.findIndex((item) => item.id === stage);
    const selected = stages[stageIndex];
    const step = stage !== "input" && stage !== "images" ? stage : undefined;
    const blockReason = step ? bangbangStepBlockReason(view, step) : undefined;
    const output = step ? view.outputs[step]?.text : undefined;
    const videoModePending = bangbangCreationMode(view) !== bangbangCreationMode(project);
    const videoTemplateReady = Boolean(videoTemplate && videoTemplate.mode === bangbangCreationMode(project) && !videoTemplateLoading && !videoTemplateError);
    const videoInstructionsText =
        patch.videoPromptInstructions !== undefined
            ? videoDefaultPreview && patch.videoPromptInstructions === ""
                ? videoTemplate?.defaultText || ""
                : patch.videoPromptInstructions
            : project.videoPromptInstructions?.trim()
              ? project.videoPromptInstructions
              : videoTemplate?.defaultText || "";
    const videoInstructionsValidation = videoTemplateReady && !videoInstructionsText.trim() ? "生成指令不能为空；可点击恢复默认" : videoInstructionsText.length > 50_000 ? "生成指令不能超过 50000 字" : undefined;
    const videoInstructionsInvalid = patch.videoPromptInstructions !== undefined && (!videoTemplateReady || Boolean(videoInstructionsValidation));
    const panel = { project: view, disabled, change, upload };
    return (
        <main className="flex h-full min-h-0 flex-col bg-background">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 md:px-6">
                <div className="flex min-w-0 items-center gap-3">
                    <Link href="/bangbang" aria-label="返回短剧项目" className="rounded-lg p-1 hover:bg-muted">
                        <ArrowLeft className="size-5" />
                    </Link>
                    <div className="min-w-0">
                        <h1 className="max-w-[65vw] truncate text-sm font-semibold md:max-w-md">{view.title}</h1>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                            {productMode ? "产品原创" : "对标裂变"} · {dirty ? "有未保存修改" : "已保存"}
                        </p>
                    </div>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button variant="outline" disabled={Boolean(busy) || dirty || autoSteps.length > 0} onClick={() => void action("检查状态", async () => accept(await load()))}>
                        检查状态
                    </Button>
                    <Button
                        disabled={disabled || !dirty || videoInstructionsInvalid}
                        onClick={() =>
                            void action("保存项目", async () => {
                                await save();
                                setNotice("已保存修改，受影响的后续结果需重新生成");
                            })
                        }
                    >
                        <Save className="size-4" />
                        保存
                    </Button>
                </div>
            </header>
            <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
                <aside className="shrink-0 border-b bg-muted/15 lg:w-60 lg:overflow-y-auto lg:border-b-0 lg:border-r">
                    <div className="hidden px-5 pb-3 pt-5 lg:block">
                        <p className="text-xs font-medium text-muted-foreground">生产环节</p>
                        <p className="mt-2 text-sm">
                            已完成 {stages.filter((item) => bangbangStageComplete(view, item.id)).length} / {stages.length}
                        </p>
                    </div>
                    <nav aria-label="短剧生产环节" className="flex gap-1 overflow-x-auto p-2 lg:flex-col lg:px-3">
                        {stages.map((item, index) => (
                            <button
                                key={item.id}
                                aria-current={stage === item.id ? "step" : undefined}
                                className={`flex shrink-0 items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors ${stage === item.id ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
                                onClick={() => setStage(item.id)}
                            >
                                <span className={`flex size-6 shrink-0 items-center justify-center rounded-md text-xs ${bangbangStageComplete(view, item.id) ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "bg-muted"}`}>
                                    {project.operation?.step === item.id ? <Loader2 className="size-3.5 animate-spin" /> : bangbangStageComplete(view, item.id) ? <Check className="size-3.5" /> : String(index + 1).padStart(2, "0")}
                                </span>
                                <span className="whitespace-nowrap">{item.label}</span>
                            </button>
                        ))}
                    </nav>
                    <div className="hidden border-t px-5 py-4 text-xs leading-6 text-muted-foreground lg:block">
                        环节 1–{productMode ? 5 : 9} · 棒棒脚本
                        <br />
                        环节 {productMode ? 6 : 10}–{stages.length} · 棒棒生图
                    </div>
                </aside>
                <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
                    <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-7">
                        {(busy || running || autoSteps.length > 0) && (
                            <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg bg-muted px-4 py-3 text-sm">
                                <Loader2 className="size-4 animate-spin" />
                                <span>{busy || (project.operation ? `${productMode && project.operation.step === "directions" ? "创作方向" : BANGBANG_STEP_LABELS[project.operation.step]}处理中` : "九宫格处理中")} · 完成后自动更新</span>
                                {autoSteps.length > 0 && (
                                    <Button
                                        variant="ghost"
                                        className="ml-auto"
                                        onClick={() => {
                                            setAutoSteps([]);
                                            autoProductScript.current = false;
                                        }}
                                    >
                                        当前环节完成后暂停
                                    </Button>
                                )}
                            </div>
                        )}
                        {(error || project.error) && (
                            <p role="alert" className="rounded-lg border border-destructive/30 px-4 py-3 text-sm text-destructive">
                                {error || project.error}
                            </p>
                        )}
                        {notice && (
                            <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
                                {notice}
                            </p>
                        )}
                        {Object.keys(orphanedPrompts).length > 0 && (
                            <details className="rounded-lg border p-4">
                                <summary className="cursor-pointer text-sm font-medium">上游修改后，旧分镜提示词已暂存在此页</summary>
                                <p className="mt-3 text-xs leading-6 text-muted-foreground">分镜需要重新规划。以下未提交的编辑保留在当前页面，可复制后用于新分镜。</p>
                                {Object.entries(orphanedPrompts).map(([groupId, text]) => (
                                    <div key={groupId} className="mt-4">
                                        <p className="mb-2 text-xs text-muted-foreground">{groupId}</p>
                                        <FullOutput text={text} copy={copy} />
                                    </div>
                                ))}
                            </details>
                        )}
                        <header className="flex flex-wrap items-start justify-between gap-4">
                            <div>
                                <p className="mb-2 text-xs text-muted-foreground">
                                    环节 {stageIndex + 1} / {stages.length}
                                </p>
                                <h2 className="text-xl font-semibold">{selected.label}</h2>
                                <p className="mt-2 text-sm leading-6 text-muted-foreground">{selected.hint}</p>
                            </div>
                            {step && (
                                <Button
                                    disabled={disabled || Boolean(blockReason) || (step === "transcript" && asr === false) || (step === "video-prompts" && (!videoTemplateReady || videoModePending || Boolean(videoInstructionsValidation)))}
                                    onClick={() => void operation(step)}
                                >
                                    <Play className="size-3.5" />
                                    {output ? "重新" : ""}
                                    {productMode && step === "directions" ? "生成创作方向" : stepActions[step]}
                                </Button>
                            )}
                        </header>
                        {step && blockReason && <p className="border-l-2 border-amber-500/60 pl-3 text-sm leading-6 text-muted-foreground">{blockReason}</p>}
                        {stage === "input" && (
                            <>
                                <InputPanel {...panel} />
                                <div className="flex flex-wrap items-center gap-3 border-t pt-5">
                                    {productMode ? (
                                        <Button disabled={disabled || !view.references.product.length} onClick={() => void createProductScript()}>
                                            <Play className="size-4" />
                                            根据产品生成剧本
                                        </Button>
                                    ) : (
                                        <Button disabled={disabled || !view.sourceVideo || (asr === false && !view.outputs.transcript?.text)} onClick={() => void analyze()}>
                                            <Play className="size-4" />
                                            连续完成视频分析
                                        </Button>
                                    )}
                                    <Button variant="outline" onClick={() => setStage("storyboard")}>
                                        导入已有分镜规划
                                    </Button>
                                </div>
                                {productMode ? (
                                    <p className="text-xs leading-6 text-muted-foreground">根据产品生成创作方向，采用第一推荐方向写出完整剧本，完成后可直接编辑。也可以先进入「创作方向」手动选择。</p>
                                ) : (
                                    <p className="text-xs leading-6 text-muted-foreground">连续分析会完成字幕、视频理解、流量分析、拆帧与方向建议，之后由你选择裂变方向。{asr === false ? "当前未配置语音转写，可在环节 2 导入字幕后继续。" : ""}</p>
                                )}
                            </>
                        )}
                        {stage === "transcript" && (
                            <div className="space-y-4">
                                {asr === false && <p className="rounded-lg bg-amber-500/10 p-4 text-sm leading-6">当前未配置语音转写。可粘贴已有字幕后保存并继续分析，或联系管理员配置语音转写服务。</p>}
                                <Field label="字幕全文（可粘贴已有字幕）">
                                    <Textarea aria-label="字幕全文" className="min-h-64" disabled={disabled} value={view.outputs.transcript?.text || ""} onChange={(event) => change({ transcriptText: event.target.value })} />
                                </Field>
                                <Button
                                    variant="outline"
                                    disabled={disabled || patch.transcriptText === undefined}
                                    onClick={() =>
                                        void action("保存字幕", async () => {
                                            await save();
                                            setNotice("字幕已保存，可以继续视频理解");
                                        })
                                    }
                                >
                                    保存字幕
                                </Button>
                            </div>
                        )}
                        {stage === "directions" && <DirectionPanel {...panel} />}
                        {stage === "script" && (
                            <Field label="完整剧本（可编辑）">
                                <Textarea aria-label="完整剧本" className="min-h-96" value={view.outputs.script?.text || ""} disabled={disabled} onChange={(event) => change({ scriptText: event.target.value })} />
                            </Field>
                        )}
                        {stage === "characters" && <CharactersPanel {...panel} />}
                        {stage === "storyboard" && (
                            <details open={!view.groups.length} className="rounded-lg border p-4">
                                <summary className="cursor-pointer text-sm font-medium">导入已有分镜规划表</summary>
                                <p className="mt-3 text-xs leading-6 text-muted-foreground">粘贴完整规划表，包括每组时间、场景、人物、台词、产品状态与衔接关系，然后点击上方「生成分镜规划表」。</p>
                                <Textarea aria-label="导入分镜规划表" className="mt-3 min-h-48" disabled={disabled} value={view.storyboardImport} onChange={(event) => change({ storyboardImport: event.target.value })} />
                            </details>
                        )}
                        {stage === "frames" && view.sourceFrames.length > 0 && (
                            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                                {view.sourceFrames.map((frame, index) => (
                                    <a key={frame.url} href={frame.url} target="_blank" rel="noreferrer" className="overflow-hidden rounded-lg border">
                                        <img src={frame.url} alt={`原片关键画面 ${index + 1}`} className="aspect-video w-full bg-muted object-contain" />
                                        <p className="p-2 text-xs text-muted-foreground">关键画面 {index + 1}</p>
                                    </a>
                                ))}
                            </div>
                        )}
                        {(["storyboard", "expand", "optimize", "images"] as string[]).includes(stage) && view.groups.length > 0 && (
                            <GroupPanel
                                project={view}
                                disabled={disabled}
                                actionsDisabled={Boolean(busy || project.operation || project.groups.some((group) => group.image.status === "running"))}
                                mode={stage as "storyboard" | "expand" | "optimize" | "images"}
                                promptChange={(groupId, text) => setPrompts((previous) => ({ ...previous, [groupId]: text }))}
                                generate={(groupId) => imageAction(groupId, "image")}
                                approve={(groupId) => imageAction(groupId, "approve")}
                                cancel={cancelImage}
                                save={() =>
                                    void action("保存提示词", async () => {
                                        await save();
                                    })
                                }
                            />
                        )}
                        {stage === "images" && !view.groups.length && <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">先完成分镜规划、九格展开与提示词优化，再逐张生成九宫格。</p>}
                        {stage === "video-prompts" && (
                            <VideoPromptInstructions
                                text={videoInstructionsText}
                                source={patch.videoPromptInstructions !== undefined ? (videoDefaultPreview ? "default" : "custom") : project.videoPromptInstructions?.trim() ? "custom" : "default"}
                                ready={videoTemplateReady}
                                loading={videoTemplateLoading}
                                loadError={videoTemplateError}
                                modePending={videoModePending}
                                disabled={disabled}
                                dirty={patch.videoPromptInstructions !== undefined}
                                hasOutput={Boolean(output || view.videoSegments.length)}
                                validationError={videoInstructionsValidation}
                                generationBlockReason={blockReason}
                                onChange={(text) => {
                                    setVideoDefaultPreview(false);
                                    change({ videoPromptInstructions: text });
                                }}
                                onSave={saveVideoInstructions}
                                onRestoreDefault={() => {
                                    if (!videoTemplateReady) return;
                                    setVideoDefaultPreview(true);
                                    change({ videoPromptInstructions: "" });
                                }}
                                onGenerate={() => void operation("video-prompts")}
                                onRetry={() => void reloadVideoTemplate()}
                                onSaveMode={() =>
                                    void action("保存创作方式", async () => {
                                        await save();
                                    })
                                }
                                onCopy={copy}
                            />
                        )}
                        {stage === "video-prompts" && view.videoSegments.length > 0 && (
                            <div className="divide-y rounded-lg border">
                                {view.videoSegments.map((segment, index) => (
                                    <div key={segment.id} className="space-y-3 p-4">
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                            <h3 className="text-sm font-medium">
                                                第 {index + 1} 段 · {segment.duration} 秒
                                            </h3>
                                            <Button variant="ghost" onClick={() => copy(segment.prompt)}>
                                                复制本段
                                            </Button>
                                        </div>
                                        <p className="text-xs text-muted-foreground">九宫格组：{segment.groupIds.join("、")}</p>
                                        <p className="whitespace-pre-wrap text-sm leading-7">{segment.prompt}</p>
                                    </div>
                                ))}
                            </div>
                        )}
                        {output && <FullOutput text={output} copy={copy} />}
                        {step && !output && <p className="text-xs leading-6 text-muted-foreground">完成此环节后，完整输出将保存在这里。离开页面后可继续查看已有结果。</p>}
                        <footer className="flex flex-wrap items-center justify-between gap-3 border-t pt-5">
                            <div className="flex flex-wrap gap-2">
                                <Button variant="outline" disabled={disabled || !Object.keys(view.outputs).length} onClick={() => download("text")}>
                                    <Download className="size-4" />
                                    导出文本包
                                </Button>
                                <Button variant="outline" disabled={disabled || !view.groups.length} onClick={() => download("production")}>
                                    <Download className="size-4" />
                                    导出生产素材包
                                </Button>
                            </div>
                            {stageIndex < stages.length - 1 && (
                                <Button variant="ghost" onClick={() => setStage(stages[stageIndex + 1].id)}>
                                    下一环节
                                    <ArrowRight className="size-4" />
                                </Button>
                            )}
                        </footer>
                    </div>
                </div>
            </div>
        </main>
    );
}
