// ═══════════════════════════════════════════════════════════════
// مزود kie.ai — Jobs API الموحد (المزود الأساسي)
// الأشكال أدناه مقاسة فعليًا بـ curl (لا حقول مخترعة):
//   POST /api/v1/jobs/createTask  → {"code":200,"msg":"success","data":{"taskId":"..."}}
//   GET  /api/v1/jobs/recordInfo  → {"code":200,"data":{"state":"waiting|queuing|generating|success|fail",
//          "resultJson":"{\"resultUrls\":[\"https://...\"]}",  // نص JSON داخل JSON يحتاج parse ثانيًا
//          "failMsg":"..."}}
// إن تغيّر الشكل لاحقًا فالمصدر هو توثيق docs.kie.ai الرسمي.
// ═══════════════════════════════════════════════════════════════
import type { KeyRow } from "../keys";
import { ProviderError, fetchJson, type CheckResult, type ProviderAdapter } from "./types";

const BASE = "https://api.kie.ai";

interface KieResponse {
  code?: number;
  msg?: string;
  error?: string;
  data?: unknown;
}

async function callKie(key: KeyRow, path: string, init?: RequestInit & { timeoutMs?: number }): Promise<KieResponse> {
  const { status, json, text } = await fetchJson(BASE + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${key.api_key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init?.headers || {}),
    },
  });
  const body = (json ?? {}) as KieResponse;
  // kie قد يرجع 200 HTTP مع code != 200 داخل الجسم — نعاملها كخطأ بالحالة المناسبة
  const effectiveStatus = status >= 400 ? status : body.code && body.code !== 200 ? body.code : status;
  if (effectiveStatus >= 400) {
    throw new ProviderError(effectiveStatus, String(body.msg || body.error || text.slice(0, 200) || `خطأ HTTP ${status}`));
  }
  return body;
}

export const kieAdapter: ProviderAdapter = {
  async createTask(key: KeyRow, model: string, input: Record<string, unknown>) {
    const body = await callKie(key, "/api/v1/jobs/createTask", {
      method: "POST",
      body: JSON.stringify({ model, input }),
      timeoutMs: 45_000,
    });
    const taskId = (body.data as { taskId?: unknown } | undefined)?.taskId;
    if (!taskId) throw new ProviderError(502, "لم يُعد kie.ai معرّف مهمة صالحًا");
    return { providerTaskId: String(taskId) };
  },

  async checkTask(key: KeyRow, providerTaskId: string): Promise<CheckResult> {
    const body = await callKie(key, `/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`, {
      method: "GET",
      timeoutMs: 20_000,
    });
    const d = (body.data ?? {}) as {
      state?: string;
      resultJson?: string;
      failMsg?: string | null;
      failCode?: string | null;
    };
    const state = String(d.state || "").toLowerCase();

    if (state === "success") {
      // resultJson نص JSON داخل JSON — يحتاج JSON.parse ثانيًا
      let urls: string[] = [];
      try {
        const inner = JSON.parse(d.resultJson || "{}") as { resultUrls?: unknown };
        if (Array.isArray(inner.resultUrls)) {
          urls = inner.resultUrls.map((u) => String(u)).filter((u) => /^https?:\/\//.test(u));
        }
      } catch {
        // تجاهل — يُعامل أدناه كاكتمال دون روابط
      }
      if (urls.length === 0) {
        return { status: "failed", error: "اكتملت المهمة لدى المزود دون روابط نتائج صالحة" };
      }
      return { status: "completed", urls };
    }

    if (state === "fail") {
      return { status: "failed", error: String(d.failMsg || d.failCode || "فشل التوليد لدى المزود") };
    }

    // waiting | queuing | generating → قيد المعالجة (kie لا يقدم نسبة — يُقدَّر التقدم خارجيًا)
    return { status: "processing" };
  },
};
