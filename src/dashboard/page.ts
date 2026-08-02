/** Self-contained Super Admin dashboard SPA served at /dashboard. */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>لوحة تحكم البوت</title>
<style>
  :root { --bg:#0f1117; --card:#1a1d27; --line:#2a2e3a; --fg:#e6e8ee; --muted:#8b90a0; --accent:#7c6cf0; --ok:#34d399; --bad:#f87171; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:system-ui,'Segoe UI',Tahoma,sans-serif; background:var(--bg); color:var(--fg); }
  header { padding:14px 18px; border-bottom:1px solid var(--line); display:flex; align-items:center; justify-content:space-between; }
  header h1 { font-size:17px; margin:0; }
  nav { display:flex; gap:6px; padding:10px 14px; border-bottom:1px solid var(--line); overflow-x:auto; }
  nav button { background:transparent; border:1px solid var(--line); color:var(--muted); border-radius:20px; padding:6px 14px; cursor:pointer; white-space:nowrap; font-family:inherit; }
  nav button.active { background:var(--accent); color:#fff; border-color:var(--accent); }
  .page { padding:16px; max-width:1100px; margin:0 auto; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; margin-bottom:14px; }
  .muted { color:var(--muted); font-size:13px; }
  .row { display:flex; gap:8px; margin:6px 0; flex-wrap:wrap; }
  input,textarea,select { background:#0e1017; border:1px solid var(--line); color:var(--fg); border-radius:8px; padding:8px; font-family:inherit; }
  input,textarea { flex:1; }
  button.act { background:var(--accent); color:#fff; border:none; border-radius:8px; padding:8px 14px; cursor:pointer; font-family:inherit; }
  button.ghost { background:transparent; border:1px solid var(--line); color:var(--fg); border-radius:8px; padding:8px 14px; cursor:pointer; }
  button.del { background:transparent; color:var(--bad); border:1px solid var(--line); border-radius:6px; padding:3px 8px; cursor:pointer; }
  .toggle { display:flex; align-items:center; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--line); }
  .switch { position:relative; width:44px; height:24px; flex-shrink:0; }
  .switch input { display:none; }
  .slider { position:absolute; inset:0; background:#3a3f4d; border-radius:20px; cursor:pointer; transition:.2s; }
  .slider:before { content:''; position:absolute; width:18px; height:18px; right:3px; top:3px; background:#fff; border-radius:50%; transition:.2s; }
  input:checked + .slider { background:var(--accent); }
  input:checked + .slider:before { transform:translateX(-20px); }
  .chat-item { padding:8px 10px; border-radius:8px; cursor:pointer; }
  .chat-item:hover,.chat-item.active { background:#232132; }
  .grid2 { display:flex; gap:14px; flex-wrap:wrap; }
  .grid2 > * { flex:1; min-width:260px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  td,th { text-align:right; padding:6px 8px; border-bottom:1px solid var(--line); }
  th { color:var(--muted); }
  .pill { display:inline-flex; gap:6px; background:#222634; border:1px solid var(--line); border-radius:8px; padding:5px 9px; margin:3px 3px 0 0; font-size:13px; }
  .box { background:#0e1017; border:1px solid var(--line); border-radius:10px; padding:12px 16px; text-align:center; }
  .box b { font-size:20px; display:block; }
  .stat { display:flex; gap:12px; flex-wrap:wrap; }
  .media-item { display:inline-block; width:120px; vertical-align:top; margin:4px; text-align:center; }
  .media-item .thumb { width:120px; height:90px; background:#0e1017; border:1px solid var(--line); border-radius:8px; display:flex; align-items:center; justify-content:center; font-size:32px; cursor:pointer; overflow:hidden; }
  .media-item img { max-width:100%; max-height:100%; }
  .center { text-align:center; padding:60px 20px; }
  .err { color:var(--bad); font-size:12px; }
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

const TOGGLES=[['welcomeEnabled','الترحيب'],['captchaEnabled','CAPTCHA'],['antispamEnabled','مكافحة السبام'],['antiLinkEnabled','منع الروابط'],['filtersEnabled','الكلمات الممنوعة'],['moderationEnabled','فحص AI'],['repliesEnabled','الردود'],['gamesEnabled','الألعاب'],['economyEnabled','الاقتصاد'],['xpEnabled','النقاط'],['cleanServiceEnabled','حذف رسائل الانضمام'],['aiEnabled','الذكاء الاصطناعي']];
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

/* ---- Users / Conversations ---- */
async function loadUsers(){ const users=await api('/users'); const c=document.getElementById('content');
  const list=users.length?users.map(u=>'<div class="chat-item" onclick="openConv(\\''+u.userId+'\\',this)">'+esc(u.name)+'<div class="muted">'+u.userId+' · '+u.count+' 💬'+(u.last?' · '+new Date(u.last).toLocaleDateString('ar'):'')+'</div></div>').join(''):'<p class="muted">لا سجلّات. فعّل MESSAGE_LOG_ENABLED=true.</p>';
  c.innerHTML='<div class="grid2"><div class="card" style="max-width:300px"><h3 style="margin-top:0">👥 المستخدمون</h3><p class="muted">كل من تحدّث مع البوت (خاص أو في الجروبات).</p><div id="uList">'+list+'</div></div><div class="card" id="convPanel"><p class="muted">اختر مستخدماً لعرض محادثته مع البوت.</p></div></div>'; }
async function openConv(uid,node){ document.querySelectorAll('#uList .chat-item').forEach(n=>n.classList.remove('active')); if(node)node.classList.add('active');
  const rows=await api('/users/'+uid+'/conversation?limit=250'); rows.reverse();
  const bubbles=rows.map(r=>'<div style="margin:6px 0;padding:8px 10px;background:#0e1017;border:1px solid var(--line);border-radius:10px"><div class="muted" style="font-size:11px">'+new Date(r.createdAt).toLocaleString('ar')+' · '+esc(r.chatTitle||r.chatId)+' · '+r.type+(r.flagged?' 🚩':'')+'</div>'+esc(r.text||('['+r.type+']'))+'</div>').join('')||'<p class="muted">لا رسائل.</p>';
  document.getElementById('convPanel').innerHTML='<h3 style="margin-top:0">💬 محادثة '+esc((node?node.textContent:uid)||uid)+'</h3><div style="max-height:72vh;overflow:auto">'+bubbles+'</div>'; }

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
