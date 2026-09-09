import { App } from "antd";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { DramaProject } from "@/lib/drama-project-contract";
import { adoptDramaWorkflowArtifact, appendDramaWorkflowArtifact, createDramaWorkflowArtifact } from "@/lib/drama-workflow";
import type { DramaWorkflowStage } from "@/lib/drama-workflow-contract";
import { DramaWorkflowPanel } from "./drama-workflow-panel";
import { DramaWorkflowResult } from "./drama-workflow-result";

function project(): DramaProject {
    return { id: "analysis-project", title: "归来", summary: "", style: "动态漫", ratio: "9:16", status: "active", defaultVideoMode: "storyboard", characters: [], scenes: [], props: [], clues: [], createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z", episodes: [{ id: "episode", title: "第一集", script: "林夏带着旧信回到故乡，她要找到失踪的哥哥。", outline: "", hook: "", nextPreview: "", sourceRange: "", reviewStatus: "draft", shots: [] }] };
}

function renderPanel(value: DramaProject, stage: DramaWorkflowStage) {
    return renderToStaticMarkup(<App><DramaWorkflowPanel project={value} episode={value.episodes[0]} stage={stage} onStageChange={() => undefined} onAdoptingChange={() => undefined} /></App>);
}

describe("短剧分析结果面板", () => {
    it.each(["story", "characters", "beats"] as const)("%s 无产物时显示剧本入口且默认不展开手工表单", (stage) => {
        const markup = renderPanel(project(), stage);
        expect(markup).toContain("返回剧本开始分析");
        expect(markup).toContain("无需逐项填写");
        expect(visibleForms(parseFragment(markup))).toBe(0);
    });

    it("已有分析默认展示可读结果和编辑入口，未知时长不填成默认秒数", () => {
        const base = project();
        const artifact = createDramaWorkflowArtifact(base, { stage: "story", intent: "analysis", source: "ai", data: { logline: "林夏返乡寻找失踪的哥哥。", genre: "悬疑", audience: "", worldRules: "当代小镇", coreConflict: "旧信线索与邻里的隐瞒", adaptationMode: "faithful", lockedFacts: "林夏持有哥哥留下的旧信。", targetDuration: null, episodeCount: 1 } });
        const adopted = adoptDramaWorkflowArtifact(appendDramaWorkflowArtifact(base, artifact), artifact.id);
        const markup = renderPanel(adopted, "story");
        expect(markup).toContain('data-drama-analysis-result="story"');
        expect(markup).toContain("林夏返乡寻找失踪的哥哥。");
        expect(markup).toContain("原稿未标注单集时长");
        expect(markup).toContain("编辑分析结果");
        expect(markup).toContain("AI 重新分析");
        expect(visibleForms(parseFragment(markup))).toBe(0);
    });

    it("没有识别到人物时明确展示结果，而非制造空人物表单", () => {
        const artifact = createDramaWorkflowArtifact(project(), { stage: "characters", intent: "analysis", source: "ai", data: { characters: [] } });
        const markup = renderToStaticMarkup(<DramaWorkflowResult artifact={artifact} />);
        expect(markup).toContain("原稿中未识别到具名人物");
        expect(markup).not.toContain("<input");
    });

    it("节奏结果保留剧情顺序和原稿未标注的时长", () => {
        const artifact = createDramaWorkflowArtifact(project(), { stage: "beats", episodeId: "episode", intent: "analysis", source: "ai", data: { outline: "返乡寻亲", hook: "旧信背面出现陌生地址", nextPreview: "", beats: [{ id: "arrival", title: "返乡", duration: null, description: "林夏带旧信回到小镇", emotion: "疑惑", payoff: "旧信" }, { id: "search", title: "寻找哥哥", duration: 12, description: "邻里避谈哥哥的去向", emotion: "不安", payoff: "众人的隐瞒" }] } });
        const markup = renderToStaticMarkup(<DramaWorkflowResult artifact={artifact} />);
        expect(markup.indexOf("林夏带旧信回到小镇")).toBeLessThan(markup.indexOf("邻里避谈哥哥的去向"));
        expect(markup).toContain("原稿未标注时长");
        expect(markup).toContain("约 12 秒");
    });
});

function visibleForms(node: DefaultTreeAdapterMap["node"], hidden = false): number {
    const isHidden = hidden || ("attrs" in node && node.attrs.some((attribute) => attribute.name === "hidden"));
    const current = "tagName" in node && node.tagName === "form" && !isHidden ? 1 : 0;
    return current + ("childNodes" in node ? node.childNodes.reduce((total, child) => total + visibleForms(child, isHidden), 0) : 0);
}
