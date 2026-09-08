import { Clapperboard, ImagePlus, Package, ScanSearch, Shirt, UserRound, WandSparkles } from "lucide-react";

export const commerceVideoTools = [
    { slug: "bangbang", label: "带货短剧裂变", description: "上传产品图原创剧本，或按对标视频裂变，逐张制作九宫格。", icon: Clapperboard },
    { slug: "remake15", label: "15 秒换品换人", description: "替换产品和人物，制作 12 分镜短视频。", icon: Clapperboard },
    { slug: "remake60", label: "1 分钟换品换人", description: "48 分镜，分四段生成并合成完整视频。", icon: Clapperboard },
    { slug: "remake-product", label: "1 分钟只换产品", description: "保留原人物和背景，替换视频中的产品。", icon: Package },
    { slug: "remake-person", label: "1 分钟只换人物", description: "保留原产品，替换人物并设置目标背景。", icon: UserRound },
    { slug: "omni-clothing", label: "Omni 服装复刻", description: "上传服装参考图，按原视频切片替换服装。", icon: Shirt },
    { slug: "omni-remake", label: "Omni 全品类复刻", description: "按原视频切片，自选替换产品、人物和背景。", icon: WandSparkles },
    { slug: "remake", label: "1 分钟换品换人（早期版）", description: "替换产品并按需换人，继续已有复刻项目。", icon: ScanSearch },
] as const;

export const commerceImageTool = {
    slug: "commerce/image",
    label: "电商图生成",
    description: "制作商品主图、场景图、详情页和营销海报。",
    icon: ImagePlus,
} as const;

export function commerceToolForPathname(pathname: string) {
    return [...commerceVideoTools, commerceImageTool].find((tool) => pathname === `/${tool.slug}` || pathname.startsWith(`/${tool.slug}/`));
}
