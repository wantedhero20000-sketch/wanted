// ═══════════════════════════════════════════════════════════════
// منسّق التوليد — runGeneration / refreshTask
//
// القواعد الجوهرية المنفَّذة هنا (لا تُخرَق):
// 1) المفاتيح تُجرَّب تسلسليًا بترتيب الإضافة (created_at ASC, id ASC).
// 2) عند أي خطأ مفتاح/رصيد/مزود/مؤقت → تبديل فوري للمفتاح التالي دون توقف.
// 3) فشل منتصف المهمة بنمط مفتاح/رصيد → إعادة إنشاء نفس المهمة بنفس task_id.
// 4) فشل الإنشاء على كل المفاتيح → المهمة تبقى processing (ليست failed)
//    وتُعاد المحاولة تلقائيًا مع كل get_task بعد تهدئة ~45 ثانية.
// 5) نموذج الذكاء الاصطناعي لا يرى أخطاء مفاتيح/رصيد أبدًا — التبديل صامت.
// 6) خطأ معطيات (params) = توقف فوري — تبديل المفاتيح لن يحل خطأ معطيات.
// ═══════════════════════════════════════════════════════════════
import {
  getTask,
  insertTask,
  updateTask,
  type AttemptEntry,
  type MediaType,
  type TaskRow,
} from "./turso";
import {
  classifyProviderError,
  getKeyPool,
  looksLikeKeyOrBalanceFailure,
  makeAttempt,
  recordKeyResult,
  type KeyRow,
} from "./keys";
import { resolveModel, type ModelDef } from "./models";
import { getAdapter, ProviderError, type CheckResult, type ProviderAdapter } from "./providers";

const POLL_INTERVAL_MS = 3_000; // استعلام كل 3 ثوانٍ أثناء نافذة الانتظار
const RETRY_COOLDOWN_MS = 45_000; // تهدئة قبل إعادة محاولة الإنشاء بعد فشل كل المفاتيح
const DEFAULT_WAIT: Record<MediaType, number> = { image: 90, video: 25, merge: 60 };
const EXPECTED_DURATION_MS: Record<MediaType, number> = {
  image: 45_000, // لتقدير التقدم — kie لا يقدم نسبة تقدم حقيقية
  video: 150_000,
  merge: 20_000,
};

/** باث المعطيات الأصلية للصور/الفيديو — يُخزَّن كاملًا لإعادة الإنشاء عند التبديل */
export interface GenParams {
  prompt: string;
  model: string;
  aspect_ratio?: string;
  resolution?: string;
  background?: string;
  output_format?: string;
  image_url?: string;
  enable_audio?: boolean;
  duration?: number;
  wait_seconds?: number;
}

export type NotifyFn = (p: { progress: number; total: number; message: string }) => Promise<void> | void;

export type GenOutcome =
  | { kind: "completed"; task: TaskRow }
  | { kind: "processing"; task: TaskRow; progress: number }
  | { kind: "failed"; task: TaskRow }
  | { kind: "no_keys"; model: string }
  | { kind: "bad_model"; name: string };

/** بناء input المزود من المعطيات الموحدة — فقط الحقول الممررة (بدون auto الافتراضية إن لزم) */
function buildProviderInput(type: MediaType, p: GenParams): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt: p.prompt };
  if (type === "image") {
    if (p.aspect_ratio) input.aspect_ratio = p.aspect_ratio;
    if (p.resolution) input.resolution = p.resolution;
    if (p.background && p.background !== "auto") input.background = p.background;
    if (p.output_format) input.output_format = p.output_format;
  } else {
    if (p.image_url) input.image_url = p.image_url;
    if (p.aspect_ratio && p.aspect_ratio !== "auto") input.aspect_ratio = p.aspect_ratio;
    if (p.resolution) input.resolution = p.resolution;
    if (p.enable_audio !== undefined) input.enable_audio = p.enable_audio;
    if (p.duration) input.duration = p.duration;
  }
  return input;
}

/** تقدير تقدم تقريبي من الزمن المنقضي — يُستخدم عندما لا يقدم المزود نسبة */
function estimatedProgress(startedAtMs: number, type: MediaType): number {
  const elapsed = Date.now() - startedAtMs;
  const pct = Math.round((elapsed / EXPECTED_DURATION_MS[type]) * 100);
  return Math.max(5, Math.min(95, pct));
}

function classifyErr(e: unknown): { status: number; message: string } {
  if (e instanceof ProviderError) return { status: e.status, message: e.message };
  return { status: 0, message: e instanceof Error ? e.message : String(e) };
}

interface CreationSuccess {
  ok: true;
  provider: string;
  providerTaskId: string;
  key: KeyRow;
}
interface CreationAllFailed {
  ok: false;
}

/**
 * محاولة إنشاء المهمة على مرشّحي المفاتيح بالترتيب الصارم.
 * كل محاولة (نجاح/فشل + الفئة) تُسجَّل في attempts وعدّادات المفتاح تُحدَّث دائمًا.
 * خطأ معطيات (params) يُرمى استثناءً — توقف فوري حسب القاعدة 4.2.
 */
async function attemptCreation(
  task: TaskRow,
  def: ModelDef,
  pool: KeyRow[],
  adapterOf: (provider: string) => ProviderAdapter | undefined,
  whenFailed: (a: AttemptEntry, cls: string) => Promise<void>
): Promise<CreationSuccess | CreationAllFailed> {
  const input = buildProviderInput(task.type as MediaType, JSON.parse(task.params_json) as GenParams);

  for (const key of pool) {
    const adapter = adapterOf(key.provider);
    if (!adapter) continue;
    const providerModel = def.providerModel[key.provider as keyof typeof def.providerModel] || def.canonical;
    try {
      // الصور المتزامنة (CometAPI): نتيجة فورية بلا مهمة
      if (task.type === "image" && adapter.createImageSync) {
        const { urls } = await adapter.createImageSync(key, providerModel, input);
        await recordKeyResult(key, { ok: true });
        await whenFailed(makeAttempt(key, key.provider, true), "ok");
        await updateTask(task.id, {
          provider: key.provider,
          provider_task_id: null, // متزامنة — لا معرّف مهمة لدى المزود
          key_id: key.id,
          status: "completed",
          result_urls: urls,
          appendAttempt: makeAttempt(key, key.provider, true),
        });
        return { ok: true, provider: key.provider, providerTaskId: "", key };
      }

      const { providerTaskId } = await adapter.createTask(key, providerModel, input);
      await recordKeyResult(key, { ok: true });
      await updateTask(task.id, {
        provider: key.provider,
        provider_task_id: providerTaskId,
        key_id: key.id,
        status: "processing",
        error_message: null,
        appendAttempt: makeAttempt(key, key.provider, true),
      });
      return { ok: true, provider: key.provider, providerTaskId, key };
    } catch (e) {
      const { status, message } = classifyErr(e);
      const cls = classifyProviderError({ status, message });
      await recordKeyResult(key, { ok: false, errorClass: cls, error: message });
      await whenFailed(makeAttempt(key, key.provider, false, cls, message), cls);
      if (cls === "params") {
        // خطأ معطيات حتمي — تبديل المفاتيح لن يحلّه: توقف فوري
        throw new ParamsError(message);
      }
      // disabled / exhausted / provider / temporary → الانتقال للمفتاح التالي فورًا
      continue;
    }
  }
  return { ok: false };
}

export class ParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParamsError";
  }
}

/**
 * التدفق الكامل لأداة generate_image / generate_video:
 * 1) توحيد اسم الموديل — غير معروف → خطأ معطيات فوري.
 * 2) جلب مرشّحي المفاتيح — فارغ → no_keys.
 * 3) تسجيل المهمة في Turso قبل أي نداء خارجي.
 * 4) إنشاء على المرشّحين بالترتيب حتى أول نجاح.
 * 5) نافذة انتظار ببث تقدم حي كل ~3 ثوانٍ.
 * 6) اكتمال → روابط؛ فشل حقيقي → failed؛ فشل مفتاح/رصيد → إعادة إنشاء بنفس task_id؛
 *    انتهاء النافذة → processing والعميل يتابع بـ get_task.
 */
export async function runGeneration(
  type: "image" | "video",
  params: GenParams,
  notify?: NotifyFn
): Promise<GenOutcome> {
  const def = resolveModel(params.model, type);
  if (!def) return { kind: "bad_model", name: params.model || "(فارغ)" };

  const pool = await getKeyPool(def.providers);
  if (pool.length === 0) {
    return { kind: "no_keys", model: def.canonical };
  }

  // تسجيل المهمة في Turso قبل أي نداء خارجي — تبقى قابلة للتتبع حتى لو انقطع الاتصال
  const task = await insertTask({
    id: crypto.randomUUID(),
    model: def.canonical,
    type,
    prompt: params.prompt,
    params_json: JSON.stringify(params),
    status: "processing",
  });

  const adapterOf = (p: string) => getAdapter(p);

  let creation: CreationSuccess | CreationAllFailed;
  try {
    creation = await attemptCreation(task, def, pool, adapterOf, async () => {});
  } catch (e) {
    if (e instanceof ParamsError) {
      const t = await updateTask(task.id, { status: "failed", error_message: `خطأ في معطيات الطلب: ${e.message}` });
      return { kind: "failed", task: t! };
    }
    throw e;
  }

  if (!creation.ok) {
    // فشل الإنشاء على كل المفاتيح — تبقى processing «بانتظار توفر مفتاح صالح…»
    const t = await updateTask(task.id, {
      status: "processing",
      error_message: "بانتظار توفر مفتاح صالح…",
      appendAttempt: {
        provider: "-",
        keyId: "-",
        ok: false,
        errorClass: "exhausted",
        error: "فشل الإنشاء على كل المفاتيح — بانتظار توفر مفتاح صالح",
        at: new Date().toISOString(),
      },
    });
    return { kind: "processing", task: t!, progress: 0 };
  }

  // صور متزامنة اكتملت فورًا
  if (creation.providerTaskId === "" && creation.provider) {
    const t = (await getTask(task.id))!;
    return { kind: "completed", task: t };
  }

  const done = await waitWindow(task.id, def, notify);
  const t = (await getTask(task.id))!;
  if (done) return { kind: "completed", task: t };
  return { kind: "processing", task: t, progress: t.progress };
}

/**
 * نافذة الانتظار: استعلام كل 3 ثوانٍ مع بث تقدم.
 * فشل حقيقي (سياسة/معطيات) → failed.
 * فشل بنمط مفتاح/رصيد → إعادة إنشاء نفس المهمة على المفتاح التالي (قسم 4.3.2).
 * انتهاء النافذة → processing (تُكمل عبر get_task).
 */
async function waitWindow(
  taskId: string,
  def: ModelDef,
  notify?: NotifyFn
): Promise<boolean> {
  let task = (await getTask(taskId))!;
  const params = JSON.parse(task.params_json) as GenParams;
  const windowMs = Math.max(0, Math.min(240, params.wait_seconds ?? DEFAULT_WAIT[task.type as MediaType])) * 1000;
  const deadline = Date.now() + windowMs;
  const startedAt = Date.parse(task.created_at.endsWith("Z") ? task.created_at : task.created_at + "Z") || Date.now();

  while (Date.now() < deadline) {
    task = (await getTask(taskId))!;
    if (task.status === "completed" || task.status === "failed") return task.status === "completed";
    if (!task.provider || !task.provider_task_id) {
      // بانتظار إعادة الإنشاء — حاول الآن إن مرّت التهدئة
      const progressed = await tryRecreateDuringWindow(taskId, def);
      if (progressed === "completed") return true;
      if (progressed === "failed") return false;
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
      continue;
    }

    const adapter = getAdapter(task.provider);
    if (!adapter) {
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
      continue;
    }

    let check: CheckResult;
    try {
      const checkKey = await resolveCheckKey(task, def);
      if (!checkKey) {
        // لا مفتاح متاح للاستعلام الآن — بانتظار مفتاح صالح
        await updateTask(taskId, { error_message: "بانتظار توفر مفتاح صالح…" });
        await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
        continue;
      }
      check = await adapter.checkTask(checkKey, task.provider_task_id);
    } catch (e) {
      const { status, message } = classifyErr(e);
      const cls = classifyProviderError({ status, message });
      // أخطاء الاستعلام المؤقتة لا توقف المهمة — نكمل الاستعلام حتى نهاية النافذة
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
      continue;
    }

    if (check.status === "completed" && check.urls?.length) {
      await updateTask(taskId, { status: "completed", result_urls: check.urls, progress: 100 });
      await notify?.({ progress: 100, total: 100, message: "اكتمل التوليد بنجاح" });
      return true;
    }

    if (check.status === "failed" && check.error) {
      if (looksLikeKeyOrBalanceFailure(check.error)) {
        // فشل منتصف المهمة بنمط مفتاح/رصيد → إعادة إنشاء بنفس task_id على المفتاح التالي
        await updateTask(taskId, {
          appendAttempt: {
            provider: task.provider,
            keyId: task.key_id ?? "-",
            ok: false,
            errorClass: "exhausted",
            error: `فشل منتصف المهمة: ${check.error.slice(0, 200)}`,
            at: new Date().toISOString(),
          },
        });
        // نفرغ المعرّف القديم لنُعيد الإنشاء على مفتاح آخر
        await updateTask(taskId, { provider: null, provider_task_id: null, key_id: null });
        const rec = await tryRecreateDuringWindow(taskId, def);
        if (rec === "completed") return true;
        if (rec === "failed") return false;
        continue;
      }
      // فشل حقيقي (انتهاك سياسة/معطيات) → failed نهائي
      await updateTask(taskId, { status: "failed", error_message: check.error.slice(0, 500) });
      return false;
    }

    // قيد المعالجة — تحديث التقدم وبث الإشعار
    const progress = check.progress ?? estimatedProgress(startedAt, task.type as MediaType);
    await updateTask(taskId, { progress });
    await notify?.({ progress, total: 100, message: `قيد التوليد… ${progress}%` });
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
  return false; // انتهت النافذة — تبقى processing
}

/** إعادة إنشاء أثناء نافذة الانتظار بعد فشل مفتاح/رصيد */
async function tryRecreateDuringWindow(
  taskId: string,
  def: ModelDef
): Promise<"completed" | "failed" | "waiting"> {
  const task = (await getTask(taskId))!;
  if (task.provider_task_id) return "waiting";
  const pool = await getKeyPool(def.providers);
  try {
    const creation = await attemptCreation(task, def, pool, (p) => getAdapter(p), async () => {});
    if (!creation.ok) {
      await updateTask(taskId, { error_message: "بانتظار توفر مفتاح صالح…" });
      return "waiting";
    }
    if (creation.providerTaskId === "") {
      // صورة متزامنة اكتملت فورًا
      return "completed";
    }
    return "waiting"; // أُنشئت — تُتابع في الدورة القادمة من النافذة
  } catch (e) {
    if (e instanceof ParamsError) {
      await updateTask(taskId, { status: "failed", error_message: `خطأ في معطيات الطلب: ${e.message}` });
      return "failed";
    }
    return "waiting";
  }
}

/** اختيار مفتاح للاستعلام: مفتاح المهمة إن كان صالحًا وإلا أول مفتاح متاح لنفس المزود */
async function resolveCheckKey(task: TaskRow, def: ModelDef): Promise<KeyRow | null> {
  if (task.key_id) {
    const pool = await getKeyPool(def.providers);
    const same = pool.find((k) => k.id === task.key_id);
    if (same) return same;
    const anyForProvider = pool.find((k) => k.provider === task.provider);
    if (anyForProvider) {
      await updateTask(task.id, { key_id: anyForProvider.id });
      return anyForProvider;
    }
    return null;
  }
  const pool = await getKeyPool(def.providers);
  return pool[0] ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ───────────────────────── get_task — تحديث حي ─────────────────────────

/**
 * refreshTask: المهمة الجارية تُحدَّث حية من المزود/خدمة الدمج،
 * مع نفس منطق إعادة المحاولة/التبديل أعلاه، ثم تُعاد الصف المحدثة.
 */
export async function refreshTask(taskId: string): Promise<TaskRow | null> {
  let task = await getTask(taskId);
  if (!task) return null;
  if (task.status === "completed" || task.status === "failed") return task;

  if (task.type === "merge") {
    // مهمة الدمج تُحدَّث عبر refreshMergeTask (merger.ts)
    const { refreshMergeTask } = await import("./merger");
    return refreshMergeTask(task);
  }

  const def = resolveModel(task.model, task.type as MediaType);
  if (!def) {
    return updateTask(task.id, { status: "failed", error_message: "موديل غير معروف في المهمة المخزنة" });
  }

  // 1) لم تُنشأ بعد لدى أي مزود (فشل كل المفاتيح سابقًا) — أعد المحاولة بعد التهدئة
  if (!task.provider || !task.provider_task_id) {
    const lastAttempt = lastAttemptAt(task);
    if (lastAttempt && Date.now() - lastAttempt < RETRY_COOLDOWN_MS) {
      return task; // التهدئة لم تنته — العميل يرى «قيد المعالجة» فقط
    }
    const pool = await getKeyPool(def.providers);
    if (pool.length === 0) return task;
    try {
      const creation = await attemptCreation(task, def, pool, (p) => getAdapter(p), async () => {});
      if (!creation.ok) {
        return updateTask(task.id, { error_message: "بانتظار توفر مفتاح صالح…" });
      }
      if (creation.providerTaskId === "") {
        return getTask(task.id); // صورة متزامنة اكتملت
      }
      task = (await getTask(task.id))!; // أُنشئت — نتابع للتحقق الحي أدناه
    } catch (e) {
      if (e instanceof ParamsError) {
        return updateTask(task.id, { status: "failed", error_message: `خطأ في معطيات الطلب: ${e.message}` });
      }
      return updateTask(task.id, { error_message: "بانتظار توفر مفتاح صالح…" });
    }
  }

  // 2) تحقق حي من المزود
  const adapter = getAdapter(task.provider!);
  if (!adapter) return task;

  let check: CheckResult;
  try {
    const checkKey = await resolveCheckKey(task, def);
    if (!checkKey) {
      // لا مفتاح للاستعلام — نحاول إعادة الإنشاء بعد التهدئة
      return updateTask(task.id, { error_message: "بانتظار توفر مفتاح صالح…" });
    }
    check = await adapter.checkTask(checkKey, task.provider_task_id!);
  } catch (e) {
    const { status, message } = classifyErr(e);
    const cls = classifyProviderError({ status, message });
    if (cls === "disabled" || cls === "exhausted") {
      // مفتاح الاستعلام أصبح غير صالح — المحاولة القادمة ستلتقط مفتاحًا آخر
      return updateTask(task.id, { error_message: "بانتظار توفر مفتاح صالح…" });
    }
    return task; // مؤقت — تبقى قيد المعالجة
  }

  if (check.status === "completed" && check.urls?.length) {
    return updateTask(task.id, { status: "completed", result_urls: check.urls, progress: 100 });
  }
  if (check.status === "failed" && check.error) {
    if (looksLikeKeyOrBalanceFailure(check.error)) {
      // إعادة إنشاء بنفس task_id — التهدئة تنطبق إن لم يتوفر مفتاح
      await updateTask(task.id, { provider: null, provider_task_id: null, key_id: null });
      const pool = await getKeyPool(def.providers);
      try {
        const creation = await attemptCreation(task, def, pool, (p) => getAdapter(p), async () => {});
        if (!creation.ok) return updateTask(task.id, { error_message: "بانتظار توفر مفتاح صالح…" });
        return getTask(task.id);
      } catch (e) {
        if (e instanceof ParamsError) {
          return updateTask(task.id, { status: "failed", error_message: `خطأ في معطيات الطلب: ${e.message}` });
        }
        return updateTask(task.id, { error_message: "بانتظار توفر مفتاح صالح…" });
      }
    }
    return updateTask(task.id, { status: "failed", error_message: check.error.slice(0, 500) });
  }
  // قيد المعالجة — حدّث التقدم
  const startedAt = Date.parse(task.created_at.endsWith("Z") ? task.created_at : task.created_at + "Z") || Date.now();
  const progress = check.progress ?? estimatedProgress(startedAt, task.type as MediaType);
  return updateTask(task.id, { progress });
}

function lastAttemptAt(task: TaskRow): number | null {
  try {
    const attempts = JSON.parse(task.attempts_json || "[]") as AttemptEntry[];
    if (!Array.isArray(attempts) || attempts.length === 0) return null;
    const last = attempts[attempts.length - 1];
    return Date.parse(last.at) || null;
  } catch {
    return null;
  }
}
