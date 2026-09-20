import { describe, expect, it, vi } from "vitest";

import { imageTaskRequestPrompt } from "@/app/api/image-tasks/image-task-support";
import { REMAKE_FEISHU_IMAGE_PROMPT } from "./remake-person-feishu-prompts";
import { remakeStoryboardPrompt, remakeStoryboardPromptReferences } from "./remake-person-image-prompt";

const photo = (name: string) => ({ url: `https://example.com/${name}.png` });

describe("person remake image bindings", () => {
    it.each([
        [false, false, 13],
        [true, false, 14],
        [false, true, 14],
        [true, true, 15],
    ] as const)("binds exactly the uploaded images (character=%s, product=%s)", (character, product, count) => {
        const input = { frames: Array.from({ length: 12 }, (_, i) => photo(`frame-${i + 13}`)), background: photo("background"), character: character ? photo("person") : undefined, product: product ? photo("product") : undefined };
        const references = remakeStoryboardPromptReferences(input);
        const prompt = remakeStoryboardPrompt("13-24", [], "", input);
        expect(prompt.startsWith(REMAKE_FEISHU_IMAGE_PROMPT + "\n\n")).toBe(true);
        const bindingText = prompt.slice(REMAKE_FEISHU_IMAGE_PROMPT.length);
        const lines = bindingText.split("\n").filter((line) => line.startsWith("@图片"));
        expect(lines).toHaveLength(count);
        references.forEach((reference, index) => {
            expect(lines[index]).toContain(`@图片${index + 1}（实际输入的第${index + 1}张图片）`);
            expect(lines[index]).toContain(index < 12 ? `全片分镜${index + 13}` : reference.label);
        });
        expect(bindingText.includes("：人物六宫格图")).toBe(character);
        expect(bindingText.includes("：原产品参考图")).toBe(product);
        expect(references[12].asset.url).toBe(input.background.url);
        if (product) {
            expect(references.at(-1)?.asset.url).toBe(input.product?.url);
            expect(lines.at(-1)).toContain("原产品参考图");
            expect(lines.at(-1)).toContain("位置、角度、画面占比、状态和手部互动仍以对应原始分镜为准");
        }
        const decorate = vi.fn(() => "unrelated image instructions");
        expect(imageTaskRequestPrompt({ projectId: "remake-person-test", generationSlotId: "remake-person:13-24:storyboard", prompt }, decorate)).toBe(prompt);
        expect(decorate).not.toHaveBeenCalled();
    });

    it.each(["1-12", "13-24", "25-36", "37-48"])("maps the local twelve cells to the original %s shot range", (groupId) => {
        const input = { frames: Array.from({ length: 12 }, (_, i) => photo(`frame-${i}`)), background: photo("background") };
        const prompt = remakeStoryboardPrompt(groupId, [], "", input);
        const first = Number(groupId.split("-")[0]);
        expect(prompt).toContain(`本次十二宫格第1格、全片分镜${first}。`);
        expect(prompt).toContain(`本次十二宫格第12格、全片分镜${first + 11}。`);
    });
});
