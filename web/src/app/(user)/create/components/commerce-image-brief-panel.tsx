"use client";

import { Button, Image, Input, Select } from "antd";
import { ChevronDown, ChevronUp, ImagePlus, LayoutTemplate, Package, Pencil, X } from "lucide-react";
import { useId, useState } from "react";

import { COMMERCE_IMAGE_REFERENCE_ROLES, type CommerceImageBrief, type CommerceImageReferenceRole } from "@/lib/commerce-image-brief";
import { creativeAssetReferenceAliases } from "@/lib/creative-asset-references";
import type { CreativeAsset } from "@/lib/creative-runtime-contract";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { cn } from "@/lib/utils";

const PLATFORM_OPTIONS = ["通用电商", "淘宝 / 天猫", "京东", "拼多多", "抖音电商", "小红书", "Amazon", "TikTok Shop", "独立站"].map((value) => ({ value, label: value }));
const IMAGE_TYPE_OPTIONS = ["白底主图", "场景展示图", "卖点图", "细节特写", "人物佩戴 / 使用图", "活动宣传图"].map((value) => ({ value, label: value }));
const labelClass = "mb-1.5 block text-xs font-medium text-[#46515d] dark:text-[#c0c8d2]";
const hintClass = "text-xs leading-5 text-[#7f8995] dark:text-[#929daa]";

export type CommerceImageBriefPanelProps = {
    brief: CommerceImageBrief;
    assets: CreativeAsset[];
    selectedAssetIds: string[];
    onChange: (brief: CommerceImageBrief) => void;
    onUpload: (role: CommerceImageReferenceRole) => void;
    onRemoveAsset: (id: string) => void;
    disabled?: boolean;
    compact?: boolean;
    onExpand?: () => void;
};

export function CommerceImageBriefPanel({ brief, assets, selectedAssetIds, onChange, onUpload, onRemoveAsset, disabled = false, compact = false, onExpand }: CommerceImageBriefPanelProps) {
    const fieldId = useId();
    const [expanded, setExpanded] = useState(false);
    const aliases = creativeAssetReferenceAliases(assets, selectedAssetIds);
    const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
    const selectedIds = Array.from(new Set(selectedAssetIds));
    const validImageIds = selectedIds.filter((id) => {
        const asset = assetsById.get(id);
        return asset?.type === "image" && asset.status === "ready" && Boolean(asset.serverUrl?.trim() || asset.remoteUrl?.trim());
    });
    const productCount = validImageIds.filter((id) => brief.referenceRoles[id] === "product").length;
    const layoutCount = validImageIds.filter((id) => brief.referenceRoles[id] === "layout").length;
    const referenceEdit = brief.workflow === "reference-edit";
    const update = (patch: Partial<CommerceImageBrief>) => onChange({ ...brief, ...patch });

    if (compact && !expanded) {
        return (
            <section aria-label="电商图片需求摘要" className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-[#e4e8ed] px-1 py-2 dark:border-[#303740]">
                <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-[#394450] dark:text-[#d9e0e8]">
                        {referenceEdit ? "参考图改图" : "商品展示图"} · {brief.productName.trim() || "未填写产品"} · {brief.imageType}
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-[#7f8995] dark:text-[#929daa]">
                        {brief.platform} · {productCount} 张产品图{layoutCount ? ` · ${layoutCount} 张排版参考` : ""}
                    </p>
                </div>
                <Button type="text" size="small" icon={<Pencil className="size-3.5" />} className="shrink-0 !text-xs" onClick={() => (onExpand ? onExpand() : setExpanded(true))} aria-expanded={false}>
                    修改需求
                    <ChevronDown className="size-3.5" />
                </Button>
            </section>
        );
    }

    return (
        <section aria-labelledby={`${fieldId}-heading`} className="min-w-0 rounded-xl border border-[#e0e5ea] bg-white px-4 py-4 dark:border-[#303740] dark:bg-[#1b1f25] sm:px-5">
            <div className="mb-4 flex items-center justify-between gap-3">
                <h2 id={`${fieldId}-heading`} className="text-sm font-semibold text-[#252d36] dark:text-[#edf1f6]">电商图片</h2>
                {compact ? (
                    <Button type="text" size="small" className="!text-xs" icon={<ChevronUp className="size-3.5" />} onClick={() => setExpanded(false)} aria-expanded={true}>
                        收起
                    </Button>
                ) : null}
            </div>

            <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="电商图片工作流">
                {[
                    { value: "showcase" as const, label: "商品展示图", icon: Package },
                    { value: "reference-edit" as const, label: "参考图改图", icon: LayoutTemplate },
                ].map(({ value, label, icon: Icon }) => (
                    <button
                        key={value}
                        type="button"
                        disabled={disabled}
                        aria-pressed={brief.workflow === value}
                        onClick={() => update({ workflow: value })}
                        className={cn(
                            "inline-flex min-h-9 flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#688da4] disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none",
                            brief.workflow === value
                                ? "border-[#b4c5cf] bg-[#eef3f6] text-[#344d5d] dark:border-[#536b7a] dark:bg-[#283946] dark:text-[#d5e5ef]"
                                : "border-[#e0e5ea] bg-transparent text-[#6b7581] hover:border-[#b6c0c9] hover:text-[#303c48] dark:border-[#363f49] dark:text-[#a4afbb] dark:hover:border-[#687785] dark:hover:text-[#e6edf3]",
                        )}
                    >
                        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                        {label}
                    </button>
                ))}
            </div>

            <div className="grid min-w-0 gap-5 md:grid-cols-2 md:gap-6">
                <div className="min-w-0 space-y-3">
                    <div>
                        <label className={labelClass} htmlFor={`${fieldId}-product`}>产品名称 <span className="font-normal text-[#7f8995]">（必填）</span></label>
                        <Input id={`${fieldId}-product`} value={brief.productName} maxLength={100} placeholder="例如：不锈钢随行杯" disabled={disabled} onChange={(event) => update({ productName: event.target.value })} aria-required="true" />
                    </div>
                    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="min-w-0">
                            <label className={labelClass} htmlFor={`${fieldId}-platform`}>目标平台</label>
                            <Select id={`${fieldId}-platform`} className="w-full" value={brief.platform} options={PLATFORM_OPTIONS} disabled={disabled} onChange={(platform) => update({ platform })} />
                        </div>
                        <div className="min-w-0">
                            <label className={labelClass} htmlFor={`${fieldId}-type`}>图片用途</label>
                            <Select id={`${fieldId}-type`} className="w-full" value={brief.imageType} options={IMAGE_TYPE_OPTIONS} disabled={disabled} onChange={(imageType) => update({ imageType })} />
                        </div>
                    </div>
                    <div>
                        <label className={labelClass} htmlFor={`${fieldId}-selling`}>产品卖点 <span className="font-normal text-[#7f8995]">（选填）</span></label>
                        <Input.TextArea
                            id={`${fieldId}-selling`}
                            value={brief.sellingPoints}
                            maxLength={800}
                            autoSize={{ minRows: 2, maxRows: 4 }}
                            placeholder="填写真实卖点；需要上图的文案请写出原文"
                            disabled={disabled}
                            onChange={(event) => update({ sellingPoints: event.target.value })}
                        />
                    </div>
                    <div>
                        <label className={labelClass} htmlFor={`${fieldId}-requirements`}>{referenceEdit ? "改图要求" : "画面要求"}</label>
                        <Input.TextArea
                            id={`${fieldId}-requirements`}
                            value={brief.requirements}
                            maxLength={1500}
                            autoSize={{ minRows: 2, maxRows: 5 }}
                            placeholder={referenceEdit ? "例如：保留参考图的构图，换成我的商品，删除原来的促销文字" : "例如：暖色桌面场景，突出杯身质感，画面不加文字"}
                            disabled={disabled}
                            onChange={(event) => update({ requirements: event.target.value })}
                        />
                    </div>
                </div>

                <div className="min-w-0 border-t border-[#e8ecf0] pt-4 dark:border-[#303740] md:border-l md:border-t-0 md:pl-6 md:pt-0">
                    <div className="flex items-center justify-between gap-3">
                        <h3 className="text-xs font-medium text-[#46515d] dark:text-[#c0c8d2]">图片素材</h3>
                        <span className="text-[11px] text-[#7f8995] dark:text-[#929daa]">已选 {selectedIds.length} 张</span>
                    </div>
                    <p className={cn(hintClass, "mb-3 mt-1")}>{referenceEdit ? "至少 1 张产品图和 1 张排版参考。用产品图中的商品替换参考图中的商品。" : "至少 1 张产品图。添加参考图后，选择它是用于排版、背景还是人物。"}</p>
                    <div className="flex flex-wrap gap-2">
                        <Button icon={<ImagePlus className="size-3.5" />} disabled={disabled} className="!text-xs" onClick={() => onUpload("product")}>上传产品图</Button>
                        <Button icon={<LayoutTemplate className="size-3.5" />} disabled={disabled} className="!text-xs" onClick={() => onUpload("layout")}>上传参考图</Button>
                    </div>

                    {selectedIds.length ? (
                        <ul className="mt-3 max-h-64 space-y-0 overflow-y-auto pr-1" aria-label="本轮素材角色">
                            {selectedIds.map((assetId) => {
                                const asset = assetsById.get(assetId);
                                const alias = aliases.get(assetId);
                                const role = COMMERCE_IMAGE_REFERENCE_ROLES.find((item) => item.value === brief.referenceRoles[assetId]);
                                const url = asset?.serverUrl?.trim() || asset?.remoteUrl?.trim();
                                const usable = asset?.type === "image" && asset.status === "ready" && Boolean(url);
                                return (
                                    <li key={assetId} className="flex min-w-0 items-center gap-2.5 border-b border-[#edf0f3] py-2.5 last:border-b-0 dark:border-[#2c333c]">
                                        <div className="grid size-14 shrink-0 place-items-center overflow-hidden rounded-md bg-[#f0f3f6] text-[#8a96a2] dark:bg-[#28313b]">
                                            {usable && url ? <Image src={imagePreviewUrl(url, 320)} alt={asset?.title || "图片素材"} width={56} height={56} className="object-contain" preview={{ src: url }} /> : <ImagePlus className="size-5" aria-hidden="true" />}
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <div className="mb-1 flex min-w-0 items-center gap-1.5">
                                                {alias ? <span className="shrink-0 text-[11px] font-medium text-[#546b7a] dark:text-[#a9c0d1]">@{alias}</span> : null}
                                                <span className="truncate text-[11px] text-[#7f8995] dark:text-[#929daa]" title={asset?.title}>{asset?.title || "素材已不可用"}</span>
                                            </div>
                                            <Select<CommerceImageReferenceRole>
                                                size="small"
                                                value={role?.value}
                                                options={COMMERCE_IMAGE_REFERENCE_ROLES.map((item) => ({ value: item.value, label: item.label }))}
                                                placeholder="选择素材用途"
                                                status={usable && !role ? "warning" : undefined}
                                                className="w-full max-w-44"
                                                disabled={disabled || !usable}
                                                aria-label={`${alias ? `@${alias}` : "已选图片"}的素材用途`}
                                                onChange={(value) => update({ referenceRoles: { ...brief.referenceRoles, [assetId]: value } })}
                                            />
                                            {!usable ? <p className="mt-1 text-[11px] text-[#b1584e] dark:text-[#e99c93]">{asset?.type && asset.type !== "image" ? "请移除非图片素材" : "图片不可用，请重新上传"}</p> : null}
                                        </div>
                                        <Button type="text" size="small" icon={<X className="size-3.5" />} disabled={disabled} onClick={() => onRemoveAsset(assetId)} aria-label={`移除${alias ? ` @${alias}` : "素材"}`} title="移除素材" className="shrink-0 !text-[#8a95a1]" />
                                    </li>
                                );
                            })}
                        </ul>
                    ) : (
                        <p className={cn(hintClass, "mt-5 border-t border-[#e8ecf0] pt-4 dark:border-[#303740]")}>上传清晰产品图，保留真实颜色、材质和包装。参考图中的旧商品和旧文案不会作为你的商品信息。</p>
                    )}
                    {selectedIds.length ? <p className={cn(hintClass, "mt-2")}>{productCount === 0 ? "还需要将一张图片设为产品图。" : referenceEdit && layoutCount === 0 ? "还需要另一张图片作为排版参考。" : "产品图决定商品外观，其他图片只用于各自标注的用途。"}</p> : null}
                </div>
            </div>
        </section>
    );
}
