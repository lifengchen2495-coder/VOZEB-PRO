/**
 * 原文保存在 frame-remake-upper-original-prompts.json，禁止在归档正文上直接改写。
 * 此处只有可审计的机械参数替换：每组 12 镜头、4 个字幕区间和本组时长。
 * 没有添加换品、换人、画面、口播或输出格式规则。
 */
export function parameterizeFrameRemakeOriginal(original: string, kind: "analysis" | "copy" | "video", seconds: number, originalVideoGroup = 1) {
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 15) throw new Error("当前组时长需大于0且不超过15秒");
    const duration = String(Number(seconds.toFixed(3)));
    if (kind === "video") {
        if (!Number.isInteger(originalVideoGroup) || originalVideoGroup < 1 || originalVideoGroup > 4) throw new Error("视频提示词原文分组编号无效");
        const offset = (originalVideoGroup - 1) * 12;
        // 原表后续组使用全片编号；每次模型调用绑定的是当前组的局部 1–12 镜头。
        const local = offset ? original.replace(/(分镜|动作描述)(\d+)(?:-(\d+))?/g, (match, label: string, first: string, last?: string) => {
            const start = Number(first) - offset;
            const end = last === undefined ? undefined : Number(last) - offset;
            if (start < 1 || start > 12 || (end !== undefined && (end < start || end > 12))) throw new Error(`视频提示词原文包含其他组编号：${match}`);
            return `${label}${start}${end === undefined ? "" : `-${end}`}`;
        }).replaceAll(`第${["一", "二", "三", "四"][originalVideoGroup - 1]}部分`, "第一部分") : original;
        return local.replaceAll("48分镜", "12分镜").replaceAll("15秒", `${duration}秒`);
    }
    if (kind === "analysis") {
        return original
            .replace(/^- \*\*第[二三四]部分\*\*：[^\n]+\n/gm, "")
            .replaceAll("48", "12")
            .replaceAll("60秒", `${duration}秒`)
            .replaceAll("4个部分", "1个部分")
            .replaceAll("4张十二宫格", "1张十二宫格");
    }
    // 仅保留首个十二宫格对应的四行字幕表，其余三组由各自独立请求执行。
    return original
        .replace(/^\| 分镜(?:13-15|46-48) \|[^\n]+\n/gm, "")
        .replace(/^\| \.\.\. \| \.\.\. \|\n/gm, "")
        .replace(/^\| \*\*第[二三四]部分\*\* \|[^\n]+\n/gm, "")
        .replace(/^- 第[二三四]部分：[^\n]+\n/gm, "")
        .replace(/\n---\n\n=== 第二部分：分镜13-24[^]*?(?=\n```\n\n---\n\n## 【输出示例】)/, "")
        .replaceAll("分镜1-3、4-6、7-9...46-48", "分镜1-3、4-6、7-9、10-12")
        .replaceAll("1-3、4-6、7-9...", "1-3、4-6、7-9、10-12")
        .replaceAll("48个分镜", "12个分镜")
        .replaceAll("四部分输出", "一部分输出")
        .replaceAll("4张十二宫格", "1张十二宫格")
        .replaceAll("4部分输出", "1部分输出")
        .replaceAll("16个", "4个")
        .replaceAll("÷ 16", "÷ 4")
        .replaceAll("0-15秒", `0-${duration}秒`);
}
