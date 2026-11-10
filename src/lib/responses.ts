// ═══════════════════════════════════════════════════════════════
// صياغة الردود العربية لأدوات MCP — المصطلحات التقنية وأسماء الأدوات تبقى بالإنجليزية.
// قاعدة ذهبية: لا رسالة تخرج للعميل تذكر مفاتيح أو أرصدة — التبديل صامت تمامًا.
// ═══════════════════════════════════════════════════════════════
import type { TaskRow } from "./turso";

function urlList(urls: string[]): string {
  return urls.map((u) => `الرابط المباشر: ${u}`).join("\n");
}

/** مكتملة صورة: العنوان + معاينة Markdown + الرابط المباشر */
export function fmtImageCompleted(urls: string[]): string {
  const first = urls[0];
  return `✅ تم توليد الصورة بنجاح\n\n![image](${first})\n\n${urlList(urls)}`;
}

/** مكتملة فيديو/فيديوهات */
export function fmtVideoCompleted(urls: string[]): string {
  return `✅ تم توليد الفيديو بنجاح\n\n${urlList(urls)}`;
}

/** مكتملة دمج — مع تحذير 24 ساعة الإلزامي */
export function fmtMergeCompleted(urls: string[]): string {
  return `✅ تم دمج المقاطع بنجاح\n\n${urlList(urls)}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`;
}

/** جارية: task_id + تعليمات المتابعة */
export function fmtProcessing(task: TaskRow): string {
  const progressLine = task.progress > 0 && task.status === "processing" ? `\n\nالتقدم الحالي: ${task.progress}%` : "";
  return `⏳ المهمة قيد المعالجة — task_id: ${task.id}${progressLine}\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`;
}

/** فاشلة: السبب (أسباب حقيقية فقط — أخطاء المفاتيح/الرصيد لا تصل هنا أبدًا) */
export function fmtFailed(reason: string): string {
  return `❌ فشلت المهمة: ${reason}`;
}

/** صياغة أي مهمة حسب نوعها وحالتها — تُستخدم في get_task و list_media */
export function fmtTask(task: TaskRow): string {
  const urls: string[] = task.result_urls_json ? safeParseUrls(task.result_urls_json) : [];
  if (task.status === "completed") {
    if (task.type === "image") return fmtImageCompleted(urls);
    if (task.type === "merge") return fmtMergeCompleted(urls);
    return fmtVideoCompleted(urls);
  }
  if (task.status === "failed") {
    return fmtFailed(task.error_message || "سبب غير معروف");
  }
  return fmtProcessing(task);
}

function safeParseUrls(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
