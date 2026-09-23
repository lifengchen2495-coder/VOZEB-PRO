import { REMAKE_FEISHU_ANALYSIS_PROMPT, REMAKE_FEISHU_COPY_PROMPT, REMAKE_FEISHU_VIDEO_PROMPTS } from "./remake-person-feishu-prompts";
import { remakePersonCopyFrameGroups, remakePersonFrameGroups, remakePersonGridLayout, type RemakeTimelineFrame } from "./remake-person-layout";
import { remakePersonSeconds, type RemakePersonTiming } from "./remake-person-timing";

// 从归档正文派生，只替换与固定时长、分镜数、区间编号相关的内容。
function section(text: string, start: string, end: string, replacement: string) {
    const from = text.indexOf(start);
    const to = text.indexOf(end, from + start.length);
    if (from < 0 || to < 0) throw new Error("分镜提示词原文结构已变化");
    return text.slice(0, from) + replacement + "\n\n---\n\n" + text.slice(to);
}

export function remakePersonSegmentAnalysisPrompt(durationMs: number) {
    const seconds = remakePersonSeconds(durationMs);
    let prompt = REMAKE_FEISHU_ANALYSIS_PROMPT
        .replace("60秒版", "实际时长版")
        .replace("针对60秒TikTok长视频，深度分析视频内容，拆解视频中的**所有镜头**，精准控制为**48个分镜**。", `针对实际时长为${seconds}秒的视频，深度分析视频内容，按剪辑切换、动作、产品展示和字幕变化拆解所有实际镜头。镜头数量由内容决定，不凑数。`)
        .replace("- **⚠️ 精准48个分镜**：拆解出来的分镜数量必须为 **48个**", "- **实际镜头数量**：不固定总分镜数，不人为拆镜或重复画面凑数")
        .replace("- **输出形式**：分为4个部分，每部分12个分镜，用于生成4张十二宫格图", "- **输出形式**：依次输出全部实际镜头，系统按0–15秒、15–30秒等分组，末组为剩余时长；跨边界镜头只在边界处拆开")
        .replace("- 根据视频实际时长，合理分配48个分镜\n- 平均每个分镜约：视频实际时长 ÷ 48", `- 按真实镜头变化确定起止时间，支持毫秒精度，禁止平均分配\n- 最后一镜结束于${seconds}秒`);
    prompt = section(prompt, "### 2. ⚠️ 分镜数量控制", "### 3. ⚠️ 产品卖点分类", "### 2. ⚠️ 分镜数量控制（核心约束）\n\n按实际内容保留镜头，不固定为48个或每组12个，不因数量不足拆镜补齐。保留字幕和产品卖点，合并纯过渡时仍须连续覆盖原时间轴。");
    prompt = section(prompt, "## 【输出格式】", "## 【输出示例", "## 【输出格式】\n\n从分镜1开始连续编号，按时间顺序输出全部实际镜头，不分成固定四部分。时间轴从0秒连续覆盖到视频实际结尾。后续每15秒生成一组分镜拼图，末组按实际剩余时长和镜头数输出。");
    prompt = prompt.replace("## 【输出示例（60秒，48个分镜 - 第1部分）】", "## 【输出示例（仅说明字段格式，时间和镜头数以实际视频为准）】").replace("...（分镜6-12，同上格式）", "后续实际分镜均按上述字段输出，不能省略。");
    prompt = section(prompt, "### 2. ⚠️ 精准48个分镜", "### 3. ⚠️ 双导向拆解", "### 2. ⚠️ 实际分镜数量（核心约束）\n\n按实际镜头变化拆解，不设固定数量，不添加视频中不存在的镜头。");
    return prompt.replace("2. **精准48个分镜**：必须拆解出48个分镜，不多不少", "2. **实际镜头数量**：有多少镜头就拆多少镜头，不凑数")
        .replace("8. **4张十二宫格输出**：分为4个部分，每部分12个分镜", "8. **按15秒分组**：末组为剩余时长，各组使用实际镜头数，不补镜头");
}

export function remakePersonSegmentCopyPrompt(frames: RemakeTimelineFrame[]) {
    const ranges = remakePersonCopyFrameGroups(frames);
    const groups = remakePersonFrameGroups(frames);
    const rangeLabel = (range: number[]) => `分镜${range[0]}-${range.at(-1)}`;
    const groupTable = groups.map((group) => `| 第${group.ordinal}部分 | 分镜${group.id} | ${frames[group.startFrame - 1].time}–${frames[group.endFrame - 1].endTime}秒 |`).join("\n");
    const outputTables = groups.map((group) => `=== 第${group.ordinal}部分：分镜${group.id} ===\n\n| 分镜区间 | 字幕 |\n|---|---|\n${ranges.filter((range) => range[0] >= group.startFrame && range.at(-1)! <= group.endFrame).map((range) => `| ${rangeLabel(range)} | 【本区间原文，无口播写-】 |`).join("\n")}`).join("\n\n");
    let prompt = REMAKE_FEISHU_COPY_PROMPT.replace(/48镜头解析/gu, "镜头解析").replace(/48个分镜/gu, `${frames.length}个实际分镜`)
        .replace(/每3个分镜为一组/gu, "同一个15秒片段内每最多3个分镜为一区间，末区间可以只有1镜或2镜，区间不能跨越视频片段边界");
    prompt = section(prompt, "### 原则3：", "### 原则5：", `### 原则3：按实际分镜区间输出\n\n每个区间对应一段合并后的文案，不重复输出每个分镜。区间依次为：${ranges.map(rangeLabel).join("、")}。\n\n### 原则4：按实际视频分组输出\n\n| 部分 | 分镜区间 | 对应视频时段 |\n|---|---|---|\n${groupTable}`);
    prompt = section(prompt, "### 步骤3：", "### 步骤4：", `### 步骤3：计算段落分配\n\n分镜区间数量：${ranges.length}个。按给定镜头时间和原文顺序，将口播分配到对应区间。跨越15秒边界的口播按内容断开，仅分配一次，不因镜头在边界拆开而重复字幕。\n\n| 区间 | 分镜范围 | 文案段落 |\n|---|---|---|\n${ranges.map((range, i) => `| 区间${i + 1} | ${rangeLabel(range)} | 【按原文分配】 |`).join("\n")}`);
    prompt = section(prompt, "### 步骤6：", "### 步骤7：", "### 步骤6：按分镜区间合并字幕\n\n根据段落分配表，按给定的实际区间合并字幕。段落按顺序分配到区间，每个区间输出一行合并后的文案，不重复输出每个分镜。");
    prompt = section(prompt, "### 步骤8：", "## 【输出格式】", `### 步骤8：输出字幕表\n\n按${groups.length}个实际视频分组输出，区间编号必须与上述列表完全一致。`);
    prompt = section(prompt, "## 【输出格式】", "## 【最终检查清单】", `## 【输出格式】\n\n保留文案切分结果、处理方式、顺序填充检查、字幕补全校对统计，然后按以下实际区间输出字幕表：\n\n${outputTables}`);
    return prompt.replace("分镜区间（1-3、4-6、7-9...）", "上述实际分镜区间").replace("是否按4部分输出？", `是否按${groups.length}个实际分组输出？`);
}

export function remakePersonSegmentVideoPrompt(timing: RemakePersonTiming) {
    const ordinals = timing.frameOrdinals || [];
    const grid = remakePersonGridLayout(ordinals.length);
    const seconds = remakePersonSeconds(timing.durationMs);
    const ranges = Array.from({ length: Math.ceil(ordinals.length / 3) }, (_, i) => ordinals.slice(i * 3, i * 3 + 3));
    const block = (range: number[]) => `分镜${range[0]}-${range.at(-1)}，[景别（仅生图有人脸时写）]，${range.map((ordinal) => `[动作描述${ordinal}]`).join("；")}；口播（中文，[旁白/人物]，[情绪]）：★"[字幕]"；[仅当生图有人脸时添加"生成人物 禁止出现模糊处理、遮挡；"]`;
    let prompt = REMAKE_FEISHU_VIDEO_PROMPTS["37-48"];
    prompt = section(prompt, "## 【字幕读取规则】", "## 【分镜描述格式规则】", `## 【字幕读取规则】\n\n从字幕预处理结果中只读取本组分镜${timing.groupId}的字幕，禁止读取其他组。\n\n| 分镜区间 | 读取位置 |\n|---|---|\n${ranges.map((range) => `| 分镜${range[0]}-${range.at(-1)} | 本组同编号区间 |`).join("\n")}`);
    const outputStart = prompt.indexOf("## 【输出格式】");
    const firstBlock = prompt.indexOf("分镜37-39，", outputStart);
    const end = prompt.indexOf("整体画面：", firstBlock);
    if (firstBlock < 0 || end < 0) throw new Error("视频提示词原文结构已变化");
    prompt = prompt.slice(0, firstBlock).replace(/分镜37-39，[^\n]+/u, block(ranges[0])) + ranges.map(block).join("\n\n") + "\n\n" + prompt.slice(end);
    return prompt.replace(/15\s*秒/gu, `${seconds}秒`)
        .replace(/第四张/gu, "本组").replace(/第四部分/gu, "本组")
        .replace(/37-48/gu, timing.groupId).replace(/48分镜/gu, "实际分镜").replace(/48镜头解析/gu, "镜头解析")
        .replace(/十二宫格图/gu, "分镜图").replace(/12个连续/gu, `${ordinals.length}个连续`)
        .replace("## 【任务目标】", `## 【任务目标】\n\n本组对应原片${remakePersonSeconds(timing.startMs)}–${remakePersonSeconds(timing.endMs)}秒，实际时长${seconds}秒，共${ordinals.length}镜。分镜图为${grid.columns}列×${grid.rows}行，逐格对应本组镜头，余格留空。片内时间从0秒开始，在${seconds}秒结束；不补时长、不新增镜头。`);
}
