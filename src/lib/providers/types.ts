// ═══════════════════════════════════════════════════════════════
// واجهة المزودات المشتركة — كل مزود ينفذ هذه الواجهة
// أي خطأ يُرمى كـ ProviderError ليُصنَّف في classifyProviderError (keys.ts)
// ═══════════════════════════════════════════════════════════════
import type { KeyRow } from "../keys";

export class ProviderError extends Error {
  constructor(
    public status: number, // 0 = خطأ شبكة/timeout
    message: string
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface CreateTaskResult {
  providerTaskId: string;
}

export interface CheckResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number; // 0..100 إن قدّمه المزود
}

export interface ProviderAdapter {
  // مهمة غير متزامنة (فيديو، وبعض الصور): تعيد providerTaskId
  createTask(key: KeyRow, model: string, input: Record<string, unknown>): Promise<CreateTaskResult>;
  // صور متزامنة إن كان المزود يدعمها (CometAPI تعيد النتيجة فورًا)
  createImageSync?(key: KeyRow, model: string, input: Record<string, unknown>): Promise<{ urls: string[] }>;
  // استعلام حالة مهمة جارية
  checkTask(key: KeyRow, providerTaskId: string): Promise<CheckResult>;
}

/** جلب JSON من استجابة fetch مع تحويل الأخطاء إلى ProviderError */
export async function fetchJson(
  url: string,
  init: RequestInit & { timeoutMs?: number }
): Promise<{ status: number; json: unknown; text: string }> {
  const { timeoutMs = 30_000, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    // خطأ شبكة/انقطاع/timeout — مصنف لاحقًا كـ temporary (status 0)
    throw new ProviderError(0, `تعذر الاتصال بالمزود: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    if (res.ok) {
      throw new ProviderError(res.status, `استجابة غير صالحة (JSON) من المزود: ${text.slice(0, 180)}`);
    }
  }
  return { status: res.status, json, text };
}
