const http = require('http');

const PORT = process.env.PORT || 3000;
const VERSION = process.env.VERSION || '2.0.0';

/* ================================================================
   LANDING PAGE — public chat-first interface
   ================================================================ */
const landingHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Getouch — AI-Powered Engagement Platform</title>
  <meta name="description" content="Intelligent engagement powered by on-premises AI. WhatsApp automation, conversational AI, and REST APIs — built for speed, privacy, and scale.">
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: #0a0a0b; --surface: #111113; --surface-2: #18181b;
      --border: #1e1e22; --border-hover: #2e2e34;
      --text: #e4e4e7; --text-muted: #71717a; --text-dim: #52525b;
      --accent: #6366f1; --accent-light: #818cf8;
      --accent-glow: rgba(99, 102, 241, 0.15);
      --green: #22c55e; --green-bg: rgba(34,197,94,0.1);
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif;
      background: var(--bg); color: var(--text); min-height: 100vh;
      display: flex; flex-direction: column;
      -webkit-font-smoothing: antialiased;
    }
    .bg-mesh {
      position: fixed; inset: 0; z-index: 0; pointer-events: none;
      background:
        radial-gradient(ellipse 600px 400px at 20% 10%, rgba(99,102,241,0.06), transparent),
        radial-gradient(ellipse 500px 300px at 80% 90%, rgba(139,92,246,0.04), transparent);
    }

    /* ── Nav ─────────────────────────────────── */
    nav {
      position: relative; z-index: 10;
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 24px; border-bottom: 1px solid var(--border);
      max-width: 1200px; width: 100%; margin: 0 auto;
    }
    .logo { font-size: 1.25rem; font-weight: 700; letter-spacing: -0.02em; }
    .logo span { color: var(--accent); }
    .nav-right { display: flex; align-items: center; gap: 12px; }
    .nav-btn {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 7px 16px; border-radius: 8px;
      font-size: 0.8rem; font-weight: 600; text-decoration: none;
      transition: all 0.2s; cursor: pointer; border: none;
    }
    .nav-btn.ghost {
      background: transparent; color: var(--text-muted);
      border: 1px solid var(--border);
    }
    .nav-btn.ghost:hover { border-color: var(--border-hover); color: var(--text); }
    .nav-btn.primary {
      background: var(--accent); color: white;
    }
    .nav-btn.primary:hover { background: var(--accent-light); }

    /* ── Main Layout ─────────────────────────── */
    .main-wrap {
      position: relative; z-index: 1;
      flex: 1; display: flex; flex-direction: column;
      max-width: 820px; width: 100%; margin: 0 auto;
      padding: 0 24px;
    }

    /* ── Welcome (shown when no messages) ────── */
    .welcome {
      flex: 1; display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      text-align: center; padding: 40px 0;
      transition: opacity 0.3s;
    }
    .welcome.hidden { display: none; }
    .welcome-icon {
      width: 56px; height: 56px; border-radius: 16px;
      background: var(--accent-glow); border: 1px solid rgba(99,102,241,0.2);
      display: flex; align-items: center; justify-content: center;
      font-size: 1.5rem; margin-bottom: 20px;
    }
    .welcome h1 {
      font-size: clamp(1.5rem, 4vw, 2.25rem); font-weight: 800;
      letter-spacing: -0.03em; line-height: 1.2; margin-bottom: 8px;
    }
    .welcome h1 .gradient { background: linear-gradient(135deg, var(--accent), #a78bfa, #ec4899); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .welcome p { color: var(--text-muted); font-size: 0.95rem; line-height: 1.6; max-width: 480px; margin-bottom: 28px; }
    .welcome-sub { color: var(--text-dim); font-size: 0.8rem; margin-bottom: 20px; }

    /* Quick action chips */
    .chips { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
    .chip {
      padding: 8px 16px; border-radius: 999px;
      background: var(--surface); border: 1px solid var(--border);
      color: var(--text-muted); font-size: 0.8rem; cursor: pointer;
      transition: all 0.2s; text-decoration: none;
    }
    .chip:hover { border-color: var(--accent); color: var(--text); background: var(--accent-glow); }
    .chip-icon { margin-right: 4px; }

    /* ── Chat Area ───────────────────────────── */
    .chat-area {
      flex: 1; overflow-y: auto; padding: 20px 0;
      display: none; flex-direction: column; gap: 16px;
    }
    .chat-area.active { display: flex; }
    .msg-row { display: flex; gap: 10px; max-width: 100%; }
    .msg-row.user { justify-content: flex-end; }
    .msg-row.bot { justify-content: flex-start; }
    .msg-avatar {
      width: 28px; height: 28px; border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-size: 0.8rem; flex-shrink: 0; margin-top: 2px;
    }
    .msg-row.bot .msg-avatar { background: var(--accent-glow); border: 1px solid rgba(99,102,241,0.2); }
    .msg-bubble {
      padding: 10px 14px; border-radius: 14px;
      font-size: 0.875rem; line-height: 1.6; max-width: 75%;
      word-wrap: break-word; white-space: pre-wrap;
    }
    .msg-row.user .msg-bubble {
      background: var(--accent); color: white;
      border-bottom-right-radius: 4px;
    }
    .msg-row.bot .msg-bubble {
      background: var(--surface); border: 1px solid var(--border);
      border-bottom-left-radius: 4px;
    }
    .msg-meta { font-size: 0.65rem; color: var(--text-dim); margin-top: 4px; }
    .msg-row.user .msg-meta { text-align: right; }

    /* Typing indicator */
    .typing-wrap { display: flex; align-items: flex-start; gap: 4px; padding: 10px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; border-bottom-left-radius: 4px; max-width: 260px; }
    .typing-text { font-size: 0.8rem; color: var(--text-muted); }
    .typing-dots { display: inline-flex; gap: 3px; margin-left: 2px; vertical-align: middle; }
    .typing-dots span {
      width: 5px; height: 5px; border-radius: 50%; background: var(--accent-light);
      display: inline-block;
      animation: blink 1.4s infinite both;
    }
    .typing-dots span:nth-child(2) { animation-delay: 0.2s; }
    .typing-dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes blink { 0%,80%,100% { opacity:0.3; } 40% { opacity:1; } }
    .typing-timer { font-size: 0.65rem; color: var(--text-dim); margin-top: 4px; }

    /* ── Input Bar ───────────────────────────── */
    .input-bar {
      position: relative; z-index: 10;
      padding: 16px 0 12px;
      border-top: 1px solid var(--border);
      background: var(--bg);
    }
    .input-wrap {
      display: flex; align-items: flex-end; gap: 8px;
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 14px; padding: 6px 6px 6px 16px;
      transition: border-color 0.2s;
    }
    .input-wrap:focus-within { border-color: var(--accent); }
    .input-wrap textarea {
      flex: 1; background: transparent; border: none; outline: none;
      color: var(--text); font-size: 0.9rem; font-family: inherit;
      resize: none; min-height: 24px; max-height: 120px; line-height: 1.5;
      padding: 6px 0;
    }
    .input-wrap textarea::placeholder { color: var(--text-dim); }
    .send-btn {
      width: 36px; height: 36px; border-radius: 10px;
      background: var(--accent); border: none; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: all 0.2s; flex-shrink: 0;
    }
    .send-btn:hover { background: var(--accent-light); }
    .send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .send-btn svg { width: 16px; height: 16px; fill: white; }
    .input-hint {
      text-align: center; font-size: 0.68rem; color: var(--text-dim); margin-top: 8px;
      display: flex; align-items: center; justify-content: center; gap: 6px; flex-wrap: wrap;
    }
    .input-hint a { color: var(--accent); text-decoration: none; }
    .input-hint .sep { color: var(--text-dim); }

    /* ── Responsive ──────────────────────────── */
    @media (max-width: 640px) {
      nav { padding: 12px 16px; }
      .main-wrap { padding: 0 16px; }
      .msg-bubble { max-width: 85%; }
      .welcome h1 { font-size: 1.5rem; }
      .nav-btn.ghost { display: none; }
    }
  </style>
</head>
<body>
  <div class="bg-mesh"></div>

  <nav>
    <a href="https://getouch.co" class="logo" style="text-decoration:none;color:var(--text)">ge<span>touch</span></a>
    <div class="nav-right">
      <a href="/auth/login" class="nav-btn ghost">Login</a>
      <a href="/auth/register" class="nav-btn primary">Get Started</a>
    </div>
  </nav>

  <div class="main-wrap">
    <div class="welcome" id="welcome">
      <div class="welcome-icon">&#128172;</div>
      <h1>Hi, I'm <span class="gradient">Getouch AI</span></h1>
      <p>Ask me anything about our services — WhatsApp automation, AI chatbot API, database tools, or any general question. Powered by on-premises AI.</p>
      <div class="welcome-sub">Try one of these to get started:</div>
      <div class="chips">
        <button class="chip" onclick="askChip(this)"><span class="chip-icon">&#128172;</span>What services do you offer?</button>
        <button class="chip" onclick="askChip(this)"><span class="chip-icon">&#128241;</span>Tell me about WhatsApp Gateway</button>
        <button class="chip" onclick="askChip(this)"><span class="chip-icon">&#129302;</span>How does the AI Bot work?</button>
        <button class="chip" onclick="askChip(this)"><span class="chip-icon">&#9889;</span>Show me the REST API</button>
        <button class="chip" onclick="askChip(this)"><span class="chip-icon">&#128187;</span>What are AI + DB tools?</button>
        <button class="chip" onclick="askChip(this)"><span class="chip-icon">&#128640;</span>How do I get started?</button>
      </div>
    </div>

    <div class="chat-area" id="chatArea"></div>
  </div>

  <div class="input-bar">
    <div style="max-width:820px;margin:0 auto;padding:0 24px;">
      <div class="input-wrap">
        <textarea id="msgInput" rows="1" placeholder="Ask about our services or anything else..." onkeydown="handleKey(event)" oninput="autoGrow(this)"></textarea>
        <button class="send-btn" id="sendBtn" onclick="sendMessage()" title="Send">
          <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        </button>
      </div>
      <div class="input-hint">
        Powered by <a href="https://getouch.co">Getouch AI</a>
        <span class="sep">&middot;</span> On-premises
        <span class="sep">&middot;</span> Your data stays private
        <span class="sep">&middot;</span> <a href="/admin/">Admin</a>
      </div>
    </div>
  </div>

  <script>
    var chatArea = document.getElementById('chatArea');
    var welcome = document.getElementById('welcome');
    var input = document.getElementById('msgInput');
    var sendBtn = document.getElementById('sendBtn');
    var chatHistory = [];
    var sending = false;

    function autoGrow(el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }

    function handleKey(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    }

    function askChip(el) {
      var text = el.textContent.replace(/^[^\\w]+/, '').trim();
      input.value = text;
      sendMessage();
    }

    function timeStr() {
      return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function addMessage(role, text, meta) {
      welcome.classList.add('hidden');
      chatArea.classList.add('active');
      var row = document.createElement('div');
      row.className = 'msg-row ' + role;
      if (role === 'bot') {
        var av = document.createElement('div');
        av.className = 'msg-avatar';
        av.innerHTML = '&#128172;';
        row.appendChild(av);
      }
      var wrap = document.createElement('div');
      var bubble = document.createElement('div');
      bubble.className = 'msg-bubble';
      bubble.textContent = text;
      wrap.appendChild(bubble);
      if (meta) {
        var m = document.createElement('div');
        m.className = 'msg-meta';
        m.textContent = meta;
        wrap.appendChild(m);
      }
      row.appendChild(wrap);
      chatArea.appendChild(row);
      chatArea.scrollTop = chatArea.scrollHeight;
      return bubble;
    }

    function showTyping() {
      var row = document.createElement('div');
      row.className = 'msg-row bot';
      row.id = 'typing-row';
      var av = document.createElement('div');
      av.className = 'msg-avatar';
      av.innerHTML = '&#128172;';
      row.appendChild(av);
      var wrap = document.createElement('div');
      var bubble = document.createElement('div');
      bubble.className = 'typing-wrap';
      bubble.innerHTML = '<span class="typing-text">Thinking</span><span class="typing-dots"><span></span><span></span><span></span></span>';
      wrap.appendChild(bubble);
      var timer = document.createElement('div');
      timer.className = 'typing-timer';
      timer.id = 'typing-timer';
      wrap.appendChild(timer);
      row.appendChild(wrap);
      chatArea.appendChild(row);
      chatArea.scrollTop = chatArea.scrollHeight;
      var startTime = Date.now();
      window._typingInterval = setInterval(function() {
        var el = document.getElementById('typing-timer');
        if (!el) { clearInterval(window._typingInterval); return; }
        var secs = Math.floor((Date.now() - startTime) / 1000);
        if (secs >= 3) el.textContent = secs + 's elapsed';
      }, 1000);
    }

    function hideTyping() {
      if (window._typingInterval) clearInterval(window._typingInterval);
      var el = document.getElementById('typing-row');
      if (el) el.remove();
    }

    async function sendMessage() {
      var text = input.value.trim();
      if (!text || sending) return;
      sending = true;
      sendBtn.disabled = true;
      input.value = '';
      input.style.height = 'auto';
      addMessage('user', text, timeStr());

      try {
        chatHistory.push({ role: 'user', content: text });
        showTyping();
        var controller = new AbortController();
        var timeout = setTimeout(function() { controller.abort(); }, 90000);
        var res = await fetch('https://bot.getouch.co/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, history: chatHistory.slice(-20) }),
          signal: controller.signal
        });
        clearTimeout(timeout);
        if (!res.ok) {
          hideTyping();
          addMessage('bot', 'Service temporarily unavailable (HTTP ' + res.status + '). Please try again in a minute.', 'Error');
          sending = false; sendBtn.disabled = false; input.focus(); return;
        }
        var data = await res.json();
        hideTyping();
        if (data.error) {
          addMessage('bot', 'Sorry, something went wrong: ' + (data.error || 'unknown error'), 'Error');
        } else {
          var response = data.response || 'No response';
          var dur = data.total_duration_ms ? data.total_duration_ms + 'ms' : '';
          addMessage('bot', response, [dur, timeStr()].filter(Boolean).join(' \\u00b7 '));
          chatHistory.push({ role: 'assistant', content: response });
        }
      } catch (err) {
        hideTyping();
        var errMsg = err.name === 'AbortError'
          ? 'Request timed out. The AI may be loading \\u2014 please try again.'
          : 'Cannot reach the AI service. Please try again shortly.';
        addMessage('bot', errMsg, 'Error');
      }
      sending = false;
      sendBtn.disabled = false;
      input.focus();
    }

    input.focus();

    // Warm up model silently on page load
    fetch('https://bot.getouch.co/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi' })
    }).catch(function() {});
  </script>
</body>
</html>`;



/* ================================================================
   ADMIN — data stores & Cloudflare Email Routing integration
   ================================================================ */
const https = require('https');

const CF_TOKEN     = process.env.CLOUDFLARE_API_TOKEN || '';
const CF_ZONE      = process.env.CLOUDFLARE_ZONE_ID   || '';
const CF_ACCOUNT   = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const EMAIL_DOMAIN = process.env.EMAIL_DOMAIN || 'getouch.co';

// ── Email destinations (with cf_destination_id for verification tracking) ──
var emailDestinations = [
  { id:'d1', label:'Gmail (primary)', email:'edi.erwan@gmail.com', cfDestinationId:null, verified:true, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() }
];

// ── Email aliases ──
var emailAliases = [
  { id:'a1', localPart:'admin',   address:'admin@getouch.co',   destinationId:'d1', note:'Primary admin',     desiredState:'active', syncStatus:'synced', lastSyncAt:null, lastError:null, createdAt:new Date().toISOString() },
  { id:'a2', localPart:'support', address:'support@getouch.co', destinationId:'d1', note:'Customer support',  desiredState:'active', syncStatus:'synced', lastSyncAt:null, lastError:null, createdAt:new Date().toISOString() },
  { id:'a3', localPart:'sales',   address:'sales@getouch.co',   destinationId:'d1', note:'Sales inquiries',   desiredState:'active', syncStatus:'synced', lastSyncAt:null, lastError:null, createdAt:new Date().toISOString() },
  { id:'a4', localPart:'billing', address:'billing@getouch.co', destinationId:'d1', note:'Billing & invoices',desiredState:'active', syncStatus:'synced', lastSyncAt:null, lastError:null, createdAt:new Date().toISOString() },
  { id:'a5', localPart:'noreply', address:'noreply@getouch.co', destinationId:null, note:'No-reply sender',   desiredState:'drop',   syncStatus:'synced', lastSyncAt:null, lastError:null, createdAt:new Date().toISOString() }
];

// ── Activity log ──
var activityLog = [
  { id:1, ts:new Date().toISOString(), action:'system.start', detail:'Admin dashboard initialized', actor:'system' }
];
var actLogSeq = 2;
function logActivity(action, detail, actor) {
  activityLog.unshift({ id:actLogSeq++, ts:new Date().toISOString(), action:action, detail:detail, actor:actor||'admin' });
  if (activityLog.length > 200) activityLog.length = 200;
}

// ── Global sync timestamp ──
var lastGlobalSync = null;

// ── ID generator ──
function uid() { return 'x' + Math.random().toString(36).slice(2,10) + Date.now().toString(36); }

// ── Cloudflare API helpers ──
function cfZoneRequest(method, path, body) {
  return new Promise(function(resolve, reject) {
    if (!CF_TOKEN || !CF_ZONE) return reject(new Error('Cloudflare credentials not configured (need CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID)'));
    var data = body ? JSON.stringify(body) : null;
    var opts = {
      hostname: 'api.cloudflare.com',
      path: '/client/v4/zones/' + CF_ZONE + path,
      method: method,
      headers: { 'Authorization': 'Bearer ' + CF_TOKEN, 'Content-Type': 'application/json' }
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    var req = https.request(opts, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch(e) { reject(new Error('Invalid CF response')); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function cfAccountRequest(method, path, body) {
  return new Promise(function(resolve, reject) {
    if (!CF_TOKEN || !CF_ACCOUNT) return reject(new Error('Cloudflare credentials not configured (need CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID)'));
    var data = body ? JSON.stringify(body) : null;
    var opts = {
      hostname: 'api.cloudflare.com',
      path: '/client/v4/accounts/' + CF_ACCOUNT + path,
      method: method,
      headers: { 'Authorization': 'Bearer ' + CF_TOKEN, 'Content-Type': 'application/json' }
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    var req = https.request(opts, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch(e) { reject(new Error('Invalid CF response')); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Reserved local parts ──
var RESERVED = ['postmaster','abuse','hostmaster'];

// ── Helpers ──
function findDest(id) { return emailDestinations.find(function(d){ return d.id===id; }); }
function aliasWithDest(a) {
  var d = findDest(a.destinationId);
  return Object.assign({}, a, { destination: d ? { label:d.label, email:d.email, verified:d.verified } : null });
}

/* ================================================================
   ADMIN DASHBOARD HTML
   ================================================================ */
const adminHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Getouch Admin</title>
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#0a0a0b;--surface:#111113;--s2:#18181b;--s3:#1f1f23;
  --border:#1e1e22;--bh:#2e2e34;--ba:#3e3e44;
  --text:#e4e4e7;--tm:#71717a;--td:#52525b;
  --accent:#6366f1;--al:#818cf8;--ag:rgba(99,102,241,.12);
  --green:#22c55e;--gd:rgba(34,197,94,.12);
  --red:#ef4444;--rd:rgba(239,68,68,.12);
  --yellow:#eab308;--yd:rgba(234,179,8,.12);
  --blue:#3b82f6;--bd:rgba(59,130,246,.12);
  --purple:#a855f7;--pd:rgba(168,85,247,.12);
  --orange:#f97316;--od:rgba(249,115,22,.12);
  --mono:"SF Mono","Fira Code","Cascadia Code",monospace;
  --r:10px;
}
body{font-family:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;background:var(--bg);color:var(--text);min-height:100vh;-webkit-font-smoothing:antialiased}
a{color:var(--al);text-decoration:none}a:hover{text-decoration:underline}
@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
.fade-in{animation:fadeIn .3s ease-out}
.skeleton{background:linear-gradient(90deg,var(--s2) 25%,var(--s3) 50%,var(--s2) 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:4px;height:14px;width:80px;display:inline-block}

/* Status Banner */
.status-banner{display:flex;align-items:center;justify-content:center;gap:12px;padding:6px 16px;font-size:.68rem;font-weight:600;border-bottom:1px solid var(--border);flex-wrap:wrap}
.status-banner .env{padding:2px 8px;border-radius:4px;background:var(--gd);color:var(--green);text-transform:uppercase;letter-spacing:.06em}
.status-banner .sep{color:var(--td)}

/* Topbar */
.topbar{display:flex;align-items:center;justify-content:space-between;padding:10px 24px;border-bottom:1px solid var(--border);background:var(--surface);position:sticky;top:0;z-index:100}
.topbar-l{display:flex;align-items:center;gap:12px}
.logo{font-size:1rem;font-weight:700;color:var(--text);text-decoration:none}.logo:hover{text-decoration:none}.logo b{color:var(--accent)}
.badge{font-size:.58rem;padding:2px 7px;border-radius:4px;background:var(--accent);color:#fff;font-weight:700;letter-spacing:.04em}
.topbar-r{display:flex;align-items:center;gap:8px}
.tl{color:var(--tm);font-size:.75rem;text-decoration:none;transition:color .15s}.tl:hover{color:var(--text);text-decoration:none}
.rbtn{background:var(--s2);border:1px solid var(--border);color:var(--tm);padding:5px 11px;border-radius:6px;font-size:.7rem;cursor:pointer;transition:all .15s}.rbtn:hover{border-color:var(--accent);color:var(--text)}

/* Tabs */
.tab-bar{display:flex;gap:1px;padding:0 24px;background:var(--surface);border-bottom:1px solid var(--border);overflow-x:auto;-webkit-overflow-scrolling:touch}
.tab-bar::-webkit-scrollbar{display:none}
.tb{background:none;border:none;padding:9px 14px;color:var(--tm);font-size:.74rem;font-weight:600;cursor:pointer;border-bottom:2px solid transparent;transition:all .15s;white-space:nowrap;display:flex;align-items:center;gap:5px}
.tb:hover{color:var(--text);background:var(--s2)}
.tb.active{color:var(--al);border-bottom-color:var(--accent)}
.tp{display:none;padding:24px;max-width:1200px;margin:0 auto}.tp.active{display:block;animation:fadeIn .25s ease-out}

/* Cards & Grid */
.section{margin-bottom:22px}
.sh{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:8px}
.st{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--td)}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden;transition:border-color .15s,transform .15s}
.card:hover{border-color:var(--bh)}
.card.link-card:hover{transform:translateY(-2px);border-color:var(--accent)}
.cb{padding:14px}
.g2{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px}
.g3{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
.g4{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px}

/* Tags */
.tag{font-size:.6rem;padding:2px 7px;border-radius:4px;font-weight:600;display:inline-flex;align-items:center;gap:3px}
.tag.green{background:var(--gd);color:var(--green)}.tag.red{background:var(--rd);color:var(--red)}
.tag.blue{background:var(--bd);color:var(--blue)}.tag.purple{background:var(--pd);color:var(--purple)}
.tag.yellow{background:var(--yd);color:var(--yellow)}.tag.orange{background:var(--od);color:var(--orange)}
.tag.muted{background:var(--s2);color:var(--tm)}
.dot{width:6px;height:6px;border-radius:50%;display:inline-block}
.dot.green{background:var(--green)}.dot.red{background:var(--red)}
.dot.yellow{background:var(--yellow);animation:pulse 1.5s infinite}

/* Buttons */
.btn{display:inline-flex;align-items:center;gap:5px;padding:6px 12px;border-radius:6px;font-size:.72rem;font-weight:600;cursor:pointer;border:1px solid var(--border);transition:all .15s;text-decoration:none;font-family:inherit}
.btn:hover{text-decoration:none}
.btn-p{background:var(--accent);border-color:var(--accent);color:#fff}.btn-p:hover{background:var(--al)}
.btn-g{background:transparent;color:var(--tm)}.btn-g:hover{border-color:var(--bh);color:var(--text)}
.btn-o{background:var(--ag);border-color:rgba(99,102,241,.3);color:var(--al)}.btn-o:hover{background:var(--accent);color:#fff}
.btn-d{background:transparent;color:var(--red);border-color:rgba(239,68,68,.3)}.btn-d:hover{background:var(--rd)}
.btn-w{background:var(--yd);border-color:rgba(234,179,8,.3);color:var(--yellow)}.btn-w:hover{background:rgba(234,179,8,.2)}
.btn-sm{padding:4px 9px;font-size:.66rem;border-radius:5px}
.btn .spin{width:12px;height:12px;border:2px solid transparent;border-top-color:currentColor;border-radius:50%;animation:spin .6s linear infinite;display:none}
.btn.loading .spin{display:inline-block}
.btn.loading{opacity:.7;pointer-events:none}

/* Stats */
.stats-row{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin-bottom:18px}
.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px;text-align:center;transition:border-color .15s}
.stat-card:hover{border-color:var(--bh)}
.sv{font-size:1.4rem;font-weight:800;color:var(--al);line-height:1}.sl{font-size:.62rem;color:var(--tm);margin-top:3px}

/* Health cards */
.hc{display:flex;align-items:flex-start;gap:10px}
.hi{width:36px;height:36px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:1rem;flex-shrink:0}
.hn{font-size:.8rem;font-weight:600;margin-bottom:1px}
.hd{font-size:.66rem;color:var(--tm);margin-bottom:5px}
.hs{display:inline-flex;align-items:center;gap:4px;font-size:.64rem;font-weight:600;padding:2px 7px;border-radius:99px}
.hs.up{background:var(--gd);color:var(--green)}.hs.down{background:var(--rd);color:var(--red)}.hs.ck{background:var(--yd);color:var(--yellow)}
.hm{font-size:.6rem;color:var(--td);margin-top:2px}

/* Service cards */
.svc .cb{display:flex;flex-direction:column;gap:9px;min-height:150px}
.svc-h{display:flex;align-items:center;gap:9px}
.svc-i{width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:1rem;flex-shrink:0}
.svc-t{font-size:.82rem;font-weight:600}
.svc-d{font-size:.7rem;color:var(--tm);line-height:1.5;flex:1}
.svc-f{display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap}

/* Data table */
.dt{width:100%;border-collapse:collapse;font-size:.73rem}
.dt th{text-align:left;padding:7px 10px;font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--td);background:var(--s2);border-bottom:1px solid var(--border)}
.dt td{padding:7px 10px;border-bottom:1px solid var(--border);vertical-align:middle}
.dt tr:last-child td{border-bottom:none}
.dt tr:hover td{background:rgba(255,255,255,.02)}

/* Info rows */
.ir{display:flex;justify-content:space-between;padding:4px 0;font-size:.7rem;border-bottom:1px solid var(--border)}
.ir:last-child{border:none}
.ik{color:var(--tm)}.iv{color:var(--text);font-weight:500;font-family:var(--mono);font-size:.68rem}

/* Form */
.fr{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end}
.fg{display:flex;flex-direction:column;gap:3px}
.fg label{font-size:.65rem;font-weight:600;color:var(--tm)}
.fg input,.fg select{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:7px 10px;color:var(--text);font-size:.76rem;font-family:inherit;outline:none;transition:border-color .15s}
.fg input:focus,.fg select:focus{border-color:var(--accent)}
.fg input::placeholder{color:var(--td)}
.fg select option:disabled{color:var(--td)}

/* Cmd blocks */
.cmd{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px 14px;font-size:.68rem;color:var(--tm);font-family:var(--mono);line-height:1.9;overflow-x:auto;white-space:pre-wrap;word-break:break-all;position:relative}
.cmd .cm{color:var(--td)}
.cpb{position:absolute;top:7px;right:7px;background:var(--s2);border:1px solid var(--border);color:var(--td);padding:2px 7px;border-radius:4px;font-size:.6rem;cursor:pointer;transition:all .15s}.cpb:hover{border-color:var(--accent);color:var(--text)}

/* Modal */
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:500;display:none;align-items:center;justify-content:center;animation:fadeIn .15s}
.overlay.show{display:flex}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px;min-width:340px;max-width:480px;width:90%}
.modal h3{font-size:.95rem;font-weight:700;margin-bottom:4px}
.modal .desc{font-size:.78rem;color:var(--tm);margin-bottom:16px;line-height:1.5}
.modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}

/* Alert box */
.alert{padding:10px 14px;border-radius:8px;font-size:.74rem;line-height:1.5;margin-bottom:12px;display:none}
.alert.show{display:block}
.alert.info{background:var(--bd);border:1px solid rgba(59,130,246,.3);color:var(--blue)}
.alert.warn{background:var(--yd);border:1px solid rgba(234,179,8,.3);color:var(--yellow)}
.alert.err{background:var(--rd);border:1px solid rgba(239,68,68,.3);color:var(--red)}
.alert.ok{background:var(--gd);border:1px solid rgba(34,197,94,.3);color:var(--green)}

/* Toast */
.toast{position:fixed;bottom:20px;right:20px;background:var(--s2);border:1px solid var(--border);border-radius:8px;padding:10px 16px;font-size:.76rem;color:var(--text);z-index:9999;transform:translateY(80px);opacity:0;transition:all .3s;pointer-events:none;max-width:380px;display:flex;align-items:center;gap:8px}
.toast.show{transform:translateY(0);opacity:1}
.toast.success{border-color:var(--green)}.toast.error{border-color:var(--red)}

/* Cmd+K Palette */
.palette-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:600;display:none;align-items:flex-start;justify-content:center;padding-top:15vh}
.palette-overlay.show{display:flex;animation:fadeIn .12s}
.palette{background:var(--surface);border:1px solid var(--border);border-radius:12px;width:90%;max-width:520px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.palette input{width:100%;padding:14px 18px;background:transparent;border:none;border-bottom:1px solid var(--border);color:var(--text);font-size:.9rem;outline:none;font-family:inherit}
.palette input::placeholder{color:var(--td)}
.palette-list{max-height:320px;overflow-y:auto;padding:6px}
.palette-item{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:6px;cursor:pointer;font-size:.8rem;color:var(--tm);transition:all .1s}
.palette-item:hover,.palette-item.selected{background:var(--ag);color:var(--text)}
.palette-item .pi-icon{width:24px;text-align:center;font-size:.9rem;flex-shrink:0}
.palette-item .pi-label{flex:1}.palette-item .pi-hint{font-size:.62rem;color:var(--td);font-family:var(--mono)}

/* Danger Zone */
.danger-zone{border:1px solid rgba(239,68,68,.3);border-radius:var(--r);padding:16px}
.danger-zone h4{color:var(--red);font-size:.82rem;margin-bottom:10px;display:flex;align-items:center;gap:6px}
.dz-row{display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);gap:12px}
.dz-row:last-child{border:none}
.dz-info{flex:1}.dz-name{font-size:.78rem;font-weight:600}.dz-desc{font-size:.66rem;color:var(--tm)}

/* Responsive */
@media(max-width:768px){.g2,.g3,.g4{grid-template-columns:1fr}.tb{padding:7px 10px;font-size:.68rem}.stats-row{grid-template-columns:repeat(2,1fr)}.fr{flex-direction:column}.fg{width:100%}.modal{min-width:auto}}
</style>
</head>
<body>

<!-- Status Banner -->
<div class="status-banner" id="statusBanner">
  <span class="env" id="envBadge">PRODUCTION</span>
  <span class="sep">&#183;</span>
  <span id="bannerHealth">Checking services...</span>
  <span class="sep">&#183;</span>
  <span id="bannerSync" style="color:var(--tm)">Last sync: loading...</span>
</div>

<!-- Topbar -->
<div class="topbar">
  <div class="topbar-l">
    <a href="/" class="logo">ge<b>touch</b></a>
    <span class="badge">ADMIN</span>
  </div>
  <div class="topbar-r">
    <span style="font-size:.62rem;color:var(--td)">&#8984;K</span>
    <a href="/" class="tl">&#8592; Site</a>
    <button class="rbtn" onclick="checkAllHealth()">&#8635; Refresh</button>
  </div>
</div>

<!-- Tabs -->
<div class="tab-bar">
  <button class="tb active" data-tab="overview">&#9678; Overview</button>
  <button class="tb" data-tab="services">&#9889; Services</button>
  <button class="tb" data-tab="database">&#128451; Database</button>
  <button class="tb" data-tab="monitoring">&#128200; Monitoring</button>
  <button class="tb" data-tab="email">&#9993; Email</button>
  <button class="tb" data-tab="activity">&#128203; Activity</button>
  <button class="tb" data-tab="system">&#9881; System</button>
</div>

<!-- ═══════ OVERVIEW ═══════ -->
<div class="tp active" id="tab-overview">
  <div class="stats-row" id="statsRow">
    <div class="stat-card"><div class="sv" id="stat-online">-</div><div class="sl">Services Online</div></div>
    <div class="stat-card"><div class="sv">13</div><div class="sl">Containers</div></div>
    <div class="stat-card"><div class="sv" id="stat-emails">-</div><div class="sl">Email Aliases</div></div>
    <div class="stat-card"><div class="sv" id="stat-resp">-</div><div class="sl">Avg Response</div></div>
    <div class="stat-card"><div class="sv" id="stat-backup" style="font-size:1rem">&#10003;</div><div class="sl">Backup Status</div></div>
    <div class="stat-card"><div class="sv" id="stat-tunnel" style="font-size:1rem;color:var(--green)">&#9679;</div><div class="sl">CF Tunnel</div></div>
  </div>
  <div class="section">
    <div class="sh"><div class="st">Service Health</div><span style="font-size:.62rem;color:var(--td)" id="lastCheck">Checking...</span></div>
    <div class="g3" id="healthGrid"></div>
  </div>
  <div class="section">
    <div class="st" style="margin-bottom:10px">Quick Access</div>
    <div class="g4">
      <a href="https://db.getouch.co" target="_blank" class="card link-card" style="text-decoration:none"><div class="cb" style="display:flex;align-items:center;gap:8px;padding:10px 12px"><div style="width:28px;height:28px;border-radius:7px;background:var(--bd);display:flex;align-items:center;justify-content:center">&#128451;</div><div><div style="font-size:.75rem;font-weight:600;color:var(--text)">pgAdmin</div><div style="font-size:.6rem;color:var(--tm)">db.getouch.co</div></div></div></a>
      <a href="https://grafana.getouch.co" target="_blank" class="card link-card" style="text-decoration:none"><div class="cb" style="display:flex;align-items:center;gap:8px;padding:10px 12px"><div style="width:28px;height:28px;border-radius:7px;background:var(--gd);display:flex;align-items:center;justify-content:center">&#128200;</div><div><div style="font-size:.75rem;font-weight:600;color:var(--text)">Grafana</div><div style="font-size:.6rem;color:var(--tm)">grafana.getouch.co</div></div></div></a>
      <a href="https://dash.cloudflare.com" target="_blank" class="card link-card" style="text-decoration:none"><div class="cb" style="display:flex;align-items:center;gap:8px;padding:10px 12px"><div style="width:28px;height:28px;border-radius:7px;background:var(--od);display:flex;align-items:center;justify-content:center">&#9729;</div><div><div style="font-size:.75rem;font-weight:600;color:var(--text)">Cloudflare</div><div style="font-size:.6rem;color:var(--tm)">DNS + Tunnel</div></div></div></a>
      <a href="https://bot.getouch.co/health" target="_blank" class="card link-card" style="text-decoration:none"><div class="cb" style="display:flex;align-items:center;gap:8px;padding:10px 12px"><div style="width:28px;height:28px;border-radius:7px;background:var(--pd);display:flex;align-items:center;justify-content:center">&#9829;</div><div><div style="font-size:.75rem;font-weight:600;color:var(--text)">Health API</div><div style="font-size:.6rem;color:var(--tm)">All endpoints</div></div></div></a>
    </div>
  </div>
  <div class="section">
    <div class="st" style="margin-bottom:10px">Recent Activity</div>
    <div class="card"><div class="cb" style="padding:0"><table class="dt" id="recentActivityTable"><thead><tr><th>Time</th><th>Action</th><th>Detail</th></tr></thead><tbody id="recentActivityBody"><tr><td colspan="3" style="text-align:center;color:var(--td);padding:20px">Loading...</td></tr></tbody></table></div></div>
  </div>
</div>

<!-- ═══════ SERVICES ═══════ -->
<div class="tp" id="tab-services">
  <div class="section">
    <div class="st" style="margin-bottom:10px">Platform Services</div>
    <div class="g2">
      <div class="card svc"><div class="cb"><div class="svc-h"><div class="svc-i" style="background:var(--gd)">&#128172;</div><div><div class="svc-t">WhatsApp Gateway</div><span class="tag green" id="svc-wa">Checking...</span></div></div><div class="svc-d">Multi-tenant WhatsApp messaging via Baileys. QR-code pairing, keyword triggers, smart routing.</div><div class="svc-f"><span class="tag muted">wa.getouch.co</span><div style="display:flex;gap:5px"><a href="https://wa.getouch.co/health" target="_blank" class="btn btn-sm btn-g">Health</a><a href="https://wa.getouch.co" target="_blank" class="btn btn-sm btn-o">Open &#8599;</a></div></div></div></div>
      <div class="card svc"><div class="cb"><div class="svc-h"><div class="svc-i" style="background:var(--pd)">&#129302;</div><div><div class="svc-t">Bot / AI API</div><span class="tag green" id="svc-bot">Checking...</span></div></div><div class="svc-d">Conversational AI with on-premises GPU inference. Public /chat, API-key protected /v1/chat.</div><div class="svc-f"><span class="tag muted">bot.getouch.co</span><div style="display:flex;gap:5px"><a href="https://bot.getouch.co/health" target="_blank" class="btn btn-sm btn-g">Health</a><a href="/" target="_blank" class="btn btn-sm btn-o">Try Chat &#8599;</a></div></div></div></div>
      <div class="card svc"><div class="cb"><div class="svc-h"><div class="svc-i" style="background:var(--yd)">&#9889;</div><div><div class="svc-t">REST API</div><span class="tag green" id="svc-api">Checking...</span></div></div><div class="svc-d">Programmatic access to platform features. API key management, webhook delivery.</div><div class="svc-f"><span class="tag muted">api.getouch.co</span><div style="display:flex;gap:5px"><a href="https://api.getouch.co/health" target="_blank" class="btn btn-sm btn-g">Health</a><a href="https://api.getouch.co" target="_blank" class="btn btn-sm btn-o">Open &#8599;</a></div></div></div></div>
      <div class="card svc"><div class="cb"><div class="svc-h"><div class="svc-i" style="background:var(--bd)">&#127968;</div><div><div class="svc-t">Landing Page</div><span class="tag green">Active</span></div></div><div class="svc-d">Public-facing chat interface. Visitors interact with AI directly.</div><div class="svc-f"><span class="tag muted">getouch.co</span><div style="display:flex;gap:5px"><a href="/health" target="_blank" class="btn btn-sm btn-g">Health</a><a href="/" target="_blank" class="btn btn-sm btn-o">Open &#8599;</a></div></div></div></div>
      <div class="card svc"><div class="cb"><div class="svc-h"><div class="svc-i" style="background:var(--od)">&#129504;</div><div><div class="svc-t">Ollama (AI Engine)</div><span class="tag green">Running</span></div></div><div class="svc-d">On-premises LLM inference with GPU. Model: llama3.1:8b.</div><div class="svc-f"><span class="tag muted">Internal :11434</span><span class="tag purple">GPU Accelerated</span></div></div></div>
      <div class="card svc"><div class="cb"><div class="svc-h"><div class="svc-i" style="background:var(--ag)">&#9729;</div><div><div class="svc-t">Cloudflare Tunnel</div><span class="tag green">Active</span></div></div><div class="svc-d">Zero-trust ingress. All traffic via Cloudflare edge.</div><div class="svc-f"><span class="tag muted">cloudflared</span><a href="https://dash.cloudflare.com" target="_blank" class="btn btn-sm btn-o">Dashboard &#8599;</a></div></div></div>
    </div>
  </div>
</div>

<!-- ═══════ DATABASE ═══════ -->
<div class="tp" id="tab-database">
  <div class="section">
    <div class="sh"><div class="st">PostgreSQL</div><a href="https://db.getouch.co" target="_blank" class="btn btn-sm btn-o">Open pgAdmin &#8599;</a></div>
    <div class="g2" style="margin-bottom:14px">
      <div class="card"><div class="cb">
        <div style="font-size:.8rem;font-weight:600;margin-bottom:7px">&#128451; Connection</div>
        <div class="ir"><span class="ik">Host</span><span class="iv">postgres (internal)</span></div>
        <div class="ir"><span class="ik">Port</span><span class="iv">5432</span></div>
        <div class="ir"><span class="ik">pgAdmin</span><span class="iv"><a href="https://db.getouch.co" target="_blank">db.getouch.co</a></span></div>
        <div class="ir"><span class="ik">Access</span><span class="iv">Cloudflare Access</span></div>
      </div></div>
      <div class="card"><div class="cb">
        <div style="font-size:.8rem;font-weight:600;margin-bottom:7px">&#9881; Configuration</div>
        <div class="ir"><span class="ik">Engine</span><span class="iv">PostgreSQL 16</span></div>
        <div class="ir"><span class="ik">Backups</span><span class="iv">Daily automated</span></div>
        <div class="ir"><span class="ik">Script</span><span class="iv">/opt/getouch/scripts/backup.sh</span></div>
        <div class="ir"><span class="ik">Restore</span><span class="iv">/opt/getouch/scripts/restore.sh</span></div>
      </div></div>
    </div>
  </div>
  <div class="section">
    <div class="st" style="margin-bottom:10px">Databases</div>
    <div class="card"><div class="cb" style="padding:0"><table class="dt"><thead><tr><th>Database</th><th>Service</th><th>Purpose</th><th>Action</th></tr></thead><tbody>
      <tr><td style="font-family:var(--mono);font-weight:600">getouch_bot</td><td><span class="tag purple">Bot</span></td><td style="color:var(--tm)">Chat history, API keys, rate limits</td><td><a href="https://db.getouch.co" target="_blank" class="btn btn-sm btn-o">Browse &#8599;</a></td></tr>
      <tr><td style="font-family:var(--mono);font-weight:600">getouch_wa</td><td><span class="tag green">WA</span></td><td style="color:var(--tm)">Sessions, keyword triggers, logs</td><td><a href="https://db.getouch.co" target="_blank" class="btn btn-sm btn-o">Browse &#8599;</a></td></tr>
      <tr><td style="font-family:var(--mono);font-weight:600">getouch_api</td><td><span class="tag yellow">API</span></td><td style="color:var(--tm)">API keys, webhooks, analytics</td><td><a href="https://db.getouch.co" target="_blank" class="btn btn-sm btn-o">Browse &#8599;</a></td></tr>
    </tbody></table></div></div>
  </div>
  <div class="section">
    <div class="st" style="margin-bottom:10px">Commands</div>
    <div class="card"><div class="cb" style="padding:0"><div class="cmd"><button class="cpb" onclick="copyCmd(this)">Copy</button><span class="cm"># Connect to database</span>
docker exec -it postgres psql -U getouch -d getouch_bot

<span class="cm"># Backup all databases</span>
/opt/getouch/scripts/backup.sh

<span class="cm"># List tables</span>
docker exec postgres psql -U getouch -d getouch_bot -c "\\dt"

<span class="cm"># Database sizes</span>
docker exec postgres psql -U getouch -c "SELECT datname, pg_size_pretty(pg_database_size(datname)) FROM pg_database WHERE datistemplate=false;"</div></div></div>
  </div>
</div>

<!-- ═══════ MONITORING ═══════ -->
<div class="tp" id="tab-monitoring">
  <div class="section">
    <div class="sh"><div class="st">Grafana Dashboards</div><a href="https://grafana.getouch.co" target="_blank" class="btn btn-sm btn-o">Open Grafana &#8599;</a></div>
    <div class="card" style="margin-bottom:14px"><div class="cb" style="text-align:center;padding:32px 20px">
      <div style="font-size:2.5rem;margin-bottom:12px">&#128200;</div>
      <div style="font-size:.9rem;font-weight:600;margin-bottom:6px">Grafana is available via HTTPS</div>
      <div style="font-size:.75rem;color:var(--tm);margin-bottom:16px;max-width:400px;margin-left:auto;margin-right:auto;line-height:1.5">Protected by Cloudflare Access &#8212; no VPN required. Grafana shows system resources, container stats, request latencies, and error rates.</div>
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
        <a href="https://grafana.getouch.co" target="_blank" class="btn btn-o">&#128200; Open Grafana &#8599;</a>
        <a href="https://metrics.getouch.co" target="_blank" class="btn btn-g">&#128201; Prometheus &#8599;</a>
      </div>
      <div style="margin-top:12px;font-size:.65rem;color:var(--td)">HTTPS via Cloudflare Tunnel &#183; grafana.getouch.co &#183; metrics.getouch.co</div>
    </div></div>
  </div>
  <div class="section">
    <div class="st" style="margin-bottom:10px">Monitoring Stack</div>
    <div class="g2">
      <div class="card"><div class="cb">
        <div style="font-size:.8rem;font-weight:600;margin-bottom:7px">&#128201; Prometheus</div>
        <div class="ir"><span class="ik">Storage</span><span class="iv">/data/prometheus</span></div>
        <div class="ir"><span class="ik">Retention</span><span class="iv">30 days</span></div>
        <div class="ir"><span class="ik">Scrape</span><span class="iv">15s</span></div>
        <div class="ir"><span class="ik">URL</span><span class="iv">metrics.getouch.co</span></div>
        <div style="margin-top:7px"><a href="https://metrics.getouch.co" target="_blank" class="btn btn-sm btn-o">Open &#8599;</a></div>
      </div></div>
      <div class="card"><div class="cb">
        <div style="font-size:.8rem;font-weight:600;margin-bottom:7px">&#128200; Grafana</div>
        <div class="ir"><span class="ik">Storage</span><span class="iv">/data/grafana</span></div>
        <div class="ir"><span class="ik">URL</span><span class="iv">grafana.getouch.co</span></div>
        <div class="ir"><span class="ik">Auth</span><span class="iv">Cloudflare Access SSO</span></div>
        <div class="ir"><span class="ik">Source</span><span class="iv">Prometheus</span></div>
        <div style="margin-top:7px"><a href="https://grafana.getouch.co" target="_blank" class="btn btn-sm btn-o">Open &#8599;</a></div>
      </div></div>
      <div class="card"><div class="cb">
        <div style="font-size:.8rem;font-weight:600;margin-bottom:7px">&#127959; Node Exporter</div>
        <div class="ir"><span class="ik">Metrics</span><span class="iv">CPU, RAM, Disk, Net</span></div>
        <div class="ir"><span class="ik">Port</span><span class="iv">:9100 (internal)</span></div>
        <div class="ir"><span class="ik">Status</span><span class="iv" style="color:var(--green)">Running</span></div>
      </div></div>
      <div class="card"><div class="cb">
        <div style="font-size:.8rem;font-weight:600;margin-bottom:7px">&#128230; cAdvisor</div>
        <div class="ir"><span class="ik">Metrics</span><span class="iv">Per-container stats</span></div>
        <div class="ir"><span class="ik">Port</span><span class="iv">:8080 (internal)</span></div>
        <div class="ir"><span class="ik">Status</span><span class="iv" style="color:var(--green)">Running</span></div>
      </div></div>
    </div>
  </div>
</div>

<!-- ═══════ EMAIL ═══════ -->
<div class="tp" id="tab-email">
  <div class="stats-row">
    <div class="stat-card"><div class="sv" id="email-total">-</div><div class="sl">Total Aliases</div></div>
    <div class="stat-card"><div class="sv" id="email-active" style="color:var(--green)">-</div><div class="sl">Active</div></div>
    <div class="stat-card"><div class="sv" id="email-synced" style="color:var(--green)">-</div><div class="sl">Synced</div></div>
    <div class="stat-card"><div class="sv" id="email-pending" style="color:var(--yellow)">-</div><div class="sl">Pending</div></div>
  </div>

  <!-- Destinations section (top of email tab) -->
  <div class="section">
    <div class="sh">
      <div class="st">Destinations (Forward-To Addresses)</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn btn-sm btn-g" onclick="refreshDestVerification(this)"><span class="spin"></span>&#8635; Refresh Verification</button>
        <button class="btn btn-sm btn-p" onclick="showAddDest()">+ Add Destination</button>
      </div>
    </div>
    <div id="destAlert" class="alert info">Verification email sent! Check the inbox and click the link from Cloudflare to verify.</div>
    <div class="card"><div class="cb" style="padding:0"><table class="dt"><thead><tr><th>Label</th><th>Email</th><th>CF Status</th><th style="width:120px">Actions</th></tr></thead><tbody id="destBody"><tr><td colspan="4" style="text-align:center;color:var(--td);padding:16px"><span class="skeleton" style="width:100px"></span></td></tr></tbody></table></div></div>
    <p style="font-size:.62rem;color:var(--td);margin-top:6px">&#9432; Cloudflare requires destination addresses to be verified before email routing works. After adding, check the inbox for a verification link.</p>
  </div>

  <!-- Aliases section -->
  <div class="section">
    <div class="sh">
      <div class="st">Email Aliases (Cloudflare &#8594; Destination)</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn btn-sm btn-g" onclick="refreshFromCF(this)"><span class="spin"></span>&#8635; Refresh from CF</button>
        <button class="btn btn-sm btn-p" onclick="syncToCF(this)"><span class="spin"></span>&#9889; Sync to Cloudflare</button>
        <a href="https://dash.cloudflare.com/?to=/:account/email/routing/routes" target="_blank" class="btn btn-sm btn-g">CF Dashboard &#8599;</a>
      </div>
    </div>
    <div id="syncAlert" class="alert warn"></div>
    <div class="card"><div class="cb" style="padding:0"><table class="dt" id="emailTable"><thead><tr><th>Alias</th><th>Forward To</th><th>Sync</th><th>Note</th><th style="width:100px">Actions</th></tr></thead><tbody id="emailBody"><tr><td colspan="5" style="text-align:center;color:var(--td);padding:20px"><span class="skeleton" style="width:120px"></span></td></tr></tbody></table></div></div>
  </div>

  <!-- Add alias section -->
  <div class="section">
    <div class="st" style="margin-bottom:10px">Add New Alias</div>
    <div class="card"><div class="cb">
      <div class="fr" id="addAliasForm">
        <div class="fg" style="flex:1"><label>Local Part</label><input type="text" id="newLocal" placeholder="e.g. hello" oninput="this.value=this.value.toLowerCase().replace(/[^a-z0-9._-]/g,'')"></div>
        <div class="fg" style="flex:1"><label>Forward To</label><select id="newDest"></select></div>
        <div class="fg" style="flex:1"><label>Note</label><input type="text" id="newNote" placeholder="e.g. General inquiries"></div>
        <div class="fg"><label>&nbsp;</label><button class="btn btn-p" onclick="addAlias()">+ Add Alias</button></div>
      </div>
      <div id="aliasDestWarn" class="alert warn" style="margin-top:8px;margin-bottom:0">&#9888; Selected destination is not verified. Alias will be saved but sync is blocked until verification.</div>
    </div></div>
  </div>

  <!-- DNS section -->
  <div class="section">
    <div class="st" style="margin-bottom:10px">DNS &amp; Deliverability</div>
    <div class="g2">
      <div class="card"><div class="cb">
        <div style="font-size:.8rem;font-weight:600;margin-bottom:7px">DNS Records</div>
        <div class="ir"><span class="ik">MX</span><span class="iv">Cloudflare (auto)</span></div>
        <div class="ir"><span class="ik">SPF</span><span class="iv" style="font-size:.6rem;word-break:break-all">v=spf1 include:_spf.mx.cloudflare.net include:_spf.google.com ~all</span></div>
        <div class="ir"><span class="ik">DMARC</span><span class="iv">v=DMARC1; p=none</span></div>
        <div class="ir"><span class="ik">DKIM</span><span class="iv">Via Gmail SMTP</span></div>
      </div></div>
      <div class="card"><div class="cb">
        <div style="font-size:.8rem;font-weight:600;margin-bottom:7px">Outbound (Send As)</div>
        <div class="ir"><span class="ik">Method</span><span class="iv">Gmail "Send mail as"</span></div>
        <div class="ir"><span class="ik">SMTP</span><span class="iv">smtp.gmail.com:587</span></div>
        <div class="ir"><span class="ik">Auth</span><span class="iv">App Password</span></div>
        <div class="ir"><span class="ik">From</span><span class="iv">admin@getouch.co</span></div>
        <div style="margin-top:7px"><a href="https://mail.google.com/mail/u/0/#settings/accounts" target="_blank" class="btn btn-sm btn-g">Gmail Settings &#8599;</a></div>
      </div></div>
    </div>
  </div>
</div>

<!-- ═══════ ACTIVITY ═══════ -->
<div class="tp" id="tab-activity">
  <div class="section">
    <div class="sh">
      <div class="st">Activity Log</div>
      <select id="actFilter" onchange="loadActivity()" style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:4px 8px;color:var(--text);font-size:.72rem">
        <option value="">All Actions</option>
        <option value="email">Email</option>
        <option value="system">System</option>
        <option value="service">Service</option>
      </select>
    </div>
    <div class="card"><div class="cb" style="padding:0"><table class="dt"><thead><tr><th style="width:140px">Timestamp</th><th style="width:140px">Action</th><th>Detail</th><th style="width:80px">Actor</th></tr></thead><tbody id="activityBody"><tr><td colspan="4" style="text-align:center;color:var(--td);padding:20px">Loading...</td></tr></tbody></table></div></div>
  </div>
</div>

<!-- ═══════ SYSTEM ═══════ -->
<div class="tp" id="tab-system">
  <div class="section">
    <div class="st" style="margin-bottom:10px">Infrastructure</div>
    <div class="g2">
      <div class="card"><div class="cb">
        <div style="font-size:.8rem;font-weight:600;margin-bottom:7px">&#127959; Server</div>
        <div class="ir"><span class="ik">OS</span><span class="iv">Ubuntu 22.04 LTS</span></div>
        <div class="ir"><span class="ik">GPU</span><span class="iv">NVIDIA (AI inference)</span></div>
        <div class="ir"><span class="ik">Runtime</span><span class="iv">Docker + Compose v2</span></div>
        <div class="ir"><span class="ik">Proxy</span><span class="iv">Caddy</span></div>
        <div class="ir"><span class="ik">Tunnel</span><span class="iv">Cloudflare (cloudflared)</span></div>
      </div></div>
      <div class="card"><div class="cb">
        <div style="font-size:.8rem;font-weight:600;margin-bottom:7px">&#128190; Storage</div>
        <div class="ir"><span class="ik">NVMe (/)</span><span class="iv">466 GB</span></div>
        <div class="ir"><span class="ik">SATA (/data)</span><span class="iv">938 GB</span></div>
        <div class="ir"><span class="ik">Prometheus</span><span class="iv">/data/prometheus</span></div>
        <div class="ir"><span class="ik">Grafana</span><span class="iv">/data/grafana</span></div>
      </div></div>
      <div class="card"><div class="cb">
        <div style="font-size:.8rem;font-weight:600;margin-bottom:7px">&#128274; Security</div>
        <div class="ir"><span class="ik">Network</span><span class="iv">Cloudflare Tunnel</span></div>
        <div class="ir"><span class="ik">Firewall</span><span class="iv">UFW (deny all inbound)</span></div>
        <div class="ir"><span class="ik">Admin</span><span class="iv">Cloudflare Access</span></div>
        <div class="ir"><span class="ik">TLS</span><span class="iv">Cloudflare edge (auto)</span></div>
      </div></div>
      <div class="card"><div class="cb">
        <div style="font-size:.8rem;font-weight:600;margin-bottom:7px">&#127760; Networking</div>
        <div class="ir"><span class="ik">Tailscale</span><span class="iv">100.103.248.15</span></div>
        <div class="ir"><span class="ik">Domain</span><span class="iv">getouch.co</span></div>
        <div class="ir"><span class="ik">Subdomains</span><span class="iv">bot, wa, api, db, grafana, metrics</span></div>
        <div class="ir"><span class="ik">CF Tunnel</span><span class="iv" style="color:var(--green)">Active</span></div>
      </div></div>
    </div>
  </div>
  <div class="section">
    <div class="st" style="margin-bottom:10px">Docker Containers</div>
    <div class="card"><div class="cb" style="padding:0"><table class="dt"><thead><tr><th>Container</th><th>Compose</th><th>Port</th><th>Status</th></tr></thead><tbody>
      <tr><td style="font-family:var(--mono);font-weight:600">landing</td><td style="color:var(--tm)">apps</td><td style="font-family:var(--mono)">3000</td><td><span class="tag green">&#9679; Running</span></td></tr>
      <tr><td style="font-family:var(--mono);font-weight:600">bot</td><td style="color:var(--tm)">apps</td><td style="font-family:var(--mono)">3000</td><td><span class="tag green">&#9679; Running</span></td></tr>
      <tr><td style="font-family:var(--mono);font-weight:600">wa</td><td style="color:var(--tm)">apps</td><td style="font-family:var(--mono)">3000</td><td><span class="tag green">&#9679; Running</span></td></tr>
      <tr><td style="font-family:var(--mono);font-weight:600">api</td><td style="color:var(--tm)">apps</td><td style="font-family:var(--mono)">3000</td><td><span class="tag green">&#9679; Running</span></td></tr>
      <tr><td style="font-family:var(--mono);font-weight:600">ollama</td><td style="color:var(--tm)">ollama</td><td style="font-family:var(--mono)">11434</td><td><span class="tag green">&#9679; Running</span></td></tr>
      <tr><td style="font-family:var(--mono);font-weight:600">postgres</td><td style="color:var(--tm)">db</td><td style="font-family:var(--mono)">5432</td><td><span class="tag green">&#9679; Running</span></td></tr>
      <tr><td style="font-family:var(--mono);font-weight:600">pgadmin</td><td style="color:var(--tm)">db</td><td style="font-family:var(--mono)">5050</td><td><span class="tag green">&#9679; Running</span></td></tr>
      <tr><td style="font-family:var(--mono);font-weight:600">caddy</td><td style="color:var(--tm)">main</td><td style="font-family:var(--mono)">80</td><td><span class="tag green">&#9679; Running</span></td></tr>
      <tr><td style="font-family:var(--mono);font-weight:600">cloudflared</td><td style="color:var(--tm)">main</td><td style="font-family:var(--mono)">&#8212;</td><td><span class="tag green">&#9679; Running</span></td></tr>
      <tr><td style="font-family:var(--mono);font-weight:600">prometheus</td><td style="color:var(--tm)">mon</td><td style="font-family:var(--mono)">9090</td><td><span class="tag green">&#9679; Running</span></td></tr>
      <tr><td style="font-family:var(--mono);font-weight:600">grafana</td><td style="color:var(--tm)">mon</td><td style="font-family:var(--mono)">3001</td><td><span class="tag green">&#9679; Running</span></td></tr>
      <tr><td style="font-family:var(--mono);font-weight:600">node-exporter</td><td style="color:var(--tm)">mon</td><td style="font-family:var(--mono)">9100</td><td><span class="tag green">&#9679; Running</span></td></tr>
      <tr><td style="font-family:var(--mono);font-weight:600">cadvisor</td><td style="color:var(--tm)">mon</td><td style="font-family:var(--mono)">8080</td><td><span class="tag green">&#9679; Running</span></td></tr>
    </tbody></table></div></div>
  </div>
  <div class="section">
    <div class="st" style="margin-bottom:10px">Operations Commands</div>
    <div class="card"><div class="cb" style="padding:0"><div class="cmd"><button class="cpb" onclick="copyCmd(this)">Copy All</button><span class="cm"># SSH into server</span>
ssh deploy@100.103.248.15

<span class="cm"># View all containers</span>
docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"

<span class="cm"># App logs</span>
cd /opt/getouch/compose
docker compose -f docker-compose.apps.yml logs -f --tail 100

<span class="cm"># Restart a service</span>
docker compose -f docker-compose.apps.yml restart bot

<span class="cm"># Rebuild &amp; deploy</span>
docker compose -f docker-compose.apps.yml build landing --no-cache
docker compose -f docker-compose.apps.yml up -d landing</div></div></div>
  </div>
  <div class="section">
    <div class="st" style="margin-bottom:10px">Danger Zone</div>
    <div class="danger-zone">
      <h4>&#9888; Destructive Actions</h4>
      <div class="dz-row">
        <div class="dz-info"><div class="dz-name">Restart Container</div><div class="dz-desc">Restart a Docker container. Brief downtime.</div></div>
        <select id="restartTarget" style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:5px 8px;color:var(--text);font-size:.72rem;margin-right:8px">
          <option>landing</option><option>bot</option><option>wa</option><option>api</option><option>ollama</option>
        </select>
        <button class="btn btn-sm btn-d" onclick="showConfirm('Restart '+document.getElementById('restartTarget').value+'?','This will briefly interrupt the service.',function(){showToast('Restart command sent (requires SSH)','success')})">Restart</button>
      </div>
      <div class="dz-row">
        <div class="dz-info"><div class="dz-name">Force Cloudflare Sync</div><div class="dz-desc">Overrides any manual Cloudflare changes.</div></div>
        <button class="btn btn-sm btn-d" onclick="syncToCF(this)">Force Sync</button>
      </div>
      <div class="dz-row">
        <div class="dz-info"><div class="dz-name">Clear Activity Log</div><div class="dz-desc">Permanently removes all log entries.</div></div>
        <button class="btn btn-sm btn-d" onclick="showConfirm('Clear all activity logs?','This cannot be undone.',function(){fetch('/api/admin/activity',{method:'DELETE'}).then(function(){loadActivity();showToast('Activity log cleared','success')})})">Clear Log</button>
      </div>
    </div>
  </div>
</div>

<!-- ═══ Modals ═══ -->
<div class="overlay" id="confirmOverlay">
  <div class="modal">
    <h3 id="confirmTitle">Confirm</h3>
    <div class="desc" id="confirmDesc"></div>
    <div class="modal-actions">
      <button class="btn btn-g" onclick="hideConfirm()">Cancel</button>
      <button class="btn btn-d" id="confirmBtn" onclick="executeConfirm()">Confirm</button>
    </div>
  </div>
</div>

<div class="overlay" id="destOverlay">
  <div class="modal">
    <h3>Add Email Destination</h3>
    <div class="desc">Add a forwarding Gmail address. Cloudflare will send a verification email that must be confirmed before routing works.</div>
    <div class="fg" style="margin-bottom:10px"><label>Label</label><input type="text" id="destLabel" placeholder="e.g. Rahim Gmail"></div>
    <div class="fg" style="margin-bottom:10px"><label>Email Address</label><input type="email" id="destEmail" placeholder="e.g. rahim@gmail.com"></div>
    <div id="addDestError" class="alert err" style="margin-bottom:0"></div>
    <div class="modal-actions">
      <button class="btn btn-g" onclick="document.getElementById('destOverlay').classList.remove('show')">Cancel</button>
      <button class="btn btn-p" id="addDestBtn" onclick="addDest()"><span class="spin"></span>Add &amp; Send Verification</button>
    </div>
  </div>
</div>

<div class="overlay" id="editOverlay">
  <div class="modal">
    <h3>Edit Alias</h3>
    <div class="desc" id="editAliasAddr"></div>
    <input type="hidden" id="editAliasId">
    <div class="fg" style="margin-bottom:10px"><label>Forward To</label><select id="editDest"></select></div>
    <div class="fg" style="margin-bottom:10px"><label>Note</label><input type="text" id="editNote"></div>
    <div class="fg" style="margin-bottom:10px"><label>State</label><select id="editState"><option value="active">Active</option><option value="drop">Drop (discard)</option></select></div>
    <div id="editDestWarn" class="alert warn" style="margin-bottom:0">&#9888; Selected destination not verified. Sync blocked until verified.</div>
    <div class="modal-actions">
      <button class="btn btn-g" onclick="document.getElementById('editOverlay').classList.remove('show')">Cancel</button>
      <button class="btn btn-p" onclick="saveEdit()">Save</button>
    </div>
  </div>
</div>

<!-- Cmd+K Palette -->
<div class="palette-overlay" id="paletteOverlay">
  <div class="palette">
    <input type="text" id="paletteInput" placeholder="Search commands..." oninput="filterPalette()" onkeydown="paletteKey(event)">
    <div class="palette-list" id="paletteList"></div>
  </div>
</div>

<div id="toast" class="toast"></div>

<script>
/* ── Global state ── */
var _destinations = [];
var _aliases = [];

/* ── Tabs ── */
document.querySelectorAll('.tb').forEach(function(btn){
  btn.addEventListener('click',function(){
    document.querySelectorAll('.tp').forEach(function(p){p.classList.remove('active')});
    document.querySelectorAll('.tb').forEach(function(b){b.classList.remove('active')});
    document.getElementById('tab-'+btn.dataset.tab).classList.add('active');
    btn.classList.add('active');
  });
});

/* ── Toast ── */
function showToast(msg,type){var t=document.getElementById('toast');t.textContent=msg;t.className='toast show '+(type||'');clearTimeout(window._tt);window._tt=setTimeout(function(){t.className='toast'},3500)}

/* ── Copy ── */
function copyCmd(btn){var b=btn.parentElement;var t=b.textContent.replace(/Copy All|Copy/g,'').trim();navigator.clipboard.writeText(t).then(function(){showToast('Copied to clipboard','success')})}

/* ── Confirm modal ── */
var _confirmFn=null;
function showConfirm(title,desc,fn){document.getElementById('confirmTitle').textContent=title;document.getElementById('confirmDesc').textContent=desc;_confirmFn=fn;document.getElementById('confirmOverlay').classList.add('show')}
function hideConfirm(){document.getElementById('confirmOverlay').classList.remove('show');_confirmFn=null}
function executeConfirm(){if(_confirmFn)_confirmFn();hideConfirm()}

/* ── Health ── */
var onlineCount=0,totalMs=0;
var healthSvcs=[
  {name:'Landing',url:'/health',icon:'&#127968;',color:'var(--bd)',desc:'Website & chat'},
  {name:'Bot',url:'https://bot.getouch.co/health',icon:'&#129302;',color:'var(--pd)',desc:'AI engine'},
  {name:'WhatsApp',url:'https://wa.getouch.co/health',icon:'&#128172;',color:'var(--gd)',desc:'WA gateway'},
  {name:'API',url:'https://api.getouch.co/health',icon:'&#9889;',color:'var(--yd)',desc:'REST API'}
];
function checkAllHealth(){
  onlineCount=0;totalMs=0;
  var g=document.getElementById('healthGrid');g.innerHTML='';
  healthSvcs.forEach(function(s){
    var c=document.createElement('div');c.className='card';
    c.innerHTML='<div class="cb hc"><div class="hi" style="background:'+s.color+'">'+s.icon+'</div><div style="flex:1;min-width:0"><div class="hn">'+s.name+'</div><div class="hd">'+s.desc+'</div><div class="hs ck" id="hs-'+s.name+'"><span class="dot yellow"></span> Checking...</div><div class="hm" id="hm-'+s.name+'"></div></div></div>';
    g.appendChild(c);
    var t0=performance.now();
    fetch(s.url,{signal:AbortSignal.timeout(10000)})
      .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})
      .then(function(d){
        var ms=Math.round(performance.now()-t0);onlineCount++;totalMs+=ms;
        var el=document.getElementById('hs-'+s.name);el.className='hs up';el.innerHTML='<span class="dot green"></span> Online &#183; '+ms+'ms';
        var m=document.getElementById('hm-'+s.name);var p=[];
        if(d.version)p.push('v'+d.version);if(d.database)p.push('DB: '+d.database);if(d.engine)p.push(d.engine);if(d.session)p.push(d.session);
        m.textContent=p.join(' \\u00b7 ');
        if(s.name==='Bot'){var t=document.getElementById('svc-bot');if(t){t.className='tag green';t.textContent='Online \\u00b7 v'+(d.version||'?')}}
        if(s.name==='WhatsApp'){var t=document.getElementById('svc-wa');if(t){t.className='tag green';t.textContent='Online \\u00b7 '+(d.session||'active')}}
        if(s.name==='API'){var t=document.getElementById('svc-api');if(t){t.className='tag green';t.textContent='Online \\u00b7 v'+(d.version||'?')}}
        updateStats();
      })
      .catch(function(){
        var el=document.getElementById('hs-'+s.name);el.className='hs down';el.innerHTML='<span class="dot red"></span> Unreachable';
        updateStats();
      });
  });
  document.getElementById('lastCheck').textContent='Checked: '+new Date().toLocaleTimeString();
}
function updateStats(){
  document.getElementById('stat-online').textContent=onlineCount+'/'+healthSvcs.length;
  document.getElementById('stat-resp').textContent=onlineCount>0?Math.round(totalMs/onlineCount)+'ms':'-';
  var bh=document.getElementById('bannerHealth');
  if(onlineCount===healthSvcs.length){bh.innerHTML='<span style="color:var(--green)">&#9679;</span> All systems operational';bh.style.color='var(--green)'}
  else{bh.innerHTML='<span style="color:var(--yellow)">&#9679;</span> '+onlineCount+'/'+healthSvcs.length+' services online';bh.style.color='var(--yellow)'}
}

/* ══════ Destinations ══════ */
function loadDests(){
  fetch('/api/admin/email/destinations').then(function(r){return r.json()}).then(function(data){
    _destinations = data;
    var tb=document.getElementById('destBody');tb.innerHTML='';
    if (!data.length) {
      tb.innerHTML='<tr><td colspan="4" style="text-align:center;color:var(--td);padding:20px">No destinations. Add one to start routing email.</td></tr>';
    }
    data.forEach(function(d){
      var tr=document.createElement('tr');
      var vTag = d.verified
        ? '<span class="tag green">&#10003; Verified</span>'
        : '<span class="tag yellow"><span class="dot yellow"></span> Pending Verification</span>';
      var actions = '';
      if (!d.verified) actions += '<button class="btn btn-sm btn-w" onclick="resendVerify(\\''+d.id+'\\',\\''+d.email+'\\')">Resend</button> ';
      actions += '<button class="btn btn-sm btn-d" onclick="removeDest(\\''+d.id+'\\',\\''+d.label+'\\')">Remove</button>';
      tr.innerHTML='<td style="font-weight:600">'+d.label+'</td><td style="font-family:var(--mono);font-size:.72rem">'+d.email+'</td><td>'+vTag+'</td><td><div style="display:flex;gap:4px;flex-wrap:wrap">'+actions+'</div></td>';
      tb.appendChild(tr);
    });
    populateDestDropdowns(data);
  }).catch(function(){});
}

function populateDestDropdowns(dests){
  var sel1=document.getElementById('newDest');
  var sel2=document.getElementById('editDest');
  sel1.innerHTML='<option value="">-- Select destination --</option>';
  sel2.innerHTML='<option value="">-- Select destination --</option><option value="__drop">Drop (discard)</option>';
  dests.forEach(function(d){
    var verified = d.verified;
    var label = d.label+' ('+d.email+')';
    var disabledAttr = verified ? '' : ' disabled title="Not verified yet"';
    var suffix = verified ? '' : ' [NOT VERIFIED]';
    sel1.innerHTML += '<option value="'+d.id+'"'+disabledAttr+'>'+label+suffix+'</option>';
    sel2.innerHTML += '<option value="'+d.id+'"'+disabledAttr+'>'+label+suffix+'</option>';
  });
  // Add drop to newDest too
  sel1.innerHTML += '<option value="__drop">Drop (discard)</option>';
}

function showAddDest(){
  document.getElementById('destLabel').value='';
  document.getElementById('destEmail').value='';
  document.getElementById('addDestError').classList.remove('show');
  document.getElementById('addDestBtn').classList.remove('loading');
  document.getElementById('destOverlay').classList.add('show');
}

function addDest(){
  var label=document.getElementById('destLabel').value.trim();
  var email=document.getElementById('destEmail').value.trim();
  var errEl=document.getElementById('addDestError');
  errEl.classList.remove('show');
  if(!label||!email){errEl.textContent='Fill in all fields';errEl.classList.add('show');return}
  if(!/^[^@]+@[^@]+\\.[^@]+$/.test(email)){errEl.textContent='Invalid email address';errEl.classList.add('show');return}
  var btn=document.getElementById('addDestBtn');
  btn.classList.add('loading');
  fetch('/api/admin/email/destinations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({label:label,email:email})})
    .then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})})
    .then(function(res){
      btn.classList.remove('loading');
      if(!res.ok){errEl.textContent=res.data.error||'Failed';errEl.classList.add('show');return}
      document.getElementById('destOverlay').classList.remove('show');
      var alert=document.getElementById('destAlert');
      alert.innerHTML='&#9993; Verification email sent to <b>'+email+'</b>! Check the inbox and click the link from Cloudflare. Then click "Refresh Verification" here.';
      alert.classList.add('show');
      setTimeout(function(){alert.classList.remove('show')},15000);
      showToast('Destination added. Verification email sent!','success');
      loadDests();loadActivity();
    }).catch(function(){btn.classList.remove('loading');errEl.textContent='Request failed';errEl.classList.add('show')});
}

function removeDest(id,label){
  showConfirm('Remove destination "'+label+'"?','Any aliases using it will need reassignment or removal.',function(){
    fetch('/api/admin/email/destinations/'+id,{method:'DELETE'}).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})}).then(function(res){
      if(!res.ok){showToast(res.data.error||'Failed','error');return}
      showToast('Destination removed','success');loadDests();loadAliases();loadActivity();
    }).catch(function(){showToast('Failed to remove','error')});
  });
}

function resendVerify(id,email){
  showConfirm('Resend verification to '+email+'?','Cloudflare will send a new verification link.',function(){
    fetch('/api/admin/email/destinations/'+id+'/resend',{method:'POST'}).then(function(r){return r.json()}).then(function(d){
      if(d.error){showToast(d.error,'error');return}
      showToast('Verification email resent to '+email,'success');
      var alert=document.getElementById('destAlert');
      alert.innerHTML='&#9993; Verification re-sent to <b>'+email+'</b>. Check inbox!';
      alert.classList.add('show');
      setTimeout(function(){alert.classList.remove('show')},10000);
      loadActivity();
    }).catch(function(){showToast('Failed','error')});
  });
}

function refreshDestVerification(btn){
  btn.classList.add('loading');
  fetch('/api/admin/email/destinations/refresh',{method:'POST'}).then(function(r){return r.json()}).then(function(d){
    btn.classList.remove('loading');
    if(d.error){showToast(d.error,'error');return}
    showToast(d.message||'Verification status refreshed','success');loadDests();loadActivity();
  }).catch(function(){btn.classList.remove('loading');showToast('Failed','error')});
}

/* ══════ Aliases ══════ */
function loadAliases(){
  fetch('/api/admin/email/aliases').then(function(r){return r.json()}).then(function(data){
    _aliases = data;
    var tb=document.getElementById('emailBody');tb.innerHTML='';
    var activeC=0,syncedC=0,pendingC=0;
    data.forEach(function(a){
      if(a.desiredState==='active')activeC++;
      if(a.syncStatus==='synced')syncedC++;
      if(a.syncStatus==='pending'||a.syncStatus==='blocked')pendingC++;
      var syncCls=a.syncStatus==='synced'?'green':a.syncStatus==='pending'?'yellow':a.syncStatus==='blocked'?'orange':a.syncStatus==='mismatch'?'orange':'red';
      var fwd;
      if(a.desiredState==='drop'){
        fwd='<span class="tag muted">Drop (discard)</span>';
      } else if(a.destination){
        var destWarn = !a.destination.verified ? '<br><span class="tag orange" style="font-size:.56rem;margin-top:2px">&#9888; Not verified</span>' : '';
        fwd='<span style="font-size:.72rem">'+a.destination.label+'</span><br><span style="font-size:.62rem;color:var(--tm);font-family:var(--mono)">'+a.destination.email+'</span>'+destWarn;
      } else {
        fwd='<span class="tag red">No destination</span>';
      }
      var tr=document.createElement('tr');
      tr.innerHTML='<td style="font-family:var(--mono);font-weight:500">'+a.address+'</td><td>'+fwd+'</td><td><span class="tag '+syncCls+'">'+a.syncStatus+'</span>'+(a.lastError?'<br><span style="font-size:.58rem;color:var(--red)">'+a.lastError+'</span>':'')+'</td><td style="color:var(--tm);font-size:.7rem">'+(a.note||'-')+'</td><td><div style="display:flex;gap:4px"><button class="btn btn-sm btn-g" onclick="showEdit(\\''+a.id+'\\')">Edit</button><button class="btn btn-sm btn-d" onclick="removeAlias(\\''+a.id+'\\',\\''+a.address+'\\')">Del</button></div></td>';
      tb.appendChild(tr);
    });
    document.getElementById('email-total').textContent=data.length;
    document.getElementById('email-active').textContent=activeC;
    document.getElementById('email-synced').textContent=syncedC;
    document.getElementById('email-pending').textContent=pendingC;
    document.getElementById('stat-emails').textContent=data.length;
  }).catch(function(){});
}

function addAlias(){
  var lp=document.getElementById('newLocal').value.trim().toLowerCase();
  var di=document.getElementById('newDest').value;
  var note=document.getElementById('newNote').value.trim();
  if(!lp){showToast('Enter alias local part','error');return}
  if(!/^[a-z0-9._-]+$/.test(lp)){showToast('Only lowercase letters, numbers, dots, dashes, underscores','error');return}
  if(!di){showToast('Select a destination','error');return}
  var destState = di === '__drop' ? 'drop' : 'active';
  var destId = di === '__drop' ? null : di;
  fetch('/api/admin/email/aliases',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({localPart:lp,destinationId:destId,note:note,desiredState:destState})})
    .then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})}).then(function(res){
      if(!res.ok){showToast(res.data.error||'Failed','error');return}
      showToast('Alias added!','success');
      document.getElementById('newLocal').value='';document.getElementById('newNote').value='';
      document.getElementById('aliasDestWarn').classList.remove('show');
      loadAliases();loadActivity();
    }).catch(function(){showToast('Failed to add alias','error')});
}

// Show warning when unverified destination is selected
document.getElementById('newDest').addEventListener('change', function(){
  var sel = this.value;
  var warn = document.getElementById('aliasDestWarn');
  if(sel && sel !== '__drop'){
    var dest = _destinations.find(function(d){return d.id === sel});
    if(dest && !dest.verified) { warn.classList.add('show'); return; }
  }
  warn.classList.remove('show');
});

function removeAlias(id,addr){
  showConfirm('Remove '+addr+'?','Alias will be deleted. Sync to Cloudflare to remove the route.',function(){
    fetch('/api/admin/email/aliases/'+id,{method:'DELETE'}).then(function(r){return r.json()}).then(function(d){
      if(d.error){showToast(d.error,'error');return}
      showToast('Alias removed','success');loadAliases();loadActivity();
    }).catch(function(){showToast('Failed','error')});
  });
}

function showEdit(id){
  var a = _aliases.find(function(x){return x.id===id});
  if(!a) return;
  document.getElementById('editAliasId').value=id;
  document.getElementById('editAliasAddr').textContent=a.address;
  document.getElementById('editNote').value=a.note||'';
  document.getElementById('editState').value=a.desiredState;
  if(a.desiredState==='drop') document.getElementById('editDest').value='__drop';
  else document.getElementById('editDest').value=a.destinationId||'';
  checkEditDestWarn();
  document.getElementById('editOverlay').classList.add('show');
}
document.getElementById('editDest').addEventListener('change', checkEditDestWarn);
document.getElementById('editState').addEventListener('change', checkEditDestWarn);
function checkEditDestWarn(){
  var sel = document.getElementById('editDest').value;
  var state = document.getElementById('editState').value;
  var warn = document.getElementById('editDestWarn');
  if(state==='drop' || sel==='__drop'){warn.classList.remove('show');return}
  if(sel){
    var dest = _destinations.find(function(d){return d.id===sel});
    if(dest && !dest.verified){warn.classList.add('show');return}
  }
  warn.classList.remove('show');
}

function saveEdit(){
  var id=document.getElementById('editAliasId').value;
  var destVal=document.getElementById('editDest').value;
  var state=document.getElementById('editState').value;
  if(destVal==='__drop')state='drop';
  var destId=destVal==='__drop'?null:(destVal||null);
  fetch('/api/admin/email/aliases/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({destinationId:destId,note:document.getElementById('editNote').value,desiredState:state})})
    .then(function(r){return r.json()}).then(function(d){
      if(d.error){showToast(d.error,'error');return}
      showToast('Alias updated','success');
      document.getElementById('editOverlay').classList.remove('show');
      loadAliases();loadActivity();
    }).catch(function(){showToast('Failed','error')});
}

/* ══════ Sync ══════ */
function syncToCF(btn){
  btn.classList.add('loading');
  document.getElementById('syncAlert').classList.remove('show');
  fetch('/api/admin/email/sync',{method:'POST'}).then(function(r){return r.json()}).then(function(d){
    btn.classList.remove('loading');
    if(d.error){showToast(d.error,'error');return}
    // Show blocked aliases warning
    if(d.blocked && d.blocked.length > 0){
      var sa=document.getElementById('syncAlert');
      sa.innerHTML='&#9888; <b>'+d.blocked.length+' alias(es) blocked</b> (destination not verified):<br>'+d.blocked.join(', ')+'<br>Verify the destination first, then sync again.';
      sa.classList.add('show');
    }
    var msg = d.message || 'Sync complete';
    if(d.synced !== undefined) msg += ' ('+d.synced+' synced, '+d.errors+' errors, '+d.blocked_count+' blocked)';
    showToast(msg,'success');
    document.getElementById('bannerSync').textContent='Last sync: '+new Date().toLocaleTimeString();
    loadAliases();loadActivity();
  }).catch(function(){btn.classList.remove('loading');showToast('Sync failed','error')});
}

function refreshFromCF(btn){
  btn.classList.add('loading');
  fetch('/api/admin/email/refresh',{method:'POST'}).then(function(r){return r.json()}).then(function(d){
    btn.classList.remove('loading');
    if(d.error){showToast(d.error,'error');return}
    showToast(d.message||'Refresh complete','success');loadAliases();loadActivity();
  }).catch(function(){btn.classList.remove('loading');showToast('Refresh failed','error')});
}

/* ══════ Activity ══════ */
function loadActivity(){
  var filter=document.getElementById('actFilter')?document.getElementById('actFilter').value:'';
  var url='/api/admin/activity'+(filter?'?filter='+filter:'');
  fetch(url).then(function(r){return r.json()}).then(function(data){
    var tb=document.getElementById('activityBody');tb.innerHTML='';
    if(!data.length){tb.innerHTML='<tr><td colspan="4" style="text-align:center;color:var(--td);padding:24px">No activity yet</td></tr>';return}
    data.slice(0,50).forEach(function(a){
      var tr=document.createElement('tr');
      var actionCls=a.action.startsWith('email')?'blue':a.action.startsWith('system')?'purple':'green';
      tr.innerHTML='<td style="font-size:.68rem;font-family:var(--mono);color:var(--tm)">'+new Date(a.ts).toLocaleString()+'</td><td><span class="tag '+actionCls+'">'+a.action+'</span></td><td style="font-size:.72rem">'+a.detail+'</td><td style="font-size:.68rem;color:var(--tm)">'+a.actor+'</td>';
      tb.appendChild(tr);
    });
    var rb=document.getElementById('recentActivityBody');if(rb){
      rb.innerHTML='';
      data.slice(0,5).forEach(function(a){
        var tr=document.createElement('tr');
        tr.innerHTML='<td style="font-size:.68rem;color:var(--tm)">'+new Date(a.ts).toLocaleString()+'</td><td><span class="tag muted" style="font-size:.58rem">'+a.action+'</span></td><td style="font-size:.72rem">'+a.detail+'</td>';
        rb.appendChild(tr);
      });
    }
  }).catch(function(){});
}

/* ══════ Banner sync time ══════ */
function loadSyncStatus(){
  fetch('/api/admin/status').then(function(r){return r.json()}).then(function(d){
    var bs=document.getElementById('bannerSync');
    if(d.lastSync){bs.textContent='Last sync: '+new Date(d.lastSync).toLocaleString()}
    else{bs.textContent='Last sync: not yet synced'}
    if(!d.cfConfigured){bs.textContent+=' (stub mode)'}
  }).catch(function(){});
}

/* ══════ Cmd+K Palette ══════ */
var paletteCommands=[
  {icon:'&#9678;',label:'Go to Overview',action:function(){clickTab('overview')}},
  {icon:'&#9889;',label:'Go to Services',action:function(){clickTab('services')}},
  {icon:'&#128451;',label:'Go to Database',action:function(){clickTab('database')}},
  {icon:'&#128200;',label:'Go to Monitoring',action:function(){clickTab('monitoring')}},
  {icon:'&#9993;',label:'Go to Email',action:function(){clickTab('email')}},
  {icon:'&#128203;',label:'Go to Activity',action:function(){clickTab('activity')}},
  {icon:'&#9881;',label:'Go to System',action:function(){clickTab('system')}},
  {icon:'&#8635;',label:'Refresh Health',action:function(){checkAllHealth()}},
  {icon:'&#9889;',label:'Sync Email to Cloudflare',action:function(){clickTab('email');setTimeout(function(){document.querySelector('[onclick*="syncToCF"]').click()},200)}},
  {icon:'&#128451;',label:'Open pgAdmin',action:function(){window.open('https://db.getouch.co','_blank')}},
  {icon:'&#128200;',label:'Open Grafana',action:function(){window.open('https://grafana.getouch.co','_blank')}},
  {icon:'&#9729;',label:'Open Cloudflare',action:function(){window.open('https://dash.cloudflare.com','_blank')}},
];
var paletteIdx=0;
function clickTab(name){var btn=document.querySelector('.tb[data-tab="'+name+'"]');if(btn)btn.click()}
function showPalette(){document.getElementById('paletteOverlay').classList.add('show');var inp=document.getElementById('paletteInput');inp.value='';inp.focus();paletteIdx=0;renderPalette(paletteCommands)}
function hidePalette(){document.getElementById('paletteOverlay').classList.remove('show')}
function renderPalette(cmds){var list=document.getElementById('paletteList');list.innerHTML='';cmds.forEach(function(c,i){var d=document.createElement('div');d.className='palette-item'+(i===paletteIdx?' selected':'');d.innerHTML='<span class="pi-icon">'+c.icon+'</span><span class="pi-label">'+c.label+'</span>';d.onclick=function(){c.action();hidePalette()};list.appendChild(d)})}
function filterPalette(){var q=document.getElementById('paletteInput').value.toLowerCase();var filtered=paletteCommands.filter(function(c){return c.label.toLowerCase().indexOf(q)>-1});paletteIdx=0;renderPalette(filtered)}
function paletteKey(e){var items=document.querySelectorAll('.palette-item');if(e.key==='Escape'){hidePalette();return}if(e.key==='ArrowDown'){e.preventDefault();paletteIdx=Math.min(paletteIdx+1,items.length-1)}if(e.key==='ArrowUp'){e.preventDefault();paletteIdx=Math.max(paletteIdx-1,0)}if(e.key==='Enter'){e.preventDefault();if(items[paletteIdx])items[paletteIdx].click();return}items.forEach(function(it,i){it.classList.toggle('selected',i===paletteIdx)});if(items[paletteIdx])items[paletteIdx].scrollIntoView({block:'nearest'})}
document.addEventListener('keydown',function(e){if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();showPalette()}if(e.key==='Escape')hidePalette()});
document.getElementById('paletteOverlay').addEventListener('click',function(e){if(e.target===this)hidePalette()});
document.querySelectorAll('.overlay').forEach(function(o){o.addEventListener('click',function(e){if(e.target===o)o.classList.remove('show')})});

/* ── Init ── */
checkAllHealth();
loadDests();
loadAliases();
loadActivity();
loadSyncStatus();
</script>
</body>
</html>`;


/* ================================================================
   HTTP SERVER
   ================================================================ */
function parseBody(req) {
  return new Promise(function(resolve, reject) {
    var body = '';
    req.on('data', function(c) { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', function() {
      try { resolve(JSON.parse(body)); } catch(e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async function(req, res) {
  var method = req.method;
  var url = (req.url || '/').split('?')[0];
  var query = {};
  if (req.url && req.url.indexOf('?') > -1) {
    req.url.split('?')[1].split('&').forEach(function(p) {
      var kv = p.split('=');
      query[kv[0]] = decodeURIComponent(kv[1] || '');
    });
  }

  function json(code, data) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  // ── Health ──
  if (url === '/health') {
    return json(200, { service: 'landing', status: 'ok', version: VERSION, timestamp: new Date().toISOString() });
  }

  // ══════════════════════════════════════════════════
  // EMAIL DESTINATIONS API
  // ══════════════════════════════════════════════════

  // GET /api/admin/email/destinations — list all destinations
  if (url === '/api/admin/email/destinations' && method === 'GET') {
    return json(200, emailDestinations);
  }

  // POST /api/admin/email/destinations — create + send CF verification
  if (url === '/api/admin/email/destinations' && method === 'POST') {
    try {
      var d = await parseBody(req);
      if (!d.label || !d.email) return json(400, { error: 'Label and email required' });
      if (!/^[^@]+@[^@]+\.[^@]+$/.test(d.email)) return json(400, { error: 'Invalid email address' });
      var exists = emailDestinations.some(function(x) { return x.email === d.email; });
      if (exists) return json(409, { error: 'Destination email already exists' });

      var nd = { id: uid(), label: d.label, email: d.email, cfDestinationId: null, verified: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };

      // Try Cloudflare API to create destination address
      if (CF_TOKEN && CF_ACCOUNT) {
        try {
          var cfRes = await cfAccountRequest('POST', '/email/routing/addresses', { email: d.email });
          if (cfRes.success && cfRes.result) {
            nd.cfDestinationId = cfRes.result.id;
            nd.verified = cfRes.result.verified ? true : false;
            logActivity('email.dest.add', 'Added destination via CF API: ' + d.label + ' (' + d.email + '). Verification email sent.');
          } else {
            // CF returned error — might be duplicate or invalid
            var cfErr = (cfRes.errors && cfRes.errors[0] && cfRes.errors[0].message) || 'Unknown Cloudflare error';
            // If already exists on CF side, still add locally
            if (cfErr.indexOf('already') > -1 || cfErr.indexOf('exist') > -1) {
              logActivity('email.dest.add', 'Added destination locally (already exists in CF): ' + d.email);
            } else {
              logActivity('email.dest.add.warn', 'CF API error for ' + d.email + ': ' + cfErr + '. Added locally.');
            }
          }
        } catch(cfE) {
          logActivity('email.dest.add.warn', 'CF API call failed: ' + cfE.message + '. Added locally.');
        }
      } else {
        logActivity('email.dest.add', 'Added destination (stub mode): ' + d.label + ' (' + d.email + ')');
      }

      emailDestinations.push(nd);
      return json(201, { destination: nd, message: 'Destination added. Verification email sent to ' + d.email + '. Check inbox and click the Cloudflare verification link.' });
    } catch(e) { return json(400, { error: 'Invalid request body' }); }
  }

  // POST /api/admin/email/destinations/:id/resend — resend verification
  if (url.match(/^\/api\/admin\/email\/destinations\/[^/]+\/resend$/) && method === 'POST') {
    var did = url.split('/')[5];
    var dest = emailDestinations.find(function(x) { return x.id === did; });
    if (!dest) return json(404, { error: 'Destination not found' });
    if (dest.verified) return json(400, { error: 'Already verified' });

    if (CF_TOKEN && CF_ACCOUNT) {
      try {
        // Delete and re-create to resend verification
        if (dest.cfDestinationId) {
          await cfAccountRequest('DELETE', '/email/routing/addresses/' + dest.cfDestinationId);
        }
        var cfRes = await cfAccountRequest('POST', '/email/routing/addresses', { email: dest.email });
        if (cfRes.success && cfRes.result) {
          dest.cfDestinationId = cfRes.result.id;
          dest.updatedAt = new Date().toISOString();
        }
        logActivity('email.dest.resend', 'Resent verification to ' + dest.email);
      } catch(e) {
        logActivity('email.dest.resend.error', 'Failed to resend: ' + e.message);
        return json(500, { error: 'Failed to resend: ' + e.message });
      }
    } else {
      logActivity('email.dest.resend', 'Resend verification (stub mode): ' + dest.email);
    }
    return json(200, { ok: true, message: 'Verification email resent to ' + dest.email });
  }

  // POST /api/admin/email/destinations/refresh — refresh verification statuses from CF
  if (url === '/api/admin/email/destinations/refresh' && method === 'POST') {
    if (!CF_TOKEN || !CF_ACCOUNT) {
      // Stub mode: mark all as verified
      emailDestinations.forEach(function(d) { d.verified = true; d.updatedAt = new Date().toISOString(); });
      logActivity('email.dest.refresh', 'Verification refresh (stub mode) — all marked verified');
      return json(200, { message: 'Refresh complete (stub mode). All destinations marked verified.' });
    }
    try {
      var cfRes = await cfAccountRequest('GET', '/email/routing/addresses?per_page=50', null);
      if (!cfRes.success) throw new Error('CF API returned error');
      var cfDests = cfRes.result || [];
      var updated = 0;
      emailDestinations.forEach(function(d) {
        var match = cfDests.find(function(cd) { return cd.email === d.email; });
        if (match) {
          var wasVerified = d.verified;
          d.cfDestinationId = match.id;
          d.verified = match.verified === true;
          d.updatedAt = new Date().toISOString();
          if (!wasVerified && d.verified) updated++;
        }
      });
      logActivity('email.dest.refresh', 'Refreshed from Cloudflare. ' + cfDests.length + ' destinations found, ' + updated + ' newly verified.');
      return json(200, { message: 'Refresh complete. ' + updated + ' destination(s) newly verified.', total: cfDests.length });
    } catch(e) {
      logActivity('email.dest.refresh.error', 'Refresh failed: ' + e.message);
      return json(500, { error: 'Refresh failed: ' + e.message });
    }
  }

  // DELETE /api/admin/email/destinations/:id — remove destination
  if (url.indexOf('/api/admin/email/destinations/') === 0 && !url.includes('/resend') && !url.includes('/refresh') && method === 'DELETE') {
    var did = url.split('/').pop();
    var di = emailDestinations.findIndex(function(x) { return x.id === did; });
    if (di === -1) return json(404, { error: 'Not found' });
    // Check if in-use
    var inUse = emailAliases.filter(function(a) { return a.destinationId === did && a.desiredState !== 'drop'; });
    if (inUse.length > 0) {
      return json(409, { error: 'Destination is used by ' + inUse.length + ' alias(es): ' + inUse.map(function(a){return a.address}).join(', ') + '. Reassign or delete them first.' });
    }
    var removed = emailDestinations.splice(di, 1)[0];
    // Optionally delete from Cloudflare
    if (CF_TOKEN && CF_ACCOUNT && removed.cfDestinationId) {
      cfAccountRequest('DELETE', '/email/routing/addresses/' + removed.cfDestinationId).catch(function(){});
    }
    logActivity('email.dest.remove', 'Removed destination: ' + removed.label + ' (' + removed.email + ')');
    return json(200, { ok: true });
  }

  // ══════════════════════════════════════════════════
  // EMAIL ALIASES API
  // ══════════════════════════════════════════════════

  if (url === '/api/admin/email/aliases' && method === 'GET') {
    return json(200, emailAliases.map(aliasWithDest));
  }

  if (url === '/api/admin/email/aliases' && method === 'POST') {
    try {
      var d = await parseBody(req);
      if (!d.localPart) return json(400, { error: 'localPart required' });
      var lp = d.localPart.toLowerCase().replace(/[^a-z0-9._-]/g, '');
      if (!lp) return json(400, { error: 'Invalid local part' });
      if (RESERVED.indexOf(lp) > -1 && !d.overrideReserved) {
        return json(400, { error: lp + ' is a reserved address. Set overrideReserved:true to force.' });
      }
      var addr = lp + '@' + EMAIL_DOMAIN;
      var exists = emailAliases.some(function(a) { return a.address === addr; });
      if (exists) return json(409, { error: 'Alias ' + addr + ' already exists' });

      var state = d.desiredState || 'active';
      var syncSt = 'pending';

      // Check destination verification for non-drop aliases
      if (state !== 'drop' && d.destinationId) {
        var dest = findDest(d.destinationId);
        if (dest && !dest.verified) {
          syncSt = 'blocked';
        }
      }

      var na = {
        id: uid(), localPart: lp, address: addr,
        destinationId: d.destinationId || null, note: d.note || '',
        desiredState: state, syncStatus: syncSt,
        lastSyncAt: null, lastError: syncSt === 'blocked' ? 'Destination not verified' : null,
        createdAt: new Date().toISOString()
      };
      emailAliases.push(na);
      logActivity('email.alias.add', 'Created alias: ' + addr + (syncSt === 'blocked' ? ' (blocked: dest not verified)' : ''));
      return json(201, aliasWithDest(na));
    } catch(e) { return json(400, { error: 'Invalid request' }); }
  }

  if (url.indexOf('/api/admin/email/aliases/') === 0 && method === 'PATCH') {
    var aid = url.split('/').pop();
    var alias = emailAliases.find(function(a) { return a.id === aid; });
    if (!alias) return json(404, { error: 'Alias not found' });
    try {
      var d = await parseBody(req);
      if (d.destinationId !== undefined) alias.destinationId = d.destinationId;
      if (d.note !== undefined) alias.note = d.note;
      if (d.desiredState !== undefined) alias.desiredState = d.desiredState;

      // Re-evaluate sync status
      if (alias.desiredState !== 'drop' && alias.destinationId) {
        var dest = findDest(alias.destinationId);
        if (dest && !dest.verified) {
          alias.syncStatus = 'blocked';
          alias.lastError = 'Destination not verified';
        } else {
          alias.syncStatus = 'pending';
          alias.lastError = null;
        }
      } else {
        alias.syncStatus = 'pending';
        alias.lastError = null;
      }

      logActivity('email.alias.edit', 'Updated alias: ' + alias.address);
      return json(200, aliasWithDest(alias));
    } catch(e) { return json(400, { error: 'Invalid request' }); }
  }

  if (url.indexOf('/api/admin/email/aliases/') === 0 && method === 'DELETE') {
    var aid = url.split('/').pop();
    var ai = emailAliases.findIndex(function(a) { return a.id === aid; });
    if (ai === -1) return json(404, { error: 'Alias not found' });
    var removed = emailAliases.splice(ai, 1)[0];
    logActivity('email.alias.remove', 'Removed alias: ' + removed.address);
    return json(200, { ok: true });
  }

  // ══════════════════════════════════════════════════
  // EMAIL SYNC / REFRESH
  // ══════════════════════════════════════════════════

  if (url === '/api/admin/email/sync' && method === 'POST') {
    var blockedAliases = [];
    var syncableAliases = [];

    // Separate blocked (unverified dest) from syncable
    emailAliases.forEach(function(a) {
      if (a.desiredState === 'drop') {
        syncableAliases.push(a);
      } else if (a.destinationId) {
        var dest = findDest(a.destinationId);
        if (!dest || !dest.verified) {
          blockedAliases.push(a);
          a.syncStatus = 'blocked';
          a.lastError = 'Destination not verified';
        } else {
          syncableAliases.push(a);
        }
      } else {
        blockedAliases.push(a);
        a.syncStatus = 'blocked';
        a.lastError = 'No destination assigned';
      }
    });

    if (!CF_TOKEN || !CF_ZONE) {
      syncableAliases.forEach(function(a) {
        a.syncStatus = 'synced'; a.lastSyncAt = new Date().toISOString(); a.lastError = null;
      });
      lastGlobalSync = new Date().toISOString();
      logActivity('email.sync', 'Sync completed (stub mode). ' + syncableAliases.length + ' synced, ' + blockedAliases.length + ' blocked.');
      return json(200, {
        message: 'Sync completed (stub mode).',
        synced: syncableAliases.length, errors: 0,
        blocked_count: blockedAliases.length,
        blocked: blockedAliases.map(function(a) { return a.address + ' (' + (a.lastError || 'unknown') + ')'; })
      });
    }

    try {
      var existing = await cfZoneRequest('GET', '/email/routing/rules', null);
      var cfRules = (existing.result || []);
      var errorCount = 0;

      for (var i = 0; i < syncableAliases.length; i++) {
        var alias = syncableAliases[i];
        var dest = findDest(alias.destinationId);
        var cfRule = cfRules.find(function(r) {
          return r.matchers && r.matchers.some(function(m) { return m.type === 'literal' && m.value === alias.address; });
        });
        try {
          var ruleBody;
          if (alias.desiredState === 'drop') {
            ruleBody = { matchers: [{ type: 'literal', field: 'to', value: alias.address }], actions: [{ type: 'drop' }], enabled: true, name: alias.address + ' (drop)' };
          } else if (dest) {
            ruleBody = { matchers: [{ type: 'literal', field: 'to', value: alias.address }], actions: [{ type: 'forward', value: [dest.email] }], enabled: true, name: alias.address + ' -> ' + dest.email };
          } else {
            alias.syncStatus = 'error'; alias.lastError = 'No destination';
            errorCount++; continue;
          }
          if (cfRule) await cfZoneRequest('PUT', '/email/routing/rules/' + cfRule.id, ruleBody);
          else await cfZoneRequest('POST', '/email/routing/rules', ruleBody);
          alias.syncStatus = 'synced';
          alias.lastSyncAt = new Date().toISOString();
          alias.lastError = null;
        } catch(e) {
          alias.syncStatus = 'error';
          alias.lastError = e.message || 'Unknown error';
          errorCount++;
        }
      }
      lastGlobalSync = new Date().toISOString();
      logActivity('email.sync', 'Cloudflare sync: ' + (syncableAliases.length - errorCount) + ' synced, ' + errorCount + ' errors, ' + blockedAliases.length + ' blocked');
      return json(200, {
        message: 'Sync completed',
        synced: syncableAliases.length - errorCount, errors: errorCount,
        blocked_count: blockedAliases.length,
        blocked: blockedAliases.map(function(a) { return a.address + ' (' + (a.lastError || 'unknown') + ')'; })
      });
    } catch(e) {
      logActivity('email.sync.error', 'Sync failed: ' + e.message);
      return json(500, { error: 'Sync failed: ' + e.message });
    }
  }

  if (url === '/api/admin/email/refresh' && method === 'POST') {
    if (!CF_TOKEN || !CF_ZONE) {
      logActivity('email.refresh', 'Refresh skipped (stub mode)');
      return json(200, { message: 'Refresh skipped (stub mode). Configure CF credentials for real refresh.' });
    }
    try {
      var existing = await cfZoneRequest('GET', '/email/routing/rules', null);
      var cfRules = (existing.result || []);
      emailAliases.forEach(function(alias) {
        var cfRule = cfRules.find(function(r) {
          return r.matchers && r.matchers.some(function(m) { return m.value === alias.address; });
        });
        if (!cfRule) { alias.syncStatus = 'pending'; return; }
        var dest = findDest(alias.destinationId);
        if (alias.desiredState === 'drop') {
          alias.syncStatus = cfRule.actions && cfRule.actions.some(function(a) { return a.type === 'drop'; }) ? 'synced' : 'mismatch';
        } else if (dest) {
          var cfDest = cfRule.actions && cfRule.actions.find(function(a) { return a.type === 'forward'; });
          alias.syncStatus = (cfDest && cfDest.value && cfDest.value.indexOf(dest.email) > -1) ? 'synced' : 'mismatch';
        }
        alias.lastSyncAt = new Date().toISOString();
      });
      logActivity('email.refresh', 'Refreshed from CF: ' + cfRules.length + ' rules found');
      return json(200, { message: 'Refresh complete', rules: cfRules.length });
    } catch(e) {
      logActivity('email.refresh.error', 'Refresh failed: ' + e.message);
      return json(500, { error: 'Refresh failed: ' + e.message });
    }
  }

  // ── Activity Log API ──
  if (url === '/api/admin/activity' && method === 'GET') {
    var filtered = activityLog;
    if (query.filter) {
      filtered = activityLog.filter(function(a) { return a.action.indexOf(query.filter) > -1; });
    }
    return json(200, filtered);
  }
  if (url === '/api/admin/activity' && method === 'DELETE') {
    activityLog.length = 0;
    logActivity('system.clear_log', 'Activity log cleared');
    return json(200, { ok: true });
  }

  // ── Admin Status API ──
  if (url === '/api/admin/status' && method === 'GET') {
    return json(200, {
      environment: 'production',
      version: VERSION,
      aliases: emailAliases.length,
      destinations: emailDestinations.length,
      cfConfigured: !!(CF_TOKEN && CF_ZONE),
      lastSync: lastGlobalSync,
      timestamp: new Date().toISOString()
    });
  }

  // ── Admin pages ──
  if (url === '/admin') {
    res.writeHead(302, { Location: '/admin/' });
    return res.end();
  }
  if (url.indexOf('/admin/') === 0 || url === '/admin') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(adminHtml);
  }

  // ── Landing page ──
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(landingHtml);
});

server.listen(PORT, '0.0.0.0', function() {
  console.log('[landing] v' + VERSION + ' on port ' + PORT);
  console.log('[landing] Cloudflare integration: ' + (CF_TOKEN && CF_ZONE ? 'ENABLED' : 'STUB MODE'));
  console.log('[landing] CF Account API: ' + (CF_TOKEN && CF_ACCOUNT ? 'ENABLED' : 'NOT CONFIGURED'));
});
