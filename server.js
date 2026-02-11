/**
 * DZ34SNI Server v3.0 — with OZ Reverse Proxy
 * 
 * Flow:
 * 1. Agent captures userId + transactionId + realIp → POST /task/:phone
 * 2. APK polls GET /task/:phone → receives task
 * 3. APK loads /oz-page → page loads OZ SDK via /oz-proxy/
 * 4. ALL ozforensics requests go through /oz-proxy/ with Agent's IP
 * 5. APK POSTs result to /result/:phone
 * 6. Agent polls GET /result/:phone → injects session_id
 */

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════
app.use(cors());

// Parse JSON for normal routes, but NOT for /oz-proxy (needs raw body)
app.use((req, res, next) => {
    if (req.path.startsWith('/oz-proxy/')) {
        // Collect raw body for proxy forwarding
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            req.rawBody = Buffer.concat(chunks);
            next();
        });
    } else {
        express.json({ limit: '10mb' })(req, res, next);
    }
});
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
    const ts = new Date().toISOString().substring(11, 19);
    if (!req.path.startsWith('/oz-proxy/')) {
        console.log(`[${ts}] ${req.method} ${req.path}`);
    }
    next();
});

// ═══════════════════════════════════════════
// STORAGE
// ═══════════════════════════════════════════
const tasks = {};
const results = {};
const phoneIpMap = {};

setInterval(() => {
    const now = Date.now();
    const MAX = 30 * 60 * 1000;
    for (const p in tasks) { if (now - (tasks[p].timestamp || 0) > MAX) { delete tasks[p]; delete phoneIpMap[p]; } }
    for (const p in results) { if (now - (results[p].timestamp || 0) > MAX) { delete results[p]; } }
}, 5 * 60 * 1000);

// ═══════════════════════════════════════════
// TASK ROUTES
// ═══════════════════════════════════════════

app.post('/task/:phone', (req, res) => {
    const phone = req.params.phone;
    const body = req.body || {};
    if (!body.userId || !body.transactionId) {
        return res.status(400).json({ ok: false, error: 'Missing userId or transactionId' });
    }
    tasks[phone] = {
        userId: body.userId,
        transactionId: body.transactionId,
        realIp: body.realIp || '',
        cookies: body.cookies || '',
        userAgent: body.userAgent || '',
        pageUrl: body.pageUrl || '',
        verificationToken: body.verificationToken || '',
        timestamp: body.timestamp || Date.now()
    };
    if (body.realIp) phoneIpMap[phone] = body.realIp;
    console.log(`[TASK] 📥 ${phone}: userId=${body.userId.substring(0, 20)}... realIp=${body.realIp || 'none'}`);
    res.json({ ok: true });
});

app.get('/task/:phone', (req, res) => {
    const phone = req.params.phone;
    const task = tasks[phone];
    if (task) {
        console.log(`[TASK] 📤 ${phone}: sending task`);
        res.json({ ok: true, task });
    } else {
        res.json({ ok: false, task: null });
    }
});

// ═══════════════════════════════════════════
// RESULT ROUTES
// ═══════════════════════════════════════════

app.post('/result/:phone', (req, res) => {
    const phone = req.params.phone;
    const body = req.body || {};
    if (!body.event_session_id) {
        return res.status(400).json({ ok: false, error: 'Missing event_session_id' });
    }
    results[phone] = {
        event_session_id: body.event_session_id,
        status: body.status || 'completed',
        realIp: body.realIp || '',
        timestamp: body.timestamp || Date.now()
    };
    delete tasks[phone];
    console.log(`[RESULT] ✅ ${phone}: session=${body.event_session_id.substring(0, 20)}...`);
    res.json({ ok: true });
});

app.get('/result/:phone', (req, res) => {
    const phone = req.params.phone;
    const result = results[phone];
    if (result) res.json({ ok: true, result });
    else res.json({ ok: false, result: null });
});

// ═══════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════

app.delete('/clear/:phone', (req, res) => {
    const phone = req.params.phone;
    delete tasks[phone]; delete results[phone]; delete phoneIpMap[phone];
    console.log(`[CLEAR] 🗑️ ${phone}`);
    res.json({ ok: true });
});

// ═══════════════════════════════════════════
// OZ REVERSE PROXY
// ═══════════════════════════════════════════

// CORS preflight
app.options('/oz-proxy/*', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).end();
});

app.all('/oz-proxy/:phone/*', async (req, res) => {
    const phone = req.params.phone;
    const realIp = phoneIpMap[phone] || '';
    const serverUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const proxyBase = `${serverUrl}/oz-proxy/${encodeURIComponent(phone)}/`;
    
    // Build target URL
    const targetPath = req.params[0] || '';
    // Remove any query string that Express might have parsed
    const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    const targetUrl = 'https://' + targetPath + qs;
    
    console.log(`[OZ-PROXY] ${req.method} → ${targetUrl.substring(0, 100)} (IP: ${realIp})`);

    try {
        // Build proxy headers
        const proxyHeaders = {};
        const fwd = ['accept', 'accept-language', 'content-type', 'cache-control', 'pragma',
                      'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
                      'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site'];
        for (const h of fwd) {
            if (req.headers[h]) proxyHeaders[h] = req.headers[h];
        }

        proxyHeaders['User-Agent'] = 'Mozilla/5.0 (Android 13; Mobile; rv:120.0) Gecko/120.0 Firefox/120.0';
        proxyHeaders['Referer'] = 'https://algeria.blsspainglobal.com/dza/appointment/LivenessRequest';
        proxyHeaders['Origin'] = 'https://algeria.blsspainglobal.com';
        
        if (realIp) {
            proxyHeaders['X-Forwarded-For'] = realIp;
            proxyHeaders['X-Real-IP'] = realIp;
        }

        const fetchOpts = {
            method: req.method,
            headers: proxyHeaders,
            redirect: 'follow',
            timeout: 60000
        };

        // Forward body for POST/PUT/PATCH
        if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.rawBody && req.rawBody.length > 0) {
            fetchOpts.body = req.rawBody;
            if (req.headers['content-length']) {
                proxyHeaders['content-length'] = String(req.rawBody.length);
            }
        }

        const proxyRes = await fetch(targetUrl, fetchOpts);
        
        // Get content type to decide if we need to rewrite URLs in response
        const contentType = proxyRes.headers.get('content-type') || '';
        const isTextContent = contentType.includes('text/') || 
                              contentType.includes('javascript') || 
                              contentType.includes('json') ||
                              contentType.includes('xml');

        // Forward response headers
        const skip = new Set(['transfer-encoding', 'connection', 'keep-alive', 'content-encoding', 'content-length']);
        proxyRes.headers.forEach((value, name) => {
            if (!skip.has(name.toLowerCase())) {
                res.setHeader(name, value);
            }
        });

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');

        let body = await proxyRes.buffer();

        // For text content (JS, HTML, CSS), rewrite ozforensics.com URLs to go through proxy
        if (isTextContent && body.length > 0) {
            let text = body.toString('utf-8');
            
            // Rewrite all https://xxx.ozforensics.com URLs to proxy
            text = text.replace(/https?:\/\/([a-z0-9\-\.]*ozforensics\.com)/gi, (match, domain) => {
                return proxyBase + domain;
            });
            
            body = Buffer.from(text, 'utf-8');
        }

        res.status(proxyRes.status);
        res.setHeader('Content-Length', body.length);
        res.send(body);

        console.log(`[OZ-PROXY] ← ${proxyRes.status} ${contentType.substring(0, 30)} (${body.length}b)`);

    } catch (err) {
        console.error(`[OZ-PROXY] ERROR: ${err.message}`);
        res.status(502).json({ error: 'Proxy error', message: err.message });
    }
});

// ═══════════════════════════════════════════
// OZ-PAGE
// ═══════════════════════════════════════════

app.get('/oz-page', (req, res) => {
    const { userId, transactionId, realIp, phone } = req.query;
    
    const esc = (s) => (s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/</g, '\\x3c').replace(/>/g, '\\x3e');
    const uid = esc(userId);
    const tid = esc(transactionId);
    const ip = esc(realIp);
    const ph = esc(phone);

    if (phone && realIp) phoneIpMap[phone] = realIp;

    const serverUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const proxyBase = `${serverUrl}/oz-proxy/${encodeURIComponent(phone || '')}`;

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>BLS Liveness</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0f172a;font-family:system-ui,sans-serif;min-height:100vh}
.ld{position:fixed;inset:0;z-index:9999;background:#0f172a;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff}
.ld .logo{width:70px;height:70px;border-radius:50%;background:linear-gradient(135deg,#dc2626,#b91c1c);display:flex;align-items:center;justify-content:center;margin-bottom:16px;box-shadow:0 8px 32px rgba(220,38,38,.4)}
.ld .logo span{font-size:32px;font-weight:900}
.ld h2{font-size:18px;font-weight:700;margin-bottom:8px}
.ld p{font-size:13px;color:#94a3b8}
.ld-spin{width:40px;height:40px;border:4px solid rgba(255,255,255,.1);border-top-color:#0d9488;border-radius:50%;animation:sp .8s linear infinite;margin-top:20px}
@keyframes sp{to{transform:rotate(360deg)}}
#k2-ok{position:fixed;inset:0;z-index:2147483647;display:none;flex-direction:column;align-items:center;justify-content:center;background:linear-gradient(135deg,#059669,#0d9488,#0891b2);text-align:center;padding:30px}
.chk{width:100px;height:100px;border-radius:50%;background:rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;margin-bottom:20px;animation:pop .5s ease-out}
@keyframes pop{0%{transform:scale(0);opacity:0}70%{transform:scale(1.2)}100%{transform:scale(1);opacity:1}}
.btn-ret{background:rgba(255,255,255,.2);color:#fff;border:2px solid rgba(255,255,255,.4);padding:14px 32px;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer;margin-top:16px}
.ozliveness_logo,.ozliveness_version{display:none!important}
#dbg{position:fixed;bottom:0;left:0;right:0;background:rgba(0,0,0,.8);color:#0f0;font:10px monospace;padding:4px 8px;z-index:99999;max-height:80px;overflow-y:auto;display:none}
</style>
</head>
<body>

<div class="ld" id="ld">
    <div class="logo"><span>D</span></div>
    <h2 id="ld-text">Chargement du selfie...</h2>
    <p>Preparez votre visage face a la camera</p>
    <div class="ld-spin"></div>
</div>

<div id="k2-ok">
    <div class="chk"><span style="font-size:50px;color:#fff">&#10003;</span></div>
    <p style="font-size:28px;font-weight:900;color:#fff;margin-bottom:8px">SELFIE FAIT AVEC SUCCES</p>
    <p style="font-size:16px;color:rgba(255,255,255,.8);margin-bottom:6px">\u062a\u0645 \u0627\u0644\u062a\u0642\u0627\u0637 \u0627\u0644\u0633\u064a\u0644\u0641\u064a \u0628\u0646\u062c\u0627\u062d</p>
    <p style="font-size:15px;color:rgba(255,255,255,.9);font-weight:700;margin-bottom:10px">
        Retour dans <span id="k2-c" style="background:rgba(255,255,255,.2);padding:4px 14px;border-radius:8px;font-size:22px">10</span>s
    </p>
    <button class="btn-ret" onclick="goBack()">RETOUR PAGE PRINCIPALE</button>
</div>

<div id="dbg"></div>

<!-- Intercept ALL ozforensics URLs → route through server proxy -->
<script>
(function(){
    var PHONE = '${ph}';
    var PROXY_BASE = '${proxyBase}/';
    
    function rewriteUrl(url) {
        if (typeof url !== 'string') return url;
        var m = url.match(/^https?:\\/\\/([a-z0-9\\-\\.]*ozforensics\\.com)(\\/.*)$/i);
        if (m) return PROXY_BASE + m[1] + m[2];
        return url;
    }
    
    // Override fetch
    var _fetch = window.fetch;
    window.fetch = function(input, init) {
        if (typeof input === 'string') {
            var nw = rewriteUrl(input);
            if (nw !== input) { dbg('fetch: ' + input.substring(0,60) + ' → proxy'); input = nw; }
        } else if (input && input.url) {
            var nw2 = rewriteUrl(input.url);
            if (nw2 !== input.url) { input = new Request(nw2, input); }
        }
        return _fetch.call(this, input, init);
    };
    
    // Override XMLHttpRequest
    var _xo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        var nw = rewriteUrl(url);
        if (nw !== url) dbg('xhr: ' + url.substring(0,60) + ' → proxy');
        arguments[1] = nw;
        return _xo.apply(this, arguments);
    };
    
    // Override dynamic script creation
    var _ce = document.createElement.bind(document);
    document.createElement = function(tag) {
        var el = _ce(tag);
        if (tag.toLowerCase() === 'script') {
            var pd = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
            if (pd && pd.set) {
                Object.defineProperty(el, 'src', {
                    set: function(v) { pd.set.call(this, rewriteUrl(v)); },
                    get: function() { return pd.get.call(this); },
                    configurable: true
                });
            }
        }
        if (tag.toLowerCase() === 'link') {
            var pd2 = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, 'href');
            if (pd2 && pd2.set) {
                Object.defineProperty(el, 'href', {
                    set: function(v) { pd2.set.call(this, rewriteUrl(v)); },
                    get: function() { return pd2.get.call(this); },
                    configurable: true
                });
            }
        }
        return el;
    };
    
    // Override Image
    var _Img = window.Image;
    window.Image = function(w, h) {
        var img = new _Img(w, h);
        var pd = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
        if (pd && pd.set) {
            Object.defineProperty(img, 'src', {
                set: function(v) { pd.set.call(this, rewriteUrl(v)); },
                get: function() { return pd.get.call(this); },
                configurable: true
            });
        }
        return img;
    };

    // Debug log
    function dbg(m) {
        console.log('[OZ-PROXY] ' + m);
        var d = document.getElementById('dbg');
        if (d) { d.style.display = 'block'; d.textContent += m + '\\n'; d.scrollTop = d.scrollHeight; }
    }
    
    dbg('Proxy intercept ready: ' + PROXY_BASE);
})();
</script>

<form id="formLiveness" method="post" action="/DZA/appointment/LivenessResponse">
    <input type="hidden" name="event_session_id" id="event_session_id" value="">
    <input type="hidden" name="LivenessId" id="LivenessId" value="">
</form>

<!-- Load OZ SDK via server proxy -->
<script src="${proxyBase}/web-sdk.prod.cdn.spain.ozforensics.com/blsinternational/plugin_liveness.php"></script>

<!-- Launch liveness after SDK loads -->
<script>
var __phone = '${ph}';
var __server = '${serverUrl}';
var __realIp = '${ip}';
var __sent = false;

function goBack() {
    try { __dz34sni_bridge.onGoHome(); } catch(e) {
        window.history.back();
    }
}

function showOK() {
    var ld = document.getElementById('ld'); if (ld) ld.style.display = 'none';
    var ok = document.getElementById('k2-ok'); if (ok) ok.style.display = 'flex';
    var c = document.getElementById('k2-c'), n = 10;
    var t = setInterval(function() {
        n--; if (c) c.textContent = String(n);
        if (n <= 0) { clearInterval(t); goBack(); }
    }, 1000);
}

function postResult(sid) {
    if (__sent) return; __sent = true;
    try { __dz34sni_bridge.onStatus('Envoi resultat...'); } catch(e) {}
    var url = __server + '/result/' + encodeURIComponent(__phone);
    var body = JSON.stringify({ event_session_id: sid, status: 'completed', realIp: __realIp, timestamp: Date.now() });
    function go(n) {
        fetch(url, { method: 'POST', headers: {'Content-Type':'application/json'}, body: body, cache: 'no-store' })
            .then(function() { try { __dz34sni_bridge.onResult(sid); } catch(e) {} })
            .catch(function() { if (n < 5) setTimeout(function() { go(n+1); }, 2000); });
    }
    go(0);
}

// Check if SDK loaded
function checkAndLaunch() {
    var ldText = document.getElementById('ld-text');
    
    if (typeof OzLiveness === 'undefined') {
        if (ldText) ldText.textContent = 'SDK non charge - verifiez la connexion';
        console.log('[DZ34SNI] OzLiveness undefined, retrying in 3s...');
        setTimeout(checkAndLaunch, 3000);
        return;
    }
    
    if (ldText) ldText.textContent = 'Demarrage selfie...';
    console.log('[DZ34SNI] OzLiveness found! Launching...');
    try { __dz34sni_bridge.onStatus('Selfie en cours...'); } catch(e) {}

    var ld = document.getElementById('ld'); if (ld) ld.style.display = 'none';
    
    try {
        OzLiveness.open({
            lang: 'en',
            meta: { 'user_id': '${uid}', 'transaction_id': '${tid}' },
            overlay_options: false,
            action: ['video_selfie_blank'],
            result_mode: 'safe',
            on_complete: function(r) {
                var sid = r && r.event_session_id ? String(r.event_session_id) : '';
                console.log('[DZ34SNI] OZ complete: ' + sid);
                if (sid) {
                    try { document.getElementById('LivenessId').value = sid; } catch(e) {}
                    postResult(sid);
                    showOK();
                }
            },
            on_error: function(e) {
                console.log('[DZ34SNI] OZ error: ' + JSON.stringify(e));
                try { __dz34sni_bridge.onError('OZ:' + (e && e.message || JSON.stringify(e))); } catch(x) {}
            }
        });
    } catch(e) {
        console.log('[DZ34SNI] SDK error: ' + e.message);
        try { __dz34sni_bridge.onError('SDK:' + e.message); } catch(x) {}
    }
}

// Start after page loads
window.addEventListener('load', function() {
    setTimeout(checkAndLaunch, 2000);
});
</script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
});

// ═══════════════════════════════════════════
// CATCH-ALL for /DZA/* paths
// ═══════════════════════════════════════════
app.all('/DZA/*', (req, res) => res.redirect('/oz-done'));
app.all('/dza/*', (req, res) => res.redirect('/oz-done'));

app.get('/oz-done', (req, res) => {
    res.send('<html><body style="background:#0f172a;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui"><h1>Done</h1></body></html>');
});

// ═══════════════════════════════════════════
// HEALTH
// ═══════════════════════════════════════════
app.get('/', (req, res) => {
    res.json({
        service: 'DZ34SNI', version: '3.0', status: 'running',
        features: ['task-relay', 'result-relay', 'oz-proxy'],
        activeTasks: Object.keys(tasks).length,
        activeResults: Object.keys(results).length,
        uptime: Math.floor(process.uptime()) + 's'
    });
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/debug', (req, res) => {
    res.json({
        tasks: Object.keys(tasks).map(p => ({ phone: p, userId: (tasks[p].userId || '').substring(0, 10) + '...', realIp: tasks[p].realIp })),
        results: Object.keys(results).map(p => ({ phone: p, sid: (results[p].event_session_id || '').substring(0, 10) + '...' })),
        ipMap: phoneIpMap
    });
});

// ═══════════════════════════════════════════
// START
// ═══════════════════════════════════════════
app.listen(PORT, () => {
    console.log(`\n🐉 DZ34SNI Server v3.0 — with OZ Proxy`);
    console.log(`   Port: ${PORT}`);
    console.log(`   Ready!\n`);
});
