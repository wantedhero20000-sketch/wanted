// تعطيل/تنشيط/حذف مفتاح — التعطيل اليدوي هو الاستثناء الوحيد الذي يُخرج المفتاح من القائمة
import { NextResponse } from "next/server";
import { deleteKey, setKeyStatus, toPublicKey } from "@/lib/keys";

export const runtime = "nodejs";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = (await request.json()) as { status?: string };
    if (body.status !== "active" && body.status !== "disabled") {
      return NextResponse.json({ error: "status يجب أن يكون active أو disabled" }, { status: 400 });
    }
    const key = await setKeyStatus(id, body.status);
    if (!key) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
    return NextResponse.json({ key: toPublicKey(key) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "خطأ غير متوقع" }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const deleted = await deleteKey(id);
    if (!deleted) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "خطأ غير متوقع" }, { status: 500 });
  }
}
