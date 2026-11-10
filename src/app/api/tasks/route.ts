// قائمة المهام + الإحصائيات — تستهلكها لوحة المهام (تحديث تلقائي كل ~5 ثوانٍ)
import { NextResponse } from "next/server";
import { listRecentTasks, taskStats } from "@/lib/turso";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit")) || 20));
    const type = url.searchParams.get("type") || undefined;
    const status = url.searchParams.get("status") || undefined;

    const [tasks, stats] = await Promise.all([listRecentTasks(limit, { type, status }), taskStats()]);
    return NextResponse.json({
      stats,
      tasks: tasks.map((t) => ({
        id: t.id,
        provider: t.provider,
        model: t.model,
        type: t.type,
        prompt: t.prompt?.slice(0, 160) || "",
        status: t.status,
        progress: t.progress,
        result_urls: t.result_urls_json ? safeParse(t.result_urls_json) : [],
        error_message: t.error_message,
        attempts: safeParse(t.attempts_json).length,
        created_at: t.created_at,
        completed_at: t.completed_at,
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "خطأ غير متوقع" }, { status: 500 });
  }
}

function safeParse(json: string): unknown[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
