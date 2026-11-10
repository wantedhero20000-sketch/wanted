// ═══════════════════════════════════════════════════════════════
// خادم MCP — يُبنى لكل طلب (نمط stateless متوافق مع serverless/Vercel)
// النقل: WebStandardStreamableHTTPServerTransport الرسمي من SDK —
// هو نفسه النقل StreamableHTTP الرسمي (نسخة البيئات المعيارية للويب
// التي يعتمدها SDK 1.32 لبيئات مثل Next.js App Router / Workers / Bun).
// لا كتابة JSON-RPC يدويًا إطلاقًا.
//
// أوصاف الأدوات بالإنجليزية (يقرأها نموذج الذكاء الاصطناعي)،
// ونتائج الاستدعاء بالعربية (يراها المستخدم).
// ═══════════════════════════════════════════════════════════════
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getTask, listRecentTasks } from "./turso";
import { runGeneration, type GenParams, type NotifyFn } from "./generation";
import { runMerge } from "./merger";
import { fmtImageCompleted, fmtMergeCompleted, fmtFailed, fmtProcessing, fmtTask, fmtVideoCompleted } from "./responses";
import type { TaskRow } from "./turso";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

// ───────────────────────── مساعدات ─────────────────────────

type ToolExtra = {
  _meta?: { progressToken?: string | number };
  sendNotification: (n: { method: string; params: Record<string, unknown> }) => Promise<void>;
};

/** باث إشعارات التقدم — يُرسل فقط إن زوّد العميل الطلب بـ _meta.progressToken */
function makeNotify(extra: ToolExtra): NotifyFn {
  const progressToken = extra._meta?.progressToken;
  return async ({ progress, total, message }) => {
    if (progressToken === undefined) return;
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress, total, message },
      });
    } catch {
      // فشل بث الإشعار لا يوقف المهمة أبدًا
    }
  };
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** تحويل نتيجة التوليد إلى رد عربي جاهز */
function genOutcomeToResult(o: Awaited<ReturnType<typeof runGeneration>>): ToolResult {
  switch (o.kind) {
    case "completed": {
      const urls = safeUrls(o.task);
      if (o.task.type === "image") return ok(fmtImageCompleted(urls));
      return ok(fmtVideoCompleted(urls));
    }
    case "processing":
      return ok(fmtProcessing(o.task));
    case "failed":
      return err(fmtFailed(o.task.error_message || "سبب غير معروف"));
    case "no_keys":
      return err(`❌ لا توجد مفاتيح نشطة لخدمة ${o.model}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`);
    case "bad_model":
      return err(`❌ موديل غير معروف: ${o.name}. المتاح: gpt-image-2-6/flare-text-to-image (صور) — grok-imagine-video-1-5-preview (فيديو).`);
  }
}

function safeUrls(task: TaskRow): string[] {
  try {
    const v = JSON.parse(task.result_urls_json || "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** حل روابط task_ids — لكل معرّف: أول رابط نتيجة من مهمة مكتملة، بالترتيب المعطى */
async function resolveTaskIds(taskIds: string[]): Promise<{ urls: string[]; failed: Array<{ id: string; reason: string }> }> {
  const urls: string[] = [];
  const failed: Array<{ id: string; reason: string }> = [];
  for (const id of taskIds) {
    const t = await getTask(id.trim());
    if (!t) {
      failed.push({ id, reason: "مهمة غير موجودة في قاعدة البيانات" });
      continue;
    }
    if (t.status !== "completed") {
      failed.push({ id, reason: `المهمة ليست مكتملة (حالتها: ${t.status})` });
      continue;
    }
    const u = safeUrls(t);
    if (u.length === 0) {
      failed.push({ id, reason: "لا توجد روابط نتائج مخزنة لهذه المهمة" });
      continue;
    }
    urls.push(u[0]);
  }
  return { urls, failed };
}

// ───────────────────────── بناء الخادم ─────────────────────────

export function buildMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  // 1) generate_image ─────────────────────────────────────────
  server.registerTool(
    "generate_image",
    {
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic failover across all active API keys). Returns the ready image URL if it completes within the wait window; otherwise returns a task_id — call get_task every ~10 seconds until completed, then show the URL and stop.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z
          .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
          .default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z
          .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
          .default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args, extra) => {
      const notify = makeNotify(extra as ToolExtra);
      const params: GenParams = {
        prompt: args.prompt,
        model: args.model,
        aspect_ratio: args.aspect_ratio,
        resolution: args.resolution,
        background: args.background,
        output_format: args.output_format,
        wait_seconds: args.wait_seconds,
      };
      try {
        const outcome = await runGeneration("image", params, notify);
        return genOutcomeToResult(outcome);
      } catch (e) {
        return err(`❌ حدث خطأ غير متوقع أثناء التوليد: ${e instanceof Error ? e.message.slice(0, 200) : "خطأ مجهول"}`);
      }
    }
  );

  // 2) generate_video ─────────────────────────────────────────
  server.registerTool(
    "generate_video",
    {
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio, optional image-to-video). Video takes minutes: short wait with live progress streaming, then a task_id — track it with get_task every ~10 seconds.",
      inputSchema: {
        prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        model: z
          .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
          .default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) => {
      const notify = makeNotify(extra as ToolExtra);
      const params: GenParams = {
        prompt: args.prompt,
        image_url: args.image_url,
        model: args.model,
        aspect_ratio: args.aspect_ratio,
        resolution: args.resolution,
        enable_audio: args.enable_audio,
        duration: args.duration,
        wait_seconds: args.wait_seconds,
      };
      try {
        const outcome = await runGeneration("video", params, notify);
        return genOutcomeToResult(outcome);
      } catch (e) {
        return err(`❌ حدث خطأ غير متوقع أثناء التوليد: ${e instanceof Error ? e.message.slice(0, 200) : "خطأ مجهول"}`);
      }
    }
  );

  // 3) merge_videos ───────────────────────────────────────────
  server.registerTool(
    "merge_videos",
    {
      description:
        "Merge several clips into one final video in the given order. Pass 'urls' (public direct video links — like the URLs returned by generate_video) or 'task_ids' (completed video tasks, their result URLs are resolved from the database in this order — ideal after generating several clips). Merging is usually fast: short wait with live progress, then a merge task_id — track it with get_task. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: {
        urls: z
          .array(z.string())
          .min(2, { message: "الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة." })
          .max(10, { message: "أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى)." })
          .optional()
          .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
        task_ids: z
          .array(z.string())
          .min(2, { message: "الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة." })
          .max(10, { message: "أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى)." })
          .optional()
          .describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args, extra) => {
      const notify = makeNotify(extra as ToolExtra);
      try {
        // الترتيب: روابط task_ids أولًا ثم urls المباشرة بنفس ترتيبها
        const resolved = args.task_ids ? await resolveTaskIds(args.task_ids) : { urls: [], failed: [] };
        const combined = [...resolved.urls, ...(args.urls ?? [])];

        if (combined.length < 2) {
          let msg = "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";
          if (resolved.failed.length > 0) {
            msg += "\n\nتفاصيل كل معرّف:\n" + resolved.failed.map((f) => `- ${f.id}: ${f.reason}`).join("\n");
          }
          return err(msg);
        }
        if (combined.length > 10) {
          return err("❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).");
        }

        const outcome = await runMerge(combined, args.wait_seconds, notify);
        switch (outcome.kind) {
          case "completed":
            return ok(fmtMergeCompleted(safeUrls(outcome.task)));
          case "processing":
            return ok(fmtProcessing(outcome.task));
          case "failed":
            return err(outcome.task ? fmtTask(outcome.task) : fmtFailed(outcome.message));
          case "invalid":
            return err(outcome.message);
        }
      } catch (e) {
        return err(`❌ حدث خطأ غير متوقع أثناء الدمج: ${e instanceof Error ? e.message.slice(0, 200) : "خطأ مجهول"}`);
      }
    }
  );

  // 4) get_task ───────────────────────────────────────────────
  server.registerTool(
    "get_task",
    {
      description:
        "Track any task by its id — image/video generation and merging (reads the database and refreshes live from the provider/merging service while it is in progress). Poll it every ~10 seconds; when completed you will find the result URLs — show them to the user and stop polling.",
      inputSchema: {
        task_id: z.string().describe("The task_id returned by generate_image / generate_video / merge_videos."),
      },
    },
    async (args) => {
      try {
        const { refreshTask } = await import("./generation");
        const task = await refreshTask(args.task_id.trim());
        if (!task) {
          return err(`❌ لم يتم العثور على مهمة بالمعرّف: ${args.task_id}`);
        }
        return ok(fmtTask(task));
      } catch (e) {
        return err(`❌ حدث خطأ غير متوقع أثناء تتبع المهمة: ${e instanceof Error ? e.message.slice(0, 200) : "خطأ مجهول"}`);
      }
    }
  );

  // 5) list_media ─────────────────────────────────────────────
  server.registerTool(
    "list_media",
    {
      description:
        "List the latest stored images/videos/merges with their URLs from the database (no regeneration) — to recall previous results.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) => {
      try {
        const tasks = await listRecentTasks(args.limit ?? 10, { type: args.type, status: args.status });
        if (tasks.length === 0) {
          return ok("لا توجد وسائط مخزنة بعد مطابقة لهذا الفلتر.");
        }
        const lines = tasks.map((t, i) => {
          const urls = safeUrls(t);
          const statusAr = t.status === "completed" ? "مكتملة" : t.status === "failed" ? "فاشلة" : "جارية";
          const typeAr = t.type === "image" ? "صورة" : t.type === "video" ? "فيديو" : "دمج";
          let line = `${i + 1}. [${statusAr}] ${typeAr} — ${t.model} — task_id: ${t.id}`;
          if (t.status === "completed" && urls.length > 0) {
            line += `\n   ${urls.map((u) => `الرابط المباشر: ${u}`).join("\n   ")}`;
          }
          if (t.status === "failed" && t.error_message) {
            line += `\n   السبب: ${t.error_message}`;
          }
          return line;
        });
        return ok(`أحدث الوسائط المخزنة (${tasks.length}):\n\n${lines.join("\n\n")}`);
      } catch (e) {
        return err(`❌ حدث خطأ أثناء عرض الوسائط: ${e instanceof Error ? e.message.slice(0, 200) : "خطأ مجهول"}`);
      }
    }
  );

  // ملاحظة: استدعاء أداة باسم غير معروف يعالجه SDK الرسمي برسالة JSON-RPC قياسية
  // (Invalid tool name) — وهذا هو السلوك المتوافق مع المواصفة.

  return server;
}
