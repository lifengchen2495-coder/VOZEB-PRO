import type { BangbangProject, BangbangProjectList } from "@/lib/bangbang-contract";

import { readJsonDataFile, withJsonDataFileLock, writeJsonDataFile } from "@/lib/server/data-adapter";
import { ensurePostgresSchema, getDatabaseProvider, postgresQuery, withPostgresTransaction } from "@/lib/server/database";

type BangbangProjectRecord = { userId: string; project: BangbangProject };
type BangbangProjectDatabase = { version: 1; projects: BangbangProjectRecord[] };

const FILE_NAME = "bangbang-projects.json";

export async function listBangbangProjects(userId: string, input: { page?: number; pageSize?: number } = {}): Promise<BangbangProjectList> {
    const page = Number.isFinite(input.page) ? Math.max(1, Math.min(1_000_000, Math.floor(input.page!))) : 1;
    const pageSize = Number.isFinite(input.pageSize) && input.pageSize! > 0 ? Math.max(1, Math.min(100, Math.floor(input.pageSize!))) : 20;
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ project_json: BangbangProject }>(
            `SELECT project_json
             FROM bangbang_projects
             WHERE user_id = $1
             ORDER BY updated_at DESC, id DESC
             LIMIT $2 OFFSET $3`,
            [userId, pageSize, (page - 1) * pageSize],
        );
        const count = await postgresQuery<{ total_count: number | string }>("SELECT COUNT(*) AS total_count FROM bangbang_projects WHERE user_id = $1", [userId]);
        return { items: result.rows.map((row) => row.project_json), total: Number(count.rows[0]?.total_count) || 0, page, pageSize };
    }
    const summaries = (await readDatabase()).projects
        .filter((record) => record.userId === userId)
        .map((record) => record.project)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
    return { items: summaries.slice((page - 1) * pageSize, page * pageSize), total: summaries.length, page, pageSize };
}

export async function getBangbangProject(id: string, userId: string): Promise<BangbangProject | null> {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ project_json: BangbangProject }>("SELECT project_json FROM bangbang_projects WHERE id = $1 AND user_id = $2", [id, userId]);
        return result.rows[0]?.project_json || null;
    }
    return (await readDatabase()).projects.find((record) => record.userId === userId && record.project.id === id)?.project || null;
}

export async function createBangbangProject(userId: string, project: BangbangProject) {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery(
            `INSERT INTO bangbang_projects (id, user_id, title, status, project_json, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
             ON CONFLICT DO NOTHING
             RETURNING id`,
            [project.id, userId, project.title, project.status, JSON.stringify(project), new Date(project.createdAt), new Date(project.updatedAt)],
        );
        if (!result.rows[0]) throw new BangbangProjectStoreError("带货短剧项目已存在", 409);
        return project;
    }
    return withFileMutation((database) => {
        if (database.projects.some((record) => record.project.id === project.id)) throw new BangbangProjectStoreError("带货短剧项目已存在", 409);
        return { database: { ...database, projects: [{ userId, project }, ...database.projects] }, result: project };
    });
}

export async function updateBangbangProject(userId: string, project: BangbangProject, expectedRevision: number) {
    const updated = await mutateBangbangProject(userId, project.id, (current) => {
        if (current.revision !== expectedRevision) throw new BangbangProjectStoreError("带货短剧项目已在其他页面更新，请刷新后重试", 409);
        return project;
    });
    if (!updated) throw new BangbangProjectStoreError("带货短剧项目不存在", 404);
    return updated;
}

export async function mutateBangbangProject(userId: string, id: string, mutate: (current: BangbangProject) => BangbangProject | null): Promise<BangbangProject | null> {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        return withPostgresTransaction(async (client) => {
            const selected = await client.query<{ project_json: BangbangProject }>("SELECT project_json FROM bangbang_projects WHERE id = $1 AND user_id = $2 FOR UPDATE", [id, userId]);
            const current = selected.rows[0]?.project_json;
            if (!current) return null;
            const next = mutate(current);
            if (!next || next === current) return current;
            assertMutationIdentity(next, current);
            await client.query(
                `UPDATE bangbang_projects
                 SET title = $3, status = $4, project_json = $5::jsonb, updated_at = $6
                 WHERE id = $1 AND user_id = $2`,
                [id, userId, next.title, next.status, JSON.stringify(next), new Date(next.updatedAt)],
            );
            return next;
        });
    }
    return withFileMutation((database) => {
        let result: BangbangProject | null = null;
        const projects = database.projects.map((record) => {
            if (record.userId !== userId || record.project.id !== id) return record;
            const next = mutate(record.project);
            result = next || record.project;
            if (!next || next === record.project) return record;
            assertMutationIdentity(next, record.project);
            return { ...record, project: next };
        });
        return { database: { ...database, projects }, result };
    });
}

export async function deleteBangbangProject(userId: string, id: string) {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ project_json: BangbangProject }>("DELETE FROM bangbang_projects WHERE id = $1 AND user_id = $2 RETURNING project_json", [id, userId]);
        return result.rows[0]?.project_json || null;
    }
    return withFileMutation((database) => {
        let deleted: BangbangProject | null = null;
        const projects = database.projects.filter((record) => {
            if (record.userId === userId && record.project.id === id) {
                deleted = record.project;
                return false;
            }
            return true;
        });
        return { database: { ...database, projects }, result: deleted };
    });
}

function readDatabase() {
    return readJsonDataFile<BangbangProjectDatabase>(FILE_NAME, { version: 1, projects: [] });
}

function withFileMutation<T>(mutate: (database: BangbangProjectDatabase) => { database: BangbangProjectDatabase; result: T }) {
    return withJsonDataFileLock(FILE_NAME, async () => {
        const mutation = mutate(await readDatabase());
        await writeJsonDataFile(FILE_NAME, mutation.database);
        return mutation.result;
    });
}

function assertMutationIdentity(next: BangbangProject, current: BangbangProject) {
    if (next.id !== current.id || next.createdAt !== current.createdAt) throw new Error("带货短剧项目更新不能改变项目身份");
    if (!Number.isSafeInteger(next.revision) || next.revision !== current.revision + 1) throw new BangbangProjectStoreError("带货短剧项目版本不正确，请刷新后重试", 409);
}

export class BangbangProjectStoreError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
        this.name = "BangbangProjectStoreError";
    }
}
