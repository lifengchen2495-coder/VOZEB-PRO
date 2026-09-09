"use client";

import { App, Button, Collapse, Input, Tabs } from "antd";
import { ArrowUpRight, Check, Copy, FileDown, ListChecks } from "lucide-react";
import Link from "next/link";

import { createAgentPromptHref, CREATE_AGENT_PROMPT_MAX_LENGTH } from "@/lib/create-agent-prompt";
import { exportCommerceVideoWorkflowJson, exportCommerceVideoWorkflowMarkdown, normalizeCommerceVideoWorkflow, type CommerceVideoWorkflow, type CommerceVideoWorkflowInput } from "@/lib/commerce-video-workflow";
import type { CommerceVideoWorkflowResult } from "@/services/api/commerce-video-workflow";

export function WorkflowResult({ result, input, onChange }: { result: CommerceVideoWorkflowResult; input: CommerceVideoWorkflowInput; onChange: (workflow: CommerceVideoWorkflow) => void }) {
    const { message } = App.useApp();
    const workflow = result.workflow;
    const copy = async (value: string) => {
        try {
            await navigator.clipboard.writeText(value);
            message.success("提示词已复制");
        } catch {
            message.error("复制失败，请选中文字后复制");
        }
    };
    const download = (format: "md" | "json") => {
        try {
            const checked = normalizeCommerceVideoWorkflow(workflow, input);
            const content = format === "md" ? exportCommerceVideoWorkflowMarkdown(checked) : exportCommerceVideoWorkflowJson(checked);
            const url = URL.createObjectURL(new Blob([content], { type: format === "md" ? "text/markdown;charset=utf-8" : "application/json;charset=utf-8" }));
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = `视频流程-${input.durationSeconds}秒.${format}`;
            anchor.click();
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (error) {
            message.warning(error instanceof Error ? error.message : "请检查流程内容后再导出");
        }
    };

    return (
        <section aria-label="视频生产流程" className="min-w-0" data-testid="commerce-video-workflow-result">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
                <div className="min-w-0">
                    <p className="mb-2 flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400"><Check className="size-3.5" />流程已生成</p>
                    <h2 className="break-words text-lg font-semibold">{workflow.title}</h2>
                    <p className="mt-2 text-xs text-muted-foreground">{input.durationSeconds} 秒 · {workflow.stages.length} 个阶段 · {result.skill.name}</p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                    <Button size="small" icon={<FileDown className="size-3.5" />} onClick={() => download("md")}>下载流程</Button>
                    <Button size="small" onClick={() => download("json")}>下载 JSON</Button>
                </div>
            </div>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">流程保留在当前页面，离开或刷新前请下载保存。</p>
            <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{workflow.summary}</p>
            <p className="mt-2 text-sm leading-6"><span className="font-medium">路线选择：</span>{workflow.route.reason}</p>

            <Tabs items={[
                {
                    key: "stages", label: "阶段与提示词", children: (
                        <div className="space-y-3">
                            <p className="text-xs leading-5 text-muted-foreground">提示词可以修改。打开创作后，添加该阶段所需的素材，再开始执行。</p>
                            <Collapse defaultActiveKey={workflow.stages[0] ? [workflow.stages[0].id] : []} items={workflow.stages.map((stage, index) => ({
                                key: stage.id,
                                label: <span className="text-sm font-medium">{index + 1}. {stage.title}</span>,
                                children: (
                                    <div className="min-w-0 space-y-3">
                                        <p className="text-sm leading-6">{stage.goal}</p>
                                        <dl className="grid gap-2 text-xs leading-5 sm:grid-cols-2">
                                            <div><dt className="font-medium">需要输入</dt><dd className="mt-1 whitespace-pre-wrap text-muted-foreground">{stage.inputs.join("、")}</dd></div>
                                            <div><dt className="font-medium">阶段产物</dt><dd className="mt-1 whitespace-pre-wrap text-muted-foreground">{stage.outputs.join("、")}</dd></div>
                                        </dl>
                                        {stage.dependsOn.length ? <p className="text-xs leading-5 text-muted-foreground">先完成：{stage.dependsOn.map((id) => workflow.stages.find((item) => item.id === id)?.title || id).join("、")}</p> : null}
                                        <Input.TextArea aria-label={`${stage.title}提示词`} value={stage.prompt} autoSize={{ minRows: 6, maxRows: 16 }} maxLength={6000} onChange={(event) => onChange({ ...workflow, stages: workflow.stages.map((item) => item.id === stage.id ? { ...item, prompt: event.target.value } : item) })} />
                                        <div className="flex flex-wrap items-center gap-2">
                                            <Button size="small" icon={<Copy className="size-3.5" />} disabled={!stage.prompt.trim()} onClick={() => void copy(stage.prompt)}>复制提示词</Button>
                                            <ExecutionLink execution={stage.execution} prompt={stage.prompt} />
                                        </div>
                                    </div>
                                ),
                            }))} />
                        </div>
                    ),
                },
                {
                    key: "segments", label: "视频分段", children: (
                        <div className="space-y-5">
                            <p className="text-xs leading-5 text-muted-foreground">共 {input.durationSeconds} 秒。逐段制作并检查衔接，完成后按流程安排剪辑与音频。</p>
                            {workflow.segments.map((segment, index) => (
                                <article key={segment.id} className="min-w-0 border-b border-border pb-5 last:border-0">
                                    <h3 className="text-sm font-semibold">第 {index + 1} 段 · {segment.startSeconds}–{segment.endSeconds} 秒</h3>
                                    <p className="my-2 text-sm leading-6">{segment.goal}</p>
                                    <Input.TextArea aria-label={`第 ${index + 1} 段视频提示词`} value={segment.visualPrompt} autoSize={{ minRows: 4, maxRows: 12 }} maxLength={4000} onChange={(event) => onChange({ ...workflow, segments: workflow.segments.map((item) => item.id === segment.id ? { ...item, visualPrompt: event.target.value } : item) })} />
                                    {segment.voiceover ? <p className="mt-2 whitespace-pre-wrap text-xs leading-5"><span className="font-medium">旁白：</span>{segment.voiceover}</p> : null}
                                    <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">衔接要求：{segment.continuityNotes}</p>
                                    <div className="mt-3 flex flex-wrap gap-2">
                                        <Button size="small" icon={<Copy className="size-3.5" />} disabled={!segment.visualPrompt.trim()} onClick={() => void copy(segment.visualPrompt)}>复制该段提示词</Button>
                                        <ExecutionLink execution="video" prompt={segment.visualPrompt} />
                                    </div>
                                </article>
                            ))}
                        </div>
                    ),
                },
                {
                    key: "materials", label: "素材与检查", children: (
                        <div className="space-y-5">
                            <p className="text-xs leading-5 text-muted-foreground">“已有”来自你填写的素材状态。具体画面、声音和产品外观将在执行对应阶段时分析。</p>
                            <ul className="divide-y divide-border">
                                {workflow.materialChecklist.map((material) => (
                                    <li key={material.id} className="flex min-w-0 items-start gap-3 py-3">
                                        <span className={`mt-0.5 shrink-0 rounded px-2 py-0.5 text-xs ${material.status === "missing" ? "bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300" : "bg-muted text-muted-foreground"}`}>{material.status === "ready" ? "已有" : material.status === "missing" ? "待补充" : "可选"}</span>
                                        <div className="min-w-0"><p className="text-sm font-medium">{material.name}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{material.purpose}</p></div>
                                    </li>
                                ))}
                            </ul>
                            <div>
                                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><ListChecks className="size-4" />执行检查</h3>
                                <ul className="list-disc space-y-2 pl-5 text-sm leading-6 text-muted-foreground">{workflow.checks.map((check, index) => <li key={index}>{check}</li>)}</ul>
                            </div>
                        </div>
                    ),
                },
            ]} />
        </section>
    );
}

function ExecutionLink({ execution, prompt }: { execution: CommerceVideoWorkflow["stages"][number]["execution"]; prompt: string }) {
    if (execution !== "image" && execution !== "video") return <span className="text-xs text-muted-foreground">{execution === "text" ? "复制到文本模型执行" : execution === "edit" ? "在剪辑工具中完成" : "按本阶段要求手动完成"}</span>;
    if (prompt.trim().length > CREATE_AGENT_PROMPT_MAX_LENGTH) return <span className="text-xs text-muted-foreground">提示词较长，请精简后打开创作，或复制后分步执行。</span>;
    if (!prompt.trim()) return null;
    return <Link href={createAgentPromptHref(prompt, { mode: execution })} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-8 items-center gap-1 rounded-md border border-border px-2.5 text-xs transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">{execution === "image" ? "打开图片创作" : "打开视频创作"}<ArrowUpRight className="size-3.5" /></Link>;
}
