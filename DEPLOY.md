# 🚀 نشر البوت مجاناً على VPS (GitHub Student → DigitalOcean)

كل شي (البوت + الكول + قاعدة البيانات) بينشتغل بأمر واحد عبر Docker Compose.

---

## 1) خذ حزمة الطالب (مرة وحدة)
1. افتح: **education.github.com/pack** → "Get student benefits".
2. سجّل دخول بحساب GitHub.
3. وثّق إنك طالب: إيميل جامعي (`.edu` أو دومين جامعتك) **أو** ارفع هوية/إثبات تسجيل.
4. استنى الموافقة (دقايق لأيام).

## 2) خذ رصيد DigitalOcean 200$
1. من صفحة الحزمة، دوّر على **DigitalOcean** → "$200 credit".
2. أنشئ حساب DigitalOcean وأضف بطاقة (الرصيد بيغطّي — سيرفر صغير بيكفّي ~سنة).

## 3) أنشئ سيرفر (Droplet)
1. **Create → Droplet**.
2. النظام: **Ubuntu 24.04**.
3. الخطة: **Basic → Regular → 2 GB RAM / 1 CPU** (مهم للـ music-bot). (~12$/شهر، والرصيد بيغطّي أكثر من سنة).
4. المنطقة: الأقرب إلك (**Frankfurt** مناسبة للشرق الأوسط).
5. اختر كلمة سر أو مفتاح SSH → **Create**.

## 4) ادخل على السيرفر وثبّت Docker
```bash
ssh root@عنوان_السيرفر
curl -fsSL https://get.docker.com | sh
```

## 5) نزّل المشروع
```bash
git clone https://github.com/Y1X0/BOT.git
cd BOT
git checkout claude/telegram-group-bot-xenp00
```

## 6) اضبط المتغيّرات
```bash
cp .env.example .env
nano .env
```
عبّي **على الأقل**:
- `BOT_TOKEN` — توكن البوت من BotFather
- `OWNER_IDS` — الآيدي تبعك
- `POSTGRES_PASSWORD` — أي كلمة سر قوية (تنحفظ بنفس الـ .env)
- للكول (music-bot): `API_ID` · `API_HASH` · `SESSION_STRING` · `STREAMER_TOKEN` · `MUSIC_STORAGE_CHANNEL_ID`
- اختياري: `SUPPORT_CONTACT` · `BOT_CHANNEL_URL` · `YT_COOKIES`

> ملاحظة: `DATABASE_URL` و`STREAMER_URL` و`BOT_MODE` **ما تلمسهم** — الـ compose بيضبطهم تلقائياً.

## 7) شغّل كل شي 🎉
```bash
docker compose up -d --build
```
- أول مرة بتاخد شوي (بناء). بعدها البوت بينشئ جداول القاعدة تلقائياً.
- شوف اللوقات: `docker compose logs -f bot`
- للكول: `docker compose logs -f music-bot`

## أوامر يومية
```bash
docker compose ps            # حالة الخدمات
docker compose logs -f bot   # لوقات مباشرة
docker compose restart bot   # إعادة تشغيل
git pull && docker compose up -d --build   # تحديث لأحدث كود
docker compose down          # إيقاف الكل
```

---

## ملاحظات
- **البيانات محفوظة**: Postgres على volume ثابت (`pgdata`) — ما بتضيع مع إعادة التشغيل/التحديث.
- **الوضع**: البوت شغّال بـ **long polling** (ما بدو دومين ولا HTTPS). لو بدك webhook لاحقاً بنضيف Caddy/Nginx.
- **بديل مجاني للأبد**: نفس الخطوات بتشتغل على **Oracle Cloud Always Free** (VPS مجاني دائم) — بس التسجيل أصعب شوي.
