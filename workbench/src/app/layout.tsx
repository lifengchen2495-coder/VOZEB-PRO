import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = { title: "VOZEB 本地工作台", description: "本地运行的 AI 对话、图片与视频创作工作台", icons: { icon: "/icon.svg" } };

export default function RootLayout({ children }: { children: ReactNode }) {
    return (
        <html lang="zh-CN">
            <body>
                <Providers>{children}</Providers>
            </body>
        </html>
    );
}
