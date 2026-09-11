// 完整 Skill 报告与创作历史共用项目存储，统一所有写入入口的容量约束。
export const DRAMA_MAX_PROJECT_BYTES = 16 * 1024 * 1024;
export const DRAMA_PROJECT_SIZE_ERROR = "项目内容超过 16 MB，请拆分为多个项目后重试";
