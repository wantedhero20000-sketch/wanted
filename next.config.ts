import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // مخرجات مستقلة للنشر الذاتي — على Vercel تعمل بالوضع الافتراضي دون تأثير
  output: "standalone",
  // مجلد البناء قابل للتجاوز بمتغير NEXT_DIST_DIR (اختياري — يبقى الافتراضي .next)
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // فحص TypeScript داخل البناء مفعّل افتراضيًا.
  // NEXT_SKIP_TS=1 للبيئات محدودة الذاكرة فقط — يُعوَّض بتشغيل `npm run typecheck` منفصلًا.
  typescript: {
    ignoreBuildErrors: process.env.NEXT_SKIP_TS === "1",
  },
  reactStrictMode: false,
  // حزم تعمل على Node مباشرة (وحدات أصلية/ديناميكية) — تُترك خارج التجميع
  serverExternalPackages: ["@libsql/client", "@modelcontextprotocol/sdk"],
};

export default nextConfig;
