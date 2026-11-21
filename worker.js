// RocAI Pulse — Worker Cloudflare (denyut nadi device Ayah)
// Arsitektur: device (cron 3 mnt) -> Worker /hb -> KV 1 kunci "pulse" (state+riwayat) -> dashboard
//             Worker cron (tiap 1 mnt) -> deteksi offline/recovery/gate -> alert Telegram
// $0 biaya: Workers free (100k req/hari) + KV free (1000 tulis/hari).
// Anggaran tulis KV: hb 480/hari (1 tulis/hb) + transisi cron (puluhan) ≈ 520/hari = 52% kuota.
// Tanpa kartu. Tanpa Neon (hemat kuota compute Neon keluarga).

const OFFLINE_AFTER_MIN = 8;  // >8 mnt tanpa hb = mati (2x hb terlewat + margin; anti-false-positive blip jaringan)
const HB_EVERY_MIN = 3;       // device kirim tiap 3 mnt
const HIST_MAX = 240;         // 240 x 3 mnt = 12 jam riwayat grafik
const GATE = { mem: 1400, swap: 55, load: 10, stableMin: 3 }; // mirror delayed_launch_v4

// ---------- util ----------
const j = (data, status = 200) => new Response(JSON.stringify(data, null, 1), { status, headers: { 'content-type': 'application/json' } });
const esc = (s) => String(s).replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');
function fmtDur(min) {
  if (min < 60) return `${Math.round(min)} mnt`;
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return m ? `${h}j ${m}mnt` : `${h}j`;
}

// ---------- state KV (SATU kunci: "pulse") ----------
async function getState(env) {
  const raw = await env.PULSE_KV.get('pulse', 'json');
  return raw || { lastHb: null, state: 'INIT', goodSince: null, gateNotified: false, offlineSince: null, events: [], hist: [] };
}
async function putState(env, s) {
  await env.PULSE_KV.put('pulse', JSON.stringify(s));
}
function addEvent(s, kind, detail) {
  s.events = [{ ts: Date.now(), kind, detail }].concat(s.events || []).slice(0, 50);
}
function streakMin(s, now = Date.now()) {
  return s.goodSince ? (now - s.goodSince) / 60000 : 0;
}

// ---------- deteksi transisi (dipakai cron + lazy di GET + di hb) ----------
// return true kalau state berubah (pemanggil wajib putState).
async function checkState(env, s) {
  const now = Date.now();
  let changed = false;

  // 1) offline?
  if (s.lastHb && s.state !== 'OFFLINE') {
    const ageMin = (now - s.lastHb.ts) / 60000;
    if (ageMin > OFFLINE_AFTER_MIN) {
      s.state = 'OFFLINE'; s.offlineSince = s.offlineSince || now;
      s.goodSince = null; s.gateNotified = false;
      addEvent(s, 'OFFLINE', `denyut putus ${fmtDur(ageMin)} (kemungkinan kill-cycle Android/LMK)`);
      await tg(env, `🔴 <b>ROCAI PULSE — DENYUT PUTUS</b>\nDevice Termux tidak kirim heartbeat ${fmtDur(ageMin)}.\nKemungkinan: kill-cycle Android (LMK) atau mati total.\nDashboard: https://rocai-pulse.rocai.workers.dev`);
      return true;
    }
  }
  if (s.state === 'OFFLINE') return false; // recovery ditangani handler /hb

  // 2) gate: transisi good<->bad saja yang menulis (bukan tiap menit)
  if (s.lastHb && s.lastHb.mem != null) {
    const ok = s.lastHb.mem >= GATE.mem && s.lastHb.swap <= GATE.swap && s.lastHb.load <= GATE.load;
    if (ok && !s.goodSince) { s.goodSince = now; changed = true; }
    if (!ok && s.goodSince) { s.goodSince = null; s.gateNotified = false; changed = true; }
    if (s.goodSince && streakMin(s, now) >= GATE.stableMin && !s.gateNotified) {
      s.gateNotified = true; changed = true;
      addEvent(s, 'GATE_AMAN', `device aman stabil ${Math.round(streakMin(s, now))} mnt — launcher v4 seharusnya meluncur`);
      await tg(env, `✅ <b>ROCAI PULSE — DEVICE AMAN STABIL</b>\navail ${s.lastHb.mem}MB / swap ${s.lastHb.swap}% / load ${s.lastHb.load} bertahan ${Math.round(streakMin(s, now))} mnt.\nLauncher benchmark v4 seharusnya sudah meluncur otomatis.`);
    }
  }
  return changed;
}

// ---------- Telegram ----------
async function tg(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const d = await r.json().catch(() => ({}));
    if (!d.ok) console.error('tg gagal', JSON.stringify(d).slice(0, 200));
  } catch (e) { console.error('tg err', e.message); }
}

// ---------- dashboard ----------
function sparkline(points, w = 560, h = 64) {
  if (!points || !points.length) return `<svg width="${w}" height="${h}"></svg>`;
  const clean = points.filter(v => v != null);
  if (!clean.length) return `<svg width="${w}" height="${h}"></svg>`;
  const min = Math.min(...clean), max = Math.max(...clean), span = max - min || 1;
  const step = w / Math.max(points.length - 1, 1);
  let d = '', gap = true, lastY = 0, lastX = 0;
  points.forEach((v, i) => {
    if (v == null) { gap = true; return; }
    const y = h - 6 - ((v - min) / span) * (h - 12);
    d += (gap ? 'M' : 'L') + (i * step).toFixed(1) + ',' + y.toFixed(1) + ' ';
    gap = false; lastY = y; lastX = i * step;
  });
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${d}" fill="none" stroke="#7aa2f7" stroke-width="2"/><circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="3" fill="#7aa2f7"/></svg>`;
}

function classify(hb) {
  if (hb.mem >= GATE.mem && hb.swap <= GATE.swap && hb.load <= GATE.load) return 'AMAN';
  if (hb.mem >= 1000 && hb.swap <= 70 && hb.load <= 25) return 'WASPADA';
  return 'BAHAYA';
}

function dashboard(s) {
  const latest = s.lastHb;
  const now = Date.now();
  const ageMin = latest ? (now - latest.ts) / 60000 : null;
  const offline = s.state === 'OFFLINE';
  const cls = !latest ? ['INIT', '#777'] : offline ? ['OFFLINE', '#f7768e'] : classify(latest) === 'AMAN' ? ['AMAN', '#9ece6a'] : classify(latest) === 'WASPADA' ? ['WASPADA', '#e0af68'] : ['BAHAYA', '#f7768e'];
  const badge = { AMAN: '🟢', WASPADA: '🟡', BAHAYA: '🔴', OFFLINE: '⚫', INIT: '⚪' }[cls[0]];
  const bar = (pct, color) => `<div class="bar"><div class="fill" style="width:${pct}%;background:${color}"></div></div>`;
  const memPct = latest ? Math.max(0, Math.min(100, Math.round((latest.mem / 3656) * 100))) : 0;
  const col = (v, good, warn) => v <= good ? '#9ece6a' : v <= warn ? '#e0af68' : '#f7768e';
  const colHi = (v, good, warn) => v >= good ? '#9ece6a' : v >= warn ? '#e0af68' : '#f7768e';
  const fmtTs = (ts) => new Date(ts).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const streak = Math.round(streakMin(s, now));
  const hist = s.hist || [];
  return `<!DOCTYPE html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>RocAI Pulse — Denyut Nadi Device</title>
<style>
:root{--bg:#16161e;--card:#1f2335;--tx:#c0caf5;--dim:#565f89;--ac:#7aa2f7}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--tx);font:15px/1.6 -apple-system,'Segoe UI',Roboto,sans-serif;padding:24px;max-width:960px;margin:0 auto}
h1{font-size:22px;margin-bottom:4px}
.sub{color:var(--dim);font-size:13px;margin-bottom:20px}
.badge{display:inline-block;padding:2px 14px;border-radius:20px;font-weight:700;font-size:14px;color:#16161e;background:${cls[1]}}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin:18px 0}
.card{background:var(--card);border-radius:12px;padding:16px}
.card .label{color:var(--dim);font-size:12px;text-transform:uppercase;letter-spacing:.08em}
.card .val{font-size:26px;font-weight:700;margin:4px 0}
.card .val small{font-size:14px;color:var(--dim);font-weight:400}
.bar{height:8px;background:#2a2e42;border-radius:4px;margin-top:8px;overflow:hidden}
.fill{height:100%;border-radius:4px;transition:width .5s}
.chart{background:var(--card);border-radius:12px;padding:16px;margin:14px 0}
.chart h3{font-size:13px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px}
.chart .now{float:right;color:var(--ac);font-weight:700}
.events{background:var(--card);border-radius:12px;padding:16px;margin:14px 0}
.events table{width:100%;border-collapse:collapse;font-size:13px}
.events td{padding:6px 8px;border-bottom:1px solid #2a2e42}
.events .k{font-weight:700}
a{color:var(--ac)}
footer{color:var(--dim);font-size:12px;margin-top:24px;text-align:center}
</style></head><body>
<h1>❤️ RocAI Pulse</h1>
<div class="sub">Denyut nadi device Ayah (Termux/Android) · heartbeat tiap ${HB_EVERY_MIN} mnt · update otomatis 60 dtk</div>
<span class="badge">${badge} ${cls[0]}</span>
${latest ? `<span class="sub" style="margin-left:10px">denyut terakhir ${fmtDur(ageMin)} lalu · ${fmtTs(latest.ts)} WIB</span>` : '<span class="sub" style="margin-left:10px">menunggu heartbeat pertama…</span>'}
<div class="grid">
<div class="card"><div class="label">Mem Avail</div><div class="val">${latest ? latest.mem : '—'} <small>MB</small></div>${bar(memPct, latest ? colHi(latest.mem, GATE.mem, 1000) : '#777')}<div class="label" style="margin-top:6px">gate ≥ ${GATE.mem} MB</div></div>
<div class="card"><div class="label">Swap Terpakai</div><div class="val">${latest ? latest.swap : '—'}<small>%</small></div>${bar(latest ? Math.round(latest.swap) : 0, latest ? col(latest.swap, GATE.swap, 70) : '#777')}<div class="label" style="margin-top:6px">gate ≤ ${GATE.swap}%</div></div>
<div class="card"><div class="label">Load 1 mnt</div><div class="val">${latest ? latest.load : '—'}</div>${bar(latest ? Math.min(100, Math.round((latest.load / 40) * 100)) : 0, latest ? col(latest.load, GATE.load, 25) : '#777')}<div class="label" style="margin-top:6px">gate ≤ ${GATE.load}</div></div>
<div class="card"><div class="label">Proses Keluarga</div><div class="val" style="font-size:18px">gateway ${latest && latest.gw_s != null ? Math.round(latest.gw_s / 60) + ' mnt' : '—'}<br>bench v4 ${latest && latest.runner ? '🟢 jalan' : '⚪ idle'}<br>robot OCI ${latest && latest.oci ? '🟢 jalan' : '⚪ idle'}</div></div>
</div>
<div class="card"><div class="label">Gate Relaunch Benchmark v4</div>
<div style="margin-top:6px;font-size:15px">${offline ? '⚫ device offline — gate dijeda' : (s.gateNotified ? '✅ AMAN stabil ' + streak + ' mnt — launcher v4 seharusnya sudah meluncur' : '⏳ ' + streak + '/' + GATE.stableMin + ' mnt aman berturut-turut (avail≥' + GATE.mem + 'MB, swap≤' + GATE.swap + '%, load≤' + GATE.load + ')')}</div></div>
<div class="chart"><h3>Mem Avail (12 jam terakhir) <span class="now">${latest ? latest.mem + ' MB' : ''}</span></h3>${sparkline(hist.map(p => p.mem))}</div>
<div class="chart"><h3>Swap % <span class="now">${latest ? latest.swap + '%' : ''}</span></h3>${sparkline(hist.map(p => p.swap))}</div>
<div class="chart"><h3>Load 1 mnt <span class="now">${latest ? latest.load : ''}</span></h3>${sparkline(hist.map(p => p.load))}</div>
<div class="events"><h3 style="font-size:13px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">Peristiwa Terakhir</h3>
<table>${(s.events || []).map(e => `<tr><td class="k" style="color:${e.kind === 'OFFLINE' ? '#f7768e' : e.kind === 'RECOVERED' ? '#9ece6a' : '#e0af68'}">${esc(e.kind)}</td><td>${fmtTs(e.ts)}</td><td>${esc(e.detail || '')}</td></tr>`).join('') || '<tr><td colspan="3" style="color:var(--dim)">belum ada</td></tr>'}</table></div>
<footer>RocAI Family · <a href="/api/pulse">/api/pulse</a> · Cloudflare Workers free + KV · $0</footer>
</body></html>`;
}

// ---------- fetch handler ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // POST /hb — heartbeat device
    if (request.method === 'POST' && url.pathname === '/hb') {
      const auth = request.headers.get('authorization') || '';
      if (!env.PULSE_TOKEN || auth !== `Bearer ${env.PULSE_TOKEN}`) return j({ ok: false, error: 'unauthorized' }, 401);
      let b = {}; try { b = await request.json(); } catch {}
      const hb = {
        ts: Date.now(),
        mem: Number(b.mem) || null, swap: Number(b.swap) || null, load: Number(b.load) || null,
        gw_s: Number(b.gw_s) || null, runner: !!b.runner, oci: !!b.oci,
        extra: b.extra || null, src: String(b.src || 'device').slice(0, 32),
      };
      const s = await getState(env);

      // transisi pertama / recovery
      if (s.state === 'INIT') {
        addEvent(s, 'ACTIVATED', 'pulse pertama diterima — monitor aktif');
        await tg(env, `🤖 <b>ROCAI PULSE AKTIF</b>\nMonitor denyut nadi device mulai beroperasi di Cloudflare Workers.\nDashboard: https://rocai-pulse.rocai.workers.dev`);
        s.state = 'ONLINE';
      } else if (s.state === 'OFFLINE') {
        const dur = s.offlineSince ? (Date.now() - s.offlineSince) / 60000 : 0;
        addEvent(s, 'RECOVERED', `denyut kembali setelah ${fmtDur(dur)} offline`);
        await tg(env, `🟢 <b>ROCAI PULSE — DENYUT KEMBALI</b>\nDevice hidup lagi setelah ${fmtDur(dur)} offline.\nBoot-stack seharusnya sudah dibangkitkan Termux:Boot.`);
        s.state = 'ONLINE'; s.offlineSince = null;
      }

      s.lastHb = hb;
      s.hist = (s.hist || []).concat([hb]).slice(-HIST_MAX);
      await checkState(env, s); // update transisi gate (goodSince) tanpa menunggu cron
      await putState(env, s);   // SATU tulis KV per heartbeat
      return j({ ok: true, state: s.state, gateStreak: Math.round(streakMin(s)) });
    }

    // GET /healthz
    if (request.method === 'GET' && url.pathname === '/healthz') return new Response('ok');

    // GET /api/pulse
    if (request.method === 'GET' && url.pathname === '/api/pulse') {
      const s = await getState(env);
      if (await checkState(env, s)) await putState(env, s); // lazy check (cadangan bila cron gagal)
      return j({ ok: true, state: s.state, gateStreak: Math.round(streakMin(s)), lastHb: s.lastHb, events: s.events, count: (s.hist || []).length, rows: s.hist });
    }

    // GET / — dashboard
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const s = await getState(env);
      if (await checkState(env, s)) await putState(env, s); // lazy check
      return new Response(dashboard(s), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    return j({ ok: false, error: 'not found' }, 404);
  },

  // cron trigger tiap 1 mnt — deteksi offline + gate (tulis KV HANYA saat transisi)
  async scheduled(event, env, ctx) {
    const s = await getState(env);
    if (!s.lastHb) return;
    if (await checkState(env, s)) await putState(env, s);
  },
};
