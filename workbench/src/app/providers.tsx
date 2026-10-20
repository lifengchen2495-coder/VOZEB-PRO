"use client";

import { AntdRegistry } from "@ant-design/nextjs-registry";
import { App, ConfigProvider, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { useSyncExternalStore, type ReactNode } from "react";

const query = "(prefers-color-scheme: dark)";
const subscribe = (notify: () => void) => {
    const media = window.matchMedia(query);
    media.addEventListener("change", notify);
    return () => media.removeEventListener("change", notify);
};

// 主题跟随系统浅色/深色
export function Providers({ children }: { children: ReactNode }) {
    const dark = useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
    return (
        <AntdRegistry>
            <ConfigProvider locale={zhCN} theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm, token: { colorPrimary: "#6d5efc", borderRadius: 10 } }}>
                <App className="h-full">{children}</App>
            </ConfigProvider>
        </AntdRegistry>
    );
}
