import type { ReactNode } from "react";

export default function FrameRemakeLayout({ children }: { children: ReactNode }) {
    // 工作空间外壳固定高度并隐藏溢出，由本路由承接入口页和详情页的纵向滚动。
    return <div className="h-full min-h-0 overflow-y-auto overscroll-y-contain">{children}</div>;
}
