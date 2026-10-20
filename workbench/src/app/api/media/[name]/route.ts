import { fail } from "@/lib/server/http";
import { readMedia } from "@/lib/server/store";

export async function GET(request: Request, { params }: { params: Promise<{ name: string }> }) {
    try {
        const { bytes, mime } = await readMedia((await params).name);
        const headers = { "content-type": mime, "accept-ranges": "bytes", "cache-control": "private, max-age=31536000, immutable" };
        // 视频拖动进度依赖 Range 请求
        const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get("range") || "");
        if (!range) return new Response(new Uint8Array(bytes), { headers });
        const start = range[1] ? Number(range[1]) : Math.max(0, bytes.length - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
        if (start > end || start >= bytes.length) return new Response(null, { status: 416, headers: { "content-range": `bytes */${bytes.length}` } });
        return new Response(new Uint8Array(bytes.subarray(start, end + 1)), { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${bytes.length}` } });
    } catch {
        return fail("文件不存在", 404);
    }
}
