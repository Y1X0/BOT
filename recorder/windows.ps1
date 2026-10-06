# مسجّل الدورة على ويندوز — مجاني، بدون كوكيز، بدون حساب Google، بدون GitHub.
# جهازك على IP منزلي، فيوتيوب ما بيحظره. السكربت ينزّل كل الأدوات لحاله
# (yt-dlp.exe + ffmpeg + deno) أول مرة، ثم ينزّل الفيديو بمجلد "out".
#
# ── كيف تشغّله ──────────────────────────────────────────────────────
#   1) احفظ هذا الملف على سطح المكتب باسم record.ps1
#   2) افتح PowerShell (ابحث عن PowerShell بقائمة ابدأ)
#   3) الصق هذا السطر (بدّل الرابط):
#        powershell -ExecutionPolicy Bypass -File "$HOME\Desktop\record.ps1" -Url "https://www.youtube.com/live/XXXX"
#      ولدقة محددة أضف:  -Quality 720
#
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [string]$Quality = "best"
)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$Tools  = Join-Path $Root "win-tools"
$Out    = Join-Path $Root "out"
New-Item -ItemType Directory -Force -Path $Tools, $Out | Out-Null

$ytdlp  = Join-Path $Tools "yt-dlp.exe"
$deno   = Join-Path $Tools "deno.exe"
$ffmpeg = Join-Path $Tools "ffmpeg.exe"

# ── yt-dlp.exe (النسخة الرسمية تتضمّن مكوّن EJS، فما بنحتاج تثبيت إضافي) ──
if (-not (Test-Path $ytdlp)) {
  Write-Host "تنزيل yt-dlp..."
  Invoke-WebRequest "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" -OutFile $ytdlp
} else {
  Write-Host "تحديث yt-dlp..."
  & $ytdlp -U | Out-Null
}

# ── ffmpeg (دمج الصوت والصورة) ──
if (-not (Test-Path $ffmpeg)) {
  Write-Host "تنزيل ffmpeg (مرة واحدة)..."
  $zip = Join-Path $Tools "ffmpeg.zip"
  Invoke-WebRequest "https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip" -OutFile $zip
  Expand-Archive $zip -DestinationPath $Tools -Force
  Get-ChildItem $Tools -Recurse -Filter ffmpeg.exe  | Select-Object -First 1 | ForEach-Object { Copy-Item $_.FullName $ffmpeg -Force }
  Get-ChildItem $Tools -Recurse -Filter ffprobe.exe | Select-Object -First 1 | ForEach-Object { Copy-Item $_.FullName (Join-Path $Tools "ffprobe.exe") -Force }
  Remove-Item $zip -Force
}

# ── deno (JS runtime ليوتيوب — احتياط لو طلب تحدّي JavaScript) ──
if (-not (Test-Path $deno)) {
  Write-Host "تنزيل deno (مرة واحدة)..."
  $dz = Join-Path $Tools "deno.zip"
  Invoke-WebRequest "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip" -OutFile $dz
  Expand-Archive $dz -DestinationPath $Tools -Force
  Remove-Item $dz -Force
}

$env:PATH = "$Tools;$env:PATH"

if ($Quality -eq "best" -or [string]::IsNullOrEmpty($Quality)) {
  $Format = "bv*+ba/b"
} else {
  $Format = "bv*[height<=$Quality]+ba/b[height<=$Quality]/b"
}

Write-Host "`n➡️  تنزيل الفيديو (بدون كوكيز، IP منزلي)...`n"
& $ytdlp -v --live-from-start -f $Format `
  --ffmpeg-location $Tools `
  --js-runtimes deno `
  --extractor-args "youtube:player_client=tv,mweb,web_safari,default" `
  --merge-output-format mp4 --no-part `
  -P $Out -o "%(title)s [%(id)s].%(ext)s" $Url

Write-Host "`n✅ خلص. الفيديو محفوظ في:`n   $Out"
