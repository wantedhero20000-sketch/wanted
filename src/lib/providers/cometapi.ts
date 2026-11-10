// ═══════════════════════════════════════════════════════════════
// مزود CometAPI — المزود الثاني
// - الصور: نقطة متوافقة مع OpenAI (متزامنة تعيد الرابط/ b64_json فورًا).
// - الفيديو: نقطة مهام غير متزامنة بنمط create/check.
// ملاحظة: لا يوجد مفتاح CometAPI للتجربة الحية هنا، لذا تلتزم الأشكال
// أدناه بالنمط المتوافق مع OpenAI الموثق لدى api.cometapi.com، وكل المسارات
// قابلة للتجاوز بمتغيرات البيئة (COMETAPI_BASE/COMETAPI_VIDEO_BASE...) —
// عند الاشتراك الفعلي يُتحقق من docs.cometapi.com ويُضبط التجاوز إن لزم دون تغيير الكود.
// ═══════════════════════════════════════════════════════════════
import type { KeyRow } from "../keys";
import { ProviderError, fetchJson, type CheckResult, type ProviderAdapter } from "./types";

const BASE = () => (process.env.COMETAPI_BASE || "https://api.cometapi.com").replace(/\/+$/, "");

function authHeaders(key: KeyRow): Record<string, string> {
  return {
    Authorization: `Bearer ${key.api_key}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/** تحويل نسبة الأبعاد إلى حجم OpenAI المتوافق لنقطة الصور */
function aspectToSize(aspect?: string): string {
  switch (aspect) {
    case "16:9":
    case "2:1":
    case "21:9":
    case "3:1":
      return "1792x1024";
    case "9:16":
    case "1:2":
    case "9:21":
    case "1:3":
      return "1024x1792";
    default:
      return "1024x1024";
  }
}

export const cometApiAdapter: ProviderAdapter = {
  // صور متزامنة — تُعاد النتيجة فورًا دون مهمة
  async createImageSync(key, model, input) {
    const payload: Record<string, unknown> = {
      model,
      prompt: String(input.prompt ?? ""),
      n: 1,
      response_format: "url",
      size: aspectToSize(input.aspect_ratio as string | undefined),
    };
    const { status, json, text } = await fetchJson(`${BASE()}/v1/images/generations`, {
      method: "POST",
      headers: authHeaders(key),
      body: JSON.stringify(payload),
      timeoutMs: 120_000, // التوليد المتزامن قد يستغرق وقتًا
    });
    if (status >= 400) {
      const msg = (json as { error?: { message?: string } } | null)?.error?.message || text.slice(0, 200);
      throw new ProviderError(status, String(msg || `خطأ HTTP ${status}`));
    }
    const data = (json as { data?: Array<{ url?: string; b64_json?: string }> } | null)?.data ?? [];
    const urls: string[] = [];
    for (const item of data) {
      if (item?.url) urls.push(String(item.url));
      // b64_json: روابط فقط تُخزَّن لدينا — لا ننزّل أي وسائط على السيرفر (قاعدة ذهبية)
    }
    if (urls.length === 0) {
      throw new ProviderError(502, "لم تُعد CometAPI روابط صور صالحة (b64_json غير مخزَّن لدينا بالتصميم — استخدم مزودًا يعيد روابط)");
    }
    return { urls };
  },

  // فيديو — مهمة غير متزامنة بنمط create/check
  async createTask(key, model, input) {
    const payload: Record<string, unknown> = {
      model,
      prompt: String(input.prompt ?? ""),
    };
    if (input.image_url) payload.image_url = input.image_url;
    if (input.aspect_ratio && input.aspect_ratio !== "auto") payload.aspect_ratio = input.aspect_ratio;
    if (input.resolution) payload.resolution = input.resolution;
    if (input.enable_audio !== undefined) payload.enable_audio = input.enable_audio;
    if (input.duration) payload.duration = input.duration;

    const { status, json, text } = await fetchJson(`${BASE()}/v1/videos/generations`, {
      method: "POST",
      headers: authHeaders(key),
      body: JSON.stringify(payload),
      timeoutMs: 45_000,
    });
    if (status >= 400) {
      const msg = (json as { error?: { message?: string } } | null)?.error?.message || text.slice(0, 200);
      throw new ProviderError(status, String(msg || `خطأ HTTP ${status}`));
    }
    const body = json as { id?: string; task_id?: string; data?: { task_id?: string; id?: string } };
    const taskId = body.task_id || body.id || body.data?.task_id || body.data?.id;
    if (!taskId) throw new ProviderError(502, "لم تُعد CometAPI معرّف مهمة صالحًا");
    return { providerTaskId: String(taskId) };
  },

  async checkTask(key, providerTaskId) {
    const { status, json, text } = await fetchJson(`${BASE()}/v1/videos/generations/${encodeURIComponent(providerTaskId)}`, {
      method: "GET",
      headers: authHeaders(key),
      timeoutMs: 20_000,
    });
    if (status >= 400) {
      const msg = (json as { error?: { message?: string } } | null)?.error?.message || text.slice(0, 200);
      throw new ProviderError(status, String(msg || `خطأ HTTP ${status}`));
    }
    const body = json as { status?: string; data?: { status?: string; video_url?: string; videoUrl?: string; url?: string; output?: string[]; error?: string } };
    const dataObj = (body.data ?? {}) as {
      status?: string;
      video_url?: string;
      videoUrl?: string;
      url?: string;
      output?: string[];
      error?: string;
    };
    const st = String(dataObj.status || body.status || "").toLowerCase();
    const urls: string[] = [];
    const rawCandidates = dataObj.output || [dataObj.video_url, dataObj.videoUrl, dataObj.url].filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u));
    for (const u of rawCandidates) if (typeof u === "string" && /^https?:\/\//.test(u)) urls.push(u);

    if (["succeeded", "completed", "success", "done"].includes(st)) {
      if (urls.length === 0) return { status: "failed", error: "اكتملت المهمة لدى CometAPI دون روابط نتائج" };
      return { status: "completed", urls };
    }
    if (["failed", "error", "cancelled"].includes(st)) {
      return { status: "failed", error: String(dataObj.error || "فشل التوليد لدى CometAPI") };
    }
    return { status: "processing" };
  },
};
