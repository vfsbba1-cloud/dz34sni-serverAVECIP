/**
 * DZ34SNI Server v3.0 — with OZ Reverse Proxy
 * Deploy on Render: https://dz34sni-26.onrender.com
 * 
 * NEW in v3: /oz-proxy/* endpoint
 * All OZ SDK API requests are routed through the server.
 * The server adds X-Forwarded-For header with the Agent's realIp.
 * This way OZ Forensics sees the Agent's IP, not the phone's IP.
 *
 * Flow:
 * 1. Agent captures userId + transactionId + realIp → POST /task/:phone
 * 2. APK polls GET /task/:phone → receives task
 * 3. APK loads /oz-page?... → page uses OZ SDK
 * 4. OZ SDK requests go to /oz-proxy/* instead of ozforensics.com directly
 * 5. Server proxies to ozforensics.com with X-Forwarded-For: realIp
 * 6. APK POSTs result to /result/:phone
 * 7. Agent polls GET /result/:phone → injects session_id
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
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
    const ts = new Date().toISOString().substring(11, 19);
    console.log(`[${ts}] ${req.method} ${req.path}`);
    next();
});

// ═══════════════════════════════════════════
// IN-MEMORY STORAGE
// ═══════════════════════════════════════════
const tasks = {};
const results = {};

// Store realIp per phone for proxy use
const phoneIpMap = {};

setInterval(() => {
    const now = Date.now();
    const MAX_AGE = 30 * 60 * 1000;
    for (const phone in tasks) {
        if (now - (tasks[phone].timestamp || 0) > MAX_AGE) {
            delete tasks[phone]; delete phoneIpMap[phone];
            console.log(`[CLEANUP] Task removed: ${phone}`);
        }
    }
    for (const phone in results) {
        if (now - (results[phone].timestamp || 0) > MAX_AGE) {
            delete results[phone];
            console.log(`[CLEANUP] Result removed: ${phone}`);
        }
    }
}, 5 * 60 * 1000);

// ═══════════════════════════════════════════
// ROUTES: TASK
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

    // Store IP mapping for proxy
    if (body.realIp) {
        phoneIpMap[phone] = body.realIp;
    }

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
// ROUTES: RESULT
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
    if (result) {
        res.json({ ok: true, result });
    } else {
        res.json({ ok: false, result: null });
    }
});

// ═══════════════════════════════════════════
// ROUTES: CLEANUP
// ═══════════════════════════════════════════

app.delete('/clear/:phone', (req, res) => {
    const phone = req.params.phone;
    delete tasks[phone];
    delete results[phone];
    delete phoneIpMap[phone];
    console.log(`[CLEAR] 🗑️ ${phone}`);
    res.json({ ok: true });
});

// ═══════════════════════════════════════════
// OZ REVERSE PROXY
// ═══════════════════════════════════════════
/**
 * /oz-proxy/:phone/* — Proxies ALL requests to ozforensics.com
 * 
 * The OZ SDK in /oz-page is configured to use this proxy URL
 * instead of hitting ozforensics.com directly.
 * 
 * The server adds:
 * - X-Forwarded-For: <Agent's realIp>
 * - X-Real-IP: <Agent's realIp>  
 * - Correct Referer/Origin headers
 * 
 * This way OZ Forensics sees the Agent's IP, not the phone's.
 */

// Handle all HTTP methods (GET, POST, PUT, etc.)
app.all('/oz-proxy/:phone/*', async (req, res) => {
    const phone = req.params.phone;
    const realIp = phoneIpMap[phone] || req.query.ip || '';
    
    // Build the target URL: everything after /oz-proxy/:phone/
    const targetPath = req.params[0] || '';
    const targetUrl = 'https://' + targetPath + (req._parsedUrl.search || '');
    
    console.log(`[OZ-PROXY] ${req.method} ${phone} → ${targetUrl.substring(0, 80)}... (IP: ${realIp})`);

    try {
        // Build headers — forward most original headers
        const proxyHeaders = {};
        
        // Copy relevant headers from the client request
        const copyHeaders = [
            'accept', 'accept-language', 'accept-encoding',
            'content-type', 'content-length',
            'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
            'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
            'cache-control', 'pragma'
        ];
        
        for (const h of copyHeaders) {
            if (req.headers[h]) {
                proxyHeaders[h] = req.headers[h];
            }
        }

        // Override/add critical headers
        proxyHeaders['User-Agent'] = 'Mozilla/5.0 (Android 13; Mobile; rv:120.0) Gecko/120.0 Firefox/120.0';
        proxyHeaders['Referer'] = 'https://algeria.blsspainglobal.com/dza/appointment/LivenessRequest';
        proxyHeaders['Origin'] = 'https://algeria.blsspainglobal.com';
        
        // THE KEY: Set the Agent's IP
        if (realIp) {
            proxyHeaders['X-Forwarded-For'] = realIp;
            proxyHeaders['X-Real-IP'] = realIp;
        }

        // Build fetch options
        const fetchOpts = {
            method: req.method,
            headers: proxyHeaders,
            redirect: 'follow',
            timeout: 30000
        };

        // Forward body for POST/PUT/PATCH
        if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
            if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
                fetchOpts.body = JSON.stringify(req.body);
            } else {
                // Raw body — collect from stream
                const chunks = [];
                req.on('data', chunk => chunks.push(chunk));
                await new Promise(resolve => req.on('end', resolve));
                if (chunks.length > 0) {
                    fetchOpts.body = Buffer.concat(chunks);
                }
            }
        }

        // Make the proxied request
        const proxyRes = await fetch(targetUrl, fetchOpts);
        
        // Forward response headers
        const skipResHeaders = ['transfer-encoding', 'connection', 'keep-alive', 'content-encoding'];
        proxyRes.headers.forEach((value, name) => {
            if (!skipResHeaders.includes(name.toLowerCase())) {
                res.setHeader(name, value);
            }
        });

        // CORS headers for the APK WebView
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');

        res.status(proxyRes.status);

        // Stream the response body
        const body = await proxyRes.buffer();
        res.send(body);

        console.log(`[OZ-PROXY] ← ${proxyRes.status} (${body.length} bytes)`);

    } catch (err) {
        console.error(`[OZ-PROXY] ERROR: ${err.message}`);
        res.status(502).json({ error: 'Proxy error', message: err.message });
    }
});

// CORS preflight for proxy
app.options('/oz-proxy/*', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).end();
});

// ═══════════════════════════════════════════
// OZ-PAGE: Serves liveness page with PROXIED SDK
// ═══════════════════════════════════════════
/**
 * The key change: OZ SDK JS is loaded via /oz-proxy/ and
 * all SDK API calls are intercepted to go through /oz-proxy/
 * instead of directly to ozforensics.com
 */

app.get('/oz-page', (req, res) => {
    const { userId, transactionId, realIp, phone } = req.query;
    
    const esc = (s) => (s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/</g, '\\x3c').replace(/>/g, '\\x3e');
    const uid = esc(userId);
    const tid = esc(transactionId);
    const ip = esc(realIp);
    const ph = esc(phone);

    // Store IP for proxy
    if (phone && realIp) {
        phoneIpMap[phone] = realIp;
    }

    // The server's own URL (for proxy paths)
    const serverUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>BLS Liveness</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0f172a;font-family:system-ui,sans-serif;min-height:100vh}

/* Loading screen */
.ld{position:fixed;inset:0;z-index:9999;background:#0f172a;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff}
.ld .logo{width:70px;height:70px;border-radius:50%;background:linear-gradient(135deg,#dc2626,#b91c1c);display:flex;align-items:center;justify-content:center;margin-bottom:16px;box-shadow:0 8px 32px rgba(220,38,38,.4)}
.ld .logo span{font-size:32px;font-weight:900}
.ld h2{font-size:18px;font-weight:700;margin-bottom:8px}
.ld p{font-size:13px;color:#94a3b8}
.ld-spin{width:40px;height:40px;border:4px solid rgba(255,255,255,.1);border-top-color:#0d9488;border-radius:50%;animation:sp .8s linear infinite;margin-top:20px}
@keyframes sp{to{transform:rotate(360deg)}}

/* Success overlay */
#k2-ok{position:fixed;inset:0;z-index:2147483647;display:none;flex-direction:column;align-items:center;justify-content:center;background:linear-gradient(135deg,#059669,#0d9488,#0891b2);text-align:center;padding:30px}
.chk{width:100px;height:100px;border-radius:50%;background:rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;margin-bottom:20px;animation:pop .5s ease-out}
@keyframes pop{0%{transform:scale(0);opacity:0}70%{transform:scale(1.2)}100%{transform:scale(1);opacity:1}}
.btn-ret{background:rgba(255,255,255,.2);color:#fff;border:2px solid rgba(255,255,255,.4);padding:14px 32px;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer;margin-top:16px}

/* Hide OZ branding */
.ozliveness_logo,.ozliveness_version{display:none!important}
</style>
</head>
<body>

<!-- Loading -->
<div class="ld" id="ld">
    <div class="logo"><span>D</span></div>
    <h2>Chargement du selfie...</h2>
    <p>Preparez votre visage face a la camera</p>
    <div class="ld-spin"></div>
</div>

<!-- Success -->
<div id="k2-ok">
    <div class="chk"><span style="font-size:50px;color:#fff">&#10003;</span></div>
    <p style="font-size:28px;font-weight:900;color:#fff;margin-bottom:8px">SELFIE FAIT AVEC SUCCES</p>
    <p style="font-size:16px;color:rgba(255,255,255,.8);margin-bottom:6px">\u062a\u0645 \u0627\u0644\u062a\u0642\u0627\u0637 \u0627\u0644\u0633\u064a\u0644\u0641\u064a \u0628\u0646\u062c\u0627\u062d</p>
    <p style="font-size:15px;color:rgba(255,255,255,.9);font-weight:700;margin-bottom:10px">
        Retour dans <span id="k2-c" style="background:rgba(255,255,255,.2);padding:4px 14px;border-radius:8px;font-size:22px">10</span>s
    </p>
    <button class="btn-ret" onclick="goBack()">RETOUR PAGE PRINCIPALE</button>
</div>

<!-- URL spoof -->
<script>try{history.replaceState({},'','/DZA/appointment/LivenessRequest');}catch(e){}</script>

<!-- ═══ CRITICAL: Intercept ALL ozforensics.com requests → route through server proxy ═══ -->
<script>
(function(){
    var PHONE = '${ph}';
    var PROXY_BASE = '${serverUrl}/oz-proxy/' + encodeURIComponent(PHONE) + '/';
    
    // Rewrite URL: https://something.ozforensics.com/path → PROXY_BASE/something.ozforensics.com/path
    function rewriteUrl(url) {
        if (typeof url !== 'string') return url;
        // Match any ozforensics.com URL
        var m = url.match(/^https?:\\/\\/([^/]*ozforensics\\.com)(\\/.*)$/);
        if (m) {
            var proxied = PROXY_BASE + m[1] + m[2];
            return proxied;
        }
        return url;
    }
    
    // ═══ Override fetch ═══
    var _fetch = window.fetch;
    window.fetch = function(input, init) {
        if (typeof input === 'string') {
            input = rewriteUrl(input);
        } else if (input && input.url) {
            // Request object
            var newUrl = rewriteUrl(input.url);
            if (newUrl !== input.url) {
                input = new Request(newUrl, input);
            }
        }
        return _fetch.call(this, input, init);
    };
    
    // ═══ Override XMLHttpRequest ═══
    var _xhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        arguments[1] = rewriteUrl(url);
        return _xhrOpen.apply(this, arguments);
    };
    
    // ═══ Override createElement to catch script tags loading OZ SDK ═══
    var _createElement = document.createElement.bind(document);
    document.createElement = function(tag) {
        var el = _createElement(tag);
        if (tag.toLowerCase() === 'script') {
            var _srcDesc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src') ||
                           Object.getOwnPropertyDescriptor(el.__proto__, 'src');
            if (_srcDesc && _srcDesc.set) {
                Object.defineProperty(el, 'src', {
                    set: function(v) {
                        _srcDesc.set.call(this, rewriteUrl(v));
                    },
                    get: function() {
                        return _srcDesc.get.call(this);
                    },
                    configurable: true
                });
            }
        }
        return el;
    };
    
    // ═══ Override Image for tracking pixels ═══
    var _Image = window.Image;
    window.Image = function(w, h) {
        var img = new _Image(w, h);
        var _srcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
        if (_srcDesc && _srcDesc.set) {
            Object.defineProperty(img, 'src', {
                set: function(v) { _srcDesc.set.call(this, rewriteUrl(v)); },
                get: function() { return _srcDesc.get.call(this); },
                configurable: true
            });
        }
        return img;
    };
    
    console.log('[DZ34SNI] OZ proxy intercept installed. Base: ' + PROXY_BASE);
})();
</script>

<!-- Form for compatibility -->
<form id="formLiveness" method="post" action="/DZA/appointment/LivenessResponse">
    <input type="hidden" name="event_session_id" id="event_session_id" value="">
    <input type="hidden" name="LivenessId" id="LivenessId" value="">
</form>

<!-- Load OZ SDK — this will be intercepted by our proxy rewrite above -->
<script src="https://web-sdk.prod.cdn.spain.ozforensics.com/blsinternational/plugin_liveness.php"></script>

<!-- Launch liveness -->
<script>
var __phone = '${ph}';
var __server = '${serverUrl}';
var __sent = false;

function goBack() {
    try { __dz34sni_bridge.onGoHome(); } catch(e) {
        window.location.href = '${serverUrl}/oz-done';
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
    var body = JSON.stringify({ event_session_id: sid, status: 'completed', realIp: '${ip}', timestamp: Date.now() });
    function go(n) {
        fetch(url, { method: 'POST', headers: {'Content-Type':'application/json'}, body: body, cache: 'no-store' })
            .then(function() { try { __dz34sni_bridge.onResult(sid); } catch(e) {} })
            .catch(function() { if (n < 5) setTimeout(function() { go(n+1); }, 2000); });
    }
    go(0);
}

window.addEventListener('load', function() {
    try { __dz34sni_bridge.onStatus('Selfie en cours...'); } catch(e) {}
    setTimeout(function() {
        var ld = document.getElementById('ld'); if (ld) ld.style.display = 'none';
        try {
            if (typeof OzLiveness === 'undefined') {
                try { __dz34sni_bridge.onError('SDK not loaded'); } catch(e) {}
                return;
            }
            OzLiveness.open({
                lang: 'en',
                meta: { 'user_id': '${uid}', 'transaction_id': '${tid}' },
                overlay_options: false,
                action: ['video_selfie_blank'],
                result_mode: 'safe',
                on_complete: function(r) {
                    var sid = r && r.event_session_id ? String(r.event_session_id) : '';
                    if (sid) {
                        try { document.getElementById('LivenessId').value = sid; } catch(e) {}
                        postResult(sid);
                        showOK();
                    }
                },
                on_error: function(e) {
                    try { __dz34sni_bridge.onError('OZ:' + (e&&e.message||'')); } catch(x) {}
                }
            });
        } catch(e) {
            try { __dz34sni_bridge.onError('SDK:' + e.message); } catch(x) {}
        }
    }, 2500);
});
</script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
});

// Simple done page
app.get('/oz-done', (req, res) => {
    res.send('<html><body style="background:#0f172a;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui"><h1>Done</h1></body></html>');
});

// ═══════════════════════════════════════════
// HEALTH & STATUS
// ═══════════════════════════════════════════

app.get('/', (req, res) => {
    res.json({
        service: 'DZ34SNI',
        version: '3.0',
        status: 'running',
        features: ['task-relay', 'result-relay', 'oz-proxy'],
        activeTasks: Object.keys(tasks).length,
        activeResults: Object.keys(results).length,
        uptime: Math.floor(process.uptime()) + 's'
    });
});

app.get('/health', (req, res) => {
    res.json({ ok: true, timestamp: Date.now() });
});

app.get('/debug', (req, res) => {
    res.json({
        tasks: Object.keys(tasks).map(p => ({
            phone: p,
            userId: (tasks[p].userId || '').substring(0, 10) + '...',
            realIp: tasks[p].realIp,
            age: Math.floor((Date.now() - tasks[p].timestamp) / 1000) + 's'
        })),
        results: Object.keys(results).map(p => ({
            phone: p,
            sessionId: (results[p].event_session_id || '').substring(0, 10) + '...',
            age: Math.floor((Date.now() - results[p].timestamp) / 1000) + 's'
        })),
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
