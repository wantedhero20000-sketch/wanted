// ═══════════════════════════════════════════════════════════════
// طبقة قاعدة البيانات — Turso عبر HTTP (إلزامية للتوافق مع Vercel)
// لا ملفات SQLite محلية في الإنتاج — كل الاتصالات عبر libsql HTTP.
// ensureSchema() تنشئ الجداول عند أول وصول فلا حاجة لأداة migrations.
// ═══════════════════════════════════════════════════════════════
import { createClient, type Client, type InValue } from "@libsql/client";

let _client: Client | null = null;
let _schemaPromise: Promise<void> | null = null;

/** عميل واحد مشترك — يُنشأ عند أول استدعاء فقط (lazy) */
export function getTurso(): Client {
  if (!_client) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url || !authToken) {
      throw new Error("متغيرات البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبة");
    }
    _client = createClient({ url, authToken });
  }
  return _client;
}

/** إنشاء الجداول عند أول وصول — يُنفَّذ مرة واحدة لكل عملية (promise مشترك يمنع التكرار المتوازي) */
export async function ensureSchema(): Promise<void> {
  if (!_schemaPromise) {
    _schemaPromise = (async () => {
      const db = getTurso();
      await db.executeMultiple(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          provider TEXT,
          provider_task_id TEXT,
          key_id TEXT,
          model TEXT NOT NULL,
          type TEXT NOT NULL,
          prompt TEXT DEFAULT '',
          params_json TEXT DEFAULT '{}',
          status TEXT NOT NULL,
          progress INTEGER DEFAULT 0,
          result_urls_json TEXT,
          error_message TEXT,
          attempts_json TEXT DEFAULT '[]',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          completed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS api_keys (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          label TEXT DEFAULT '',
          api_key TEXT NOT NULL,
          status TEXT DEFAULT 'active',
          usage_count INTEGER DEFAULT 0,
          success_count INTEGER DEFAULT 0,
          fail_count INTEGER DEFAULT 0,
          last_used_at TEXT,
          last_checked_at TEXT,
          last_error TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks (created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_keys_provider ON api_keys (provider, created_at ASC);
      `);
    })().catch((e) => {
      // فشل التهيئة لا يُخزَّن نهائيًا — المحاولة القادمة تعيد التهيئة
      _schemaPromise = null;
      throw e;
    });
  }
  return _schemaPromise;
}

/** فحص جهوزية قاعدة البيانات — SELECT 1 */
export async function dbHealthy(): Promise<boolean> {
  try {
    const r = await getTurso().execute("SELECT 1 AS ok");
    return r.rows[0]?.[0] === 1 || String(r.rows[0]?.ok) === "1";
  } catch {
    return false;
  }
}

// ───────────────────────── أنواع المهام ─────────────────────────

export type TaskStatus = "pending" | "processing" | "completed" | "failed";
export type MediaType = "image" | "video" | "merge";

/** مُدخلة في سجل المحاولات — تُوثّق كل تجربة على مفتاح/مزود */
export interface AttemptEntry {
  provider: string;
  keyId: string;
  keyLabel?: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: MediaType;
  prompt: string;
  params_json: string;
  status: TaskStatus;
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

/** تعديل جزئي على مهمة — يضيف attempts تلقائيًا ويضبط completed_at عند الاكتمال */
export interface TaskPatch {
  provider?: string | null;
  provider_task_id?: string | null;
  key_id?: string | null;
  status?: TaskStatus;
  progress?: number;
  result_urls?: string[] | null;
  error_message?: string | null;
  appendAttempt?: AttemptEntry;
}

function rowToTask(r: Record<string, unknown>): TaskRow {
  return r as unknown as TaskRow;
}

export async function insertTask(t: {
  id: string;
  model: string;
  type: MediaType;
  prompt?: string;
  params_json?: string;
  status?: TaskStatus;
  provider?: string | null;
  provider_task_id?: string | null;
  key_id?: string | null;
}): Promise<TaskRow> {
  await ensureSchema();
  const db = getTurso();
  await db.execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress, attempts_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '[]')`,
    args: [t.id, t.provider ?? null, t.provider_task_id ?? null, t.key_id ?? null, t.model, t.type, t.prompt ?? "", t.params_json ?? "{}", t.status ?? "processing"] as InValue[],
  });
  return (await getTask(t.id))!;
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const r = await getTurso().execute({ sql: "SELECT * FROM tasks WHERE id = ?", args: [id] });
  if (r.rows.length === 0) return null;
  return rowToTask(r.rows[0] as unknown as Record<string, unknown>);
}

/** تحديث جزئي: patch يُبنى ديناميكيًا، ويُلحق attempts، ويضبط completed_at تلقائيًا عند completed */
export async function updateTask(id: string, patch: TaskPatch): Promise<TaskRow | null> {
  await ensureSchema();
  const db = getTurso();

  // إلحاق مُدخلة محاولات جديدة إن وُجدت — نقرأ الحالية ونضيف ثم نكتب
  if (patch.appendAttempt) {
    const current = await getTask(id);
    if (current) {
      let attempts: AttemptEntry[] = [];
      try {
        attempts = JSON.parse(current.attempts_json || "[]");
        if (!Array.isArray(attempts)) attempts = [];
      } catch {
        attempts = [];
      }
      attempts.push(patch.appendAttempt);
      await db.execute({
        sql: "UPDATE tasks SET attempts_json = ? WHERE id = ?",
        args: [JSON.stringify(attempts.slice(-50)), id], // نحفظ آخر 50 محاولة كحد أقصى
      });
    }
  }

  const sets: string[] = [];
  const args: InValue[] = [];
  const add = (col: string, val: InValue) => {
    sets.push(`${col} = ?`);
    args.push(val);
  };

  if (patch.provider !== undefined) add("provider", patch.provider);
  if (patch.provider_task_id !== undefined) add("provider_task_id", patch.provider_task_id);
  if (patch.key_id !== undefined) add("key_id", patch.key_id);
  if (patch.status !== undefined) add("status", patch.status);
  if (patch.progress !== undefined) add("progress", Math.max(0, Math.min(100, Math.round(patch.progress))));
  if (patch.result_urls !== undefined) add("result_urls_json", patch.result_urls === null ? null : JSON.stringify(patch.result_urls));
  if (patch.error_message !== undefined) add("error_message", patch.error_message);

  // الاكتمال يضبط completed_at تلقائيًا (مرة واحدة)
  if (patch.status === "completed") {
    sets.push("completed_at = COALESCE(completed_at, datetime('now'))");
    if (patch.progress === undefined) {
      sets.push("progress = 100");
    }
  }

  await db.execute({
    sql: `UPDATE tasks SET ${sets.length ? sets.join(", ") + ", " : ""}updated_at = datetime('now') WHERE id = ?`,
    args: [...args, id],
  });
  return getTask(id);
}

export async function listRecentTasks(
  limit = 10,
  filters?: { type?: string; status?: string }
): Promise<TaskRow[]> {
  await ensureSchema();
  const lim = Math.max(1, Math.min(50, Math.floor(limit) || 10));
  const where: string[] = [];
  const args: InValue[] = [];
  if (filters?.type) {
    where.push("type = ?");
    args.push(filters.type);
  }
  if (filters?.status) {
    // «جارية» تعني pending أو processing معًا
    if (filters.status === "processing") {
      where.push("status IN ('pending','processing')");
    } else {
      where.push("status = ?");
      args.push(filters.status);
    }
  }
  const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, id DESC LIMIT ${lim}`;
  const r = await getTurso().execute({ sql, args });
  return r.rows.map((row) => rowToTask(row as unknown as Record<string, unknown>));
}

export async function deleteTask(id: string): Promise<boolean> {
  await ensureSchema();
  const r = await getTurso().execute({ sql: "DELETE FROM tasks WHERE id = ?", args: [id] });
  return r.rowsAffected > 0;
}

export interface TaskStats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

export async function taskStats(): Promise<TaskStats> {
  await ensureSchema();
  const r = await getTurso().execute(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) AS processing
    FROM tasks
  `);
  const row = r.rows[0] as unknown as Record<string, unknown> | undefined;
  return {
    total: Number(row?.total ?? 0),
    completed: Number(row?.completed ?? 0),
    failed: Number(row?.failed ?? 0),
    processing: Number(row?.processing ?? 0),
  };
}
