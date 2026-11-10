// ═══════════════════════════════════════════════════════════════
// مسار خادم MCP — /mcp (نقل Streamable HTTP حسب مواصفات MCP)
// يُستخدم النقل الرسمي من SDK (نسخة البيئات المعيارية للويب — نفس فئة
// Streamable HTTP الرسمية؛ هيكل Next.js App Router يعمل بـ Web Request/Response).
// نمط stateless (sessionIdGenerator: undefined) — الصيغة الموصى بها
// للبيئات serverless مثل Vercel حيث لا تُحفظ الجلسات في الذاكرة.
// ═══════════════════════════════════════════════════════════════
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildMcpServer } from "@/lib/mcp-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** حماية اختيارية: إن ضُبط MCP_ACCESS_TOKEN يُطلب Authorization: Bearer <token> */
function checkAuth(request: Request): Response | null {
  const token = process.env.MCP_ACCESS_TOKEN;
  if (!token) return null; // غير مفعّل — الوصول مفتوح
  const auth = request.headers.get("authorization") || "";
  if (auth !== `Bearer ${token}`) {
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: MCP_ACCESS_TOKEN مطلوب" }, id: null }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }
  return null;
}

/** إنشاء خادم + نقل جديدين لكل طلب — عزل كامل بين الطلبات (stateless) */
async function handle(request: Request): Promise<Response> {
  const unauthorized = checkAuth(request);
  if (unauthorized) return unauthorized;

  // POST يقرأ الجسم مسبقًا ونمرره parsedBody (النقل لن يعيد قراءته)
  let parsedBody: unknown;
  if (request.method === "POST") {
    try {
      parsedBody = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error: جسم الطلب ليس JSON صالحًا" }, id: null }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  const server = buildMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — كل طلب قائم بذاته
  });
  await server.connect(transport);

  // النقل يعيد Response معيارية (تدعم SSE للتقدم الحي) — نمررها كما هي لـ Next.js
  const response = await transport.handleRequest(request, { parsedBody });
  return response;
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}

// GET (فتح مجرى SSE مستقل) و DELETE (إنهاء جلسة): في النمط stateless
// يرد النقل الرسمي نفسه بالرمز المناسب (405) — نمرر الطلب إليه للتوافق الكامل.
export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return handle(request);
}
