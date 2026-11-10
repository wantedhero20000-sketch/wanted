// حذف مهمة — يُستخدم لتنظيف مهام الاختبار من الواجهة
import { NextResponse } from "next/server";
import { deleteTask, getTask } from "@/lib/turso";

export const runtime = "nodejs";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const existing = await getTask(id);
    if (!existing) return NextResponse.json({ error: "المهمة غير موجودة" }, { status: 404 });
    await deleteTask(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "خطأ غير متوقع" }, { status: 500 });
  }
}
