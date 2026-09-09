import { Clapperboard, ImagePlus, Package, ScanSearch, Shirt, UserRound, WandSparkles } from "lucide-react";

export const commerceVideoTools = [
    { slug: "bangbang", label: "带货短剧裂变", description: "上传产品图原创剧本，或按对标视频裂变，逐张制作九宫格。", icon: Clapperboard },
    { slug: "remake15", label: "15 秒换品换人", description: "替换产品和人物，制作 12 分镜短视频。", icon: Clapperboard },
    { slug: "remake", label: "1 分钟换品换人", description: "替换产品并按需换人，制作 1 分钟复刻视频。", icon: ScanSearch },
    { slug: "remake-product", label: "1 分钟只换产品", description: "保留原人物和背景，替换视频中的产品。", icon: Package },
    { slug: "remake-person", label: "1 分钟只换人物", description: "保留原产品，替换人物并设置目标背景。", icon: UserRound },
    { slug: "omni-clothing", label: "Omni 服装复刻", description: "准备服装参考片段与提示词，手动生成后回传合并。", icon: Shirt },
    { slug: "omni-remake", label: "Omni 全品类复刻", description: "准备产品、人物、背景素材和提示词，手动生成后回传合并。", icon: WandSparkles },
] as const;

// 新版入口不再展示，保留已有项目链接的导航信息。
const remake60Tool = { slug: "remake60", label: "1 分钟换品换人", description: "48 分镜，分四段生成并合成完整视频。", icon: Clapperboard } as const;

export const commerceImageTool = {
    slug: "commerce/image",
    label: "电商图生成",
    description: "制作商品主图、场景图、详情页和营销海报。",
    icon: ImagePlus,
} as const;

export const commerceVideoWorkflowTool = {
    slug: "commerce/video",
    label: "视频流程生成",
    description: "按需求调用视频 Skill，安排素材、分镜、制作步骤与提示词。",
    icon: Clapperboard,
} as const;

export function commerceToolForPathname(pathname: string) {
    return [...commerceVideoTools, commerceImageTool, commerceVideoWorkflowTool, remake60Tool].find((tool) => pathname === `/${tool.slug}` || pathname.startsWith(`/${tool.slug}/`));
}
