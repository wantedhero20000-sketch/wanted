"use client";

// ═══════════════════════════════════════════════════════════════
// لوحة الإدارة العربية (RTL) — صفحة واحدة بثلاث بطاقات:
//   أ) مدير المفاتيح — إضافة/تعطيل/حذف مفاتيح kie.ai و CometAPI (مقنّعة دائمًا)
//   ب) لوحة المهام — إحصائيات وأحدث المهام مع تحديث تلقائي كل ~5 ثوانٍ
//   ج) ربط السيرفر — رابط /mcp وإعدادات JSON جاهزة للنسخ لكل عميل
// ═══════════════════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import {
  Copy, KeyRound, Link2, ListVideo, Plus, Trash2, Video, Image as ImageIcon, Merge, Activity, XCircle, Clock3, CheckCircle2,
} from "lucide-react";

// ───────────────────────── أنواع البيانات ─────────────────────────

interface HealthData {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  authRequired: boolean;
  merger: { base: string; healthy: boolean; configured: boolean };
}

interface KeyInfo {
  id: string;
  provider: "kie" | "cometapi";
  label: string;
  key_masked: string;
  status: "active" | "exhausted" | "disabled";
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_error: string | null;
  created_at: string;
}

interface TaskInfo {
  id: string;
  provider: string | null;
  model: string;
  type: "image" | "video" | "merge";
  prompt: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  result_urls: string[];
  error_message: string | null;
  attempts: number;
  created_at: string;
}

// ───────────────────────── مساعدات ─────────────────────────

const KEY_STATUS_META: Record<string, { label: string; cls: string }> = {
  active: { label: "نشط", cls: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  exhausted: { label: "مستنزف", cls: "bg-amber-100 text-amber-800 border-amber-200" },
  disabled: { label: "معطّل", cls: "bg-zinc-100 text-zinc-600 border-zinc-200" },
};

const TASK_STATUS_META: Record<string, { label: string; cls: string }> = {
  pending: { label: "بانتظار", cls: "bg-zinc-100 text-zinc-600 border-zinc-200" },
  processing: { label: "جارية", cls: "bg-teal-100 text-teal-800 border-teal-200" },
  completed: { label: "مكتملة", cls: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  failed: { label: "فاشلة", cls: "bg-red-100 text-red-700 border-red-200" },
};

const TYPE_META: Record<string, { label: string; icon: React.ReactNode }> = {
  image: { label: "صورة", icon: <ImageIcon className="h-3.5 w-3.5" /> },
  video: { label: "فيديو", icon: <Video className="h-3.5 w-3.5" /> },
  merge: { label: "دمج", icon: <Merge className="h-3.5 w-3.5" /> },
};

const TOOLS: Array<{ name: string; desc: string; icon: React.ReactNode }> = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي بالموديل المدمج للصور", icon: <ImageIcon className="h-4 w-4" /> },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن أصلي (حوار/مؤثرات/موسيقى)", icon: <Video className="h-4 w-4" /> },
  { name: "merge_videos", desc: "دمج عدة مقاطع في مقطع واحد عالي الجودة بالترتيب المطلوب", icon: <Merge className="h-4 w-4" /> },
  { name: "get_task", desc: "تتبع أي مهمة بمعرّفها حتى الاكتمال وعرض الروابط", icon: <Activity className="h-4 w-4" /> },
  { name: "list_media", desc: "استرجاع أحدث الوسائط المخزنة بروابطها دون إعادة توليد", icon: <ListVideo className="h-4 w-4" /> },
];

function fmtTime(ts?: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return ts;
  return new Intl.DateTimeFormat("ar", { dateStyle: "short", timeStyle: "short" }).format(d);
}

// ───────────────────────── الصفحة الرئيسية ─────────────────────────

export default function Page() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const { toast } = useToast();

  const refreshHealth = useCallback(async () => {
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      setHealth(await r.json());
    } catch {
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    // تأجيل أول تحميل لما بعد الربط — وتحديث دوري كل 30 ثانية
    const kickoff = requestAnimationFrame(() => refreshHealth());
    const t = setInterval(refreshHealth, 30_000);
    return () => {
      cancelAnimationFrame(kickoff);
      clearInterval(t);
    };
  }, [refreshHealth]);

  return (
    <div className="flex-1 w-full">
      <header className="border-b bg-white/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-4 flex flex-wrap items-center gap-3 justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-emerald-600 text-white flex items-center justify-center">
              <Video className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold leading-tight">MCP Media Generator</h1>
              <p className="text-xs text-muted-foreground">خادم MCP لتوليد الصور والفيديو ودمج المقاطع — لوحة الإدارة</p>
            </div>
          </div>
          <HealthBadge health={health} />
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        <KeysManager />
        <TasksPanel />
        <ServerConnection authRequired={health?.authRequired ?? false} />
      </main>

      <footer className="mt-auto border-t py-4 text-center text-xs text-muted-foreground">
        MCP Media Generator v1.2.0 — توليد الوسائط ودمجها عبر بروتوكول MCP · الخادم على المسار <span className="font-mono-tech">/mcp</span>
      </footer>
    </div>
  );
}

// ───────────────────────── شارة الصحة ─────────────────────────

function HealthBadge({ health }: { health: HealthData | null }) {
  if (!health) {
    return <Badge variant="outline" className="bg-zinc-50 text-zinc-500 animate-pulse">جارٍ فحص الاتصال…</Badge>;
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {health.ok ? (
        <Badge className="bg-emerald-600 hover:bg-emerald-600 gap-1.5">
          <span className="h-2 w-2 rounded-full bg-emerald-200 animate-pulse" />
          Turso متصل
        </Badge>
      ) : (
        <Badge className="bg-red-600 hover:bg-red-600 gap-1.5">
          <span className="h-2 w-2 rounded-full bg-red-200" />
          Turso غير متصل
        </Badge>
      )}
      {health.merger?.configured ? (
        <Badge variant="outline" className={health.merger.healthy ? "border-emerald-300 text-emerald-700" : "border-amber-300 text-amber-700"}>
          خدمة الدمج: {health.merger.healthy ? "جاهزة" : "لا تستجيب"}
        </Badge>
      ) : (
        <Badge variant="outline" className="border-amber-300 text-amber-700">خدمة الدمج: غير مهيأة</Badge>
      )}
      {health.authRequired && (
        <Badge variant="outline" className="border-zinc-300 text-zinc-600">حماية Bearer مفعّلة</Badge>
      )}
    </div>
  );
}

// ───────────────────────── أ) مدير المفاتيح ─────────────────────────

function KeysManager() {
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/keys", { cache: "no-store" });
      const j = await r.json();
      setKeys(j.keys ?? []);
    } catch {
      // تجاهل — المحاولة القادمة
    }
  }, []);

  useEffect(() => {
    const kickoff = requestAnimationFrame(() => refresh());
    return () => cancelAnimationFrame(kickoff);
  }, [refresh]);

  const addKey = async () => {
    if (!apiKey.trim()) {
      toast({ title: "أدخل مفتاح API أولًا", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), label: label.trim() }),
      });
      const j = await r.json();
      if (!r.ok) {
        toast({ title: "تعذرت الإضافة", description: j.error, variant: "destructive" });
      } else {
        toast({ title: "أُضيف المفتاح بنجاح", description: `سيُجرَّب أولًا في الترتيب التسلسلي حسب أمر الإضافة` });
        setApiKey("");
        setLabel("");
        refresh();
      }
    } catch {
      toast({ title: "خطأ شبكة عند الإضافة", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const toggleKey = async (k: KeyInfo) => {
    const next = k.status === "disabled" ? "active" : "disabled";
    const r = await fetch(`/api/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    if (r.ok) {
      toast({ title: next === "disabled" ? "عُطّل المفتاح" : "نُشّط المفتاح" });
      refresh();
    } else {
      toast({ title: "تعذّر تحديث المفتاح", variant: "destructive" });
    }
  };

  const removeKey = async (k: KeyInfo) => {
    const r = await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    if (r.ok) {
      toast({ title: "حُذف المفتاح" });
      refresh();
    } else {
      toast({ title: "تعذّر الحذف", variant: "destructive" });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-5 w-5 text-emerald-600" />
          مدير المفاتيح
        </CardTitle>
        <CardDescription className="leading-relaxed">
          أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي خطأ أو نفاد رصيد دون توقف.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* نموذج الإضافة */}
        <div className="grid gap-3 sm:grid-cols-[160px_1fr_1fr_auto] items-end">
          <div className="space-y-1.5">
            <Label htmlFor="provider">المزود</Label>
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger id="provider" className="w-full">
                <SelectValue placeholder="اختر المزود" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="kie">kie.ai</SelectItem>
                <SelectItem value="cometapi">CometAPI</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="keylabel">تسمية اختيارية</Label>
            <Input id="keylabel" dir="rtl" placeholder="مثال: الحساب الأول" value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="apikey">مفتاح API</Label>
            <Input
              id="apikey"
              dir="ltr"
              className="font-mono-tech text-sm"
              placeholder="الصق المفتاح هنا"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addKey()}
            />
          </div>
          <Button onClick={addKey} disabled={busy} className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 min-h-11">
            <Plus className="h-4 w-4" />
            إضافة
          </Button>
        </div>

        {/* قائمة المفاتيح */}
        {keys.length === 0 ? (
          <p className="text-sm text-muted-foreground border rounded-lg p-4 bg-zinc-50">
            لا توجد مفاتيح بعد — أضف مفتاحًا واحدًا على الأقل لكل مزود ليعمل التوليد.
          </p>
        ) : (
          <div className="max-h-96 overflow-y-auto scroll-thin space-y-2 pl-1" style={{ direction: "rtl" }}>
            {keys.map((k, idx) => {
              const order = idx + 1; // #1 = أول مفتاح يُجرَّب في الترتيب التسلسلي
              const meta = KEY_STATUS_META[k.status] ?? KEY_STATUS_META.active;
              return (
                <div key={k.id} className="border rounded-lg p-3 flex flex-wrap items-center gap-3 bg-white">
                  <Badge variant="outline" className="font-mono-tech">#{order}</Badge>
                  <Badge variant="outline">{k.provider === "kie" ? "kie.ai" : "CometAPI"}</Badge>
                  <span className="font-mono-tech text-sm" dir="ltr">{k.key_masked}</span>
                  {k.label && <span className="text-sm text-muted-foreground">{k.label}</span>}
                  <Badge variant="outline" className={meta.cls}>{meta.label}</Badge>
                  <div className="flex-1" />
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>الاستخدام: <b className="text-foreground">{k.usage_count}</b></span>
                    <span className="text-emerald-700">نجاح: <b>{k.success_count}</b></span>
                    <span className="text-red-700">فشل: <b>{k.fail_count}</b></span>
                    <span>آخر استخدام: {fmtTime(k.last_used_at)}</span>
                  </div>
                  {k.last_error && (
                    <p className="w-full text-xs text-red-600 truncate" title={k.last_error}>آخر خطأ: {k.last_error}</p>
                  )}
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" className="min-h-9" onClick={() => toggleKey(k)}>
                      {k.status === "disabled" ? "تنشيط" : "تعطيل"}
                    </Button>
                    <Button size="sm" variant="outline" className="min-h-9 text-red-600 hover:text-red-700" onClick={() => removeKey(k)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ───────────────────────── ب) لوحة المهام ─────────────────────────

function TasksPanel() {
  const [stats, setStats] = useState({ total: 0, completed: 0, failed: 0, processing: 0 });
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks?limit=20", { cache: "no-store" });
      const j = await r.json();
      setStats(j.stats ?? { total: 0, completed: 0, failed: 0, processing: 0 });
      setTasks(j.tasks ?? []);
    } catch {
      // تجاهل
    }
  }, []);

  useEffect(() => {
    const kickoff = requestAnimationFrame(() => refresh());
    const t = setInterval(refresh, 5_000); // تحديث تلقائي كل ~5 ثوانٍ
    return () => {
      cancelAnimationFrame(kickoff);
      clearInterval(t);
    };
  }, [refresh]);

  const deleteTask = async (id: string) => {
    const r = await fetch(`/api/tasks/${id}`, { method: "DELETE" });
    if (r.ok) {
      toast({ title: "حُذفت المهمة" });
      refresh();
    }
  };

  const chips = [
    { label: "إجمالي", value: stats.total, icon: <Activity className="h-4 w-4" />, cls: "bg-zinc-100 text-zinc-700" },
    { label: "مكتملة", value: stats.completed, icon: <CheckCircle2 className="h-4 w-4" />, cls: "bg-emerald-100 text-emerald-700" },
    { label: "فاشلة", value: stats.failed, icon: <XCircle className="h-4 w-4" />, cls: "bg-red-100 text-red-700" },
    { label: "جارية", value: stats.processing, icon: <Clock3 className="h-4 w-4" />, cls: "bg-teal-100 text-teal-700" },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="h-5 w-5 text-emerald-600" />
          لوحة المهام
        </CardTitle>
        <CardDescription>أحدث المهام تتحدث تلقائيًا كل 5 ثوانٍ — التقدم والروابط تظهر مباشرة.</CardDescription>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2">
          {chips.map((c) => (
            <div key={c.label} className={`rounded-lg border p-3 flex items-center gap-2 ${c.cls}`}>
              {c.icon}
              <div>
                <div className="text-xl font-bold leading-none">{c.value}</div>
                <div className="text-xs mt-1 opacity-80">{c.label}</div>
              </div>
            </div>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground border rounded-lg p-4 bg-zinc-50">
            لا توجد مهام بعد — انطلق من عميل MCP (ChatGPT / Claude / Cursor) وولّد أول صورة أو فيديو.
          </p>
        ) : (
          <div className="max-h-96 overflow-y-auto scroll-thin space-y-2 pl-1" style={{ direction: "rtl" }}>
            {tasks.map((t) => {
              const st = TASK_STATUS_META[t.status] ?? TASK_STATUS_META.pending;
              const tp = TYPE_META[t.type] ?? TYPE_META.image;
              return (
                <div key={t.id} className="border rounded-lg p-3 space-y-2 bg-white">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="gap-1">{tp.icon}{tp.label}</Badge>
                    <Badge variant="outline" className={st.cls}>{st.label}</Badge>
                    <span className="font-mono-tech text-xs text-muted-foreground" dir="ltr">{t.model}</span>
                    <div className="flex-1" />
                    <span className="text-xs text-muted-foreground">{fmtTime(t.created_at)}</span>
                  </div>
                  {t.prompt && <p className="text-sm text-foreground/80 truncate" title={t.prompt}>{t.prompt}</p>}
                  {t.status === "processing" && (
                    <div className="flex items-center gap-2">
                      <Progress value={t.progress} className="h-2 flex-1" />
                      <span className="text-xs text-muted-foreground">{t.progress}%</span>
                    </div>
                  )}
                  {t.status === "completed" && t.result_urls.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {t.result_urls.map((u) => (
                        <a
                          key={u}
                          href={u}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs underline underline-offset-4 text-emerald-700 break-all"
                          dir="ltr"
                        >
                          {u}
                        </a>
                      ))}
                    </div>
                  )}
                  {t.status === "failed" && t.error_message && (
                    <p className="text-xs text-red-600">{t.error_message}</p>
                  )}
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span className="font-mono-tech" dir="ltr">{t.id.slice(0, 8)}…</span>
                    <div className="flex items-center gap-3">
                      <span>المحاولات: {t.attempts}</span>
                      <button
                        className="inline-flex items-center gap-1 text-red-600 hover:underline"
                        onClick={() => deleteTask(t.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" /> حذف
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ───────────────────────── ج) ربط السيرفر ─────────────────────────

function ServerConnection({ authRequired }: { authRequired: boolean }) {
  const [origin, setOrigin] = useState("");
  const { toast } = useToast();

  useEffect(() => {
    const id = requestAnimationFrame(() => setOrigin(window.location.origin));
    return () => cancelAnimationFrame(id);
  }, []);

  const mcpUrl = `${(origin || "https://<نطاقك>").replace(/\/+$/, "")}/mcp`;

  const configs = useMemo(() => {
    const headers = authRequired ? { Authorization: `Bearer <MCP_ACCESS_TOKEN>` } : undefined;
    const entry: Record<string, unknown> = headers ? { url: mcpUrl, headers } : { url: mcpUrl };
    return {
      chatgpt: { mcpServers: { "media-generator": headers ? { ...entry } : { url: mcpUrl } } },
      claude: { mcpServers: { "media-generator": { type: "http", url: mcpUrl, ...(headers ? { headers } : {}) } } },
      cursor: { mcpServers: { "media-generator": { type: "http", url: mcpUrl, ...(headers ? { headers } : {}) } } },
    };
  }, [mcpUrl, authRequired]);

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: `نُسخ ${what} إلى الحافظة` });
    } catch {
      toast({ title: "تعذّر النسخ — انسخ يدويًا", variant: "destructive" });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Link2 className="h-5 w-5 text-emerald-600" />
          ربط السيرفر
        </CardTitle>
        <CardDescription>
          ضع هذا الرابط في أي عميل MCP — وستُتاح أدوات التوليد الخمس للنموذج مباشرة.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* رابط MCP */}
        <div className="flex gap-2 items-center">
          <Input dir="ltr" className="font-mono-tech text-sm" value={mcpUrl} onChange={(e) => setOrigin(e.target.value.replace(/\/mcp\/?$/, ""))} />
          <Button variant="outline" className="gap-1.5 min-h-11 shrink-0" onClick={() => copy(mcpUrl, "الرابط")}>
            <Copy className="h-4 w-4" /> نسخ
          </Button>
        </div>

        {/* إعدادات JSON لكل عميل */}
        <Tabs defaultValue="chatgpt" dir="rtl">
          <TabsList className="grid grid-cols-3 w-full sm:w-auto">
            <TabsTrigger value="chatgpt">ChatGPT / GPT Agents</TabsTrigger>
            <TabsTrigger value="claude">Claude Desktop</TabsTrigger>
            <TabsTrigger value="cursor">Cursor / Windsurf / Cline</TabsTrigger>
          </TabsList>
          <TabsContent value="chatgpt" className="space-y-2">
            <p className="text-xs text-muted-foreground">
              في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL».
            </p>
            <JsonBlock json={configs.chatgpt} onCopy={() => copy(JSON.stringify(configs.chatgpt, null, 2), "الإعداد")} />
          </TabsContent>
          <TabsContent value="claude" className="space-y-2">
            <p className="text-xs text-muted-foreground">ضع الإعداد في ملف claude_desktop_config.json.</p>
            <JsonBlock json={configs.claude} onCopy={() => copy(JSON.stringify(configs.claude, null, 2), "الإعداد")} />
          </TabsContent>
          <TabsContent value="cursor" className="space-y-2">
            <p className="text-xs text-muted-foreground">ضع الإعداد في mcp.json (Cursor / Windsurf / Cline).</p>
            <JsonBlock json={configs.cursor} onCopy={() => copy(JSON.stringify(configs.cursor, null, 2), "الإعداد")} />
          </TabsContent>
        </Tabs>

        {/* الأدوات الخمس */}
        <div>
          <h3 className="text-sm font-semibold mb-2">الأدوات المتاحة عبر MCP</h3>
          <div className="flex flex-wrap gap-2">
            {TOOLS.map((t) => (
              <div key={t.name} className="border rounded-lg px-3 py-2 bg-white max-w-full">
                <div className="flex items-center gap-1.5 text-sm font-semibold text-emerald-700">
                  {t.icon}
                  <span className="font-mono-tech" dir="ltr">{t.name}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{t.desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* ملاحظة كهرمانية */}
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 leading-relaxed">
          ⚠️ الفيديو يحتاج دقائق: يعيد السيرفر <span className="font-mono-tech">task_id</span> فورًا، ويتابَع تلقائيًا بـ{" "}
          <span className="font-mono-tech">get_task</span> كل 10 ثوانٍ — وعند اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف.
          أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع العملية.
        </div>
      </CardContent>
    </Card>
  );
}

function JsonBlock({ json, onCopy }: { json: unknown; onCopy: () => void }) {
  const text = JSON.stringify(json, null, 2);
  return (
    <div className="relative">
      {/* pt-10 يمنع تداخل زر النسخ مع أول سطر */}
      <pre dir="ltr" className="rounded-lg bg-zinc-950 text-zinc-100 p-4 pt-11 text-xs font-mono overflow-x-auto scroll-thin">{text}</pre>
      <Button size="sm" variant="secondary" className="absolute top-2 left-2 gap-1 min-h-9" onClick={onCopy}>
        <Copy className="h-3.5 w-3.5" /> نسخ
      </Button>
    </div>
  );
}
