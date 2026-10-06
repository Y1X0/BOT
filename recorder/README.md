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

## مهم: حظر يوتيوب على السحابة (datacenter IP)

رَنر GitHub (ومعظم الخدمات المجانية) عنوانه **datacenter**، ويوتيوب بيحظره ويطلب
`Sign in to confirm you're not a bot` — حتى لو الـ JavaScript runtime (Deno/EJS)
شغّال تمام. السبب هو **العنوان**، مش إعداد yt-dlp. في مسارين لحلّها:

### المسار ١ — self-hosted runner (بدون كوكيز، IP منزلي)
شغّل نفس الـ workflow على جهازك (لينكس/ويندوز/ماك — **مش** أندرويد/ترمكس):
1. افتح الريبو → **Settings → Actions → Runners → New self-hosted runner**.
2. نفّذ الأوامر اللي يعطيك إياها على جهازك (بتسجّل الرَنر وتشغّله).
3. وقت التشغيل من تبويب Actions، اختَر `runner = self-hosted`.
الجهاز لازم يكون شغّال وقت التسجيل، ولازم ffmpeg + python3 + (deno أو node) موجودين.

### المسار ٢ — كوكيز حساب Google **احتياطي** (مش حسابك الشخصي)
لو بدك يضل سحابي بالكامل بدون جهازك: اعمل **حساب Google جديد فاضي**، سجّل فيه
دخول يوتيوب، صدّر كوكيزه (إضافة متصفح مثل "Get cookies.txt")، وحطّ المحتوى بسر
`YT_COOKIES`. استخدم حساب احتياطي عشان لو تسرّب ما يأثّر على حسابك الحقيقي.

## الأسهل لو عندك كمبيوتر ويندوز — بدون كوكيز ولا GitHub

جهازك على IP منزلي، فيوتيوب ما بيحظره. السكربت `windows.ps1` ينزّل كل الأدوات
لحاله (yt-dlp + ffmpeg + deno) وينزّل الفيديو بمجلد `out`:

```
# احفظ windows.ps1 على سطح المكتب باسم record.ps1، ثم بـ PowerShell:
powershell -ExecutionPolicy Bypass -File "$HOME\Desktop\record.ps1" -Url "https://www.youtube.com/live/XXXX"
```

## البديل المجاني الجاهز: التنزيل من الهاتف (Termux) — بدون كوكيز

هاتفك على **IP منزلي**، فيوتيوب ما بيحظره. السكربت `termux.sh` بينزّل **ويرفع
لتيليجرام تلقائيًا** بأمر واحد، فما بيضل الملف الكبير على الهاتف:

```
# إعداد مرة وحدة:
cp recorder/termux.env.example recorder/termux.env   # واملأ API_ID/API_HASH/SESSION_STRING
# كل يوم:
bash recorder/termux.sh "https://www.youtube.com/live/XXXX"
```
