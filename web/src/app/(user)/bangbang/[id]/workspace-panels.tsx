"use client";
import { Copy, Upload, X } from "lucide-react";
import { ModelPicker } from "@/components/model-picker";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { bangbangCreationMode, bangbangImageBlockReason, type BangbangGroup, type BangbangInputPatch, type BangbangProject } from "@/lib/bangbang-contract";
import { Button, Field, Input, Textarea } from "../controls";

export type PanelProps = { project: BangbangProject; disabled: boolean; change: (patch: BangbangInputPatch) => void; upload: (file: File, category: "video" | "product" | "character" | "scene") => void };
const referenceLabels = { product: "产品", character: "人物", scene: "场景" };
export function ReferencePanel({ project, disabled, change, upload, category }: PanelProps & { category: "product" | "character" | "scene" }) {
    const items = project.references[category];
    const label = referenceLabels[category];
    return (
        <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-medium">
                    {label}参考图 <span className="font-normal text-muted-foreground">{items.length} 张</span>
                </h3>
                <label className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs focus-within:ring-2 focus-within:ring-ring ${disabled ? "opacity-50" : "hover:bg-muted"}`}>
                    <Upload className="size-3.5" />
                    添加{label}图
                    <input
                        className="sr-only"
                        aria-label={`上传${label}参考图`}
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        disabled={disabled}
                        onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = "";
                            if (file) upload(file, category);
                        }}
                    />
                </label>
            </div>
            {items.length ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {items.map((item) => (
                        <div key={item.id} className="min-w-0 space-y-2">
                            <div className="relative overflow-hidden rounded-lg border bg-muted">
                                <a href={item.media.url} target="_blank" rel="noreferrer">
                                    <img src={item.media.url} alt={item.label || `${label}参考图`} className="aspect-square w-full object-contain" />
                                </a>
                                <button
                                    aria-label={`移除${item.label || label}参考图`}
                                    className="absolute right-1 top-1 rounded-full border bg-background p-1 disabled:opacity-50"
                                    disabled={disabled}
                                    onClick={() => change({ references: { ...project.references, [category]: items.filter((value) => value.id !== item.id) } })}
                                >
                                    <X className="size-3.5" />
                                </button>
                            </div>
                            <Input
                                aria-label={`${item.id} 参考图名称`}
                                value={item.label}
                                disabled={disabled}
                                placeholder={`${label}名称`}
                                onChange={(event) => change({ references: { ...project.references, [category]: items.map((value) => (value.id === item.id ? { ...value, label: event.target.value } : value)) } })}
                            />
                        </div>
                    ))}
                </div>
            ) : (
                <p className="rounded-lg border border-dashed p-4 text-xs leading-5 text-muted-foreground">
                    {category === "product" ? "上传清晰产品图，用于外观识别与产品出镜。" : category === "character" ? "上传人物定妆照，生成人物清单后绑定到对应角色。" : "可选。上传希望保持一致的场景参考。"}
                </p>
            )}
        </section>
    );
}
export function InputPanel(props: PanelProps) {
    const { project, disabled, change, upload } = props;
    const config = useEffectiveConfig();
    const openConfig = useConfigStore((state) => state.openConfigDialog);
    const creationMode = bangbangCreationMode(project);
    const productMode = creationMode === "product";
    return (
        <div className="space-y-8">
            <fieldset disabled={disabled} className="space-y-3">
                <legend className="text-sm font-medium">创作方式</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                    {(
                        [
                            ["product", "产品原创", "上传产品图，从商品特点出发创作全新短剧。"],
                            ["reference", "对标裂变", "上传对标视频，分析原片后改编新的产品短剧。"],
                        ] as const
                    ).map(([mode, label, description]) => (
                        <label key={mode} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4 ${creationMode === mode ? "border-primary bg-primary/5" : "hover:bg-muted/40"}`}>
                            <input type="radio" className="mt-1 accent-primary" name="creation-mode" aria-label={label} checked={creationMode === mode} onChange={() => change({ creationMode: mode })} />
                            <span>
                                <span className="block text-sm font-medium">{label}</span>
                                <span className="mt-1 block text-xs leading-6 text-muted-foreground">{description}</span>
                            </span>
                        </label>
                    ))}
                </div>
                <p className="text-xs text-muted-foreground">切换方式并保存后，需要重新生成创作结果。</p>
            </fieldset>
            <div className="grid gap-6 lg:grid-cols-2">
                <div className="space-y-4">
                    <Field label="项目名称">
                        <Input aria-label="项目名称" value={project.title} maxLength={160} disabled={disabled} onChange={(event) => change({ title: event.target.value })} />
                    </Field>
                    {productMode ? (
                        <ReferencePanel {...props} category="product" />
                    ) : (
                        <>
                            <Field label="对标视频">
                                {project.sourceVideo ? (
                                    <video src={project.sourceVideo.url} controls preload="metadata" className="max-h-72 w-full rounded-lg bg-black" />
                                ) : (
                                    <div className="flex aspect-video items-center justify-center rounded-lg border border-dashed bg-muted/30 text-sm text-muted-foreground">上传对标视频，保留原片的剧情与镜头依据</div>
                                )}
                            </Field>
                            <label className={`flex cursor-pointer items-center justify-center gap-2 rounded-lg border px-4 py-3 text-sm ${disabled ? "opacity-50" : "hover:bg-muted"}`}>
                                <Upload className="size-4" />
                                {project.sourceVideo ? "更换对标视频" : "上传对标视频"}
                                <input
                                    className="sr-only"
                                    aria-label="上传对标视频"
                                    type="file"
                                    accept="video/mp4,video/quicktime,video/webm"
                                    disabled={disabled}
                                    onChange={(event) => {
                                        const file = event.target.files?.[0];
                                        event.target.value = "";
                                        if (file) upload(file, "video");
                                    }}
                                />
                            </label>
                            <p className="text-xs text-muted-foreground">支持 MP4、MOV、WebM，最大 200 MB。</p>
                        </>
                    )}
                </div>
                <section className="space-y-4">
                    <h3 className="font-medium">产品事实卡</h3>
                    {productMode && <p className="text-xs leading-6 text-muted-foreground">仅上传产品图即可开始。名称可以留空，系统会尝试从图片识别；卖点、价格和优惠请按实际情况补充。</p>}
                    {(
                        [
                            ["name", "产品名称"],
                            ["appearance", "外观与包装"],
                            ["sellingPoints", "已确认卖点"],
                            ["price", "价格与优惠"],
                        ] as const
                    ).map(([key, label]) => (
                        <Field key={key} label={label}>
                            {key === "sellingPoints" || key === "appearance" ? (
                                <Textarea aria-label={label} value={project.product[key]} disabled={disabled} onChange={(event) => change({ product: { ...project.product, [key]: event.target.value } })} />
                            ) : (
                                <Input
                                    aria-label={label}
                                    value={project.product[key]}
                                    disabled={disabled}
                                    placeholder={productMode && key === "name" ? "可留空，从产品图识别" : undefined}
                                    onChange={(event) => change({ product: { ...project.product, [key]: event.target.value } })}
                                />
                            )}
                        </Field>
                    ))}
                </section>
            </div>
            <div className={`grid gap-6 ${productMode ? "md:grid-cols-2" : "md:grid-cols-3"}`}>
                {(["product", "character", "scene"] as const)
                    .filter((category) => !productMode || category !== "product")
                    .map((category) => (
                        <ReferencePanel key={category} {...props} category={category} />
                    ))}
            </div>
            <div className="grid gap-4 md:grid-cols-2">
                <Field label="目标时长（秒）">
                    <Input aria-label="目标时长（秒）" type="number" min={15} max={300} value={project.targetDuration} disabled={disabled} onChange={(event) => change({ targetDuration: Number(event.target.value) })} />
                </Field>
                <Field label="每段视频最长时长（秒）">
                    <Input aria-label="每段视频最长时长（秒）" type="number" min={5} max={30} value={project.maxSegmentSeconds} disabled={disabled} onChange={(event) => change({ maxSegmentSeconds: Number(event.target.value) })} />
                </Field>
            </div>
            <Field label="创作要求">
                <Textarea aria-label="创作要求" value={project.instructions} disabled={disabled} placeholder="目标人群、情绪、禁止出现的内容，以及必须保留的情节" onChange={(event) => change({ instructions: event.target.value })} />
            </Field>
            <fieldset disabled={disabled} className={`grid gap-4 border-t pt-6 ${productMode ? "md:grid-cols-2" : "md:grid-cols-3"} ${disabled ? "pointer-events-none opacity-50" : ""}`}>
                {(
                    [
                        ["analysis", "视频分析模型", "text"],
                        ["prompt", "剧本与提示词模型", "text"],
                        ["image", "九宫格生图模型", "image"],
                    ] as const
                )
                    .filter(([key]) => !productMode || key !== "analysis")
                    .map(([key, label, capability]) => (
                        <div key={key} className="min-w-0 space-y-2">
                            <p className="text-sm font-medium">{label}</p>
                            <ModelPicker
                                config={config}
                                capability={capability}
                                fullWidth
                                value={project.modelSelection[key] || ""}
                                placeholder={key === "analysis" ? "自动选择可用模型" : "使用平台默认模型"}
                                onChange={(value) => {
                                    if (!disabled) change({ modelSelection: { ...project.modelSelection, [key]: value } });
                                }}
                                onMissingConfig={() => openConfig(true)}
                            />
                            {project.modelSelection[key] && (
                                <button type="button" className="text-xs text-muted-foreground underline underline-offset-4 disabled:opacity-50" disabled={disabled} onClick={() => change({ modelSelection: { ...project.modelSelection, [key]: "" } })}>
                                    {key === "analysis" ? "恢复自动选择" : "恢复平台默认"}
                                </button>
                            )}
                        </div>
                    ))}
            </fieldset>
        </div>
    );
}
export function DirectionPanel({ project, disabled, change }: Pick<PanelProps, "project" | "disabled" | "change">) {
    const directionLabel = bangbangCreationMode(project) === "product" ? "创作方向" : "裂变方向";
    return (
        <div className="space-y-4">
            <fieldset className="space-y-3" disabled={disabled}>
                <legend className="mb-3 text-sm font-medium">选择{directionLabel}</legend>
                {project.directions.map((direction) => (
                    <label key={direction.id} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4 ${project.selectedDirectionId === direction.id && !project.customDirection ? "border-primary bg-primary/5" : "hover:bg-muted/40"}`}>
                        <input
                            className="mt-1 accent-primary"
                            type="radio"
                            name="direction"
                            aria-label={`选择方向：${direction.title}`}
                            checked={project.selectedDirectionId === direction.id && !project.customDirection}
                            onChange={() => change({ selectedDirectionId: direction.id, customDirection: "" })}
                        />
                        <span className="min-w-0">
                            <span className="font-medium">{direction.title}</span>
                            <span className="mt-1 block whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{direction.description}</span>
                        </span>
                    </label>
                ))}
            </fieldset>
            <Field label={`自定义${directionLabel}`}>
                <Textarea
                    aria-label={`自定义${directionLabel}`}
                    value={project.customDirection}
                    disabled={disabled}
                    placeholder="也可以直接写下希望采用的新人物关系、冲突和成交设计"
                    onChange={(event) => change({ customDirection: event.target.value, selectedDirectionId: "" })}
                />
            </Field>
        </div>
    );
}
export function CharactersPanel(props: PanelProps) {
    const { project, disabled, change } = props;
    return (
        <div className="space-y-6">
            <ReferencePanel {...props} category="character" />
            {project.characters.length > 0 && (
                <div className="divide-y rounded-lg border">
                    {project.characters.map((character) => (
                        <div key={character.id} className="grid gap-4 p-4 sm:grid-cols-[1fr_14rem]">
                            <div className="min-w-0">
                                <h3 className="font-medium">
                                    {character.name}{" "}
                                    <span className="text-xs font-normal text-muted-foreground">
                                        {character.gender} · {character.age}
                                    </span>
                                </h3>
                                <p className="mt-1 text-sm text-muted-foreground">{character.role}</p>
                                <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{character.appearance}</p>
                            </div>
                            <div className="space-y-2">
                                <label className="text-xs text-muted-foreground" htmlFor={`character-${character.id}`}>
                                    人物参考图
                                </label>
                                <select
                                    id={`character-${character.id}`}
                                    aria-label={`绑定 ${character.name} 参考图`}
                                    className="h-10 w-full rounded-lg border bg-background px-2 text-sm disabled:opacity-50"
                                    value={character.imageId || ""}
                                    disabled={disabled}
                                    onChange={(event) => change({ characterImages: project.characters.map((item) => ({ characterId: item.id, imageId: item.id === character.id ? event.target.value : item.imageId || "" })) })}
                                >
                                    <option value="">请选择参考图</option>
                                    {project.references.character.map((reference) => (
                                        <option key={reference.id} value={reference.id}>
                                            {reference.label || reference.media.originalName || reference.id}
                                        </option>
                                    ))}
                                </select>
                                {project.references.character.find((reference) => reference.id === character.imageId)?.media.url && (
                                    <img className="h-24 w-24 rounded-lg border object-contain" src={project.references.character.find((reference) => reference.id === character.imageId)!.media.url} alt={`${character.name} 已绑定参考图`} />
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
const imageStatuses: Record<BangbangGroup["image"]["status"], string> = { idle: "待生成", queued: "提交待确认", running: "生成中", review: "待审图", approved: "已确认", error: "生成失败" };
export function GroupPanel({
    project,
    disabled,
    actionsDisabled = disabled,
    promptChange,
    generate,
    approve,
    cancel,
    save,
    mode,
}: {
    project: BangbangProject;
    disabled: boolean;
    actionsDisabled?: boolean;
    promptChange: (id: string, text: string) => void;
    generate: (id: string) => void;
    approve: (id: string) => void;
    cancel?: (id: string) => void;
    save: () => void;
    mode: "storyboard" | "expand" | "optimize" | "images";
}) {
    return (
        <div className="space-y-6">
            {project.groups.map((group) => {
                const reason = bangbangImageBlockReason(project, group.id);
                return (
                    <article key={group.id} className="overflow-hidden rounded-xl border">
                        <header className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-4 py-3">
                            <div>
                                <h3 className="font-medium">
                                    第 {group.number} 组 · {group.scene}
                                </h3>
                                <p className="mt-1 text-xs text-muted-foreground">
                                    {group.start}–{group.end} 秒 · {group.frames.length} 帧 · {group.productVisible ? "产品出镜" : "产品不出镜"}
                                </p>
                            </div>
                            {mode === "images" && (
                                <span className={`rounded-md px-2 py-1 text-xs ${group.image.status === "approved" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "bg-muted text-muted-foreground"}`}>
                                    {imageStatuses[group.image.status]}
                                </span>
                            )}
                        </header>
                        <div className="space-y-4 p-4">
                            <div className="grid gap-3 text-sm sm:grid-cols-2">
                                <p>
                                    <span className="text-muted-foreground">剧情目标：</span>
                                    {group.goal}
                                </p>
                                <p>
                                    <span className="text-muted-foreground">人物状态：</span>
                                    {group.characterState}
                                </p>
                                <p className="whitespace-pre-wrap">
                                    <span className="text-muted-foreground">台词：</span>
                                    {group.dialogue}
                                </p>
                                <p>
                                    <span className="text-muted-foreground">连续性：</span>
                                    {group.continuity}
                                </p>
                            </div>
                            {mode !== "storyboard" && group.frames.length > 0 && (
                                <details open={mode === "expand"}>
                                    <summary className="cursor-pointer text-sm font-medium">查看九格分镜（{group.frames.length}/9）</summary>
                                    <div className="mt-3 grid grid-cols-1 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3">
                                        {group.frames.map((frame) => (
                                            <div key={frame.number} className="space-y-2 bg-background p-3">
                                                <span className="text-xs font-semibold text-muted-foreground">{String(frame.number).padStart(2, "0")}</span>
                                                <p className="text-sm leading-6">{frame.description}</p>
                                                <p className="text-xs leading-5 text-muted-foreground">
                                                    人物占比：{frame.characterRatio}
                                                    <br />
                                                    产品位置：{frame.productPosition}
                                                    <br />
                                                    参考：{frame.reference}
                                                </p>
                                            </div>
                                        ))}
                                    </div>
                                </details>
                            )}
                            {(mode === "optimize" || mode === "images") && (
                                <details open={mode === "optimize"}>
                                    <summary className="cursor-pointer text-sm font-medium">生图提示词</summary>
                                    <Textarea className="mt-3 min-h-48" aria-label={`第 ${group.number} 组生图提示词`} value={group.optimizedPrompt} disabled={disabled} onChange={(event) => promptChange(group.id, event.target.value)} />
                                    <Button variant="outline" className="mt-2" disabled={disabled} onClick={save}>
                                        保存提示词
                                    </Button>
                                </details>
                            )}
                            {mode === "images" && (
                                <>
                                    {group.image.result?.url && (
                                        <a href={group.image.result.url} target="_blank" rel="noreferrer" className="block">
                                            <img src={group.image.result.url} alt={`第 ${group.number} 组九宫格`} className="max-h-[70vh] w-full rounded-lg border bg-muted object-contain" />
                                        </a>
                                    )}
                                    {group.image.error && (
                                        <p role="alert" className="text-sm text-destructive">
                                            {group.image.error}
                                        </p>
                                    )}
                                    <div className="flex flex-wrap items-center gap-3">
                                        <Button disabled={actionsDisabled || Boolean(reason)} onClick={() => generate(group.id)}>
                                            {group.image.status === "queued" ? `检查第 ${group.number} 组提交` : group.image.result ? `重做第 ${group.number} 组` : `生成第 ${group.number} 组`}
                                        </Button>
                                        <Button variant="outline" disabled={disabled || group.image.status !== "review" || !group.image.result} onClick={() => approve(group.id)}>
                                            确认第 {group.number} 组
                                        </Button>
                                        {group.image.result && (
                                            <a className="text-sm underline underline-offset-4" href={group.image.result.url} target="_blank" rel="noreferrer">
                                                打开原图
                                            </a>
                                        )}
                                    </div>
                                    {reason && <p className="text-xs text-muted-foreground">{reason}</p>}
                                    {group.image.anchorGroupId && <p className="text-xs text-muted-foreground">连续性参考：{group.image.anchorGroupId}</p>}
                                </>
                            )}
                            {mode === "images" && group.image.status === "queued" && cancel && (
                                <Button variant="ghost" disabled={actionsDisabled} onClick={() => cancel(group.id)}>
                                    撤销第 {group.number} 组未确认提交
                                </Button>
                            )}
                        </div>
                    </article>
                );
            })}
        </div>
    );
}
export function FullOutput({ text, copy }: { text: string; copy: (text: string) => void }) {
    return (
        <details open className="rounded-lg border">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium">完整输出</summary>
            <div className="border-t">
                <div className="flex justify-end px-3 pt-3">
                    <Button variant="ghost" onClick={() => copy(text)}>
                        <Copy className="size-3.5" />
                        复制全文
                    </Button>
                </div>
                <pre className="max-h-[65vh] overflow-y-auto whitespace-pre-wrap break-words px-4 pb-5 font-sans text-sm leading-7">{text}</pre>
            </div>
        </details>
    );
}
