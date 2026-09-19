"use client";
import { Button, Tag } from "antd";
import { Check } from "lucide-react";
import { frameRemakeWorkflowReadiness } from "@/lib/frame-remake-steps";
import { frameRemakeGrid, frameRemakeInputError, frameRemakeIsBasicWorkflow, frameRemakeSeconds, frameRemakeUsesTemplate, frameRemakeWorkflowSource } from "@/lib/frame-remake-contract";
import { frameRemakeImagePrompt } from "@/lib/frame-remake-prompts";
import { frameRemakeMissingPromptFields } from "@/lib/frame-remake-prompt-templates";
import { RemakeGroupCard } from "../../remake15/[id]/remake-image-stage";
import { ModelControl, type WorkflowProps } from "./workflow-controls";
import { frameRemakePromptPreview } from "./workflow-source";

export function FrameImageStage(props: WorkflowProps) {
    const { project, display } = props,
        ready = frameRemakeWorkflowReadiness(project),
        twoStep = frameRemakeUsesTemplate(display),
        basic = frameRemakeIsBasicWorkflow(display),
        personBasic = frameRemakeWorkflowSource(display) === "person-basic",
        inputError = frameRemakeInputError(display),
        missingSource = frameRemakeMissingPromptFields(display).length > 0;
    const disabled = props.disabled || !ready.planning || Boolean(inputError) || missingSource;
    return (
        <section className="h-full min-h-0 overflow-y-auto" aria-label="分镜重绘">
            <div className="mx-auto w-full max-w-[1480px] px-3 py-4 sm:px-5">
                <header className="flex flex-wrap items-end justify-between gap-3 border-b pb-4">
                    <div>
                        <p className="text-xs text-muted-foreground">阶段 02</p>
                        <h2 className="mt-1 text-lg font-semibold">十二宫格重绘</h2>
                        <p className="mt-1 text-sm text-muted-foreground">{twoStep ? "按已确认的分镜脚本，先生成模板图，再生成最终分镜图。每一步的图片和提示词都会保留。" : personBasic ? "使用飞书原文提示词和每组 12 张独立原帧，保留原产品与分镜动作，替换背景；提供人物图时替换人物外貌和服装，并按原文做人脸模糊。原镜头有人就保留人物，不能删人或改成纯产品镜头。左侧拼图仅用于预览。" : "使用所选飞书流程的原文提示词，从原分镜拼图单步生成最终图。"}</p>
                    </div>
                    <div className="flex flex-wrap items-end gap-2">
                        <ModelControl props={props} kind="image" label="生图模型" />
                        <Button disabled={disabled || ready.images} onClick={() => void props.onControl("step")}>
                            执行下一步生图
                        </Button>
                        <Tag className="!m-0">
                            {project.groups.filter((g) => g.image.status === "completed").length} / {project.groups.length} 已完成
                        </Tag>
                    </div>
                </header>
                {personBasic && display.groups.some((group) => group.image.result && (group.image.referenceUrls?.length || 0) < 13) && (
                    <p role="status" className="border-b py-3 text-sm text-amber-700">部分旧结果尚无 12 张独立原帧的输入记录。请对相应分组重新生图；已有结果不会自动改变。</p>
                )}
                {(!ready.planning || inputError) && (
                    <div className="flex items-center justify-between gap-2 border-b py-3 text-sm">
                        <span>{inputError || (basic ? "请先完成来源分析与拆帧。" : "请先完成分镜脚本和分镜提示词。")}</span>
                        <Button onClick={() => props.onStage(!ready.analysis ? "analysis" : "planning")}>{!ready.analysis ? "返回来源分析" : basic ? "设置替换素材" : "返回分镜脚本"}</Button>
                    </div>
                )}
                <div className="grid items-start gap-3 py-4">
                    {display.groups.map((group) => {
                        const grid = frameRemakeGrid(group.frames.length);
                        return (
                            <RemakeGroupCard
                                key={group.id}
                                group={{
                                    id: `${group.frames[0].number}–${group.frames.at(-1)!.number}`,
                                    sourceContactSheet: group.contactSheet,
                                    replacementGeneration: { ...group.template, prompt: group.template.prompt || "" },
                                    imageGeneration: { ...group.image, prompt: group.image.prompt || "" },
                                }}
                                title={`分镜 ${group.frames[0].number}–${group.frames.at(-1)!.number} · ${group.frames.length} 宫格`}
                                description={`${grid.columns} 列 × ${grid.rows} 行 · ${twoStep ? "两步生成" : "直接重绘"} · ${frameRemakeSeconds(group)} 秒`}
                                sourceLabel="来源分镜图"
                                singleStep={!twoStep}
                                imageLabel={twoStep ? "第二步：最终分镜图" : "最终分镜图"}
                                prompts={{ replacement: twoStep ? group.template.prompt || frameRemakePromptPreview(() => frameRemakeImagePrompt(display, group, "template")) : "", storyboard: group.image.prompt || frameRemakePromptPreview(() => frameRemakeImagePrompt(display, group, "image")) }}
                                disabled={disabled}
                                onGenerate={() => void props.onControl("start", false, { groupId: group.id, restartFrom: "images" })}
                            />
                        );
                    })}
                </div>
                <div className="flex justify-end border-t pt-4">
                    <Button type="primary" icon={<Check className="size-4" />} disabled={!ready.images} onClick={() => props.onStage("production")}>
                        进入生产内容
                    </Button>
                </div>
            </div>
        </section>
    );
}
