/** Self-contained dashboard SPA served at /dashboard. Vanilla JS, no build. */
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
  header { padding:16px 20px; border-bottom:1px solid var(--line); display:flex; align-items:center; justify-content:space-between; }
  header h1 { font-size:18px; margin:0; }
  .wrap { display:flex; gap:16px; padding:16px; max-width:1100px; margin:0 auto; flex-wrap:wrap; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; }
  .chats { width:280px; flex-shrink:0; }
  .main { flex:1; min-width:300px; }
  .chat-item { padding:10px 12px; border-radius:10px; cursor:pointer; border:1px solid transparent; }
  .chat-item:hover { background:#222634; }
  .chat-item.active { border-color:var(--accent); background:#232132; }
  .muted { color:var(--muted); font-size:13px; }
  .toggle { display:flex; align-items:center; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--line); }
  .toggle:last-child { border-bottom:none; }
  .switch { position:relative; width:44px; height:24px; }
  .switch input { display:none; }
  .slider { position:absolute; inset:0; background:#3a3f4d; border-radius:20px; transition:.2s; cursor:pointer; }
  .slider:before { content:''; position:absolute; width:18px; height:18px; right:3px; top:3px; background:#fff; border-radius:50%; transition:.2s; }
  input:checked + .slider { background:var(--accent); }
  input:checked + .slider:before { transform:translateX(-20px); }
  h3 { margin:18px 0 8px; font-size:15px; }
  .row { display:flex; gap:8px; margin:6px 0; }
  input[type=text], textarea { flex:1; background:#0e1017; border:1px solid var(--line); color:var(--fg); border-radius:8px; padding:8px; font-family:inherit; }
  button { background:var(--accent); color:#fff; border:none; border-radius:8px; padding:8px 14px; cursor:pointer; font-family:inherit; }
  button.ghost { background:transparent; border:1px solid var(--line); color:var(--fg); }
  button.del { background:transparent; color:var(--bad); border:1px solid var(--line); padding:4px 8px; }
  .pill { display:inline-flex; align-items:center; gap:6px; background:#222634; border:1px solid var(--line); border-radius:8px; padding:6px 10px; margin:4px 4px 0 0; }
  .stat { display:flex; gap:16px; flex-wrap:wrap; }
  .stat .box { background:#0e1017; border:1px solid var(--line); border-radius:10px; padding:12px 16px; text-align:center; }
  .stat .box b { font-size:22px; display:block; }
  .center { text-align:center; padding:60px 20px; }
  a { color:var(--accent); }
</style>
</head>
<body>
<header>
  <h1>🦋 لوحة تحكم البوت</h1>
  <span id="hdr"></span>
</header>

<div id="login" class="center" style="display:none">
  <div class="card" style="max-width:420px; margin:0 auto">
    <h2>تسجيل الدخول</h2>
    <p class="muted">سجّل الدخول بحساب تيليجرام (المالك فقط).</p>
    <div id="tg-btn"></div>
    <p class="muted" id="loginNote" style="margin-top:14px"></p>
  </div>
</div>

<div id="app" class="wrap" style="display:none">
  <div class="chats card">
    <h3 style="margin-top:0">الجروبات</h3>
    <div id="chatList"></div>
  </div>
  <div class="main">
    <div id="panel" class="card"><p class="muted">اختر جروباً من القائمة.</p></div>
  </div>
</div>

<script>
const api = (p, opt={}) => fetch('/api'+p, {credentials:'include', headers:{'Content-Type':'application/json'}, ...opt}).then(r=>r.json());
let current = null;

async function boot() {
  const me = await api('/me');
  if (me.authenticated) { document.getElementById('app').style.display='flex'; document.getElementById('hdr').innerHTML='<button class="ghost" onclick="logout()">خروج</button>'; loadChats(); }
  else showLogin();
}
async function showLogin() {
  document.getElementById('login').style.display='block';
  const cfg = await api('/config');
  if (!cfg.botUsername) { document.getElementById('loginNote').textContent='⚠️ لم يتم ضبط BOT_USERNAME في الخادم.'; return; }
  window.onTelegramAuth = async (user) => {
    const r = await api('/auth/telegram', {method:'POST', body:JSON.stringify(user)});
    if (r.ok) location.reload();
    else document.getElementById('loginNote').textContent = r.error==='not_owner' ? 'هذا الحساب ليس مالك البوت.' : 'فشل تسجيل الدخول.';
  };
  const s = document.createElement('script');
  s.async = true; s.src = 'https://telegram.org/js/telegram-widget.js?22';
  s.setAttribute('data-telegram-login', cfg.botUsername);
  s.setAttribute('data-size', 'large');
  s.setAttribute('data-onauth', 'onTelegramAuth(user)');
  s.setAttribute('data-request-access', 'write');
  document.getElementById('tg-btn').appendChild(s);
}
async function logout() { await api('/auth/logout', {method:'POST'}); location.reload(); }

async function loadChats() {
  const chats = await api('/chats');
  const el = document.getElementById('chatList');
  if (!chats.length) { el.innerHTML='<p class="muted">لا توجد جروبات بعد. أضف البوت لجروب.</p>'; return; }
  el.innerHTML = chats.map(c => '<div class="chat-item" data-id="'+c.id+'" onclick="selectChat(\\''+c.id+'\\',this)">'+(c.title||c.id)+'<div class="muted">'+c.type+'</div></div>').join('');
}

async function selectChat(id, node) {
  current = id;
  document.querySelectorAll('.chat-item').forEach(n=>n.classList.remove('active'));
  node.classList.add('active');
  const [settings, stats, replies, filters] = await Promise.all([
    api('/chats/'+id+'/settings'), api('/chats/'+id+'/stats'), api('/chats/'+id+'/replies'), api('/chats/'+id+'/filters')
  ]);
  renderPanel(settings, stats, replies, filters);
}

const TOGGLES = [
  ['welcomeEnabled','الترحيب'],['captchaEnabled','CAPTCHA'],['farewellEnabled','رسالة المغادرة'],
  ['antispamEnabled','مكافحة السبام'],['floodEnabled','منع الفيضان'],['antiLinkEnabled','منع الروابط'],
  ['filtersEnabled','الكلمات الممنوعة'],['repliesEnabled','الردود'],['reactionsEnabled','التفاعلات'],
  ['gamesEnabled','الألعاب'],['economyEnabled','الاقتصاد'],['xpEnabled','النقاط'],
  ['cleanServiceEnabled','حذف رسائل الانضمام'],['aiEnabled','الذكاء الاصطناعي']
];

function renderPanel(s, stats, replies, filters) {
  const toggles = TOGGLES.map(([k,l]) =>
    '<div class="toggle"><span>'+l+'</span><label class="switch"><input type="checkbox" '+(s[k]?'checked':'')+' onchange="setToggle(\\''+k+'\\',this.checked)"><span class="slider"></span></label></div>'
  ).join('');
  const top = (stats.top||[]).slice(0,5).map((m,i)=>(i+1)+'. '+m.name+' — '+m.messages+' 💬').join('<br>') || '<span class="muted">لا شيء</span>';
  const repList = replies.map(r=>'<span class="pill">'+r.trigger+' <button class="del" onclick="delReply(\\''+encodeURIComponent(r.trigger)+'\\')">×</button></span>').join('') || '<span class="muted">لا توجد ردود</span>';
  const filList = filters.map(f=>'<span class="pill">'+f.word+' <button class="del" onclick="delFilter(\\''+encodeURIComponent(f.word)+'\\')">×</button></span>').join('') || '<span class="muted">لا توجد كلمات</span>';
  document.getElementById('panel').innerHTML =
    '<h3 style="margin-top:0">📊 الإحصائيات</h3><div class="stat">'
    +'<div class="box"><b>'+stats.members+'</b>أعضاء</div><div class="box"><b>'+stats.messages+'</b>رسائل</div></div>'
    +'<div class="muted" style="margin-top:10px">الأكثر نشاطاً:<br>'+top+'</div>'
    +'<h3>⚙️ الإعدادات</h3>'+toggles
    +'<h3>📜 القوانين</h3><div class="row"><textarea id="rules" rows="3">'+(s.rules||'')+'</textarea></div><div class="row"><button onclick="saveRules()">حفظ القوانين</button></div>'
    +'<h3>💬 الردود المخصصة</h3><div>'+repList+'</div>'
    +'<div class="row"><input type="text" id="rTrig" placeholder="المحفّز"><input type="text" id="rResp" placeholder="الرد"><button onclick="addReply()">إضافة</button></div>'
    +'<h3>🚫 الكلمات الممنوعة</h3><div>'+filList+'</div>'
    +'<div class="row"><input type="text" id="fWord" placeholder="كلمة"><button onclick="addFilter()">إضافة</button></div>';
}

async function setToggle(k,v){ await api('/chats/'+current+'/settings',{method:'PATCH',body:JSON.stringify({[k]:v})}); }
async function saveRules(){ await api('/chats/'+current+'/settings',{method:'PATCH',body:JSON.stringify({rules:document.getElementById('rules').value})}); alert('تم حفظ القوانين'); }
async function addReply(){ const trigger=document.getElementById('rTrig').value.trim(); const resp=document.getElementById('rResp').value.trim(); if(!trigger||!resp)return; await api('/chats/'+current+'/replies',{method:'POST',body:JSON.stringify({trigger,responses:[resp]})}); refresh(); }
async function delReply(t){ await api('/chats/'+current+'/replies/'+t,{method:'DELETE'}); refresh(); }
async function addFilter(){ const word=document.getElementById('fWord').value.trim(); if(!word)return; await api('/chats/'+current+'/filters',{method:'POST',body:JSON.stringify({word})}); refresh(); }
async function delFilter(w){ await api('/chats/'+current+'/filters/'+w,{method:'DELETE'}); refresh(); }
async function refresh(){ const node=document.querySelector('.chat-item.active'); if(node) selectChat(current,node); }

boot();
</script>
</body>
</html>`;
