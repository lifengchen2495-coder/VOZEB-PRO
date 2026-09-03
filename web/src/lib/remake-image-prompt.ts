import { REMAKE_FEISHU_IMAGE_PROMPTS } from "@/lib/remake-feishu-prompts";

export type RemakeImagePromptAsset = {
    url?: string;
};

export type RemakeImagePromptReference<T extends RemakeImagePromptAsset> = {
    key: "source-contact-sheet" | "replacement-contact-sheet" | "product" | "character" | "background";
    label: string;
    asset: T;
};

export type RemakeImagePromptFrame = {
    ordinal: number;
    time: number;
    endTime: number;
    subtitle: string;
    sellingPoint: string;
    shotType: string;
    description: string;
    subjectRatio: string;
};

const REMAKE_GROUP_IDS = ["1-12", "13-24", "25-36", "37-48"] as const;
type RemakeImagePromptGroupId = (typeof REMAKE_GROUP_IDS)[number];

const REPLACEMENT_PERSON_PROMPTS = Object.fromEntries(REMAKE_GROUP_IDS.map((id) => [id, REMAKE_FEISHU_IMAGE_PROMPTS[id].replacement])) as Record<RemakeImagePromptGroupId, string>;
const STORYBOARD_PROMPTS = Object.fromEntries(REMAKE_GROUP_IDS.map((id) => [id, REMAKE_FEISHU_IMAGE_PROMPTS[id].storyboard])) as Record<RemakeImagePromptGroupId, string>;

export function remakeReplacementPersonPrompt(groupId: string, frames: RemakeImagePromptFrame[], hasCharacter: boolean) {
    const id = remakePromptGroupId(groupId);
    return appendFieldContext(REPLACEMENT_PERSON_PROMPTS[id], id, frames, hasCharacter ? "已上传，按人物图替换人物" : "未上传，本次保留原人物身份，只执行清理和去除旧产品");
}

export function remakeStoryboardPrompt(groupId: string, frames: RemakeImagePromptFrame[]) {
    const id = remakePromptGroupId(groupId);
    return appendFieldContext(STORYBOARD_PROMPTS[id], id, frames, "沿用上一步模板图中的人物");
}

export function remakeReplacementPromptReferences<T extends RemakeImagePromptAsset>(input: { sourceContactSheet?: T; character?: T }): RemakeImagePromptReference<T>[] {
    const references: Array<RemakeImagePromptReference<T> | null> = [
        input.sourceContactSheet ? { key: "source-contact-sheet" as const, label: "原图十二宫格分镜图", asset: input.sourceContactSheet } : null,
        input.character ? { key: "character" as const, label: "人物图", asset: input.character } : null,
    ];
    return references.filter((item): item is RemakeImagePromptReference<T> => Boolean(item?.asset.url));
}

export function remakeStoryboardPromptReferences<T extends RemakeImagePromptAsset>(input: { replacementContactSheet?: T; product?: T }): RemakeImagePromptReference<T>[] {
    const references: Array<RemakeImagePromptReference<T> | null> = [
        input.replacementContactSheet ? { key: "replacement-contact-sheet" as const, label: "十二宫格模板图（已完成清理/换人物/去旧产品）", asset: input.replacementContactSheet } : null,
        input.product ? { key: "product" as const, label: "产品图", asset: input.product } : null,
    ];
    return references.filter((item): item is RemakeImagePromptReference<T> => Boolean(item?.asset.url));
}

function appendFieldContext(prompt: string, groupId: RemakeImagePromptGroupId, frames: RemakeImagePromptFrame[], characterRule: string) {
    const selected = frames.filter((frame) => frame.ordinal >= Number(groupId.split("-")[0]) && frame.ordinal <= Number(groupId.split("-")[1]));
    const script = selected
        .map(
            (frame) =>
                `分镜${frame.ordinal}\n时间：${formatSeconds(frame.time)}-${formatSeconds(frame.endTime)}\n景别：${frame.shotType || "以原图为准"}\n画面：${frame.description || "以原图为准"}\n人物占比：${frame.subjectRatio || "以原图为准"}\n字幕：${frame.subtitle || "-"}\n卖点：${frame.sellingPoint || "-"}`,
        )
        .join("\n\n");
    return `${prompt}\n\n## 【字段引用实际内容】\n\n人物图字段：${characterRule}\n\n${groupId}分镜脚本：\n${script}`;
}

function remakePromptGroupId(value: string): RemakeImagePromptGroupId {
    return REMAKE_GROUP_IDS.includes(value as RemakeImagePromptGroupId) ? (value as RemakeImagePromptGroupId) : "1-12";
}

function formatSeconds(value: number) {
    const seconds = Math.max(0, Number.isFinite(value) ? value : 0);
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${(seconds - minutes * 60).toFixed(2).padStart(5, "0")}`;
}

export const REMAKE_IMAGE_PROMPT = `# 电商视频分镜图生成（跟品版）

## 【任务目标】

根据**12张分镜图片**（必需）、**背景图**（必需）、**人物六宫格图**（可选）三个输入，生成**1张9:16竖屏十二宫格图**。

**处理内容**：
1. 去除字幕、水印、边框、平台UI元素
2. 人脸模糊打码处理
3. 替换人物外貌和服装（如上传人物图）
4. 替换背景场景
5. 保留产品位置、状态不变
6. **⚠️⚠️⚠️ 保留人物动作、姿势、眼神方向、人物-产品互动不变**
7. 12张分镜按顺序拼接成十二宫格

---

## 【⚠️⚠️⚠️ 核心规则（最高优先级）】

### 规则1：原分镜图是唯一权威

**一切信息只从原分镜图读取，必须一一对应**：

| 信息类别 | 来源 | 强制程度 |
|---------|------|---------|
| **⚠️⚠️⚠️ 人物动作** | 从原分镜图读取，必须一模一样 | 最高优先级 |
| **⚠️⚠️⚠️ 人物姿势** | 从原分镜图读取，必须一模一样 | 最高优先级 |
| **⚠️⚠️⚠️ 眼神方向** | 从原分镜图读取，必须一模一样 | 最高优先级 |
| **⚠️⚠️⚠️ 人物-产品互动** | 从原分镜图读取，必须一模一样 | 最高优先级 |
| **⚠️⚠️⚠️ 人物景别** | 从原分镜图读取，必须一模一样 | 最高优先级 |
| **⚠️⚠️⚠️ 人物占比** | 从原分镜图读取，必须一模一样 | 最高优先级 |
| **⚠️⚠️⚠️ 产品是否展示** | 原分镜展示→生成展示；原分镜不展示→生成不展示 | 最高优先级 |
| **⚠️⚠️⚠️ 产品展示方式** | 从原分镜图读取，必须一模一样 | 最高优先级 |
| 人物是否出现 | 从原分镜图读取 | 最高优先级 |
| 是否有人脸 | 从原分镜图判断 | 最高优先级 |
| 手部动作 | 从原分镜图读取 | 最高优先级 |
| 产品位置、角度、状态 | 从原分镜图读取 | 最高优先级 |
| 风格、光线、氛围、色调 | 从原分镜图读取 | 最高优先级 |

---

### ⚠️⚠️⚠️ 规则2：人物动作、眼神、互动一模一样（最高优先级）

**核心原则：原分镜是什么样，生成就什么样，必须一模一样**

| 信息类别 | 原分镜情况 | 生成要求 |
|---------|-----------|---------|
| **眼神方向** | 原分镜人物看产品 | **生成人物看产品（不是看镜头）** |
| **眼神方向** | 原分镜人物看镜头 | **生成人物看镜头** |
| **眼神方向** | 原分镜人物低头 | **生成人物低头** |
| **眼神方向** | 原分镜人物看旁边 | **生成人物看旁边** |
| **人物-产品互动** | 原分镜手拿产品在看 | **生成手拿产品在看** |
| **人物-产品互动** | 原分镜手在展示产品 | **生成手在展示产品** |
| **人物-产品互动** | 原分镜手在操作产品 | **生成手在操作产品** |
| **人物动作** | 原分镜人物在走动 | **生成人物在走动** |
| **人物动作** | 原分镜人物在坐着 | **生成人物在坐着** |
| **人物动作** | 原分镜人物在弯腰 | **生成人物在弯腰** |

**⚠️⚠️⚠️ 自然动作规则**：
- 人物动作必须自然，符合人类正常动作习惯
- 原分镜人物在看产品、操作产品时，眼神应该看向产品，不要看镜头
- 只有原分镜人物在看镜头时，生成人物才看镜头
- **原图是什么样就什么样**

---

### ⚠️⚠️⚠️ 规则3：人物图的用途（重要）

**人物六宫格图只用于参考外貌和服装款式**：

| 参考内容 | 说明 | 强制程度 |
|---------|------|---------|
| **脸部外貌** | 五官、发型、肤色、年龄感 | 必须100%参考 |
| **服装款式** | 上装款式、下装款式、整体穿搭风格 | 参考款式相似即可 |
| **⚠️⚠️⚠️ 不参考的内容** | **姿势、动作、眼神方向、人物-产品互动** | **绝对不参考** |

**⚠️⚠️⚠️ 关键区分**：
- 人物图提供的是"谁"（外貌）和"穿什么"（服装款式）
- 原分镜图提供的是"做什么动作"、"看哪里"、"怎么和产品互动"

---

### 规则4：人脸处理

| 原分镜情况 | 生成结果 |
|-----------|---------|
| 有人脸 | 生成有人脸 + 高斯模糊打码 |
| 无人脸 | 生成无人脸 |
| 只有手部 | 只生成手部，不出现脸部 |

**模糊打码要求**：
- 高斯模糊，保留头部轮廓
- 五官细节模糊化，无法辨认
- 柔和自然，不突兀
- 禁止纯色块遮挡、马赛克颗粒

---

### 规则5：画面清理

| 清理内容 | 处理方式 |
|---------|---------|
| 字幕/文字 | 完全去除，无残留 |
| 水印 | 完全去除，无残留 |
| 边框 | 完全去除，无残留 |
| 平台UI元素 | 完全去除，无残留 |
| 黑边/圆角 | 完全去除 |

**清理区域**：自然修复背景，与画面融合，禁止白底

---

### 规则6：人物替换（如上传人物图）

| 替换内容 | 处理方式 |
|---------|---------|
| 脸部外貌 | 100%替换成人物图（五官、发型、肤色） |
| 服装款式 | 参考人物图，款式相似即可 |
| **⚠️⚠️⚠️ 人物动作** | **保持原分镜图不变，必须一模一样** |
| **⚠️⚠️⚠️ 人物姿势** | **保持原分镜图不变，必须一模一样** |
| **⚠️⚠️⚠️ 眼神方向** | **保持原分镜图不变，必须一模一样** |
| **⚠️⚠️⚠️ 人物-产品互动** | **保持原分镜图不变，必须一模一样** |
| **⚠️⚠️⚠️ 人物景别** | **保持原分镜图不变，必须一模一样** |
| **⚠️⚠️⚠️ 人物占比** | **保持原分镜图不变，必须一模一样** |

---

### 规则7：背景替换

| 处理内容 | 说明 |
|---------|------|
| 背景场景 | 替换成背景图的场景 |
| 人物空间关系 | 人物在背景物体前面，禁止穿模 |
| 风格光线氛围 | 保持原分镜图不变 |

---

### 规则8：产品保留

| 处理内容 | 说明 |
|---------|------|
| 产品位置 | 完全不变 |
| 产品角度 | 完全不变 |
| 产品状态 | 完全不变 |
| 手部拿产品的动作 | 完全不变 |
| **⚠️⚠️⚠️ 产品展示方式** | **和原分镜一模一样** |

---

## 【输入数据】

| 输入项 | 形式 | 说明 |
|-------|------|------|
| **12张分镜图片** | 12张图，宽高比一致 | 原始视频拆解的分镜，可能含字幕、水印、人脸 |
| **背景图** | 1张图 | 目标背景场景 |
| **人物六宫格图** | 1张图（可选） | 参考脸部外貌和服装款式，**不参考姿势、动作、眼神** |

---

## 【输出格式】

| 属性 | 说明 |
|-----|------|
| 输出数量 | 1张图片 |
| 画面比例 | 9:16 竖屏 |
| 布局结构 | 4行3列（12个分镜区域） |
| 排列顺序 | 从左到右、从上到下（分镜1-12） |
| 分镜间隙 | 无间隙 |
| 分割线 | 无分割线 |
| 图片质量 | 高清输出 |

**布局示意**：

\`\`\`
┌─────────────────────────────┐
│ [分镜1]  [分镜2]  [分镜3]  │
│ [分镜4]  [分镜5]  [分镜6]  │
│ [分镜7]  [分镜8]  [分镜9]  │
│[分镜10] [分镜11] [分镜12]  │
└─────────────────────────────┘
        9:16 竖屏
\`\`\`

---

## 【执行步骤】

1. **检查分镜图比例**：确认12张图宽高比一致
2. **逐格读取原分镜图**：
   - ⚠️⚠️⚠️ 人物动作、姿势、眼神方向、人物-产品互动
   - ⚠️⚠️⚠️ 人物景别、人物占比
   - ⚠️⚠️⚠️ 产品是否展示、产品展示方式
   - 人物是否出现、是否有人脸、手部动作
   - 产品位置、角度、状态
   - 风格、光线、氛围、色调
3. **读取人物六宫格图**（如有）：
   - 脸部外貌（五官、发型、肤色）
   - 服装款式（上装、下装、整体风格）
   - ⚠️⚠️⚠️ 不读取姿势、动作、眼神方向
4. **读取背景图**：场景信息
5. **画面清理**：去除字幕、水印、边框、UI
6. **人脸处理**：高斯模糊打码
7. **人物替换**（如有人物图）：
   - 替换脸部外貌和服装款式
   - ⚠️⚠️⚠️ 保持原分镜的动作、姿势、眼神、互动不变
8. **背景替换**：替换场景，保持风格光线
9. **产品保留**：位置、状态、展示方式不变
10. **拼接输出**：按分镜1-12顺序拼接成十二宫格

---

## 【禁止事项】

- ❌ **改变人物动作、姿势（最高优先级禁止）**
- ❌ **改变眼神方向（原分镜看产品，禁止改成看镜头）**
- ❌ **改变人物-产品互动方式（最高优先级禁止）**
- ❌ **改变人物景别、占比（最高优先级禁止）**
- ❌ **改变产品展示方式（最高优先级禁止）**
- ❌ 让人物总是看镜头（必须保持原分镜眼神方向）
- ❌ 原分镜无人物但生成有人物
- ❌ 原分镜只有手部但生成有身体
- ❌ 改变产品位置、状态
- ❌ 人脸未模糊处理
- ❌ 残留字幕、水印、UI
- ❌ 清理区域白底
- ❌ 人物穿模进入背景物体
- ❌ 生成文本

---

## 【最终检查】

- [ ] 字幕是否完全去除？
- [ ] 水印是否完全去除？
- [ ] 人脸是否已模糊打码？
- [ ] 人物是否已替换（如有人物图）？
- [ ] 服装是否已替换（如有人物图）？
- [ ] 背景是否已替换？
- [ ] 产品是否保留不变？
- [ ] **⚠️⚠️⚠️ 人物动作是否和原分镜一模一样？**
- [ ] **⚠️⚠️⚠️ 眼神方向是否和原分镜一模一样？**
- [ ] **⚠️⚠️⚠️ 人物-产品互动是否和原分镜一模一样？**
- [ ] **⚠️⚠️⚠️ 人物景别是否和原分镜一模一样？**
- [ ] **⚠️⚠️⚠️ 产品展示方式是否和原分镜一模一样？**
- [ ] 分镜顺序是否正确？
- [ ] 布局是否为4×3？

---`;

export function remakeImagePromptReferences<T extends RemakeImagePromptAsset>(input: { sourceContactSheet?: T; character?: T; background?: T }): RemakeImagePromptReference<T>[] {
    const references: Array<RemakeImagePromptReference<T> | null> = [
        input.sourceContactSheet ? { key: "source-contact-sheet" as const, label: "本组来源拼图（12 张分镜，唯一权威）", asset: input.sourceContactSheet } : null,
        input.character ? { key: "character" as const, label: "人物图（可选，仅参考外貌和服装款式）", asset: input.character } : null,
        input.background ? { key: "background" as const, label: "背景图（必需）", asset: input.background } : null,
    ];
    return references.filter((item): item is RemakeImagePromptReference<T> => Boolean(item?.asset.url));
}
