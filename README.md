# 🤖 Telegram Group Management & Interactive Bot

بوت تيليجرام احترافي **Production-Ready** لإدارة الجروبات والتفاعل مع الأعضاء،
مبني بمعمارية **Plugin-based** قابلة للتوسع باستخدام **Node.js + TypeScript + Telegraf + Prisma**.

> A professional, extensible Telegram group bot: welcome/CAPTCHA, anti-spam,
> moderation, games, economy, XP levels, analytics, multi-language, and an
> optional AI assistant — all behind a clean plugin architecture.

---

## ✨ المميزات (Features)

| # | الميزة | الوصف |
|---|--------|-------|
| 1 | 👋 **الترحيب والمغادرة** | رسائل ترحيب قابلة للتخصيص `{name}` `{title}`، صورة ترحيب، رسالة مغادرة، وحماية **CAPTCHA** للأعضاء الجدد |
| 2 | 💬 **الردود الذكية** | ردود مدمجة (السلام عليكم، شكراً، مبروك...) + ردود مخصصة يديرها الأدمن + ردود عشوائية + Reactions |
| 3 | ℹ️ **أوامر المعلومات** | `/time` `/date` `/day` `/weather` `/id` `/rules` |
| 4 | 🛡️ **الحماية Anti-Spam** | كشف الفيضان (Flood)، منع تكرار الرسائل، منع الروابط والتحويل، كلمات ممنوعة، تحذيرات وتصعيد تلقائي |
| 5 | 👮 **الإدارة** | `/warn` `/mute` `/kick` `/ban` `/promote` `/settings` مع نظام أدوار (Owner / Admin / Moderator) |
| 6 | 🎮 **الألعاب** | حجر ورقة مقص، تخمين رقم، أسئلة ثقافية (Quiz) مع مكافآت |
| 7 | 🎉 **التفاعل** | ردود وتفاعلات على العبارات الاجتماعية (تصبحون على خير، مبروك...) |
| 8 | 💰 **الاقتصاد** | `/balance` `/daily` `/top` `/give` — عملات ومكافأة يومية ولوحة صدارة |
| 9 | 📊 **XP والمستويات** | نقاط خبرة تلقائية من النشاط، مستويات، وإشعار عند الترقية `/rank` `/levels` |
| 10 | 📈 **الإحصائيات** | `/stats` `/activetop` — عدد الأعضاء والرسائل وأكثر الأعضاء تفاعلاً |
| 11 | 🤖 **مساعد ذكي (اختياري)** | `/ai` يرد عند مناداته فقط، مع حد يومي لكل جروب لضبط التكلفة |
| 12 | 🧩 **نظام Plugins** | إضافة ميزات جديدة بملف واحد دون لمس النواة |

**إضافات من أفضل ممارسات البوتات الحديثة:** التحقق بـ CAPTCHA، سجل إجراءات إداري
(Audit Log)، تعدد اللغات (عربي/إنجليزي)، Rate Limiting، Health Check، إيقاف رشيق
(Graceful Shutdown)، ودعم **Polling** و **Webhook**.

---

## 🏗️ البنية المعمارية (Architecture)

```
src/
├── config/          إعدادات البيئة مع تحقق Zod (env.ts)
├── core/            النواة: bot, logger, database, plugin registry, server
├── middlewares/     context (settings/locale/role), rate-limit, anti-spam
├── services/        منطق الأعمال: settings, member(XP), economy, moderation,
│                    replies, filters, ai  (طبقة مستقلة قابلة لإعادة الاستخدام)
├── plugins/         الميزات كوحدات مستقلة (welcome, moderation, games, ...)
├── locales/         ملفات الترجمة (ar.json, en.json)
├── utils/           permissions, format, time, moderation-actions
└── index.ts         نقطة الدخول (تشغيل + إيقاف رشيق)
```

**تدفق الرسالة (Middleware Pipeline):**

```
Update → context (يحمّل الإعدادات واللغة والدور)
       → rateLimit (يحد من سبام الأوامر)
       → antispam (فلترة/فيضان/روابط — قد يوقف الرسالة)
       → plugins (engagement → games → replies → commands)
```

لماذا هذا التصميم؟ **فصل الاهتمامات**: الـ `services` لا تعرف شيئاً عن Telegram،
مما يجعل إضافة **Web Dashboard** أو اختبارات الوحدة أمراً سهلاً لاحقاً.

---

## 🚀 التشغيل محلياً (Local Setup)

### المتطلبات
- Node.js ≥ 20
- (اختياري) PostgreSQL — الافتراضي SQLite بدون أي إعداد

### الخطوات

```bash
# 1) تثبيت الاعتماديات
npm install

# 2) إعداد المتغيرات
cp .env.example .env
#   ثم افتح .env وضع BOT_TOKEN و OWNER_IDS

# 3) توليد Prisma Client وإنشاء قاعدة البيانات
npm run db:push        # يستخدم SQLite افتراضياً

# 4) التشغيل (وضع التطوير مع إعادة التحميل)
npm run dev

# أو بناء وتشغيل الإنتاج
npm run build && npm start
```

### 🔑 الحصول على Telegram Bot Token
1. افتح [@BotFather](https://t.me/BotFather) على تيليجرام.
2. أرسل `/newbot` واتبع التعليمات.
3. انسخ التوكن وضعه في `.env` كـ `BOT_TOKEN`.
4. لمعرفة الـ ID الخاص بك (لـ `OWNER_IDS`): أضف البوت لأي جروب وأرسل `/id`.
5. **مهم:** اجعل البوت **Admin** في الجروب ليتمكن من الكتم/الطرد/الحذف.
   وفعّل *Group Privacy = OFF* من BotFather (`/setprivacy`) ليقرأ كل الرسائل.

---

## 🗄️ إعداد قاعدة البيانات (Database)

المشروع يدعم **SQLite** (افتراضي) و **PostgreSQL** بتصميم قابل للنقل:

```bash
# SQLite (لا يحتاج أي خادم) — الافتراضي في .env.example
DATABASE_PROVIDER=sqlite
DATABASE_URL="file:./data/bot.db"

# PostgreSQL — فقط غيّر السطرين
DATABASE_PROVIDER=postgresql
DATABASE_URL="postgresql://user:pass@host:5432/db?schema=public"
```

سكربت `scripts/set-db-provider.mjs` يضبط الـ provider في مخطط Prisma تلقائياً
قبل أي أمر (لأن Prisma لا يسمح بـ `env()` في الـ provider). لا حاجة لتعديل يدوي.

```bash
npm run db:push          # مزامنة سريعة (تطوير)
npm run prisma:migrate   # إنشاء Migration (يُنصح به للإنتاج)
npm run prisma:studio    # واجهة رسومية لتصفح البيانات
```

---

## ☁️ النشر على Render (Deployment)

### الطريقة الأسهل: Blueprint
1. ارفع المشروع إلى GitHub.
2. من Render: **New → Blueprint** واختر المستودع (يقرأ `render.yaml` تلقائياً).
3. سيُنشئ خدمة Web + قاعدة PostgreSQL مجانية.
4. أضف المتغيرات السرية في لوحة Render:
   - `BOT_TOKEN`
   - `OWNER_IDS`
   - `WEBHOOK_DOMAIN` = رابط خدمتك، مثل `https://your-service.onrender.com`
5. Render يشغّل `/health` كفحص صحة، والبوت يعمل في وضع **Webhook** تلقائياً.

### يدوياً (Docker)
```bash
docker build -t telegram-bot .
docker run -p 3000:3000 --env-file .env telegram-bot
```

> **ملاحظة:** على Render، وضع **Webhook** موصى به (لا يحتاج البوت للبقاء نشطاً
> بالـ polling). عند استخدام SQLite في الإنتاج اربط Volume على `/app/data`،
> أو استخدم PostgreSQL (الأفضل لتعدد النسخ).

---

## ⚙️ أوامر مختصرة (Commands)

**عامة:** `/start` `/help` `/time` `/date` `/day` `/weather <city>` `/id` `/rules`
`/rank` `/levels` `/stats` `/activetop` `/balance` `/daily` `/top` `/give`
`/rps` `/guess` `/quiz` `/ai <question>`

**للأدمن:** `/settings` · `/set <key> on|off` · `/setrules` · `/setwelcome`
`/warn` `/unwarn` `/warns` `/mute` `/unmute` `/kick` `/ban` `/unban` `/promote`
`/addfilter` `/delfilter` `/filters` `/addreply` `/delreply` `/replies`

مثال: `/addreply قهوة | صحتين وعافية ☕; يهنيك 🌟` (ردود متعددة تُختار عشوائياً).

---

## 🧩 كيفية إضافة ميزة جديدة (Adding a Plugin)

1. أنشئ مجلداً `src/plugins/myfeature/index.ts`:

```ts
import type { Telegraf } from 'telegraf';
import type { BotContext } from '../../core/context';
import type { Plugin } from '../../core/plugin';

export const myFeaturePlugin: Plugin = {
  name: 'myfeature',
  description: 'شرح مختصر',
  commands: [{ command: 'hello', description: '👋 مرحبا' }],
  register(bot: Telegraf<BotContext>) {
    bot.command('hello', async (ctx) => {
      await ctx.reply(ctx.state.t!('start.private'));
    });
  },
};
```

2. سجّله في `src/plugins/index.ts` بإضافته لمصفوفة `allPlugins`.
3. (اختياري) أضف مفاتيح الترجمة في `src/locales/*.json`.

هذا كل شيء — يظهر تلقائياً في `/help` وقائمة أوامر تيليجرام. لا حاجة لتعديل النواة.

> **ترتيب مستمعي النصوص مهم:** المستمعون الذين "يمرّرون" الرسالة يستدعون
> `next()`، والمستمع النهائي (مثل الردود) لا يفعل. راجع التعليقات في
> `src/plugins/index.ts`.

---

## 🔒 الأمان (Security)

- ✅ لا توكنات في الكود — كل الأسرار عبر `.env` (متحقق منها بـ Zod).
- ✅ التحقق من كل المدخلات وتنظيف مخرجات MarkdownV2.
- ✅ Rate Limiting لكل مستخدم + Anti-Spam على مستوى الجروب.
- ✅ أخطاء داخلية تُسجّل فقط ولا تُعرض للمستخدم (`bot.catch`).
- ✅ صلاحيات صارمة عبر `requireRole` وحماية المشرفين من الإجراءات.
- ✅ Redaction للتوكنات في السجلات (Pino).

---

## 🧪 الاختبارات (Tests)

```bash
npm test           # تشغيل مرة واحدة
npm run test:watch # وضع المراقبة
```

تغطي الاختبارات المنطق الأساسي: الترجمة (i18n)، حساب المستويات (XP)،
الردود الذكية، الصلاحيات، ودوال التنسيق.

---

## 📁 المتغيرات البيئية

راجع [`.env.example`](./.env.example) للقائمة الكاملة والشرح.

## 📜 الرخصة

MIT — راجع [LICENSE](./LICENSE).
