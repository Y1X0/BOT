#!/data/data/com.termux/files/usr/bin/bash
#
# مسجّل الدورة على الهاتف (Termux) — مجاني، بدون كوكيز، بدون حساب Google.
# هاتفك على IP منزلي، فيوتيوب ما بيحظره (نفس سبب نجاح تنزيلك السابق).
# ينزّل فيديو/بث يوتيوب ثم يرفعه لحسابك على تيليجرام (رسائلك المحفوظة) تلقائيًا،
# فما بيضل الملف الكبير على الهاتف.
#
# ── الإعداد (مرة واحدة) ─────────────────────────────────────────────
#   1) ثبّت تطبيق Termux (من F-Droid أفضل من Google Play).
#   2) انسخ مجلد recorder/ على الهاتف، أو نزّل هذا الملف فقط.
#   3) املأ بيانات تيليجرام مرة وحدة بملف recorder/termux.env (انظر المثال
#      بالأسفل) — أو صدّرها كمتغيّرات بيئة قبل التشغيل.
#
# ── كل يوم ──────────────────────────────────────────────────────────
#   bash termux.sh "https://www.youtube.com/live/XXXX"            # أفضل دقة
#   bash termux.sh "https://www.youtube.com/live/XXXX" 720        # دقة محددة
#
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"

# ── حمّل بيانات تيليجرام من termux.env لو موجود ──────────────────────
if [ -f "$HERE/termux.env" ]; then
  set -a; . "$HERE/termux.env"; set +a
fi

URL="$1"
QUALITY="${2:-best}"
if [ -z "$URL" ]; then
  echo "الاستعمال: bash termux.sh <رابط يوتيوب> [best|1080|720|480]" >&2
  exit 1
fi

echo "➡️  تحديث حزم Termux وتثبيت الأدوات (أول مرة فقط تاخد وقت)…"
pkg update -y >/dev/null 2>&1 || true
# nodejs = JS runtime ليوتيوب (يحلّ تحدّيات الـ JS بدل deno على الأندرويد).
pkg install -y python ffmpeg nodejs >/dev/null 2>&1 || pkg install -y python ffmpeg nodejs

echo "➡️  تثبيت/تحديث yt-dlp و EJS وأدوات الرفع…"
pip install -U "yt-dlp[default]" yt-dlp-ejs kurigram tgcrypto >/dev/null

echo "➡️  نسخة الأدوات:"
yt-dlp --version
node --version

mkdir -p "$HERE/out"

if [ "$QUALITY" = "best" ] || [ -z "$QUALITY" ]; then
  FORMAT="bv*+ba/b"
else
  FORMAT="bv*[height<=$QUALITY]+ba/b[height<=$QUALITY]/b"
fi

echo "➡️  تنزيل الفيديو (بدون كوكيز، IP منزلي)…"
# node كـ JS runtime، ونفس إعدادات العملاء اللي بتتخطّى الحظر قدر الإمكان.
yt-dlp --live-from-start -f "$FORMAT" \
  --js-runtimes node \
  --extractor-args "youtube:player_client=tv,mweb,web_safari,default" \
  --merge-output-format mp4 \
  --no-part \
  -P "$HERE/out" \
  -o "%(title)s [%(id)s].%(ext)s" \
  "$URL"

echo "✅ خلص التنزيل. الملفات:"
ls -lh "$HERE/out"

# ── الرفع لتيليجرام (اختياري: فقط لو عبّيت بيانات الحساب) ─────────────
if [ -n "$API_ID" ] && [ -n "$API_HASH" ] && [ -n "$SESSION_STRING" ]; then
  echo "➡️  رفع الملفات لتيليجرام…"
  # upload.py يدوّر على out/* بمجلده الحالي، فنشغّله من داخل recorder/.
  ( cd "$HERE" && python upload.py )
  echo "🎉 خلص — شوف رسائلك المحفوظة بتيليجرام. بتقدر تمسح recorder/out لتوفير مساحة."
else
  echo "ℹ️  ما رفعت لتيليجرام (بيانات الحساب غير معبّأة في termux.env)."
  echo "   الملفات محفوظة في: $HERE/out"
fi
