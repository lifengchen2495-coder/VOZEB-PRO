// 解析表格提示词原本要求的正文，不通过追加指令要求模型改成 JSON。
function field(section: string, labels: string, ordinal?: number) {
    const match = section.match(new RegExp(`(?:^|\\n)[ \\t]*(?:[-*][ \\t]+)?(?:\\*\\*|__)?(?:${labels})(?:\\*\\*|__)?[ \\t]*[:：][ \\t]*(?:\\*\\*|__)?([^\\r\\n]*)`));
    if (!match && ordinal !== undefined) throw new Error(`分镜${ordinal}缺少「${labels.split("|")[0]}」字段`);
    let value = (match?.[1] || "").trim().replace(/^(?:\*\*|__)|(?:\*\*|__)$/g, "").trim();
    if (/^["“‘']/.test(value)) value = value.slice(1).replace(/["”’'][,，]?$/, "");
    return value.trim();
}

export function parseRemakePersonAnalysisBody(raw: string) {
    const headings = [...raw.matchAll(/^[ \t]*(?:#{1,6}[ \t]*)?(?:[-*][ \t]+)?(?:\*\*|__)?分镜[ \t]*(\d+)[ \t]*(?:\*\*|__)?[ \t]*[:：]?[ \t]*(?:\*\*|__)?[ \t]*\r?$/gmu)];
    if (headings.length !== 48) throw new Error(`视频理解模型返回了 ${headings.length} 个分镜，必须返回完整的 48 条镜头分析`);
    const frames = headings.map((heading, index) => {
        if (Number(heading[1]) !== index + 1) throw new Error("视频分析镜头编号必须从1至48连续排列");
        const ordinal = Number(heading[1]);
        const section = raw.slice(heading.index! + heading[0].length, headings[index + 1]?.index ?? raw.length);
        const times = field(section, "时间", ordinal).split(/\s*[-–—~～至]\s*/);
        if (times.length !== 2) throw new Error(`分镜${ordinal}必须包含完整的起止时间`);
        const face = field(section, "是否包含人脸|是否出现人脸|是否有人脸|包含人脸", ordinal).replace(/^[\s🔴🟢✅❌]+/u, "");
        if (!/^(?:是|有|否|无|true|false)$/i.test(face)) throw new Error(`分镜${ordinal}的人脸判断须明确为是或否`);
        return {
            ordinal, startTime: times[0], endTime: times[1],
            subtitle: field(section, "字幕", ordinal), sellingPoint: field(section, "卖点", ordinal),
            shotType: field(section, "镜头类型|景别", ordinal), description: field(section, "画面描述", ordinal),
            subjectRatio: field(section, "人物占比|主体占比", ordinal), hasFace: /^(?:是|有|true)$/i.test(face),
        };
    });
    // 原文没有要求返回口播全文；不把字幕拼接后冒充音轨转录。
    return { sourceCopy: field(raw, "sourceCopy|原文案"), frames };
}

export function parseRemakePersonCopyBody(raw: string) {
    const rows: Array<{ first: number; last: number; text: string }> = [];
    let inTable = false;
    for (const line of raw.split(/\r?\n/)) {
        if (!line.trim().startsWith("|")) { inTable = false; continue; }
        const cells = line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
        const labels = cells.map((cell) => cell.replace(/\*\*/g, ""));
        if (labels[0] === "分镜区间" && labels[1] === "字幕" && cells.length === 2) { inTable = true; continue; }
        if (!inTable || cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
        const range = labels[0].match(/^分镜\s*(\d+)\s*[-–—~～至]\s*(\d+)$/u);
        if (!range || cells.length !== 2) throw new Error("文案预处理字幕表格式不完整");
        rows.push({ first: Number(range[1]), last: Number(range[2]), text: cells[1] === "-" ? "" : cells[1] });
    }
    if (rows.length !== 16 || rows.some((row, index) => row.first !== index * 3 + 1 || row.last !== index * 3 + 3)) {
        throw new Error("文案预处理须依次返回分镜1-3至46-48的16个字幕区间，不能缺失、重复或乱序");
    }
    return rows.map((row) => row.text);
}
