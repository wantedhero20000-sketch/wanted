// ═══════════════════════════════════════════════════════════════
// سجل الموديلات — الاسماء الموحدة والصيغ البديلة لكل مزود
// الموديلان المدمجان مثبّتان كما هما، وقابلان للتجاوز بمتغيرات البيئة.
// ═══════════════════════════════════════════════════════════════

export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string; // الاسم كما يراه عميل MCP
  aliases: string[]; // صيغ بديلة نقبلها ونوحدّها (شرطات/نقاط)
  type: MediaType;
  providers: ProviderId[]; // من يستطيع خدمته — تُجرَّب مفاتيحهم كلها بالترتيب
  providerModel: Record<ProviderId, string>; // اسم الموديل كما يُرسل لكل مزود
}

const envOr = (name: string, fallback: string) =>
  (process.env[name] || "").trim() || fallback;

/** القائمة تُبنى ديناميكيًا لاحترام متغيرات التجاوز في وقت التشغيل */
export function getModels(): ModelDef[] {
  const kieImage = envOr("KIE_IMAGE_MODEL", "gpt-image-2-6/flare-text-to-image");
  const cometImage = envOr("COMETAPI_IMAGE_MODEL", "gpt-image-2.6-flare-text-to-image");
  const kieVideo = envOr("KIE_VIDEO_MODEL", "grok-imagine-video-1-5-preview");
  const cometVideo = envOr("COMETAPI_VIDEO_MODEL", "grok-imagine-video-1-5-preview");
  return [
    {
      canonical: kieImage,
      aliases: [kieImage.replace(/gpt-image-2-6/g, "gpt-image-2.6"), "gpt-image-2.6/flare-text-to-image"],
      type: "image",
      providers: ["kie", "cometapi"],
      providerModel: { kie: kieImage, cometapi: cometImage },
    },
    {
      canonical: kieVideo,
      aliases: [kieVideo.replace(/grok-imagine-video-1-5/g, "grok-imagine-video-1.5"), "grok-imagine-video-1.5-preview"],
      type: "video",
      providers: ["kie", "cometapi"],
      providerModel: { kie: kieVideo, cometapi: cometVideo },
    },
  ];
}

/** توحيد الصيغ البديلة بالنقاط إلى الصيغة القياسية بالشرطات */
export function normalizeModelName(name: string): string {
  return name
    .trim()
    .replace(/gpt-image-2\.6/g, "gpt-image-2-6")
    .replace(/grok-imagine-video-1\.5/g, "grok-imagine-video-1-5");
}

/**
 * إيجاد تعريف موديل بالاسم الموحّد.
 * عند عدم تمرير اسم: يُعاد الموديل الافتراضي للنوع المطلوب (الأول في القائمة).
 */
export function resolveModel(name: string | undefined, type: MediaType): ModelDef | undefined {
  const models = getModels().filter((m) => m.type === type);
  if (!name) return models[0];
  const normalized = normalizeModelName(name);
  return models.find((m) => m.canonical === normalized || m.aliases.some((a) => normalizeModelName(a) === normalized));
}
