import type { Metadata } from "next";
import type { ReactNode } from "react";
import { brand } from "@/lib/brand";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = { title: brand.title, description: brand.slogan, icons: { icon: "/icon.svg" } };

export default function RootLayout({ children }: { children: ReactNode }) {
    return (
        <html lang="zh-CN">
            <body>
                <Providers>{children}</Providers>
            </body>
        </html>
    );
}
