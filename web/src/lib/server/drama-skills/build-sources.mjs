import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 默认只从仓库内的原始文件构建；更新资料时显式传入 --import 和来源目录。
const root = path.dirname(fileURLToPath(import.meta.url));
const imports = process.argv.indexOf("--import");
const sourceDirectory = imports >= 0 ? process.argv[imports + 1] : undefined;
if (imports >= 0 && !sourceDirectory) throw new Error("--import 后必须提供来源目录");
const groups = [
    { id: "dongtai-man-character", name: "动态漫人物小传写作", directory: "动态漫人物小传写作skill", guide: "动态漫人物小传写作指南.md", stages: ["characters"] },
    { id: "dongtai-man-rhythm", name: "动态漫剧情爽点与节奏设计", directory: "动态漫剧情爽点-节奏设计skill", guide: "剧情爽点节奏设计指南.md", stages: ["beats"] },
    { id: "dongtai-man-writing", name: "动态漫剧本详细写作", directory: "动态漫剧本详细写作skill", guide: "动态漫剧本写作规范.md", stages: ["script"] },
    { id: "dongtaiman", name: "动态漫剧本转分镜", directory: "动态漫剧本转分镜skill", guide: "动态漫剧本转分镜生成指南.md", stages: ["content"] },
    { id: "seedance-manual", name: "Seedance 2.0 分镜生成", directory: "Seedance2.0分镜生成skill", guide: "seedance2.0.md", stages: ["visual", "video-prompts"] },
];
const contents = {};
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
async function sourceFile(relativePath) {
    const target = path.join(root, "sources", relativePath);
    if (sourceDirectory) {
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(path.join(sourceDirectory, relativePath), target);
    }
    const bytes = await readFile(target);
    contents[relativePath] = bytes.toString("utf8");
    return { path: relativePath, sha256: sha256(bytes), bytes: bytes.length };
}
const tutorial = await sourceFile("使用教程.txt");
const skills = [];
for (const group of groups) {
    const sourceFiles = [await sourceFile(`${group.directory}/SKILL.md`), await sourceFile(`${group.directory}/${group.guide}`)];
    const digest = sha256(sourceFiles.map((file) => `${file.path}\0${file.sha256}\n`).join(""));
    skills.push({ id: group.id, name: group.name, stages: group.stages, version: `sha256-${digest.slice(0, 16)}`, sha256: digest, sourceFiles });
}
const manifest = { schemaVersion: 1, source: "用户提供的剧本 Skill 合集", tutorial, skills };
await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 4) + "\n", "utf8");
await writeFile(path.join(root, "source-texts.json"), JSON.stringify(contents, null, 4) + "\n", "utf8");
process.stdout.write(`已打包 ${skills.length} 组 Skill、${Object.keys(contents).length} 个完整来源文件。\n`);
