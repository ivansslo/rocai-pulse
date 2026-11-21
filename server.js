#!/usr/bin/env node
/**
 * RocAI Pulse — denyut nadi device Ayah (Termux/Android localhost).
 * Hosted di Render (free), data di Neon Postgres (HTTP API), alert ke Telegram.
 * Zero-dependency: hanya Node >= 18 (global fetch). Tidak ada npm install.
 *
 * Endpoint:
 *   POST /hb         — heartbeat dari device (auth: Authorization: Bearer PULSE_TOKEN)
 *   GET  /           — dashboard HTML (auto-refresh 60s)
 *   GET  /api/pulse  — JSON terbaru + riwayat
 *   GET  /healthz    — health check Render
 */
'use strict';

const PORT = process.env.PORT || 8899;
const PULSE_TOKEN = process.env.PULSE_TOKEN || '';
const DATABASE_URL = process.env.DATABASE_URL || process.env.NEON_DATABASE_URL || '';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_HOME_CHANNEL || '';

// ---- gate relaunch v4 (harus sama dengan delayed_launch_v4.py di device) ----
const GATE = { mem: 1400, swap: 55, load: 10, stableMin: 3 };
const HB_INTERVAL_MIN = 2;          // device kirim tiap 2 menit
const OFFLINE_AFTER_MIN = 6;        // >6 mnt tanpa hb = dianggap mati (kill-cycle)

// ---- state in-memory ----
let lastHb = null;                  // {ts, mem, swap, load, gw_s, runner, oci, extra}
let state = 'INIT';                 // INIT | ONLINE | OFFLINE | RECOVERED
let gateStreak = 0;                 // menit berturut-turut memenuhi gate
let gateNotified = false;           // sudah kirim notif "aman stabil" utk streak ini
let offlineSince = null;
let bootedAt = Date.now();

// ---------- Neon HTTP API ----------
const NEON_HOST = DATABASE_URL.replace(/^postgres(ql)?:\/\//, '').replace(/@.*/, '') || '';
const NEON_URL = (() => {
  try {
    const u = new URL(DATABASE_URL.replace(/^postgres:/, 'https:').replace(/^postgresql:/, 'https:'));
    return `https://${u.hostname}/sql`;
  } catch { return ''; }
})();

async function sql(query, params = []) {
  if (!NEON_URL) throw new Error('DATABASE_URL kosong');
  const res = await fetch(NEON_URL, {
    method: 'POST',
    headers: {
      'Neon-Connection-String': DATABASE_URL,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ query, params }),
  });
  if (!res.ok) throw new Error(`Neon HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function migrate() {
  await sql(`CREATE TABLE IF NOT EXISTS rocai_pulse (
    ts timestamptz NOT NULL DEFAULT now(),
    src text NOT NULL DEFAULT 'device',
    mem_avail_mb int,
    swap_pct real,
    load1 real,
    gw_s int,
    runner_v4 bool,
    oci_robot bool,
    extra jsonb)`);
  await sql(`CREATE INDEX IF NOT EXISTS rocai_pulse_ts_idx ON rocai_pulse (ts DESC)`);
  await sql(`CREATE TABLE IF NOT EXISTS rocai_pulse_events (
    ts timestamptz NOT NULL DEFAULT now(),
    kind text NOT NULL,
    detail text)`);
  console.log('[db] migrasi OK');
}

// ---------- Telegram ----------
async function tg(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) console.error('[tg] gagal:', JSON.stringify(j).slice(0, 200));
    else console.log('[tg] terkirim');
  } catch (e) { console.error('[tg] error:', e.message); }
}

function fmtDur(min) {
  if (min < 60) return `${Math.round(min)} mnt`;
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return m ? `${h}j ${m}mnt` : `${h}j`;
}

// ---------- logika status ----------
function classify(hb) {
  // mirror gate delayed_launch_v4
  if (hb.mem >= GATE.mem && hb.swap <= GATE.swap && hb.load <= GATE.load) return 'AMAN';
  if (hb.mem >= 1000 && hb.swap <= 70 && hb.load <= 25) return 'WASPADA';
  return 'BAHAYA';
}

async function recordEvent(kind, detail) {
  try { await sql('INSERT INTO rocai_pulse_events (kind, detail) VALUES ($1, $2)', [kind, detail]); } catch (e) { console.error('[event] db:', e.message); }
}

// loop pemantau tiap 60 dtk
async function monitor() {
  try {
    if (!lastHb) return;
    const ageMin = (Date.now() - lastHb.ts) / 60000;

    // --- deteksi putus denyut (kill-cycle Android / LMK) ---
    if (ageMin > OFFLINE_AFTER_MIN && state !== 'OFFLINE') {
      state = 'OFFLINE'; offlineSince = Date.now();
      await recordEvent('OFFLINE', `denyut putus ${fmtDur(ageMin)} (kemungkinan kill-cycle Android/LMK)`);
      await tg(`🔴 <b>ROCAI PULSE — DENYUT PUTUS</b>\nDevice Termux tidak kirim heartbeat ${fmtDur(ageMin)}.\nKemungkinan: kill-cycle Android (LMK) atau mati total.\nDashboard: https://rocai-pulse.onrender.com`);
      console.log('[monitor] OFFLINE terdeteksi');
    } else if (ageMin <= HB_INTERVAL_MIN + 1 && state === 'OFFLINE') {
      const dur = (Date.now() - offlineSince) / 60000;
      state = 'ONLINE';
      await recordEvent('RECOVERED', `denyut kembali setelah ${fmtDur(dur)} offline`);
      await tg(`🟢 <b>ROCAI PULSE — DENYUT KEMBALI</b>\nDevice hidup lagi setelah ${fmtDur(dur)} offline.\nBoot-stack seharusnya sudah dibangkitkan Termux:Boot.`);
      console.log('[monitor] RECOVERED');
    }

    // --- gate relaunch v4 ---
    if (state !== 'OFFLINE' && lastHb.mem != null) {
      const ok = lastHb.mem >= GATE.mem && lastHb.swap <= GATE.swap && lastHb.load <= GATE.load;
      gateStreak = ok ? gateStreak + 1 : 0;
      if (ok) gateNotified = false;
      if (gateStreak >= GATE.stableMin && !gateNotified) {
        gateNotified = true;
        await recordEvent('GATE_AMAN', `device aman stabil ${gateStreak} mnt — launcher v4 seharusnya meluncur`);
        await tg(`✅ <b>ROCAI PULSE — DEVICE AMAN STABIL</b>\navail ${lastHb.mem}MB / swap ${lastHb.swap}% / load ${lastHb.load} bertahan ${gateStreak} mnt.\nLauncher benchmark v4 seharusnya sudah meluncur otomatis.`);
      }
    }
  } catch (e) { console.error('[monitor]', e.message); }
}

// ---------- dashboard ----------
function sparkline(points, w = 560, h = 64, invert = false) {
  if (!points.length) return `<svg width="${w}" height="${h}"></svg>`;
  const vals = points.map(p => (p == null ? null : p));
  const clean = vals.filter(v => v != null);
  if (!clean.length) return `<svg width="${w}" height="${h}"></svg>`;
  const min = Math.min(...clean), max = Math.max(...clean);
  const span = max - min || 1;
  const step = w / Math.max(vals.length - 1, 1);
  let d = '', gap = true;
  vals.forEach((v, i) => {
    if (v == null) { gap = true; return; }
    let y = h - 6 - ((v - min) / span) * (h - 12);
    if (invert) y = h - 6 - (1 - (v - min) / span) * (h - 12); // dipakai utk "sisa mem" agar naik = baik
    const x = i * step;
    d += (gap ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1) + ' ';
    gap = false;
  });
  const last = clean[clean.length - 1];
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${d}" fill="none" stroke="#7aa2f7" stroke-width="2"/><circle cx="${(vals.length - 1) * step}" cy="${h - 6 - ((last - min) / span) * (h - 12)}" r="3" fill="#7aa2f7"/></svg>`;
}

function esc(s) { return String(s).replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>'); }

function dashboard(latest, series, events) {
  const now = Date.now();
  const ageMin = latest ? (now - latest.ts) / 60000 : null;
  const offline = ageMin != null && ageMin > OFFLINE_AFTER_MIN;
  const cls = !latest ? ['INIT', '#777'] : offline ? ['OFFLINE', '#f7768e'] : classify(latest) === 'AMAN' ? ['AMAN', '#9ece6a'] : classify(latest) === 'WASPADA' ? ['WASPADA', '#e0af68'] : ['BAHAYA', '#f7768e'];
  const memPct = latest ? Math.max(0, Math.min(100, Math.round((latest.mem / 3656) * 100))) : 0;
  const badge = { AMAN: '🟢', WASPADA: '🟡', BAHAYA: '🔴', OFFLINE: '⚫', INIT: '⚪' }[cls[0]];
  const bar = (pct, color) => `<div class="bar"><div class="fill" style="width:${pct}%;background:${color}"></div></div>`;

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
<div class="sub">Denyut nadi device Ayah (Termux/Android) · heartbeat tiap ${HB_INTERVAL_MIN} mnt · update otomatis 60 dtk</div>
<span class="badge">${badge} ${cls[0]}</span>
${latest ? `<span class="sub" style="margin-left:10px">denyut terakhir ${fmtDur(ageMin)} lalu · ${new Date(latest.ts).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB</span>` : '<span class="sub" style="margin-left:10px">menunggu heartbeat pertama…</span>'}
<div class="grid">
<div class="card"><div class="label">Mem Avail</div><div class="val">${latest ? latest.mem : '—'} <small>MB</small></div>${bar(memPct, latest && latest.mem >= GATE.mem ? '#9ece6a' : latest && latest.mem >= 1000 ? '#e0af68' : '#f7768e')}<div class="label" style="margin-top:6px">gate ≥ ${GATE.mem} MB</div></div>
<div class="card"><div class="label">Swap Terpakai</div><div class="val">${latest ? latest.swap : '—'}<small>%</small></div>${bar(latest ? Math.round(latest.swap) : 0, latest && latest.swap <= GATE.swap ? '#9ece6a' : latest && latest.swap <= 70 ? '#e0af68' : '#f7768e')}<div class="label" style="margin-top:6px">gate ≤ ${GATE.swap}%</div></div>
<div class="card"><div class="label">Load 1 mnt</div><div class="val">${latest ? latest.load : '—'}</div>${bar(latest ? Math.min(100, Math.round((latest.load / 40) * 100)) : 0, latest && latest.load <= GATE.load ? '#9ece6a' : latest && latest.load <= 25 ? '#e0af68' : '#f7768e')}<div class="label" style="margin-top:6px">gate ≤ ${GATE.load}</div></div>
<div class="card"><div class="label">Proses Keluarga</div><div class="val" style="font-size:18px">gateway ${latest && latest.gw_s != null ? Math.round(latest.gw_s / 60) + ' mnt' : '—'}<br>bench v4 ${latest && latest.runner ? '🟢 jalan' : '⚪ idle'}<br>robot OCI ${latest && latest.oci ? '🟢 jalan' : '⚪ idle'}</div></div>
</div>
<div class="card"><div class="label">Gate Relaunch Benchmark v4</div>
<div style="margin-top:6px;font-size:15px">${offline ? '⚫ device offline — gate dijeda' : (gateStreak >= GATE.stableMin ? '✅ AMAN stabil ' + gateStreak + ' mnt — launcher v4 seharusnya sudah meluncur' : '⏳ ' + gateStreak + '/' + GATE.stableMin + ' mnt aman berturut-turut (avail≥' + GATE.mem + 'MB, swap≤' + GATE.swap + '%, load≤' + GATE.load + ')')}</div></div>
<div class="chart"><h3>Mem Avail (6 jam terakhir) <span class="now">${latest ? latest.mem + ' MB' : ''}</span></h3>${sparkline(series.mem, 560, 64, true)}</div>
<div class="chart"><h3>Swap % <span class="now">${latest ? latest.swap + '%' : ''}</span></h3>${sparkline(series.swap)}</div>
<div class="chart"><h3>Load 1 mnt <span class="now">${latest ? latest.load : ''}</span></h3>${sparkline(series.load)}</div>
<div class="events"><h3 style="font-size:13px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">Peristiwa Terakhir</h3>
<table>${(events || []).map(e => `<tr><td class="k" style="color:${e.kind === 'OFFLINE' ? '#f7768e' : e.kind === 'RECOVERED' ? '#9ece6a' : '#e0af68'}">${esc(e.kind)}</td><td>${new Date(e.ts).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}</td><td>${esc(e.detail || '')}</td></tr>`).join('') || '<tr><td colspan="3" style="color:var(--dim)">belum ada</td></tr>'}</table></div>
<footer>RocAI Family · <a href="/api/pulse">/api/pulse</a> · <a href="/healthz">/healthz</a> · Render free + Neon · boot ${new Date(bootedAt).toISOString()}</footer>
</body></html>`;
}

// ---------- HTTP server ----------
async function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 16384) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

const server = require('http').createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'POST' && url.pathname === '/hb') {
      const auth = req.headers['authorization'] || '';
      if (!PULSE_TOKEN || auth !== `Bearer ${PULSE_TOKEN}`) { res.writeHead(401).end('unauthorized'); return; }
      const b = await readBody(req);
      const hb = {
        ts: Date.now(),
        mem: Number(b.mem) || null,
        swap: Number(b.swap) || null,
        load: Number(b.load) || null,
        gw_s: Number(b.gw_s) || null,
        runner: !!b.runner,
        oci: !!b.oci,
        extra: b.extra || null,
        src: String(b.src || 'device').slice(0, 32),
      };
      lastHb = hb;
      if (state === 'INIT' || state === 'OFFLINE') state = 'ONLINE';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, state, gateStreak }));
      // simpan async (jangan blok balasan)
      sql('INSERT INTO rocai_pulse (src, mem_avail_mb, swap_pct, load1, gw_s, runner_v4, oci_robot, extra) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [hb.src, hb.mem, hb.swap, hb.load, hb.gw_s, hb.runner, hb.oci, hb.extra ? JSON.stringify(hb.extra) : null])
        .catch(e => console.error('[db] insert:', e.message));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/healthz') { res.writeHead(200).end('ok'); return; }
    if (req.method === 'GET' && url.pathname === '/api/pulse') {
      const r = await sql(`SELECT ts, mem_avail_mb, swap_pct, load1, gw_s, runner_v4, oci_robot, extra
        FROM rocai_pulse WHERE ts > now() - interval '24 hours' ORDER BY ts DESC LIMIT 720`);
      const rows = (r.rows || []).map(x => ({
        ts: x.ts, mem: x.mem_avail_mb, swap: x.swap_pct, load: x.load1,
        gw_s: x.gw_s, runner: x.runner_v4, oci: x.oci_robot, extra: x.extra,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, state, lastHb, gateStreak, count: rows.length, rows }, null, 1));
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      // ambil 6 jam utk chart + 10 event terakhir
      const [s, ev] = await Promise.all([
        sql(`SELECT ts, mem_avail_mb, swap_pct, load1 FROM rocai_pulse WHERE ts > now() - interval '6 hours' ORDER BY ts ASC LIMIT 400`),
        sql(`SELECT ts, kind, detail FROM rocai_pulse_events ORDER BY ts DESC LIMIT 10`),
      ]);
      const pts = (s.rows || []).map(x => ({ ts: +new Date(x.ts), mem: x.mem_avail_mb, swap: x.swap_pct, load: x.load1 }));
      const series = {
        mem: pts.map(p => p.mem), swap: pts.map(p => p.swap), load: pts.map(p => p.load),
      };
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(dashboard(lastHb, series, ev.rows || []));
      return;
    }
    res.writeHead(404).end('not found');
  } catch (e) {
    console.error('[http]', req.method, url.pathname, e.message);
    res.writeHead(500).end('error: ' + e.message);
  }
});

// ---------- housekeeping ----------
async function cleanup() {
  try {
    await sql(`DELETE FROM rocai_pulse WHERE ts < now() - interval '7 days'`);
    console.log('[db] cleanup OK');
  } catch (e) { console.error('[cleanup]', e.message); }
}

// ---------- boot ----------
(async () => {
  if (!PULSE_TOKEN) console.warn('[warn] PULSE_TOKEN kosong — /hb akan menolak semua');
  if (!DATABASE_URL) { console.error('[fatal] DATABASE_URL kosong'); process.exit(1); }
  await migrate();
  // pulihkan heartbeat terakhir dari DB (supaya OFFLINE tak salah deteksi pas restart service)
  try {
    const r = await sql(`SELECT ts, mem_avail_mb, swap_pct, load1, gw_s, runner_v4, oci_robot FROM rocai_pulse ORDER BY ts DESC LIMIT 1`);
    if (r.rows && r.rows[0]) {
      const x = r.rows[0];
      lastHb = { ts: +new Date(x.ts), mem: x.mem_avail_mb, swap: x.swap_pct, load: x.load1, gw_s: x.gw_s, runner: x.runner_v4, oci: x.oci_robot };
      console.log('[boot] heartbeat terakhir dipulihkan:', new Date(lastHb.ts).toISOString());
    }
  } catch (e) { console.error('[boot] restore:', e.message); }
  server.listen(PORT, () => console.log(`[pulse] listening :${PORT}`));
  await tg(`🤖 <b>RocAI Pulse aktif</b>\nLayanan denyut nadi device sudah online di Render.\nAlert kill-cycle & gate relaunch v4 aktif.`);
  await recordEvent('BOOT', `service boot di Render port ${PORT}`);
  setInterval(monitor, 60_000);
  setInterval(cleanup, 3_600_000);
})();
