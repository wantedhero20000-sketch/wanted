// فحص الصحة الشامل — يُستخدم من الواجهة ومن الفحوص الخارجية
// runtime nodejs إلزامي (libsql + SDK يحتاجان Node) و force-dynamic لمنع التخزين المؤقت
import { NextResponse } from "next/server";
import { dbHealthy } from "@/lib/turso";
import { getModels } from "@/lib/models";
import { mergerBase, mergerHealthy, mergerConfigured } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const dbOk = await dbHealthy();
  // فحص جهوزية خدمة الدمج بمهلة 4 ثوانٍ — لا يُوقف باقي الرد
  const mergerOk = await Promise.race([mergerHealthy(), new Promise<boolean>((r) => setTimeout(() => r(false), 4000))]);

  return NextResponse.json(
    {
      ok: dbOk,
      database: dbOk ? "turso-connected" : "turso-unreachable",
      mcpEndpoint: "/mcp",
      models: getModels().map((m) => ({
        canonical: m.canonical,
        type: m.type,
        providers: m.providers,
      })),
      merger: {
        base: mergerBase(),
        healthy: mergerOk,
        configured: mergerConfigured(),
      },
      authRequired: Boolean(process.env.MCP_ACCESS_TOKEN),
    },
    { status: dbOk ? 200 : 503 }
  );
}
