# مسجّل الدورة (YouTube → Telegram) عبر GitHub Actions

يسجّل بثّ/فيديو يوتيوب على خوادم GitHub المجانية (قرص ~14GB، نت سريع) ثم يرفعه
إلى حسابك على تيليجرام (رسائلك المحفوظة) — حتى **4GB** بحساب Premium. بدون جهازك.

## الإعداد (مرة واحدة)

1) **جِب `API_ID` و `API_HASH`** من https://my.telegram.org (API development tools).

2) **ولّد `SESSION_STRING` لحسابك** (المميّز) — على جهازك (Termux/كمبيوتر):
   ```
   pip install kurigram tgcrypto
   API_ID=123456 API_HASH=xxxx python recorder/gen_session.py
   ```
   سجّل دخولك (رقمك + الكود)، وانسخ السطر الطويل اللي يطبعه.

3) **أضف الأسرار** في GitHub: افتح الريبو → **Settings → Secrets and variables → Actions → New repository secret**، وأضف:
   - `API_ID`
   - `API_HASH`
   - `SESSION_STRING`  (اللي ولّدته بالخطوة 2)
   - `TARGET_CHAT`  (اختياري — آيدي قناة/محادثة؛ اتركه فارغًا = رسائلك المحفوظة)
   - `YT_COOKIES`  (اختياري — محتوى cookies.txt لو البث خاص/للأعضاء)

## كل يوم (تسجيل بثّ)

- افتح الريبو → **Actions** → **تسجيل فيديو الدورة** → **Run workflow**.
- الصق رابط بث اليوم (مثل `https://www.youtube.com/live/XXXX`)، واختر الدقة (best افتراضيًا).
- اضغط **Run**. بعد ما يخلص، بتلاقي الفيديو برسائلك المحفوظة بتيليجرام.

> نصيحة: الأفضل تشغّله **بعد ما يخلص البث** — بينزّل التسجيل الكامل بسرعة. أو شغّله
> أثناء البث مع `--live-from-start` ليسجّل من البداية (مفعّل أصلًا في الـ workflow).

## ملاحظات

- ملف أكبر من 2GB يحتاج حساب **Premium** للرفع (الـ 3GB تمشي كملف واحد).
- دقائق Actions المجانية (~2000/شهر للخاص) تكفي لعشرات الفيديوهات.
- لو يوتيوب طلب تأكيد (bot check)، أضف سر `YT_COOKIES`.
