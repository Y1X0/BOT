/** Self-contained Super Admin dashboard SPA served at /dashboard. */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>لوحة تحكم البوت</title>
<style>
  :root { --bg:#0a0c12; --bg2:#0e1220; --card:#151a27; --soft:#111624; --line:#242c3e; --fg:#eaedf5; --muted:#8b93a8; --accent:#6d5efc; --accent2:#22d3ee; --ok:#34d399; --bad:#fb7185; --warn:#fbbf24; --grad:linear-gradient(135deg,#6d5efc,#9d7bff); --user:#141a28; --botmsg:#12241d; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:system-ui,'Segoe UI',Tahoma,'Noto Sans Arabic',sans-serif; background:var(--bg); color:var(--fg); font-size:14px; line-height:1.55; background-image:radial-gradient(900px 520px at 100% -10%,rgba(109,94,252,.14),transparent 60%),radial-gradient(700px 400px at -10% 0,rgba(34,211,238,.08),transparent 55%); background-attachment:fixed; }
  header { padding:13px 18px; border-bottom:1px solid var(--line); display:flex; align-items:center; justify-content:space-between; gap:10px; background:rgba(12,15,24,.72); backdrop-filter:blur(10px); position:sticky; top:0; z-index:10; }
  header h1 { font-size:15.5px; font-weight:700; margin:0; background:var(--grad); -webkit-background-clip:text; background-clip:text; color:transparent; }
  nav { display:flex; gap:7px; padding:11px 14px; overflow-x:auto; position:sticky; top:49px; background:rgba(10,12,18,.85); backdrop-filter:blur(10px); z-index:9; border-bottom:1px solid var(--line); }
  nav::-webkit-scrollbar { display:none; }
  nav button { background:var(--soft); border:1px solid var(--line); color:var(--muted); border-radius:20px; padding:6px 15px; cursor:pointer; white-space:nowrap; font-family:inherit; font-size:13px; transition:.15s; font-weight:500; }
  nav button:hover { color:var(--fg); border-color:var(--accent); }
  nav button.active { background:var(--grad); color:#fff; border-color:transparent; box-shadow:0 4px 14px rgba(109,94,252,.4); }
  .page { padding:16px; max-width:960px; margin:0 auto; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:16px; margin-bottom:14px; box-shadow:0 1px 2px rgba(0,0,0,.2),0 8px 24px rgba(0,0,0,.18); }
  .card h3 { font-size:14px; font-weight:700; margin:0 0 12px; display:flex; align-items:center; gap:7px; }
  .card h3:not(:first-child) { margin-top:18px; }
  .muted { color:var(--muted); font-size:12.5px; }
  .row { display:flex; gap:8px; margin:8px 0; flex-wrap:wrap; align-items:center; }
  input,textarea,select { background:var(--soft); border:1px solid var(--line); color:var(--fg); border-radius:10px; padding:10px 12px; font-family:inherit; font-size:13.5px; outline:none; transition:border-color .15s,box-shadow .15s; }
  input:focus,textarea:focus,select:focus { border-color:var(--accent); box-shadow:0 0 0 3px rgba(109,94,252,.18); }
  input,textarea { flex:1; min-width:0; }
  button { font-family:inherit; font-size:13.5px; }
  button.act { background:var(--grad); color:#fff; border:none; border-radius:10px; padding:10px 16px; cursor:pointer; font-weight:600; box-shadow:0 4px 14px rgba(109,94,252,.35); transition:.15s; }
  button.act:hover { filter:brightness(1.08); transform:translateY(-1px); }
  button.act:active { transform:translateY(0); }
  button.ghost { background:var(--soft); border:1px solid var(--line); color:var(--fg); border-radius:10px; padding:10px 15px; cursor:pointer; transition:.15s; }
  button.ghost:hover { border-color:var(--accent); }
  button.del { background:transparent; color:var(--bad); border:1px solid var(--line); border-radius:8px; padding:3px 9px; cursor:pointer; font-size:13px; }
  button.del:hover { border-color:var(--bad); background:rgba(251,113,133,.1); }
  .toggle { display:flex; align-items:center; justify-content:space-between; padding:11px 2px; border-bottom:1px solid var(--line); }
  .toggle:last-child { border-bottom:none; }
  .switch { position:relative; width:44px; height:24px; flex-shrink:0; }
  .switch input { display:none; }
  .slider { position:absolute; inset:0; background:#2a3142; border-radius:20px; cursor:pointer; transition:.2s; }
  .slider:before { content:''; position:absolute; width:18px; height:18px; right:3px; top:3px; background:#fff; border-radius:50%; transition:.2s; box-shadow:0 1px 3px rgba(0,0,0,.4); }
  input:checked + .slider { background:var(--grad); }
  input:checked + .slider:before { transform:translateX(-20px); }
  .chat-item { padding:10px 12px; border-radius:10px; cursor:pointer; border:1px solid transparent; transition:.12s; margin-bottom:2px; }
  .chat-item:hover { background:var(--soft); }
  .chat-item.active { background:var(--soft); border-color:var(--accent); }
  .grid2 { display:flex; gap:14px; flex-wrap:wrap; align-items:flex-start; }
  .grid2 > * { flex:1; min-width:270px; margin-bottom:0; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; }
  td,th { text-align:right; padding:9px 9px; border-bottom:1px solid var(--line); }
  tr:last-child td { border-bottom:none; }
  th { color:var(--muted); font-weight:600; font-size:11.5px; letter-spacing:.02em; }
  table tr:hover td { background:rgba(255,255,255,.02); }
  .pill { display:inline-flex; align-items:center; gap:6px; background:var(--soft); border:1px solid var(--line); border-radius:9px; padding:6px 11px; margin:0 0 6px 6px; font-size:13px; }
  .box { background:linear-gradient(160deg,var(--soft),rgba(109,94,252,.06)); border:1px solid var(--line); border-radius:14px; padding:15px 12px; text-align:center; flex:1; min-width:80px; transition:.15s; }
  .box:hover { border-color:var(--accent); transform:translateY(-2px); }
  .box b { font-size:22px; display:block; margin-bottom:2px; color:var(--fg); font-weight:700; }
  .box span { font-size:12px; color:var(--muted); }
  .kicon { font-size:20px; margin-bottom:5px; }
  .kpi-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:12px; margin-bottom:14px; }
  .stat { display:flex; gap:12px; flex-wrap:wrap; }
  .media-item { display:inline-block; width:110px; vertical-align:top; margin:4px; text-align:center; }
  .media-item .thumb { width:110px; height:82px; background:var(--soft); border:1px solid var(--line); border-radius:11px; display:flex; align-items:center; justify-content:center; font-size:30px; cursor:pointer; overflow:hidden; transition:.15s; }
  .media-item .thumb:hover { border-color:var(--accent); transform:translateY(-2px); }
  .media-item img { max-width:100%; max-height:100%; }
  .center { text-align:center; padding:60px 20px; }
  .err { color:var(--bad); font-size:12px; margin:3px 0; }
  .thread { display:flex; flex-direction:column; gap:8px; max-height:58vh; overflow:auto; padding:2px; }
  .msg { max-width:85%; padding:8px 11px; border-radius:13px; border:1px solid var(--line); }
  .msg .meta { font-size:10.5px; color:var(--muted); margin-bottom:3px; }
  .msg.in { align-self:flex-start; background:var(--user); border-bottom-right-radius:4px; }
  .msg.out { align-self:flex-end; background:var(--botmsg); border-bottom-left-radius:4px; }
  .avatar { width:42px; height:42px; border-radius:50%; background:var(--grad); display:flex; align-items:center; justify-content:center; font-weight:700; color:#fff; flex-shrink:0; font-size:16px; }
  .chatlist-item { display:flex; gap:10px; align-items:center; padding:9px 8px; border-radius:12px; cursor:pointer; border:1px solid transparent; }
  .chatlist-item:hover { background:var(--soft); }
  .chatlist-item.active { background:var(--soft); border-color:var(--accent); }
  .ci-main { flex:1; min-width:0; }
  .ci-name { font-size:14px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .ci-sub { font-size:12px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .ci-time { font-size:10.5px; color:var(--muted); flex-shrink:0; align-self:flex-start; }
  .chat { display:flex; flex-direction:column; height:72vh; min-height:430px; }
  .chat-head { display:flex; align-items:center; gap:10px; padding:10px 12px; border-bottom:1px solid var(--line); background:var(--card); }
  .ch-name { font-size:14px; font-weight:700; }
  .ch-sub { font-size:11px; color:var(--muted); }
  .iconbtn { background:transparent; border:none; color:var(--muted); font-size:17px; cursor:pointer; padding:5px 7px; border-radius:8px; }
  .iconbtn:hover { background:var(--soft); color:var(--fg); }
  .chat-body { flex:1; overflow-y:auto; padding:14px 12px; background:#0b1016; display:flex; flex-direction:column; gap:3px; }
  .daysep { align-self:center; background:#1b2029; color:var(--muted); font-size:11px; padding:3px 11px; border-radius:10px; margin:9px 0; }
  .bubble { max-width:82%; padding:6px 10px; border-radius:12px; font-size:14px; line-height:1.45; word-break:break-word; box-shadow:0 1px 1px rgba(0,0,0,.25); }
  .bubble.in { align-self:flex-start; background:#212b36; border-top-left-radius:3px; }
  .bubble.out { align-self:flex-end; background:#0f5c47; border-top-right-radius:3px; }
  .bubble .btime { font-size:9.5px; color:rgba(255,255,255,.5); margin-top:2px; text-align:left; }
  .gfeed { gap:0; padding:10px 10px; font-family:system-ui,'Segoe UI','Noto Sans','Noto Sans Arabic',Tahoma,'Segoe UI Symbol','Noto Color Emoji',sans-serif; }
  .gmsg { margin-top:9px; }
  .ghead { display:flex; align-items:center; gap:7px; margin:0 0 3px; }
  .gavatar { width:22px; height:22px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; color:#0b1016; flex-shrink:0; }
  .gname { font-size:12.5px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .guid { font-size:10px; color:var(--muted); direction:ltr; }
  .gbubble { background:#212b36; border-radius:9px; padding:6px 10px; margin-inline-start:29px; }
  .gtext { font-size:14px; line-height:1.5; word-break:break-word; white-space:pre-wrap; }
  .greply { font-size:11px; color:var(--muted); border-inline-start:2px solid var(--accent2); padding-inline-start:6px; margin-bottom:3px; opacity:.85; }
  .gmedia { display:block; max-width:220px; max-height:260px; width:auto; height:auto; border-radius:8px; cursor:pointer; background:#0b1016; }
  .gcap { font-size:13px; line-height:1.45; margin-top:4px; word-break:break-word; white-space:pre-wrap; }
  .chat-input { display:flex; gap:8px; align-items:center; padding:9px 10px; border-top:1px solid var(--line); background:var(--card); }
  .chat-input input { flex:1; border-radius:20px; padding:10px 15px; }
  .sendbtn { width:40px; height:40px; border-radius:50%; border:none; background:var(--grad); color:#fff; font-size:16px; cursor:pointer; flex-shrink:0; }
  .sendbtn:hover { filter:brightness(1.1); }
  .login-card { max-width:400px; margin:0 auto; text-align:center; }
  .login-card .logo { font-size:44px; margin-bottom:6px; }
</style>
</head>
<body>
<header><h1>🦋 لوحة تحكم البوت</h1><span id="hdr"></span></header>

<div id="login" class="center" style="display:none">
  <div class="card login-card"><div class="logo">🦋</div><h2 style="margin:0 0 4px">تسجيل الدخول</h2>
  <p class="muted">بحساب تيليجرام (المالك فقط).</p><div id="tg-btn" style="display:flex;justify-content:center;margin-top:10px"></div>
  <p class="muted err" id="loginNote"></p></div>
</div>

<div id="app" style="display:none">
  <nav id="nav"></nav>
  <div class="page" id="content"></div>
</div>

<script>
const api=(p,o={})=>fetch('/api'+p,{credentials:'include',headers:{'Content-Type':'application/json'},...o}).then(r=>r.json());
const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
/* Turn a decorated Telegram name into something a phone browser can actually render.
   NFKD folds fancy math/fraktur/bold letters back to plain ones; \\p{M} drops the
   stacked harakat/combining marks; the last range strips zero-width & bidi controls.
   If nothing readable survives, fall back to the raw string (then the id upstream). */
function cleanName(s){ const raw=String(s??'');
  let t=raw.normalize('NFKD').replace(/\\p{M}/gu,'').replace(/[\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\ufeff]/g,'').trim();
  return t||raw; }
/* Stable, legible color per user so you can track who's who at a glance. */
function uColor(id){ let h=0; const s=String(id); for(let i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))>>>0; return 'hsl('+(h%360)+',62%,68%)'; }
const TABS=[['overview','الرئيسية'],['groups','الجروبات'],['monitor','المراقبة'],['users','المحادثات'],['musaraha','المصارحة'],['whispers','الهمسات'],['media','الوسائط'],['logs','السجلات'],['analytics','التحليلات'],['system','النظام'],['audit','التدقيق']];
let current=null, tab='overview', monTimer=null;

async function boot(){ const me=await api('/me');
  if(me.authenticated){ document.getElementById('app').style.display='block'; document.getElementById('hdr').innerHTML='<button class="ghost" onclick="logout()">خروج</button>'; renderNav(); showTab('overview'); }
  else showLogin(); }

function renderNav(){ document.getElementById('nav').innerHTML=TABS.map(([k,l])=>'<button id="t-'+k+'" class="'+(k===tab?'active':'')+'" onclick="showTab(\\''+k+'\\')">'+l+'</button>').join(''); }
function showTab(t){ tab=t; if(monTimer){clearInterval(monTimer);monTimer=null;} renderNav();
  ({overview:loadOverview,groups:loadGroups,monitor:loadMonitor,users:loadUsers,musaraha:loadMusaraha,whispers:loadWhispers,media:()=>loadMedia(''),logs:loadLogsForm,analytics:loadAnalytics,system:loadSystem,audit:loadAudit}[t])(); }

async function showLogin(){ document.getElementById('login').style.display='block'; const c=await api('/config');
  if(!c.botUsername){document.getElementById('loginNote').textContent='⚠️ BOT_USERNAME غير مضبوط.';return;}
  window.onTelegramAuth=async u=>{const r=await api('/auth/telegram',{method:'POST',body:JSON.stringify(u)}); if(r.ok)location.reload(); else document.getElementById('loginNote').textContent=r.error==='not_owner'?'هذا الحساب ليس المالك.':'فشل الدخول.';};
  const s=document.createElement('script'); s.async=true; s.src='https://telegram.org/js/telegram-widget.js?22';
  s.setAttribute('data-telegram-login',c.botUsername); s.setAttribute('data-size','large'); s.setAttribute('data-onauth','onTelegramAuth(user)'); document.getElementById('tg-btn').appendChild(s); }
async function logout(){ await api('/auth/logout',{method:'POST'}); location.reload(); }

/* ---- Overview (home) ---- */
async function loadOverview(){ const c=document.getElementById('content'); c.innerHTML='<p class="muted" style="padding:16px">جاري التحميل...</p>';
  const [chats,users,a,sys]=await Promise.all([api('/chats'),api('/users'),api('/analytics'),api('/system')]);
  const msgs=(a.topTypes||[]).reduce((s,x)=>s+(x.count||0),0);
  const kpi=(icon,val,label)=>'<div class="box"><div class="kicon">'+icon+'</div><b>'+val+'</b><span>'+label+'</span></div>';
  const topG=(a.topGroups||[]).slice(0,6).map((x,i)=>'<tr><td>'+(i+1)+'</td><td>'+esc(cleanName(x.title))+'</td><td>'+x.count+'</td></tr>').join('')||'<tr><td colspan="3" class="muted">لا بيانات</td></tr>';
  const topU=(a.topUsers||[]).slice(0,6).map((x,i)=>'<tr><td>'+(i+1)+'</td><td>'+esc(cleanName(x.name))+'</td><td>'+x.count+'</td></tr>').join('')||'<tr><td colspan="3" class="muted">لا بيانات</td></tr>';
  c.innerHTML='<div class="kpi-grid">'
    +kpi('👥',chats.length,'جروب')
    +kpi('💬',users.length,'محادثة خاصة')
    +kpi('✉️',msgs,'رسالة مسجّلة')
    +kpi('⏱',Math.floor(sys.uptimeSec/3600)+'h','مدة التشغيل')
    +kpi('🧠',sys.memory.rssMB+'MB','الذاكرة')
    +kpi(sys.errors.length?'⚠️':'✅',sys.errors.length,'أخطاء')
    +'</div>'
    +'<div class="grid2">'
    +'<div class="card"><h3 style="margin-top:0">🏆 أنشط الجروبات</h3><table><tr><th>#</th><th>الجروب</th><th>رسائل</th></tr>'+topG+'</table></div>'
    +'<div class="card"><h3 style="margin-top:0">👤 أنشط الأعضاء</h3><table><tr><th>#</th><th>العضو</th><th>رسائل</th></tr>'+topU+'</table></div>'
    +'</div>'
    +'<div class="card"><h3 style="margin-top:0">📣 رسالة جماعية للكل</h3>'
    +'<p class="muted">أرسل رسالة وحدة لكل الجروبات والقنوات دفعة وحدة.</p>'
    +'<textarea id="bcAll" rows="3" placeholder="اكتب نص الرسالة الجماعية..."></textarea>'
    +'<div class="row"><select id="bcTarget"><option value="all">الكل (جروبات + قنوات)</option><option value="groups">الجروبات فقط</option><option value="channels">القنوات فقط</option></select><button class="act" onclick="broadcastAll()">📣 إرسال للكل</button></div>'
    +'<div id="bcResult" class="muted" style="margin-top:6px"></div></div>'
    +'<div class="card"><h3 style="margin-top:0">⚡ إجراءات سريعة</h3><div class="row"><button class="ghost" onclick="showTab(\\'groups\\')">⚙️ إدارة الجروبات</button><button class="ghost" onclick="showTab(\\'monitor\\')">📡 المراقبة المباشرة</button><button class="ghost" onclick="showTab(\\'analytics\\')">📊 التحليلات</button><button class="ghost" onclick="showTab(\\'system\\')">🖥 النظام</button></div></div>'; }

async function broadcastAll(){
  const text=document.getElementById('bcAll').value.trim();
  const target=document.getElementById('bcTarget').value;
  if(!text)return alert('اكتب نص الرسالة أولاً.');
  const label=target==='groups'?'الجروبات':target==='channels'?'القنوات':'الجروبات والقنوات';
  if(!confirm('إرسال الرسالة لكل '+label+'؟ ما في تراجع.'))return;
  const el=document.getElementById('bcResult'); el.textContent='⏳ جاري الإرسال للكل... لا تغلق الصفحة.';
  const r=await api('/broadcast',{method:'POST',body:JSON.stringify({text,target})});
  if(r&&r.ok){ el.innerHTML='✅ تم الإرسال: <b>'+r.sent+'</b> نجحت، '+r.failed+' فشلت (من '+r.total+' محادثة).'; document.getElementById('bcAll').value=''; }
  else el.textContent='⚠️ تعذّر الإرسال.';
}

/* ---- Groups ---- */
async function loadGroups(){ const chats=await api('/chats'); const c=document.getElementById('content');
  c.innerHTML='<div class="grid2"><div class="card" style="max-width:280px"><h3 style="margin-top:0">الجروبات</h3><div id="chatList">'+(chats.length?chats.map(x=>'<div class="chat-item" onclick="selChat(\\''+x.id+'\\',this)">'+esc(cleanName(x.title)||x.id)+'<div class="muted">'+x.type+'</div></div>').join(''):'<p class="muted">لا جروبات</p>')+'</div></div><div class="card" id="gpanel"><p class="muted">اختر جروباً.</p></div></div>'; }

const TOGGLES=[['welcomeEnabled','الترحيب'],['captchaEnabled','CAPTCHA'],['antispamEnabled','مكافحة السبام'],['antiLinkEnabled','منع الروابط'],['filtersEnabled','الكلمات الممنوعة'],['moderationEnabled','فحص AI'],['repliesEnabled','الردود'],['gamesEnabled','الألعاب'],['economyEnabled','الاقتصاد'],['xpEnabled','النقاط'],['cleanServiceEnabled','حذف رسائل الانضمام'],['antiRaidEnabled','مكافحة الغارات'],['weeklyReportEnabled','التقرير الأسبوعي'],['qotdEnabled','سؤال اليوم'],['athkarEnabled','الأذكار التلقائية'],['dailyAyahEnabled','آية اليوم'],['prayerNotifyEnabled','تنبيه الصلاة'],['aiEnabled','الذكاء الاصطناعي']];
function selChat(id,node){ current=id; document.querySelectorAll('.chat-item').forEach(n=>n.classList.remove('active')); if(node)node.classList.add('active');
  document.getElementById('gpanel').innerHTML='<div class="row" style="margin:0 0 10px"><button class="act" id="gtabC" onclick="groupChat(\\''+id+'\\')">💬 المحادثة</button><button class="ghost" id="gtabS" onclick="groupSettings(\\''+id+'\\')">⚙️ الإعدادات</button></div><div id="gbody"><p class="muted">جاري التحميل...</p></div>';
  groupChat(id); }
function gtab(chat){ const c=document.getElementById('gtabC'),s=document.getElementById('gtabS'); if(c)c.className=chat?'act':'ghost'; if(s)s.className=chat?'ghost':'act'; }
async function groupChat(id){ current=id; gtab(true); const rows=await api('/monitor?chatId='+id+'&limit=150'); rows.reverse();
  const b=document.getElementById('gbody'); if(!b)return;
  let html='',lastDay='',lastUid='';
  for(const r of rows){ const d=new Date(r.createdAt), day=d.toLocaleDateString('ar');
    if(day!==lastDay){ html+='<div class="daysep">'+day+'</div>'; lastDay=day; lastUid=''; }
    const tm=d.toLocaleTimeString('ar',{hour:'2-digit',minute:'2-digit'});
    const uid=String(r.userId), col=uColor(uid), nm=cleanName(r.userName)||uid;
    const rep=r.replyToName?'<div class="greply">↩️ رداً على '+esc(cleanName(r.replyToName))+'</div>':'';
    const body=msgBody(r);
    const head=uid!==lastUid?'<div class="ghead"><span class="gavatar" style="background:'+col+'">'+esc(cleanName(nm).charAt(0)||'?')+'</span><span class="gname" style="color:'+col+'">'+esc(nm)+'</span><span class="guid">'+esc(uid)+'</span></div>':'';
    lastUid=uid;
    html+='<div class="gmsg"'+(head?'':' style="margin-top:1px"')+'>'+head+'<div class="gbubble" style="border-right:3px solid '+col+'">'+rep+'<div class="gtext">'+body+'</div><div class="btime">'+tm+(r.flagged?' 🚩':'')+'</div></div></div>';
  }
  b.innerHTML='<div class="chat-body gfeed" style="height:60vh;border-radius:10px">'+(html||'<div class="center muted">لا رسائل في هذا الجروب بعد.</div>')+'</div>';
  const cb=b.querySelector('.chat-body'); if(cb)cb.scrollTop=cb.scrollHeight; }
async function groupSettings(id){ current=id; gtab(false);
  const [s,st,rep,fil,rd]=await Promise.all([api('/chats/'+id+'/settings'),api('/chats/'+id+'/stats'),api('/chats/'+id+'/replies'),api('/chats/'+id+'/filters'),api('/chats/'+id+'/roles')]);
  const tog=TOGGLES.map(([k,l])=>'<div class="toggle"><span>'+l+'</span><label class="switch"><input type="checkbox" '+(s[k]?'checked':'')+' onchange="setTog(\\''+k+'\\',this.checked)"><span class="slider"></span></label></div>').join('');
  const top=(st.top||[]).slice(0,5).map((m,i)=>(i+1)+'. '+esc(m.name)+' — '+m.messages+' 💬').join('<br>')||'-';
  const rl=rep.map(r=>'<span class="pill">'+esc(r.trigger)+' <button class="del" onclick="delRep(\\''+encodeURIComponent(r.trigger)+'\\')">×</button></span>').join('')||'<span class="muted">لا شيء</span>';
  const fl=fil.map(f=>'<span class="pill">'+esc(f.word)+' <button class="del" onclick="delFil(\\''+encodeURIComponent(f.word)+'\\')">×</button></span>').join('')||'<span class="muted">لا شيء</span>';
  const RBADGE={owner:'👑 مالك',manager:'🔰 مدير',admin:'🛡 أدمن',vip:'💎 مميّز'};
  const rolesHtml=(rd&&rd.roles||[]).map(r=>'<span class="pill">'+esc(cleanName(r.name)||r.userId)+' — '+(RBADGE[r.role]||r.role)+' <button class="del" onclick="delRole(\\''+r.userId+'\\')">×</button></span>').join('')||'<span class="muted">لا رتب مخصّصة بعد</span>';
  const roleOpts=Object.keys(RBADGE).map(k=>'<option value="'+k+'">'+RBADGE[k]+'</option>').join('');
  const b=document.getElementById('gbody'); if(!b)return;
  b.innerHTML='<h3 style="margin-top:0">📊 الإحصائيات</h3><div class="stat"><div class="box"><b>'+st.members+'</b>أعضاء</div><div class="box"><b>'+st.messages+'</b>رسائل</div></div><div class="muted" style="margin-top:8px">الأكثر نشاطاً:<br>'+top+'</div>'
   +'<h3>📣 إرسال رسالة للجروب</h3><div class="row"><input id="bc" placeholder="نص الرسالة"><button class="act" onclick="broadcast()">إرسال</button></div>'
   +'<h3>⚙️ الإعدادات</h3>'+tog
   +'<h3>📜 القوانين</h3><textarea id="rules" rows="2">'+esc(s.rules||'')+'</textarea><div class="row"><button class="act" onclick="saveRules()">حفظ</button></div>'
   +'<h3>💬 الردود</h3>'+rl+'<div class="row"><input id="rt" placeholder="محفّز"><input id="rr" placeholder="رد"><button class="act" onclick="addRep()">+</button></div>'
   +'<h3>🚫 الكلمات الممنوعة</h3>'+fl+'<div class="row"><input id="fw" placeholder="كلمة"><button class="act" onclick="addFil()">+</button></div>'
   +'<h3>🛡 صلاحيات الأدمن (الرتب)</h3>'+rolesHtml
   +'<div class="row"><input id="ruid" placeholder="آيدي العضو (User ID)"><input id="rname" placeholder="الاسم (اختياري)"><select id="rsel">'+roleOpts+'</select><button class="act" onclick="addRole()">رفع</button></div>'
   +'<p class="muted">💡 كل رتبة تقدر تستخدم أوامر رتبتها وما تحتها. آيدي العضو بتلاقيه بتبويب «المراقبة» أو «السجلات».</p>'; }
async function setTog(k,v){ await api('/chats/'+current+'/settings',{method:'PATCH',body:JSON.stringify({[k]:v})}); }
async function saveRules(){ await api('/chats/'+current+'/settings',{method:'PATCH',body:JSON.stringify({rules:document.getElementById('rules').value})}); alert('تم'); }
async function broadcast(){ const t=document.getElementById('bc').value.trim(); if(!t)return; const r=await api('/chats/'+current+'/broadcast',{method:'POST',body:JSON.stringify({text:t})}); alert(r.ok?'تم الإرسال':'فشل'); document.getElementById('bc').value=''; }
async function addRep(){ const trigger=document.getElementById('rt').value.trim(),resp=document.getElementById('rr').value.trim(); if(!trigger||!resp)return; await api('/chats/'+current+'/replies',{method:'POST',body:JSON.stringify({trigger,responses:[resp]})}); refreshChat(); }
async function delRep(t){ await api('/chats/'+current+'/replies/'+t,{method:'DELETE'}); refreshChat(); }
async function addFil(){ const w=document.getElementById('fw').value.trim(); if(!w)return; await api('/chats/'+current+'/filters',{method:'POST',body:JSON.stringify({word:w})}); refreshChat(); }
async function delFil(w){ await api('/chats/'+current+'/filters/'+w,{method:'DELETE'}); refreshChat(); }
async function addRole(){ const userId=document.getElementById('ruid').value.trim(),role=document.getElementById('rsel').value,name=document.getElementById('rname').value.trim(); if(!userId)return alert('اكتب آيدي العضو (رقم).'); const r=await api('/chats/'+current+'/roles',{method:'POST',body:JSON.stringify({userId,role,name})}); if(r.ok)refreshChat(); else alert('آيدي غير صحيح — لازم يكون رقم.'); }
async function delRole(uid){ if(!confirm('سحب رتبة هذا العضو؟'))return; await api('/chats/'+current+'/roles/'+uid,{method:'DELETE'}); refreshChat(); }
function refreshChat(){ if(current)groupSettings(current); }

/* ---- Monitor (live) ---- */
async function loadMonitor(){ document.getElementById('content').innerHTML='<div class="card"><h3 style="margin-top:0">📡 المراقبة المباشرة</h3><p class="muted">آخر الرسائل (تحديث تلقائي كل 5 ثوان). يتطلب MESSAGE_LOG_ENABLED=true.</p><div id="mon"></div></div>'; await tickMon(); monTimer=setInterval(tickMon,5000); }
async function tickMon(){ const rows=await api('/monitor?limit=60'); const el=document.getElementById('mon'); if(!el)return;
  el.innerHTML='<table><tr><th>الوقت</th><th>الجروب</th><th>المستخدم</th><th>النوع</th><th>الرسالة</th></tr>'+rows.map(r=>'<tr><td>'+new Date(r.createdAt).toLocaleTimeString('ar')+'</td><td>'+esc(cleanName(r.chatTitle)||r.chatId)+'</td><td>'+esc(cleanName(r.userName)||r.userId)+'<br><span class="muted">'+r.userId+'</span></td><td>'+r.type+'</td><td>'+esc((r.text||'').slice(0,80))+'</td></tr>').join('')+'</table>'+(rows.length?'':'<p class="muted">لا سجلّات بعد.</p>'); }

/* ---- Chats (WhatsApp/Telegram-style) ---- */
let convUid=null, convName='';
function initial(s){ return esc((cleanName(s||'?').trim().charAt(0))||'?'); }
async function loadUsers(){ const users=await api('/users'); const c=document.getElementById('content');
  const items=users.length?users.map(u=>'<div class="chatlist-item" onclick="openConv(\\''+u.userId+'\\',this)"><div class="avatar">'+initial(u.name)+'</div><div class="ci-main"><div class="ci-name">'+esc(cleanName(u.name)||u.userId)+'</div><div class="ci-sub">'+u.count+' رسالة</div></div><div class="ci-time">'+(u.last?new Date(u.last).toLocaleDateString('ar'):'')+'</div></div>').join(''):'<p class="muted" style="padding:12px">لا محادثات خاصة بعد. رسائل الجروبات تظهر في تبويبَي «الجروبات» و«المراقبة».</p>';
  c.innerHTML='<div class="grid2"><div class="card" style="max-width:330px;padding:8px"><h3 style="padding:4px 6px 6px;margin:0">💬 المحادثات</h3><div id="uList">'+items+'</div></div><div class="card" id="convPanel" style="padding:0;overflow:hidden"><div class="center muted" style="padding:70px 20px">اختر محادثة من القائمة</div></div></div>'; }
async function openConv(uid,node){ document.querySelectorAll('#uList .chatlist-item').forEach(n=>n.classList.remove('active')); if(node)node.classList.add('active');
  convUid=uid; convName=node?node.querySelector('.ci-name').textContent:uid;
  document.getElementById('convPanel').innerHTML='<div class="chat">'
   +'<div class="chat-head"><button class="iconbtn" onclick="backToList()" title="رجوع">▶</button><div class="avatar" style="width:38px;height:38px;font-size:15px">'+initial(convName)+'</div><div style="flex:1;min-width:0"><div class="ch-name">'+esc(convName)+'</div><div class="ch-sub">'+esc(uid)+'</div></div><button class="iconbtn" onclick="toggleSearch()">🔍</button><button class="iconbtn" onclick="exportConv()">📥</button></div>'
   +'<div id="convSearch" style="display:none;padding:8px 12px;border-bottom:1px solid var(--line)"><input id="convQ" placeholder="بحث في المحادثة..." onkeydown="if(event.key===\\'Enter\\')renderConv()" style="width:100%"></div>'
   +'<div class="chat-body" id="convBody"></div>'
   +'<div class="chat-input"><input id="convMsg" placeholder="اكتب رسالة تُرسل من البوت..." onkeydown="if(event.key===\\'Enter\\')sendDM()"><button class="sendbtn" onclick="sendDM()">➤</button></div>'
   +'</div>';
  document.getElementById('convPanel').scrollIntoView({behavior:'smooth',block:'start'});
  renderConv(); }
function backToList(){ const l=document.getElementById('uList'); if(l)l.scrollIntoView({behavior:'smooth',block:'start'}); }
function toggleSearch(){ const s=document.getElementById('convSearch'); if(!s)return; const show=s.style.display==='none'; s.style.display=show?'block':'none'; if(show)document.getElementById('convQ').focus(); else{ document.getElementById('convQ').value=''; renderConv(); } }
async function renderConv(){ if(!convUid)return; const q=document.getElementById('convQ'); const term=q?q.value.trim():'';
  const rows=await api('/users/'+convUid+'/conversation?limit=300'+(term?'&q='+encodeURIComponent(term):'')); rows.reverse();
  let html='',lastDay='';
  for(const r of rows){ const d=new Date(r.createdAt), day=d.toLocaleDateString('ar');
    if(day!==lastDay){ html+='<div class="daysep">'+day+'</div>'; lastDay=day; }
    const out=r.outgoing, tm=d.toLocaleTimeString('ar',{hour:'2-digit',minute:'2-digit'});
    const grp=(r.chatTitle&&r.chatTitle!=='خاص (البوت)')?'<div class="muted" style="font-size:10px;margin-bottom:1px">'+esc(r.chatTitle)+'</div>':'';
    const body=msgBody(r);
    html+='<div class="bubble '+(out?'out':'in')+'">'+grp+body+'<div class="btime">'+tm+(r.flagged?' 🚩':'')+'</div></div>';
  }
  const b=document.getElementById('convBody'); if(b){ b.innerHTML=html||'<div class="center muted">لا رسائل</div>'; b.scrollTop=b.scrollHeight; } }
async function exportConv(){ const rows=await api('/users/'+convUid+'/conversation?limit=500'); rows.reverse();
  const txt=rows.map(r=>'['+new Date(r.createdAt).toLocaleString('ar')+'] '+(r.outgoing?'البوت':(r.userName||convUid))+' ('+esc(r.chatTitle||r.chatId)+'): '+(r.text||'['+r.type+']')).join('\\n');
  const blob=new Blob([txt],{type:'text/plain;charset=utf-8'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='conversation-'+convUid+'.txt'; a.click(); URL.revokeObjectURL(a.href); }
async function sendDM(){ const el=document.getElementById('convMsg'); const t=el.value.trim(); if(!t)return; const r=await api('/users/'+convUid+'/message',{method:'POST',body:JSON.stringify({text:t})});
  if(r.ok){ el.value=''; renderConv(); } else alert(r.hint||'تعذّر الإرسال (لم يبدأ المستخدم محادثة البوت).'); }

/* ---- Musaraha (anonymous messages) ---- */
async function loadMusaraha(){ const rows=await api('/musaraha?limit=100');
  const body=rows.length?rows.map(r=>'<tr><td>'+new Date(r.createdAt).toLocaleString('ar')+'</td><td>'+esc(r.senderName||String(r.senderId))+'<br><span class="muted">'+r.senderId+'</span></td><td>'+r.recipientId+'</td><td>'+(r.isReply?'↩️ رد':'📩')+'</td><td>'+esc((r.text||'').slice(0,140))+'</td></tr>').join(''):'';
  document.getElementById('content').innerHTML='<div class="card"><h3 style="margin-top:0">💌 سجل المصارحة</h3><p class="muted">الرسائل المجهولة عبر البوت — هوية المرسِل مكشوفة لك كمالك فقط لأغراض الرقابة.</p><table><tr><th>الوقت</th><th>المرسِل</th><th>المستقبِل</th><th>النوع</th><th>النص</th></tr>'+body+'</table>'+(rows.length?'':'<p class="muted">لا رسائل بعد.</p>')+'</div>'; }

/* ---- Whispers (همسات) ---- */
async function loadWhispers(){ const rows=await api('/whispers?limit=100');
  const body=rows.length?rows.map(r=>'<tr><td>'+new Date(r.createdAt).toLocaleString('ar')+'</td>'
    +'<td>'+esc(cleanName(r.senderName)||r.senderId)+'<br><span class="muted">'+r.senderId+'</span></td>'
    +'<td>'+esc(cleanName(r.targetName)||r.targetId)+'<br><span class="muted">'+r.targetId+'</span></td>'
    +'<td>'+esc(cleanName(r.chatTitle)||r.chatId)+'</td>'
    +'<td>'+esc(r.text||'')+'</td></tr>').join(''):'';
  document.getElementById('content').innerHTML='<div class="card"><h3 style="margin-top:0">🤫 سجل الهمسات</h3><p class="muted">الهمسات السرية داخل الجروبات — محتواها ومن أرسلها لمن، مكشوف لك كمالك فقط لأغراض الرقابة.</p><table><tr><th>الوقت</th><th>من</th><th>إلى</th><th>الجروب</th><th>الهمسة</th></tr>'+body+'</table>'+(rows.length?'':'<p class="muted">لا همسات بعد.</p>')+'</div>'; }

/* ---- Media ---- */
async function loadMedia(type){ const rows=await api('/media?limit=60'+(type?'&type='+type:'')); const types=['','photo','video','voice','audio','animation','sticker','document'];
  const filt=types.map(t=>'<button class="'+(t===type?'act':'ghost')+'" onclick="loadMedia(\\''+t+'\\')">'+(t||'الكل')+'</button>').join(' ');
  const items=rows.map(r=>'<div class="media-item"><div class="thumb" onclick="openMedia('+r.id+')">'+mediaIcon(r.type)+'</div><div class="muted">'+esc((r.chatTitle||'').slice(0,14))+'</div></div>').join('')||'<p class="muted">لا وسائط.</p>';
  document.getElementById('content').innerHTML='<div class="card"><h3 style="margin-top:0">🖼 الوسائط</h3><div class="row">'+filt+'</div><div>'+items+'</div></div>'; }
function mediaIcon(t){ return {photo:'🖼',video:'🎬',voice:'🎤',audio:'🎵',animation:'🎞',sticker:'🩷',document:'📎'}[t]||'📄'; }
/* Called when an inline image/video can't be decoded (e.g. animated .tgs
   sticker or an expired/oversized file) — swap it back to the icon+label. */
function mediaFail(el){ const t=el.getAttribute('data-t')||''; el.outerHTML='<span class="muted">'+mediaIcon(t)+' '+t+'</span>'; }
/* Render one logged message body: media shows inline (photo/sticker as image,
   video/audio with a player), text as text, with any caption underneath. */
function msgBody(r){ const t=r.type, id=r.id, cap=r.text?'<div class="gcap">'+esc(r.text)+'</div>':'';
  if(t==='photo'||t==='sticker'||t==='animation') return '<img class="gmedia" loading="lazy" data-t="'+t+'" src="/api/media/'+id+'/raw" onclick="window.open(this.src)" onerror="mediaFail(this)">'+cap;
  if(t==='video') return '<video class="gmedia" controls preload="none" data-t="video" src="/api/media/'+id+'/raw" onerror="mediaFail(this)"></video>'+cap;
  if(t==='voice'||t==='audio') return '<audio controls preload="none" src="/api/media/'+id+'/raw" style="width:230px;max-width:100%"></audio>'+cap;
  if(t==='document') return '<a class="muted" href="/api/media/'+id+'/raw" target="_blank" rel="noopener">📎 '+esc(r.text||'ملف')+'</a>';
  if(r.text) return esc(r.text);
  return '<span class="muted">'+mediaIcon(t)+' '+t+'</span>'; }
async function openMedia(id){ const r=await api('/media/'+id+'/link'); if(r.url)window.open(r.url,'_blank'); else alert('تعذّر (الملف أكبر من 20MB أو منتهي).'); }

/* ---- Logs / Search ---- */
function loadLogsForm(){ document.getElementById('content').innerHTML='<div class="card"><h3 style="margin-top:0">🔎 بحث السجلات</h3><div class="row"><input id="lq" placeholder="كلمة"><input id="lu" placeholder="User ID"><input id="lc" placeholder="Chat ID"></div><div class="row"><select id="lt"><option value="">كل الأنواع</option><option>text</option><option>photo</option><option>video</option><option>edit</option><option>sticker</option></select><label class="muted"><input type="checkbox" id="lf" style="flex:none"> المخالفة فقط</label><button class="act" onclick="doSearch()">بحث</button></div><div id="lres"></div></div>'; }
async function doSearch(){ const q=new URLSearchParams({q:document.getElementById('lq').value,userId:document.getElementById('lu').value,chatId:document.getElementById('lc').value,type:document.getElementById('lt').value,flagged:document.getElementById('lf').checked?'true':'',limit:'80'}); const rows=await api('/logs?'+q);
  document.getElementById('lres').innerHTML='<table><tr><th>الوقت</th><th>الجروب</th><th>المستخدم</th><th>النوع</th><th>النص</th></tr>'+rows.map(r=>'<tr><td>'+new Date(r.createdAt).toLocaleString('ar')+'</td><td>'+esc(cleanName(r.chatTitle)||r.chatId)+'</td><td>'+esc(cleanName(r.userName)||r.userId)+'</td><td>'+r.type+(r.flagged?' 🚩':'')+'</td><td>'+esc((r.text||'').slice(0,100))+'</td></tr>').join('')+'</table>'+(rows.length?'':'<p class="muted">لا نتائج.</p>'); }

/* ---- Analytics ---- */
async function loadAnalytics(){ const a=await api('/analytics'); const list=(arr,f)=>arr.map((x,i)=>(i+1)+'. '+f(x)).join('<br>')||'-';
  document.getElementById('content').innerHTML='<div class="grid2">'
   +'<div class="card"><h3 style="margin-top:0">🏆 أنشط الجروبات</h3>'+list(a.topGroups,x=>esc(x.title)+' — '+x.count)+'</div>'
   +'<div class="card"><h3 style="margin-top:0">👤 أنشط الأعضاء</h3>'+list(a.topUsers,x=>esc(x.name)+' — '+x.count)+'</div>'
   +'<div class="card"><h3 style="margin-top:0">📦 أنواع الرسائل</h3>'+list(a.topTypes,x=>x.type+' — '+x.count)+'</div>'
   +'<div class="card"><h3 style="margin-top:0">🔤 أكثر الكلمات</h3>'+list(a.topWords,x=>esc(x.word)+' — '+x.count)+'</div></div>'; }

/* ---- System ---- */
async function loadSystem(){ const s=await api('/system');
  document.getElementById('content').innerHTML='<div class="card"><h3 style="margin-top:0">🖥 النظام</h3><div class="stat"><div class="box"><b>'+Math.floor(s.uptimeSec/3600)+'h</b>التشغيل</div><div class="box"><b>'+s.memory.rssMB+'</b>MB ذاكرة</div><div class="box"><b>'+s.cpus+'</b>أنوية</div><div class="box"><b>'+s.queue.running+'/'+s.queue.pending+'</b>طابور</div></div>'
   +'<p class="muted">Node '+s.node+' · Load '+s.loadavg.join(' / ')+'</p>'
   +'<div class="row"><button class="ghost" onclick="clearCache()">تنظيف الكاش</button><button class="del" onclick="doRestart()">إعادة تشغيل البوت</button></div>'
   +'<h3>⚠️ آخر الأخطاء</h3>'+(s.errors.length?s.errors.map(e=>'<div class="err">'+new Date(e.time).toLocaleTimeString('ar')+' — '+esc(e.message)+'</div>').join(''):'<span class="muted">لا أخطاء 🎉</span>')+'</div>'; }
async function clearCache(){ await api('/system/clearcache',{method:'POST'}); alert('تم'); loadSystem(); }
async function doRestart(){ if(!confirm('إعادة تشغيل البوت؟'))return; await api('/system/restart',{method:'POST'}); alert('يعاد التشغيل...'); }

/* ---- Audit ---- */
async function loadAudit(){ const rows=await api('/audit');
  document.getElementById('content').innerHTML='<div class="card"><h3 style="margin-top:0">🛡 سجل التدقيق</h3><table><tr><th>الوقت</th><th>المالك</th><th>الإجراء</th><th>التفاصيل</th></tr>'+rows.map(r=>'<tr><td>'+new Date(r.createdAt).toLocaleString('ar')+'</td><td>'+r.actorId+'</td><td>'+esc(r.action)+'</td><td>'+esc(r.details||'')+'</td></tr>').join('')+'</table>'+(rows.length?'':'<p class="muted">لا عمليات بعد.</p>')+'</div>'; }

boot();
</script>
</body>
</html>`;
