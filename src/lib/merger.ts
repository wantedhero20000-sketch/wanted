// ═══════════════════════════════════════════════════════════════
// خدمة دمج الفيديو — Video Merger API v2
// تدعم خدمة عامة بلا توثيق، أو خدمة خاصة محمية بمفتاح عبر
// متغير البيئة MERGER_API_TOKEN (يُرسل كترويسة X-API-Key).
// المخرجات: MP4 (H.264 + AAC) حتى 1080p بجودة CRF 18 — لا resolution/fps (الناتج ثابت).
// القيود: 10 مقاطع كحد أقصى، 200MB لكل مصدر، 150MB للناتج، 600 ثانية مجموع المدد،
// وكل الملفات تُحذف تلقائيًا بعد 24 ساعة.
//
// قواعد حتمية:
// - أي خطأ HTTP معلن من الخدمة (4xx/5xx بجسم error) = فشل نهائي فوري — لا إعادة محاولة.
// - أخطاء شبكتنا نحن (timeout/fetch) = مؤقتة → استمر بالاستعلام حتى انتهاء النافذة.
// - process يُطلق خلفيًا وبمرة واحدة فقط بقفل في الذاكرة.
// - روابط فقط — لا تنزيل أي وسائط على سيرفرنا إطلاقًا.
// ═══════════════════════════════════════════════════════════════
import { getTask, insertTask, updateTask, type TaskRow } from "./turso";

const DEFAULT_BASE = "https://xxxxxxxxxx"; // العنوان يُضبط عبر MERGER_API_BASE

export function mergerBase(): string {
  return (process.env.MERGER_API_BASE || DEFAULT_BASE).replace(/\/+$/, "");
}

/** هل الخدمة مهيأة فعلاً؟ (العنوان الافتراضي placeholder وليس خدمة حقيقية) */
export function mergerConfigured(): boolean {
  return /^https?:\/\//.test(mergerBase()) && !mergerBase().includes("xxxxxxxx");
}

/** ترويسة توثيق اختيارية لخدمة الدمج الخاصة (MERGER_API_TOKEN → X-API-Key) */
function mergerHeaders(): Record<string, string> {
  const token = (process.env.MERGER_API_TOKEN || "").trim();
  return token ? { "x-api-key": token } : {};
}

// قفل الذاكرة: مهمات الدمج التي يُنفَّذ process لها حاليًا/سبق له اكتماله بنجاح
const processInFlight = new Set<string>();
const processDoneOk = new Set<string>();

interface MergerJobResponse {
  jobId?: string;
  status?: string;
  statusUrl?: string;
  processUrl?: string;
  progress?: number;
  videoUrl?: string;
  downloadUrl?: string;
  size?: number;
  duration?: number;
  resolution?: string;
  expiresAt?: string;
  error?: string;
}

async function call(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<{ status: number; json: MergerJobResponse | null; text: string }> {
  // init اختياري — نفكك بأمان مع مهلة افتراضية 15 ثانية
  const { timeoutMs = 15_000, ...rest } = init ?? {};
  let res: Response;
  try {
    res = await fetch(mergerBase() + path, {
      ...rest,
      headers: { ...mergerHeaders(), ...((rest.headers as Record<string, string>) || {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // خطأ شبكتنا — يُعامل كمؤقت (status 0) ولا ينهي المهمة
    throw new Error(`NETWORK:${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  let json: MergerJobResponse | null = null;
  try {
    json = JSON.parse(text) as MergerJobResponse;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

/** تحليل الحالة دفاعيًا — القسم 7.2 */
function parseStatus(s?: string): "queued" | "completed" | "failed" | "processing" {
  const v = (s || "").toLowerCase();
  if (/done|completed|complete|success|succeeded|finished/.test(v)) return "completed";
  if (/error|failed|failure|cancelled/.test(v)) return "failed";
  if (/queued|pending/.test(v)) return "queued";
  return "processing";
}

function pickResultUrl(jobId: string, j: MergerJobResponse | null): string {
  // فضّل videoUrl ثم downloadUrl، وإن غابا فاضبط رابط الفيديو المباشر
  if (j?.videoUrl) return j.videoUrl;
  if (j?.downloadUrl) return j.downloadUrl;
  return `${mergerBase()}/api/jobs/${jobId}/video`;
}

function normalizeProgress(p: unknown): number {
  const n = Number(p);
  if (!Number.isFinite(n)) return 0;
  // progress يأتي أحيانًا كسرًا 0..1 → اضربه في 100
  return Math.round(n <= 1 ? n * 100 : n);
}

/** فحص جهوزية الخدمة — GET /api/config بمهلة 4 ثوانٍ (يُستخدم في /api/health) */
export async function mergerHealthy(): Promise<boolean> {
  if (!mergerConfigured()) return false;
  try {
    const { status } = await call("/api/config", { timeoutMs: 4_000 });
    return status >= 200 && status < 500; // أي رد من الخدمة يثبت أنها حية
  } catch {
    return false;
  }
}

// ───────────────────────── التحقق من الروابط ─────────────────────────

/** رابط http/https مباشر وعام — نرفض العناوين الداخلية/المحلية */
export function isPublicHttpUrl(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const h = url.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
    if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    if (h === "::1" || h === "[::1]" || h === "0.0.0.0") return false;
    return true;
  } catch {
    return false;
  }
}

// ───────────────────────── تدفق runMerge ─────────────────────────

export type MergeOutcome =
  | { kind: "completed"; task: TaskRow }
  | { kind: "processing"; task: TaskRow; progress: number }
  | { kind: "failed"; task?: TaskRow; message: string }
  | { kind: "invalid"; message: string }; // خطأ تحقق — بلا مهمة

export type NotifyFn = (p: { progress: number; total: number; message: string }) => Promise<void> | void;

/**
 * تدفق الدمج:
 * 1) تحقق صارم: ≥2 رابط، كلها http/https مباشرة وعامة، ≤10.
 * 2) تسجيل مهمة type=merge في Turso أولًا.
 * 3) POST /api/jobs ثم إطلاق process خلفيًا وبمرة واحدة (قفل في الذاكرة).
 * 4) استعلام كل 3 ثوانٍ مع بث تقدم وتحديث Turso فورًا كل مرة.
 */
export async function runMerge(urls: string[], waitSeconds?: number, notify?: NotifyFn): Promise<MergeOutcome> {
  if (!mergerConfigured()) {
    return { kind: "invalid", message: "❌ خدمة الدمج غير مهيأة — اضبط متغير البيئة MERGER_API_BASE بعنوان خدمة الدمج الحقيقي، ثم أعد المحاولة." };
  }

  // 1) التحقق الصارم
  const bad = urls.filter((u) => !isPublicHttpUrl(u));
  if (bad.length > 0) {
    return { kind: "invalid", message: `❌ روابط غير صالحة (يجب أن تكون روابط فيديو مباشرة عامة http/https):\n${bad.map((b) => `- ${b}`).join("\n")}` };
  }
  if (urls.length < 2) {
    return { kind: "invalid", message: "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة." };
  }
  if (urls.length > 10) {
    return { kind: "invalid", message: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى)." };
  }

  // 2) تسجيل المهمة أولًا
  const task = await insertTask({
    id: crypto.randomUUID(),
    model: "video-merger",
    type: "merge",
    prompt: `دمج ${urls.length} مقاطع`,
    params_json: JSON.stringify({ urls, wait_seconds: waitSeconds ?? 60 }),
    status: "processing",
  });

  // 3) إنشاء مهمة الدمج لدى الخدمة
  let jobId: string;
  try {
    const { status, json } = await call("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videos: urls }),
      timeoutMs: 20_000,
    });
    if (status >= 400 || !json?.jobId) {
      // خطأ HTTP معلن = فشل نهائي فوري (لا إعادة محاولة)
      const t = await updateTask(task.id, {
        status: "failed",
        error_message: `فشل إنشاء مهمة الدمج لدى الخدمة: ${(json?.error || `HTTP ${status}`).slice(0, 300)}`,
      });
      return { kind: "failed", task: t!, message: json?.error || `HTTP ${status}` };
    }
    jobId = json.jobId;
    await updateTask(task.id, { provider: "merger", provider_task_id: jobId });
  } catch (e) {
    if (String((e as Error).message).startsWith("NETWORK:")) {
      // خطأ شبكتنا — تبقى processing وتُعاد المحاولة عبر get_task
      const t = await updateTask(task.id, { error_message: "بانتظار خدمة الدمج…" });
      return { kind: "processing", task: t!, progress: 0 };
    }
    throw e;
  }

  // إطلاق process خلفيًا وبمرة واحدة فقط
  triggerProcess(jobId);

  // 4) نافذة الانتظار مع استعلام كل 3 ثوانٍ
  const windowSec = Math.max(0, Math.min(240, waitSeconds ?? 60));
  const deadline = Date.now() + windowSec * 1000;

  while (Date.now() < deadline) {
    const st = await pollMergeJob(task.id, jobId, notify);
    if (st === "completed") {
      return { kind: "completed", task: (await getTask(task.id))! };
    }
    if (st === "failed") {
      const t = (await getTask(task.id))!;
      return { kind: "failed", task: t, message: t.error_message || "فشل الدمج" };
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  const t = (await getTask(task.id))!;
  return { kind: "processing", task: t, progress: t.progress };
}

/** استعلام واحد عن حالة مهمة الدمج وتحديث Turso فورًا — يُعيد الحالة النهائية إن وصلت */
async function pollMergeJob(taskId: string, jobId: string, notify?: NotifyFn): Promise<"completed" | "failed" | "pending"> {
  try {
    const { status, json } = await call(`/api/jobs/${encodeURIComponent(jobId)}`, { timeoutMs: 15_000 });
    if (status === 404) {
      await updateTask(taskId, { status: "failed", error_message: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)" });
      return "failed";
    }
    if (status >= 400) {
      // خطأ HTTP معلن = فشل نهائي فوري — لا إعادة محاولة
      await updateTask(taskId, { status: "failed", error_message: `خطأ من خدمة الدمج: ${(json?.error || `HTTP ${status}`).slice(0, 300)}` });
      return "failed";
    }
    // انتبه: قد يرد الجسم فيه error بدون حقل status → عاملها failed فورًا
    if (json?.error && !json?.status) {
      await updateTask(taskId, { status: "failed", error_message: `خطأ من خدمة الدمج: ${String(json.error).slice(0, 300)}` });
      return "failed";
    }
    const st = parseStatus(json?.status);
    const progress = normalizeProgress(json?.progress);

    if (st === "completed") {
      await updateTask(taskId, { status: "completed", result_urls: [pickResultUrl(jobId, json)], progress: 100 });
      await notify?.({ progress: 100, total: 100, message: "اكتمل الدمج بنجاح" });
      return "completed";
    }
    if (st === "failed") {
      await updateTask(taskId, { status: "failed", error_message: `فشل الدمج: ${String(json?.error || "سبب غير معلن").slice(0, 300)}` });
      return "failed";
    }

    await updateTask(taskId, { status: "processing", progress });
    await notify?.({ progress, total: 100, message: `قيد الدمج… ${progress}%` });
    return "pending";
  } catch (e) {
    // أخطاء شبكتنا = مؤقتة → استمر بالاستعلام حتى انتهاء النافذة
    if (String((e as Error).message).startsWith("NETWORK:")) return "pending";
    throw e;
  }
}

/** إطلاق process مرة واحدة بقفل في الذاكرة — يستدعى خلفيًا ومن get_task عند الحاجة */
export function triggerProcess(jobId: string): void {
  if (processDoneOk.has(jobId) || processInFlight.has(jobId)) return;
  processInFlight.add(jobId);
  void (async () => {
    try {
      const { status, json } = await call(`/api/jobs/${encodeURIComponent(jobId)}/process`, {
        method: "POST",
        timeoutMs: 120_000, // يستغرق ~10–15 ثانية (blocking)
      });
      if (status >= 200 && status < 300) {
        processDoneOk.add(jobId);
      } else if (status >= 400) {
        // فشل معلن من الخدمة (مثل مصدر يرفض التحميل) — فشل حتمي: تكرار المحاولة يعطي النتيجة نفسها
        processInFlight.delete(jobId);
        // نجيب مهمة الدمج المخزنة المقابلة إن وُجدت
        await failMergeTaskByJobId(jobId, json?.error || `فشل تنفيذ المعالجة (HTTP ${status})`);
        return;
      }
    } catch {
      // timeout شبكتنا — نحرر القفل ليُعاد الإطلاق من get_task لاحقًا (الحالة عند الخدمة غير معلومة)
    }
    processInFlight.delete(jobId);
  })();
}

async function failMergeTaskByJobId(jobId: string, error: string): Promise<void> {
  const { listRecentTasks } = await import("./turso");
  const tasks = await listRecentTasks(50, { type: "merge", status: "processing" });
  const t = tasks.find((x) => x.provider_task_id === jobId);
  if (t) {
    await updateTask(t.id, { status: "failed", error_message: `فشل الدمج: ${error.slice(0, 300)}` });
  }
}

/** refreshMergeTask — يُستدعى من get_task لمهمة دمج جارية */
export async function refreshMergeTask(task: TaskRow): Promise<TaskRow | null> {
  if (!mergerConfigured()) {
    return updateTask(task.id, { error_message: "بانتظار تهيئة خدمة الدمج (MERGER_API_BASE)…" });
  }
  const jobId = task.provider_task_id;
  if (!jobId) {
    // لم تُنشأ مهمة الخدمة بعد (فشل شبكة سابق) — أعد المحاولة بعد تهدئة
    const params = JSON.parse(task.params_json || "{}") as { urls?: string[]; wait_seconds?: number };
    if (!params.urls || params.urls.length < 2) {
      return updateTask(task.id, { status: "failed", error_message: "معطيات الدمج المخزنة غير مكتملة" });
    }
    try {
      const { status, json } = await call("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videos: params.urls }),
        timeoutMs: 20_000,
      });
      if (status >= 400 || !json?.jobId) {
        return updateTask(task.id, { status: "failed", error_message: `فشل إنشاء مهمة الدمج لدى الخدمة: ${(json?.error || `HTTP ${status}`).slice(0, 300)}` });
      }
      await updateTask(task.id, { provider: "merger", provider_task_id: json.jobId });
      triggerProcess(json.jobId);
      return updateTask(task.id, { progress: 5 });
    } catch {
      return updateTask(task.id, { error_message: "بانتظار خدمة الدمج…" });
    }
  }

  triggerProcess(jobId); // إن كانت processing ولم يُنفَّذ process بعد فنفّذه الآن (القفل يمنع التزامن)

  await pollMergeJob(task.id, jobId);
  return (await getTask(task.id)) ?? task;
}

/** حذف مهمة دمج من الخدمة (تنظيف اختياري) */
export async function deleteMergerJob(jobId: string): Promise<boolean> {
  try {
    const { status } = await call(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE", timeoutMs: 10_000 });
    return status >= 200 && status < 300;
  } catch {
    return false;
  }
}
