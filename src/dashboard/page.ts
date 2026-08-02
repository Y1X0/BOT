/** Self-contained Super Admin dashboard SPA served at /dashboard. */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>لوحة تحكم البوت</title>
<style>
  :root { --bg:#0e1015; --card:#161922; --soft:#0f1219; --line:#232735; --fg:#e8eaf0; --muted:#868c9e; --accent:#7c6cf0; --ok:#34d399; --bad:#f87171; --user:#141824; --botmsg:#17251b; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:system-ui,'Segoe UI',Tahoma,sans-serif; background:var(--bg); color:var(--fg); font-size:14px; line-height:1.5; }
  header { padding:11px 16px; border-bottom:1px solid var(--line); display:flex; align-items:center; justify-content:space-between; gap:10px; }
  header h1 { font-size:15px; font-weight:600; margin:0; }
  nav { display:flex; gap:6px; padding:9px 12px; border-bottom:1px solid var(--line); overflow-x:auto; position:sticky; top:0; background:var(--bg); z-index:5; }
  nav::-webkit-scrollbar { display:none; }
  nav button { background:transparent; border:1px solid var(--line); color:var(--muted); border-radius:18px; padding:5px 13px; cursor:pointer; white-space:nowrap; font-family:inherit; font-size:13px; transition:.15s; }
  nav button:hover { color:var(--fg); }
  nav button.active { background:var(--accent); color:#fff; border-color:var(--accent); }
  .page { padding:14px; max-width:920px; margin:0 auto; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px; margin-bottom:12px; }
  .card h3 { font-size:14px; font-weight:600; margin:0 0 10px; }
  .card h3:not(:first-child) { margin-top:16px; }
  .muted { color:var(--muted); font-size:12.5px; }
  .row { display:flex; gap:8px; margin:8px 0; flex-wrap:wrap; align-items:center; }
  input,textarea,select { background:var(--soft); border:1px solid var(--line); color:var(--fg); border-radius:9px; padding:9px 11px; font-family:inherit; font-size:13.5px; outline:none; transition:border-color .15s; }
  input:focus,textarea:focus,select:focus { border-color:var(--accent); }
  input,textarea { flex:1; min-width:0; }
  button { font-family:inherit; font-size:13.5px; }
  button.act { background:var(--accent); color:#fff; border:none; border-radius:9px; padding:9px 15px; cursor:pointer; font-weight:500; }
  button.act:hover { filter:brightness(1.1); }
  button.ghost { background:transparent; border:1px solid var(--line); color:var(--fg); border-radius:9px; padding:9px 14px; cursor:pointer; }
  button.ghost:hover { background:var(--soft); }
  button.del { background:transparent; color:var(--bad); border:1px solid var(--line); border-radius:7px; padding:3px 9px; cursor:pointer; font-size:13px; }
  .toggle { display:flex; align-items:center; justify-content:space-between; padding:9px 0; border-bottom:1px solid var(--line); }
  .toggle:last-child { border-bottom:none; }
  .switch { position:relative; width:42px; height:23px; flex-shrink:0; }
  .switch input { display:none; }
  .slider { position:absolute; inset:0; background:#333846; border-radius:20px; cursor:pointer; transition:.2s; }
  .slider:before { content:''; position:absolute; width:17px; height:17px; right:3px; top:3px; background:#fff; border-radius:50%; transition:.2s; }
  input:checked + .slider { background:var(--accent); }
  input:checked + .slider:before { transform:translateX(-19px); }
  .chat-item { padding:9px 11px; border-radius:9px; cursor:pointer; border:1px solid transparent; transition:.12s; }
  .chat-item:hover { background:var(--soft); }
  .chat-item.active { background:var(--soft); border-color:var(--accent); }
  .grid2 { display:flex; gap:12px; flex-wrap:wrap; align-items:flex-start; }
  .grid2 > * { flex:1; min-width:260px; margin-bottom:0; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; }
  td,th { text-align:right; padding:7px 8px; border-bottom:1px solid var(--line); }
  tr:last-child td { border-bottom:none; }
  th { color:var(--muted); font-weight:500; }
  .pill { display:inline-flex; align-items:center; gap:6px; background:var(--soft); border:1px solid var(--line); border-radius:8px; padding:5px 10px; margin:0 0 6px 6px; font-size:13px; }
  .box { background:var(--soft); border:1px solid var(--line); border-radius:11px; padding:13px 10px; text-align:center; flex:1; min-width:70px; }
  .box b { font-size:19px; display:block; margin-bottom:2px; }
  .box span,.box { font-size:12px; color:var(--muted); }
  .box b { color:var(--fg); }
  .stat { display:flex; gap:10px; flex-wrap:wrap; }
  .media-item { display:inline-block; width:110px; vertical-align:top; margin:4px; text-align:center; }
  .media-item .thumb { width:110px; height:82px; background:var(--soft); border:1px solid var(--line); border-radius:9px; display:flex; align-items:center; justify-content:center; font-size:30px; cursor:pointer; overflow:hidden; }
  .media-item .thumb:hover { border-color:var(--accent); }
  .media-item img { max-width:100%; max-height:100%; }
  .center { text-align:center; padding:60px 20px; }
  .err { color:var(--bad); font-size:12px; margin:3px 0; }
  .thread { display:flex; flex-direction:column; gap:8px; max-height:58vh; overflow:auto; padding:2px; }
  .msg { max-width:85%; padding:8px 11px; border-radius:13px; border:1px solid var(--line); }
  .msg .meta { font-size:10.5px; color:var(--muted); margin-bottom:3px; }
  .msg.in { align-self:flex-start; background:var(--user); border-bottom-right-radius:4px; }
  .msg.out { align-self:flex-end; background:var(--botmsg); border-bottom-left-radius:4px; }
  /* WhatsApp/Telegram-style chat UI */
  .avatar { width:42px; height:42px; border-radius:50%; background:linear-gradient(135deg,#7c6cf0,#5b4bd6); display:flex; align-items:center; justify-content:center; font-weight:600; color:#fff; flex-shrink:0; font-size:16px; }
  .chatlist-item { display:flex; gap:10px; align-items:center; padding:9px 8px; border-radius:10px; cursor:pointer; border:1px solid transparent; }
  .chatlist-item:hover { background:var(--soft); }
  .chatlist-item.active { background:var(--soft); border-color:var(--accent); }
  .ci-main { flex:1; min-width:0; }
  .ci-name { font-size:14px; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .ci-sub { font-size:12px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .ci-time { font-size:10.5px; color:var(--muted); flex-shrink:0; align-self:flex-start; }
  .chat { display:flex; flex-direction:column; height:72vh; min-height:430px; }
  .chat-head { display:flex; align-items:center; gap:10px; padding:9px 12px; border-bottom:1px solid var(--line); background:var(--card); }
  .ch-name { font-size:14px; font-weight:600; }
  .ch-sub { font-size:11px; color:var(--muted); }
  .iconbtn { background:transparent; border:none; color:var(--muted); font-size:17px; cursor:pointer; padding:5px 7px; border-radius:8px; }
  .iconbtn:hover { background:var(--soft); color:var(--fg); }
  .chat-body { flex:1; overflow-y:auto; padding:14px 12px; background:#0b1016; display:flex; flex-direction:column; gap:3px; }
  .daysep { align-self:center; background:#1b2029; color:var(--muted); font-size:11px; padding:3px 11px; border-radius:10px; margin:9px 0; }
  .bubble { max-width:82%; padding:6px 10px; border-radius:12px; font-size:14px; line-height:1.45; word-break:break-word; box-shadow:0 1px 1px rgba(0,0,0,.25); }
  .bubble.in { align-self:flex-start; background:#212b36; border-top-left-radius:3px; }
  .bubble.out { align-self:flex-end; background:#0f5c47; border-top-right-radius:3px; }
  .bubble .btime { font-size:9.5px; color:rgba(255,255,255,.5); margin-top:2px; text-align:left; }
  .chat-input { display:flex; gap:8px; align-items:center; padding:9px 10px; border-top:1px solid var(--line); background:var(--card); }
  .chat-input input { flex:1; border-radius:20px; padding:10px 15px; }
  .sendbtn { width:40px; height:40px; border-radius:50%; border:none; background:var(--accent); color:#fff; font-size:16px; cursor:pointer; flex-shrink:0; }
  .sendbtn:hover { filter:brightness(1.1); }
</style>
</head>
<body>
<header><h1>🦋 لوحة تحكم البوت — Super Admin</h1><span id="hdr"></span></header>

<div id="login" class="center" style="display:none">
  <div class="card" style="max-width:420px;margin:0 auto"><h2>تسجيل الدخول</h2>
  <p class="muted">بحساب تيليجرام (المالك فقط).</p><div id="tg-btn"></div>
  <p class="muted err" id="loginNote"></p></div>
</div>

<div id="app" style="display:none">
  <nav id="nav"></nav>
  <div class="page" id="content"></div>
</div>

<script>
const api=(p,o={})=>fetch('/api'+p,{credentials:'include',headers:{'Content-Type':'application/json'},...o}).then(r=>r.json());
const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const TABS=[['groups','الجروبات'],['monitor','المراقبة'],['users','المحادثات'],['media','الوسائط'],['logs','السجلات'],['analytics','التحليلات'],['system','النظام'],['audit','التدقيق']];
let current=null, tab='groups', monTimer=null;

async function boot(){ const me=await api('/me');
  if(me.authenticated){ document.getElementById('app').style.display='block'; document.getElementById('hdr').innerHTML='<button class="ghost" onclick="logout()">خروج</button>'; renderNav(); showTab('groups'); }
  else showLogin(); }

function renderNav(){ document.getElementById('nav').innerHTML=TABS.map(([k,l])=>'<button id="t-'+k+'" class="'+(k===tab?'active':'')+'" onclick="showTab(\\''+k+'\\')">'+l+'</button>').join(''); }
function showTab(t){ tab=t; if(monTimer){clearInterval(monTimer);monTimer=null;} renderNav();
  ({groups:loadGroups,monitor:loadMonitor,users:loadUsers,media:()=>loadMedia(''),logs:loadLogsForm,analytics:loadAnalytics,system:loadSystem,audit:loadAudit}[t])(); }

async function showLogin(){ document.getElementById('login').style.display='block'; const c=await api('/config');
  if(!c.botUsername){document.getElementById('loginNote').textContent='⚠️ BOT_USERNAME غير مضبوط.';return;}
  window.onTelegramAuth=async u=>{const r=await api('/auth/telegram',{method:'POST',body:JSON.stringify(u)}); if(r.ok)location.reload(); else document.getElementById('loginNote').textContent=r.error==='not_owner'?'هذا الحساب ليس المالك.':'فشل الدخول.';};
  const s=document.createElement('script'); s.async=true; s.src='https://telegram.org/js/telegram-widget.js?22';
  s.setAttribute('data-telegram-login',c.botUsername); s.setAttribute('data-size','large'); s.setAttribute('data-onauth','onTelegramAuth(user)'); document.getElementById('tg-btn').appendChild(s); }
async function logout(){ await api('/auth/logout',{method:'POST'}); location.reload(); }

/* ---- Groups ---- */
async function loadGroups(){ const chats=await api('/chats'); const c=document.getElementById('content');
  c.innerHTML='<div class="grid2"><div class="card" style="max-width:280px"><h3 style="margin-top:0">الجروبات</h3><div id="chatList">'+(chats.length?chats.map(x=>'<div class="chat-item" onclick="selChat(\\''+x.id+'\\',this)">'+esc(x.title||x.id)+'<div class="muted">'+x.type+'</div></div>').join(''):'<p class="muted">لا جروبات</p>')+'</div></div><div class="card" id="gpanel"><p class="muted">اختر جروباً.</p></div></div>'; }

const TOGGLES=[['welcomeEnabled','الترحيب'],['captchaEnabled','CAPTCHA'],['antispamEnabled','مكافحة السبام'],['antiLinkEnabled','منع الروابط'],['filtersEnabled','الكلمات الممنوعة'],['moderationEnabled','فحص AI'],['repliesEnabled','الردود'],['gamesEnabled','الألعاب'],['economyEnabled','الاقتصاد'],['xpEnabled','النقاط'],['cleanServiceEnabled','حذف رسائل الانضمام'],['antiRaidEnabled','مكافحة الغارات'],['weeklyReportEnabled','التقرير الأسبوعي'],['qotdEnabled','سؤال اليوم'],['athkarEnabled','الأذكار التلقائية'],['dailyAyahEnabled','آية اليوم'],['prayerNotifyEnabled','تنبيه الصلاة'],['aiEnabled','الذكاء الاصطناعي']];
async function selChat(id,node){ current=id; document.querySelectorAll('.chat-item').forEach(n=>n.classList.remove('active')); node.classList.add('active');
  const [s,st,rep,fil]=await Promise.all([api('/chats/'+id+'/settings'),api('/chats/'+id+'/stats'),api('/chats/'+id+'/replies'),api('/chats/'+id+'/filters')]);
  const tog=TOGGLES.map(([k,l])=>'<div class="toggle"><span>'+l+'</span><label class="switch"><input type="checkbox" '+(s[k]?'checked':'')+' onchange="setTog(\\''+k+'\\',this.checked)"><span class="slider"></span></label></div>').join('');
  const top=(st.top||[]).slice(0,5).map((m,i)=>(i+1)+'. '+esc(m.name)+' — '+m.messages+' 💬').join('<br>')||'-';
  const rl=rep.map(r=>'<span class="pill">'+esc(r.trigger)+' <button class="del" onclick="delRep(\\''+encodeURIComponent(r.trigger)+'\\')">×</button></span>').join('')||'<span class="muted">لا شيء</span>';
  const fl=fil.map(f=>'<span class="pill">'+esc(f.word)+' <button class="del" onclick="delFil(\\''+encodeURIComponent(f.word)+'\\')">×</button></span>').join('')||'<span class="muted">لا شيء</span>';
  document.getElementById('gpanel').innerHTML='<h3 style="margin-top:0">📊 الإحصائيات</h3><div class="stat"><div class="box"><b>'+st.members+'</b>أعضاء</div><div class="box"><b>'+st.messages+'</b>رسائل</div></div><div class="muted" style="margin-top:8px">الأكثر نشاطاً:<br>'+top+'</div>'
   +'<h3>📣 إرسال رسالة للجروب</h3><div class="row"><input id="bc" placeholder="نص الرسالة"><button class="act" onclick="broadcast()">إرسال</button></div>'
   +'<h3>⚙️ الإعدادات</h3>'+tog
   +'<h3>📜 القوانين</h3><textarea id="rules" rows="2">'+esc(s.rules||'')+'</textarea><div class="row"><button class="act" onclick="saveRules()">حفظ</button></div>'
   +'<h3>💬 الردود</h3>'+rl+'<div class="row"><input id="rt" placeholder="محفّز"><input id="rr" placeholder="رد"><button class="act" onclick="addRep()">+</button></div>'
   +'<h3>🚫 الكلمات الممنوعة</h3>'+fl+'<div class="row"><input id="fw" placeholder="كلمة"><button class="act" onclick="addFil()">+</button></div>'; }
async function setTog(k,v){ await api('/chats/'+current+'/settings',{method:'PATCH',body:JSON.stringify({[k]:v})}); }
async function saveRules(){ await api('/chats/'+current+'/settings',{method:'PATCH',body:JSON.stringify({rules:document.getElementById('rules').value})}); alert('تم'); }
async function broadcast(){ const t=document.getElementById('bc').value.trim(); if(!t)return; const r=await api('/chats/'+current+'/broadcast',{method:'POST',body:JSON.stringify({text:t})}); alert(r.ok?'تم الإرسال':'فشل'); document.getElementById('bc').value=''; }
async function addRep(){ const trigger=document.getElementById('rt').value.trim(),resp=document.getElementById('rr').value.trim(); if(!trigger||!resp)return; await api('/chats/'+current+'/replies',{method:'POST',body:JSON.stringify({trigger,responses:[resp]})}); refreshChat(); }
async function delRep(t){ await api('/chats/'+current+'/replies/'+t,{method:'DELETE'}); refreshChat(); }
async function addFil(){ const w=document.getElementById('fw').value.trim(); if(!w)return; await api('/chats/'+current+'/filters',{method:'POST',body:JSON.stringify({word:w})}); refreshChat(); }
async function delFil(w){ await api('/chats/'+current+'/filters/'+w,{method:'DELETE'}); refreshChat(); }
function refreshChat(){ const n=document.querySelector('.chat-item.active'); if(n)selChat(current,n); }

/* ---- Monitor (live) ---- */
async function loadMonitor(){ document.getElementById('content').innerHTML='<div class="card"><h3 style="margin-top:0">📡 المراقبة المباشرة</h3><p class="muted">آخر الرسائل (تحديث تلقائي كل 5 ثوان). يتطلب MESSAGE_LOG_ENABLED=true.</p><div id="mon"></div></div>'; await tickMon(); monTimer=setInterval(tickMon,5000); }
async function tickMon(){ const rows=await api('/monitor?limit=60'); const el=document.getElementById('mon'); if(!el)return;
  el.innerHTML='<table><tr><th>الوقت</th><th>الجروب</th><th>المستخدم</th><th>النوع</th><th>الرسالة</th></tr>'+rows.map(r=>'<tr><td>'+new Date(r.createdAt).toLocaleTimeString('ar')+'</td><td>'+esc(r.chatTitle||r.chatId)+'</td><td>'+esc(r.userName)+'<br><span class="muted">'+r.userId+'</span></td><td>'+r.type+'</td><td>'+esc((r.text||'').slice(0,80))+'</td></tr>').join('')+'</table>'+(rows.length?'':'<p class="muted">لا سجلّات بعد.</p>'); }

/* ---- Chats (WhatsApp/Telegram-style) ---- */
let convUid=null, convName='';
function initial(s){ return esc((String(s||'?').trim().charAt(0))||'?'); }
async function loadUsers(){ const users=await api('/users'); const c=document.getElementById('content');
  const items=users.length?users.map(u=>'<div class="chatlist-item" onclick="openConv(\\''+u.userId+'\\',this)"><div class="avatar">'+initial(u.name)+'</div><div class="ci-main"><div class="ci-name">'+esc(u.name)+'</div><div class="ci-sub">'+u.count+' رسالة</div></div><div class="ci-time">'+(u.last?new Date(u.last).toLocaleDateString('ar'):'')+'</div></div>').join(''):'<p class="muted" style="padding:12px">لا محادثات بعد. فعّل MESSAGE_LOG_ENABLED=true.</p>';
  c.innerHTML='<div class="grid2"><div class="card" style="max-width:330px;padding:8px"><h3 style="padding:4px 6px 6px;margin:0">💬 المحادثات</h3><div id="uList">'+items+'</div></div><div class="card" id="convPanel" style="padding:0;overflow:hidden"><div class="center muted" style="padding:70px 20px">اختر محادثة من القائمة</div></div></div>'; }
async function openConv(uid,node){ document.querySelectorAll('#uList .chatlist-item').forEach(n=>n.classList.remove('active')); if(node)node.classList.add('active');
  convUid=uid; convName=node?node.querySelector('.ci-name').textContent:uid;
  document.getElementById('convPanel').innerHTML='<div class="chat">'
   +'<div class="chat-head"><div class="avatar" style="width:38px;height:38px;font-size:15px">'+initial(convName)+'</div><div style="flex:1;min-width:0"><div class="ch-name">'+esc(convName)+'</div><div class="ch-sub">'+esc(uid)+'</div></div><button class="iconbtn" onclick="toggleSearch()">🔍</button><button class="iconbtn" onclick="exportConv()">📥</button></div>'
   +'<div id="convSearch" style="display:none;padding:8px 12px;border-bottom:1px solid var(--line)"><input id="convQ" placeholder="بحث في المحادثة..." onkeydown="if(event.key===\\'Enter\\')renderConv()" style="width:100%"></div>'
   +'<div class="chat-body" id="convBody"></div>'
   +'<div class="chat-input"><input id="convMsg" placeholder="اكتب رسالة تُرسل من البوت..." onkeydown="if(event.key===\\'Enter\\')sendDM()"><button class="sendbtn" onclick="sendDM()">➤</button></div>'
   +'</div>';
  renderConv(); }
function toggleSearch(){ const s=document.getElementById('convSearch'); if(!s)return; const show=s.style.display==='none'; s.style.display=show?'block':'none'; if(show)document.getElementById('convQ').focus(); else{ document.getElementById('convQ').value=''; renderConv(); } }
async function renderConv(){ if(!convUid)return; const q=document.getElementById('convQ'); const term=q?q.value.trim():'';
  const rows=await api('/users/'+convUid+'/conversation?limit=300'+(term?'&q='+encodeURIComponent(term):'')); rows.reverse();
  let html='',lastDay='';
  for(const r of rows){ const d=new Date(r.createdAt), day=d.toLocaleDateString('ar');
    if(day!==lastDay){ html+='<div class="daysep">'+day+'</div>'; lastDay=day; }
    const out=r.outgoing, tm=d.toLocaleTimeString('ar',{hour:'2-digit',minute:'2-digit'});
    const grp=(r.chatTitle&&r.chatTitle!=='خاص (البوت)')?'<div class="muted" style="font-size:10px;margin-bottom:1px">'+esc(r.chatTitle)+'</div>':'';
    const body=r.text?esc(r.text):('<span class="muted">'+mediaIcon(r.type)+' '+r.type+'</span>');
    html+='<div class="bubble '+(out?'out':'in')+'">'+grp+body+'<div class="btime">'+tm+(r.flagged?' 🚩':'')+'</div></div>';
  }
  const b=document.getElementById('convBody'); if(b){ b.innerHTML=html||'<div class="center muted">لا رسائل</div>'; b.scrollTop=b.scrollHeight; } }
async function exportConv(){ const rows=await api('/users/'+convUid+'/conversation?limit=500'); rows.reverse();
  const txt=rows.map(r=>'['+new Date(r.createdAt).toLocaleString('ar')+'] '+(r.outgoing?'البوت':(r.userName||convUid))+' ('+esc(r.chatTitle||r.chatId)+'): '+(r.text||'['+r.type+']')).join('\\n');
  const blob=new Blob([txt],{type:'text/plain;charset=utf-8'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='conversation-'+convUid+'.txt'; a.click(); URL.revokeObjectURL(a.href); }
async function sendDM(){ const el=document.getElementById('convMsg'); const t=el.value.trim(); if(!t)return; const r=await api('/users/'+convUid+'/message',{method:'POST',body:JSON.stringify({text:t})});
  if(r.ok){ el.value=''; renderConv(); } else alert(r.hint||'تعذّر الإرسال (لم يبدأ المستخدم محادثة البوت).'); }

/* ---- Media ---- */
async function loadMedia(type){ const rows=await api('/media?limit=60'+(type?'&type='+type:'')); const types=['','photo','video','voice','audio','animation','sticker','document'];
  const filt=types.map(t=>'<button class="'+(t===type?'act':'ghost')+'" onclick="loadMedia(\\''+t+'\\')">'+(t||'الكل')+'</button>').join(' ');
  const items=rows.map(r=>'<div class="media-item"><div class="thumb" onclick="openMedia('+r.id+')">'+mediaIcon(r.type)+'</div><div class="muted">'+esc((r.chatTitle||'').slice(0,14))+'</div></div>').join('')||'<p class="muted">لا وسائط.</p>';
  document.getElementById('content').innerHTML='<div class="card"><h3 style="margin-top:0">🖼 الوسائط</h3><div class="row">'+filt+'</div><div>'+items+'</div></div>'; }
function mediaIcon(t){ return {photo:'🖼',video:'🎬',voice:'🎤',audio:'🎵',animation:'🎞',sticker:'🩷',document:'📎'}[t]||'📄'; }
async function openMedia(id){ const r=await api('/media/'+id+'/link'); if(r.url)window.open(r.url,'_blank'); else alert('تعذّر (الملف أكبر من 20MB أو منتهي).'); }

/* ---- Logs / Search ---- */
function loadLogsForm(){ document.getElementById('content').innerHTML='<div class="card"><h3 style="margin-top:0">🔎 بحث السجلات</h3><div class="row"><input id="lq" placeholder="كلمة"><input id="lu" placeholder="User ID"><input id="lc" placeholder="Chat ID"></div><div class="row"><select id="lt"><option value="">كل الأنواع</option><option>text</option><option>photo</option><option>video</option><option>edit</option><option>sticker</option></select><label class="muted"><input type="checkbox" id="lf" style="flex:none"> المخالفة فقط</label><button class="act" onclick="doSearch()">بحث</button></div><div id="lres"></div></div>'; }
async function doSearch(){ const q=new URLSearchParams({q:document.getElementById('lq').value,userId:document.getElementById('lu').value,chatId:document.getElementById('lc').value,type:document.getElementById('lt').value,flagged:document.getElementById('lf').checked?'true':'',limit:'80'}); const rows=await api('/logs?'+q);
  document.getElementById('lres').innerHTML='<table><tr><th>الوقت</th><th>الجروب</th><th>المستخدم</th><th>النوع</th><th>النص</th></tr>'+rows.map(r=>'<tr><td>'+new Date(r.createdAt).toLocaleString('ar')+'</td><td>'+esc(r.chatTitle||r.chatId)+'</td><td>'+esc(r.userName)+'</td><td>'+r.type+(r.flagged?' 🚩':'')+'</td><td>'+esc((r.text||'').slice(0,100))+'</td></tr>').join('')+'</table>'+(rows.length?'':'<p class="muted">لا نتائج.</p>'); }

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
