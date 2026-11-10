// ═══════════════════════════════════════════════════════════════
// نظام المفاتيح المتسلسلة — قلب المشروع
// 1) الترتيب صارم بحسب أمر الإضافة (created_at ASC, id ASC) — ليس round-robin.
// 2) تصنيف موحد للأخطاء يحدد: تعطيل المفتاح / مستنزف / مؤقت / معطيات / مزود.
// 3) المفتاح المستنزف يبقى في القاعدة ولا يُستبعد (الاستثناء الوحيد التعطيل اليدوي).
// 4) إخفاء المفاتيح إلزامي في كل الاستجابات — لا يُعاد المفتاح الكامل أبدًا.
// ═══════════════════════════════════════════════════════════════
import { ensureSchema, getTurso, type AttemptEntry } from "./turso";

export type KeyProvider = "kie" | "cometapi";
export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

export interface KeyRow {
  id: string;
  provider: KeyProvider;
  label: string;
  api_key: string;
  status: "active" | "exhausted" | "disabled";
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

/** إخفاء المفتاح: أول 7 أحرف + نقاط + آخر 4 (للمفاتيح القصيرة: أول 3 + نقاط) */
export function maskKey(key: string): string {
  if (key.length >= 14) {
    return `${key.slice(0, 7)}••••••••${key.slice(-4)}`;
  }
  return `${key.slice(0, 3)}••••`;
}

/** نسخة آمنة للعرض — تُستخدم في كل الاستجابات بدل الصف الخام */
export function toPublicKey(k: KeyRow) {
  return {
    id: k.id,
    provider: k.provider,
    label: k.label,
    key_masked: maskKey(k.api_key),
    status: k.status,
    usage_count: k.usage_count,
    success_count: k.success_count,
    fail_count: k.fail_count,
    last_used_at: k.last_used_at,
    last_checked_at: k.last_checked_at,
    last_error: k.last_error,
    created_at: k.created_at,
  };
}

/**
 * جلب مرشّحي المفاتيح لهذه المزودات بالترتيب التسلسلي الصارم:
 * أول مفتاح أُضيف يُجرَّب أولًا ثم التالي ثم التالي…
 * المستنزف (exhausted) يبقى في القائمة — التعطيل اليدوي (disabled) هو الاستثناء الوحيد.
 */
export async function getKeyPool(providers: string[]): Promise<KeyRow[]> {
  await ensureSchema();
  if (providers.length === 0) return [];
  const placeholders = providers.map(() => "?").join(", ");
  const r = await getTurso().execute({
    sql: `SELECT * FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY created_at ASC, id ASC`,
    args: providers,
  });
  return r.rows as unknown as KeyRow[];
}

// أنماط رسائل المزودين — تُفحص بحالة أحرف صغيرة
const PAT_DISABLED = /invalid api key|unauthorized|forbidden|authentication|invalid key|api key/i;
const PAT_EXHAUSTED = /insufficient|quota|balance|credit|out of credits|exhausted|充值|no enough/i;
const PAT_PROVIDER_MODEL = /model not found|unsupported model|model does not exist|no such model/i;

/**
 * تصنيف موحد لخطأ المزود — يحدد الإجراء التالي:
 * - disabled : المفتاح مرفوض → تعطيل تلقائي → المفتاح التالي
 * - exhausted: نفاد رصيد → تعليم المفتاح (يبقى في القاعدة) → التالي
 *              (تُفحص رسائل الرصيد قبل 400 لأن بعض المزودين يرسلونها بحالة 400)
 * - provider : الموديل غير مدعوم لدى هذا المزود → التالي
 * - params   : خطأ معطيات → توقف فورًا (تبديل المفاتيح لن يحل خطأ معطيات)
 * - temporary: 429/5xx/شبكة/timeout → التالي الآن والمفتاح يبقى سليمًا
 */
export function classifyProviderError(err: { status?: number; message?: string }): ErrorClass {
  const status = err.status ?? 0;
  const msg = (err.message || "").toLowerCase();

  // نفاد الرصيد أولًا — بعض المزودين يرسلونه بحالة 400
  if (status === 402 || PAT_EXHAUSTED.test(msg)) return "exhausted";
  if (status === 401 || status === 403 || PAT_DISABLED.test(msg)) return "disabled";
  if (PAT_PROVIDER_MODEL.test(msg) && [400, 404, 422].includes(status)) return "provider";
  if (status === 400 || status === 422) return "params";
  if (status === 429 || status >= 500 || status === 0) return "temporary";
  // أي شيء غير متوقع نعامله كمؤقت — الأمان أولًا (لا نوقف المهمة أبدًا لسبب مجهول)
  return "temporary";
}

/** هل هذا الفشل الوارد من المزود (منتصف المهمة) يشبه مشكلات مفتاح/رصيد؟ — القسم 4.3.2 */
export function looksLikeKeyOrBalanceFailure(message: string): boolean {
  return /insufficient|balance|credit|quota|402|401|unauthorized|exhausted/i.test(message || "");
}

export interface KeyAttemptResult {
  ok: boolean;
  errorClass?: ErrorClass;
  error?: string;
}

/** تحديث عدّادات المفتاح وحالته بعد كل محاولة (نجاح أو فشل) — يُستدعى دائمًا */
export async function recordKeyResult(key: KeyRow, result: KeyAttemptResult): Promise<void> {
  await ensureSchema();
  const now = new Date().toISOString();
  const sets: string[] = [
    "usage_count = usage_count + 1",
    "last_checked_at = ?",
  ];
  const args: (string | number | null)[] = [now];

  if (result.ok) {
    sets.push("success_count = success_count + 1", "last_used_at = ?", "last_error = NULL", "status = 'active'");
    args.push(now);
  } else {
    sets.push("fail_count = fail_count + 1", "last_error = ?");
    args.push((result.error || "خطأ غير معروف").slice(0, 500));
    // تعليم تلقائي: مرفوض → disabled، مستنزف → exhausted (يبقى في القاعدة)
    if (result.errorClass === "disabled") sets.push("status = 'disabled'");
    if (result.errorClass === "exhausted") sets.push("status = 'exhausted'");
  }

  await getTurso().execute({
    sql: `UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`,
    args: [...args, key.id],
  });
}

// ───────────────────────── إدارة المفاتيح (للواجهة) ─────────────────────────

export async function listKeys(): Promise<KeyRow[]> {
  await ensureSchema();
  const r = await getTurso().execute("SELECT * FROM api_keys ORDER BY created_at ASC, id ASC");
  return r.rows as unknown as KeyRow[];
}

export async function insertKey(provider: KeyProvider, apiKey: string, label: string): Promise<KeyRow> {
  await ensureSchema();
  const id = crypto.randomUUID();
  // رفض التكرار لنفس المزود
  const dup = await getTurso().execute({
    sql: "SELECT id FROM api_keys WHERE provider = ? AND api_key = ?",
    args: [provider, apiKey],
  });
  if (dup.rows.length > 0) {
    throw new Error("DUPLICATE_KEY");
  }
  await getTurso().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key, status) VALUES (?, ?, ?, ?, 'active')`,
    args: [id, provider, label, apiKey],
  });
  const r = await getTurso().execute({ sql: "SELECT * FROM api_keys WHERE id = ?", args: [id] });
  return r.rows[0] as unknown as KeyRow;
}

export async function setKeyStatus(id: string, status: "active" | "disabled"): Promise<KeyRow | null> {
  await ensureSchema();
  await getTurso().execute({
    sql: "UPDATE api_keys SET status = ?, last_error = NULL WHERE id = ?",
    args: [status, id],
  });
  const r = await getTurso().execute({ sql: "SELECT * FROM api_keys WHERE id = ?", args: [id] });
  return (r.rows[0] as unknown as KeyRow) ?? null;
}

export async function deleteKey(id: string): Promise<boolean> {
  await ensureSchema();
  const r = await getTurso().execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
  return r.rowsAffected > 0;
}

/** بناء مُدخلة محاولة موحدة — تُستخدم في كل تسجيلات المحاولات */
export function makeAttempt(
  key: KeyRow | null,
  provider: string,
  ok: boolean,
  errorClass?: ErrorClass,
  error?: string
): AttemptEntry {
  return {
    provider,
    keyId: key?.id ?? "-",
    keyLabel: key?.label || undefined,
    ok,
    errorClass,
    error: error?.slice(0, 300),
    at: new Date().toISOString(),
  };
}
