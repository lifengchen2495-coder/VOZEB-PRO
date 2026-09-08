import type { OmniClothingProject, OmniClothingProjectSummaryPage } from "@/lib/omni-clothing-contract";
import { summarizeOmniClothingProject } from "@/lib/omni-clothing-contract";
import { readJsonDataFile, withJsonDataFileLock, writeJsonDataFile } from "@/lib/server/data-adapter";
import { ensurePostgresSchema, getDatabaseProvider, postgresQuery, withPostgresTransaction } from "@/lib/server/database";

type OmniClothingProjectRecord = { userId: string; project: OmniClothingProject };
type OmniClothingProjectDatabase = { version: 1; projects: OmniClothingProjectRecord[] };

const FILE_NAME = "omni-clothing-projects.json";

export async function listOmniClothingProjectSummaries(userId: string, input: { page?: number; pageSize?: number } = {}): Promise<OmniClothingProjectSummaryPage> {
    const page = Math.max(1, Math.floor(Number(input.page) || 1));
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(input.pageSize) || 20)));
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ project_json: OmniClothingProject; total_count: number | string }>(
            `SELECT project_json, COUNT(*) OVER() AS total_count
             FROM omni_clothing_projects
             WHERE user_id = $1
             ORDER BY updated_at DESC, id DESC
             LIMIT $2 OFFSET $3`,
            [userId, pageSize, (page - 1) * pageSize],
        );
        return { items: result.rows.map((row) => summarizeOmniClothingProject(row.project_json)), total: Number(result.rows[0]?.total_count) || 0, page, pageSize };
    }
    const summaries = (await readDatabase()).projects
        .filter((record) => record.userId === userId)
        .map((record) => summarizeOmniClothingProject(record.project))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
    return { items: summaries.slice((page - 1) * pageSize, page * pageSize), total: summaries.length, page, pageSize };
}

export async function getOmniClothingProject(id: string, userId: string): Promise<OmniClothingProject | null> {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ project_json: OmniClothingProject }>("SELECT project_json FROM omni_clothing_projects WHERE id = $1 AND user_id = $2", [id, userId]);
        return result.rows[0]?.project_json || null;
    }
    return (await readDatabase()).projects.find((record) => record.userId === userId && record.project.id === id)?.project || null;
}

export async function createOmniClothingProject(userId: string, project: OmniClothingProject) {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery(
            `INSERT INTO omni_clothing_projects (id, user_id, title, status, project_json, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
             ON CONFLICT DO NOTHING
             RETURNING id`,
            [project.id, userId, project.title, project.status, JSON.stringify(project), new Date(project.createdAt), new Date(project.updatedAt)],
        );
        if (!result.rows[0]) throw new OmniClothingProjectStoreError("服装复刻项目已存在", 409);
        return project;
    }
    return withFileMutation((database) => {
        if (database.projects.some((record) => record.project.id === project.id)) throw new OmniClothingProjectStoreError("服装复刻项目已存在", 409);
        return { database: { ...database, projects: [{ userId, project }, ...database.projects] }, result: project };
    });
}

export async function updateOmniClothingProject(userId: string, project: OmniClothingProject, expectedRevision: number) {
    const updated = await mutateOmniClothingProject(userId, project.id, (current) => {
        if (current.revision !== expectedRevision) throw new OmniClothingProjectStoreError("服装复刻项目已在其他页面更新，请刷新后重试", 409);
        return project;
    });
    if (!updated) throw new OmniClothingProjectStoreError("服装复刻项目不存在", 404);
    return updated;
}

export async function mutateOmniClothingProject(userId: string, id: string, mutate: (current: OmniClothingProject) => OmniClothingProject | null): Promise<OmniClothingProject | null> {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        return withPostgresTransaction(async (client) => {
            const selected = await client.query<{ project_json: OmniClothingProject }>("SELECT project_json FROM omni_clothing_projects WHERE id = $1 AND user_id = $2 FOR UPDATE", [id, userId]);
            const current = selected.rows[0]?.project_json;
            if (!current) return null;
            const next = mutate(current);
            if (!next) return current;
            assertMutationIdentity(next, current);
            await client.query(
                `UPDATE omni_clothing_projects
                 SET title = $3, status = $4, project_json = $5::jsonb, updated_at = $6
                 WHERE id = $1 AND user_id = $2`,
                [id, userId, next.title, next.status, JSON.stringify(next), new Date(next.updatedAt)],
            );
            return next;
        });
    }
    return withFileMutation((database) => {
        let result: OmniClothingProject | null = null;
        const projects = database.projects.map((record) => {
            if (record.userId !== userId || record.project.id !== id) return record;
            const next = mutate(record.project);
            result = next || record.project;
            if (!next) return record;
            assertMutationIdentity(next, record.project);
            return { ...record, project: next };
        });
        return { database: { ...database, projects }, result };
    });
}

export async function deleteOmniClothingProject(userId: string, id: string, expectedRevision?: number) {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ project_json: OmniClothingProject }>(
            `DELETE FROM omni_clothing_projects WHERE id = $1 AND user_id = $2${expectedRevision === undefined ? "" : " AND project_json->>'revision' = $3"} RETURNING project_json`,
            expectedRevision === undefined ? [id, userId] : [id, userId, String(expectedRevision)],
        );
        if (expectedRevision !== undefined && !result.rows[0]) throw new OmniClothingProjectStoreError("项目状态已变化，请刷新后再删除", 409);
        return result.rows[0]?.project_json || null;
    }
    return withFileMutation((database) => {
        let deleted: OmniClothingProject | null = null;
        const projects = database.projects.filter((record) => {
            if (record.userId === userId && record.project.id === id) {
                if (expectedRevision !== undefined && record.project.revision !== expectedRevision) throw new OmniClothingProjectStoreError("项目状态已变化，请刷新后再删除", 409);
                deleted = record.project;
                return false;
            }
            return true;
        });
        return { database: { ...database, projects }, result: deleted };
    });
}

function readDatabase() {
    return readJsonDataFile<OmniClothingProjectDatabase>(FILE_NAME, { version: 1, projects: [] });
}

function withFileMutation<T>(mutate: (database: OmniClothingProjectDatabase) => { database: OmniClothingProjectDatabase; result: T }) {
    return withJsonDataFileLock(FILE_NAME, async () => {
        const mutation = mutate(await readDatabase());
        await writeJsonDataFile(FILE_NAME, mutation.database);
        return mutation.result;
    });
}

function assertMutationIdentity(next: OmniClothingProject, current: OmniClothingProject) {
    if (next.id !== current.id || next.createdAt !== current.createdAt) throw new Error("服装复刻项目更新不能改变项目身份");
}

export class OmniClothingProjectStoreError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
        this.name = "OmniClothingProjectStoreError";
    }
}
