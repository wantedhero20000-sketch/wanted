// إدارة المفاتيح — القائمة والإضافة
// القاعدة الذهبية: المفاتيح مُقنَّعة دائمًا في كل الاستجابات — لا يُعاد المفتاح الكامل أبدًا
import { NextResponse } from "next/server";
import { insertKey, listKeys, toPublicKey, type KeyProvider } from "@/lib/keys";

export const runtime = "nodejs";

export async function GET() {
  try {
    const keys = await listKeys();
    return NextResponse.json({ keys: keys.map(toPublicKey) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "خطأ غير متوقع" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { provider?: string; api_key?: string; label?: string };
    const provider = body.provider as KeyProvider;
    const apiKey = (body.api_key || "").trim();
    const label = (body.label || "").trim().slice(0, 100);

    if (provider !== "kie" && provider !== "cometapi") {
      return NextResponse.json({ error: "المزود يجب أن يكون kie أو cometapi" }, { status: 400 });
    }
    if (!apiKey || apiKey.length < 8) {
      return NextResponse.json({ error: "أدخل مفتاح API صالحًا" }, { status: 400 });
    }

    const key = await insertKey(provider, apiKey, label);
    return NextResponse.json({ key: toPublicKey(key) }, { status: 201 });
  } catch (e) {
    if (e instanceof Error && e.message === "DUPLICATE_KEY") {
      return NextResponse.json({ error: "هذا المفتاح مضاف مسبقًا لنفس المزود — رفض التكرار" }, { status: 409 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : "خطأ غير متوقع" }, { status: 500 });
  }
}
