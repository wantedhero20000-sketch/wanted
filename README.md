# MCP Media Generator

خادم **MCP** (Model Context Protocol) لتوليد الوسائط بالذكاء الاصطناعي يجمع ثلاث قدرات في أداة واحدة:

- 🖼️ **توليد صور من وصف نصي** — الموديل المدمج: `gpt-image-2-6/flare-text-to-image`
- 🎬 **توليد فيديو بصوت متزامن أصلي** (حوار/مؤثرات/موسيقى) — الموديل المدمج: `grok-imagine-video-1-5-preview`
- 🔗 **دمج عدة مقاطع فيديو** في مقطع واحد عالي الجودة وبالترتيب المطلوب (MP4 / H.264 + AAC حتى 1080p)

يعرض الخادم **5 أدوات MCP** على المسار `/mcp` يستدعيها أي عميل (ChatGPT Connectors / Claude Desktop / Cursor / Windsurf / Cline / GPT Agents SDK)، ومعه **لوحة إدارة عربية (RTL)** لإدارة مفاتيح API ومتابعة المهام حيًا.

---

## القواعد الجوهرية (لا تُخرَق)

1. **روابط فقط** — لا يُنزَّل أي ملف وسائط على السيرفر إطلاقًا؛ تُخزَّن روابط النتائج في قاعدة البيانات فقط.
2. **ترتيب مفاتيح تسلسلي صارم** بحسب أمر الإضافة (`created_at ASC, id ASC`) — أول مفتاح أُضيف يُجرَّب أولًا، ليس round-robin.
3. **لا توقف عند نفاد رصيد** — تبديل تلقائي فوري للمفتاح التالي واستئناف نفس المهمة بنفس `task_id`.
4. **نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح/الرصيد أبدًا** — التبديل صامت تمامًا من وجهة نظره.
5. مهمة فشلت على كل المفاتيح تبقى `processing` وتُعاد محاولتها تلقائيًا مع كل `get_task` (بتهدئة ~45 ثانية).
6. أخطاء خدمة الدمج المعلنة (HTTP 4xx/5xx) = فشل حتمي فوري؛ أخطاء الشبكة = مؤقتة وتستمر بالاستعلام.
7. ملفات الدمج تُحذف من خدمة الدمج بعد **~24 ساعة** — مذكورة في وصف الأداة وتعليمات الخادم.
8. إخفاء المفاتيح إلزامي في كل الاستجابات (`maskKey`: أول 7 + نقاط + آخر 4).
9. لا أسرار في الكود أو Git — `.env*` مستثنى منذ أول commit.

## الأدوات الخمس

| الأداة | الوصف |
| --- | --- |
| `generate_image` | توليد صورة بـ `gpt-image-2-6/flare-text-to-image` (نسب أبعاد، دقة 1K/2K/4K، شفافية، صيغة الخرج) |
| `generate_video` | توليد فيديو بـ `grok-imagine-video-1-5-preview` (صوت أصلي، image-to-video اختياري، 1–15 ثانية) |
| `merge_videos` | دمج 2–10 مقاطع بترتيب `urls` مباشرة أو `task_ids` لمهام مكتملة (تُحل روابطها من القاعدة) |
| `get_task` | تتبع أي مهمة بمعرّفها — تحديث حي من المزود/خدمة الدمج + إعادة المحاولة التلقائية |
| `list_media` | أحدث الوسائط المخزنة بروابطها (فلترة بالنوع/الحالة، حتى 50) |

التوليد غير متزامن: الأداة تعيد `task_id` فورًا (مع نافذة انتظار قصيرة تبث تقدمًا حيًا كل ~3 ثوانٍ عبر Progress Notifications)، ويُتابَع بـ `get_task` كل ~10 ثوانٍ حتى الاكتمال.

## التصنيف الموحد لأخطاء المزودين

| الفئة | الشرط | الإجراء |
| --- | --- | --- |
| `disabled` | HTTP 401/403 أو `invalid api key / unauthorized / forbidden / authentication` | تعطيل المفتاح تلقائيًا → المفتاح التالي |
| `exhausted` | HTTP 402 أو `insufficient / quota / balance / credit / exhausted / 充值` (تُفحص قبل 400) | تعليم المفتاح مستنزفًا (يبقى في القاعدة) → التالي |
| `provider` | `model not found / unsupported model` مع 400/404/422 | المزود لا يخدم الموديل → التالي |
| `params` | 400/422 (معطيات) | توقف فوري — تبديل المفاتيح لا يحل خطأ معطيات |
| `temporary` | 429، 5xx، انقطاع شبكة، timeout | التالي الآن والمفتاح يبقى سليمًا |

## البنية

```
src/
├── app/
│   ├── mcp/route.ts            # خادم MCP (Streamable HTTP — SDK رسمي، نمط stateless)
│   ├── api/health/route.ts     # فحص الصحة (Turso + خدمة الدمج)
│   ├── api/keys/...            # إدارة المفاتيح (مقنّعة دائمًا)
│   ├── api/tasks/...           # المهام والإحصائيات للوحة
│   ├── layout.tsx              # RTL + lang=ar + خط Cairo
│   └── page.tsx                # لوحة الإدارة (بطاقات: مفاتيح/مهام/ربط)
└── lib/
    ├── turso.ts                # عميل Turso عبر HTTP + ensureSchema (بلا migrations)
    ├── keys.ts                 # التجمع التسلسلي + تصنيف الأخطاء + maskKey
    ├── models.ts               # سجل الموديلات (أسماء موحدة + تجاوز بالبيئة)
    ├── providers/              # kie.ts (Jobs API) + cometapi.ts (متوافق OpenAI)
    ├── generation.ts           # runGeneration + refreshTask (التبديل التسلسلي)
    ├── merger.ts               # عميل Video Merger API v2 + runMerge
    ├── responses.ts            # صياغة الردود العربية
    └── mcp-server.ts           # الأدوات الخمس + SERVER_INSTRUCTIONS
```

**المزودون:** `kie.ai` هو الأساسي (Jobs API موحد — الأشكال مقاسة فعليًا)، و`CometAPI` ثانوي (صور متزامنة متوافقة مع OpenAI + فيديو غير متزامن). مفاتيح كليهما تُدار من اللوحة ويُجرَّبون بالترتيب حسب أمر الإضافة.

## التشغيل المحلي

```bash
# 1) قاعدة Turso مجانية
turso db create media-gen
turso db show media-gen --url          # ← TURSO_DATABASE_URL
turso db tokens create media-gen       # ← TURSO_AUTH_TOKEN

# 2) البيئة
cp .env.example .env.local             # واملأ القيم (MERGER_API_BASE إلزامي للدمج)

# 3) التشغيل
npm install
npm run dev                            # http://localhost:3000
npm run typecheck && npm run build     # فحص + بناء إنتاجي
```

ثم من اللوحة: أضف مفتاح `kie.ai` واحدًا على الأقل، واربط أي عميل MCP بالرابط `http://localhost:3000/mcp`.

## النشر على Vercel

1. اربط المستودع في Vercel.
2. أضف متغيرات البيئة: `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` و `MERGER_API_BASE` (واختياريًا `MCP_ACCESS_TOKEN`).
3. Deploy — كل شيء يعمل بلا ملفات محلية: libsql يتصل عبر HTTP و`/mcp` يدعم streaming (نمط stateless متوافق مع serverless).

## ربط العملاء

- **ChatGPT**: Settings → Connectors → Create → Custom MCP server → ضع `<origin>/mcp` في «Server URL».
- **Claude Desktop** (`claude_desktop_config.json`):

```json
{ "mcpServers": { "media-generator": { "type": "http", "url": "https://<نطاقك>/mcp" } } }
```

- **Cursor / Windsurf / Cline** (`mcp.json`): نفس الصيغة السابقة.

اللوحة تعرض هذه الإعدادات جاهزة للنسخ في تبويبات، مع حقل `Authorization` تلقائي إن ضُبط `MCP_ACCESS_TOKEN`.

## متغيرات البيئة

| المتغير | إلزامي | الوصف |
| --- | --- | --- |
| `TURSO_DATABASE_URL` | نعم | رابط قاعدة Turso |
| `TURSO_AUTH_TOKEN` | نعم | توكن كتابة Turso |
| `MERGER_API_BASE` | للدمج | عنوان خدمة Video Merger API v2 |
| `MCP_ACCESS_TOKEN` | لا | إن ضُبط يُطلب Bearer token على `/mcp` |
| `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` / `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL` | لا | تجاوز أسماء الموديلات |
| `COMETAPI_BASE` | لا | تجاوز عنوان CometAPI (الافتراضي `https://api.cometapi.com`) |

## ملاحظات

- حدود خدمة الدمج: 10 مقاطع كحد أقصى، 200MB لكل مصدر، 150MB للناتج، 600 ثانية مجموع المدد، والناتج ثابت الإعدادات (بلا resolution/fps).
- التقدم المُبث أثناء التوليد تقديري (المزود لا يقدم نسبة) — يُحدَّث حيًا كل ~3 ثوانٍ ويُخزَّن في القاعدة.
- محاولة إضافة مفتاح مكرر لنفس المزود تُرفض (409).
