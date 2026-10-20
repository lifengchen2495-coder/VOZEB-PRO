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

// 主题跟随系统浅色/深色，颜色与 globals.css 中的变量保持一致
export function Providers({ children }: { children: ReactNode }) {
    const dark = useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
    const token = dark
        ? { colorPrimary: "#5fbf8f", colorBgContainer: "#191c1a", colorBgElevated: "#1f2320", colorBorder: "#2c312d", colorBorderSecondary: "#252a26" }
        : { colorPrimary: "#2f8a5f", colorBgContainer: "#ffffff", colorBgElevated: "#ffffff", colorBorder: "#e3e7e2", colorBorderSecondary: "#edf0ec" };
    return (
        <AntdRegistry>
            <ConfigProvider locale={zhCN} theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm, token: { ...token, borderRadius: 10, fontSize: 14 } }}>
                <App component={false}>{children}</App>
            </ConfigProvider>
        </AntdRegistry>
    );
}
