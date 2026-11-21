#!/usr/bin/env node
/**
 * RocAI Pulse v2 — denyut nadi device Ayah (Termux/Android localhost).
 * Hosting: Render free — STATELESS in-memory (tanpa database, hemat kuota Neon).
 *
 * Desain:
 *  - Device (Termux) kirim heartbeat tiap 3 menit via pulse-sender.sh (cron).
 *  - Alert Telegram OFFLINE setelah 8 menit tanpa denyut (2x hb terlewat + margin;
 *    masih sebelum spin-down Render 15 mnt).
 *  - GATE_AMAN: notifikasi sekali saat tekanan device stabil (mem>=1400MB,
 *    swap<=55%, load<=10) selama 3 menit berturut-turut.
 *  - State in-memory: hilang saat restart/spin-down (chart mulai baru) — wajar
 *    untuk free tier; deteksi gap pasca-mati ditangani sender (flag recovered).
 *  - Upgrade path: worker.js (Cloudflare Workers + KV) bila ada token edit.
 */
'use strict';

const http = require('http');

const PORT = process.env.PORT || 8899;
const PULSE_TOKEN = process.env.PULSE_TOKEN || '';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_HOME_CHANNEL || '';
const DASH_URL = process.env.DASH_URL || 'https://rocai-pulse.onrender.com';

const GATE = { mem: 1400, swap: 55, load: 10, stableMin: 3 };
const HB_INTERVAL_MIN = 3;
const OFFLINE_AFTER_MIN = 8;
const HIST_MAX = 300;   // ~15 jam @ hb 3 mnt
const EVENTS_MAX = 50;

// ---------- state in-memory ----------
let lastHb = null;
let state = 'INIT'; // INIT | ONLINE | OFFLINE
let gateStreak = 0;
let gateNotified = false;
let offlineSince = null;
const bootedAt = Date.now();
let bootAlerted = false;
let hist = [];   // {ts, mem, swap, load}
let events = []; // {ts, kind, detail}

function ev(kind, detail) {
  events.unshift({ ts: Date.now(), kind, detail });
  if (events.length > EVENTS_MAX) events.length = EVENTS_MAX;
}

async function tg(text) {
  if (!TG_TOKEN || !TG_CHAT) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' }),
    });
    return r.ok;
  } catch { return false; }
}

function fmtDur(min) {
  if (!isFinite(min) || min < 0) min = 0;
  const m = Math.round(min);
  if (m < 60) return `${m} mnt`;
  return `${Math.floor(m / 60)} jam ${m % 60} mnt`;
}

async function notify(kind, detail, tgText) {
  ev(kind, detail);
  if (tgText) await tg(tgText);
}

// ---------- monitor (tiap 60 dtk) ----------
async function monitor() {
  const now = Date.now();
  if (!lastHb) {
    // kebutaan pasca-restart monitor: device belum hb 10 mnt sejak boot
    if (!bootAlerted && now - bootedAt > 10 * 60000) {
      bootAlerted = true;
      await notify('BLIND',
        'monitor hidup ulang & device belum kirim hb 10 mnt — kemungkinan device mati',
        `🟠 <b>ROCAI PULSE — CEK DEVICE</b>\nMonitor hidup ulang tapi device belum kirim heartbeat 10 mnt.\nKemungkinan device mati saat monitor restart.\nDashboard: ${DASH_URL}`);
    }
    return;
  }
  const ageMin = (now - lastHb.ts) / 60000;

  if (ageMin > OFFLINE_AFTER_MIN && state !== 'OFFLINE') {
    state = 'OFFLINE';
    offlineSince = now;
    await notify('OFFLINE',
      `denyut putus ${fmtDur(ageMin)} (kill-cycle Android / LMK / device mati?)`,
      `🔴 <b>ROCAI PULSE — DEVICE OFFLINE</b>\nDenyut putus ${fmtDur(ageMin)}.\nKemungkinan: kill-cycle Android (LMK), device mati, atau jaringan.\nDashboard: ${DASH_URL}`);
    return;
  }
  if (ageMin <= HB_INTERVAL_MIN + 1 && state === 'OFFLINE') {
    const dur = (now - offlineSince) / 60000;
    state = 'ONLINE';
    offlineSince = null;
    await notify('RECOVERED',
      `denyut kembali setelah ${fmtDur(dur)} offline`,
      `🟢 <b>ROCAI PULSE — DEVICE ONLINE LAGI</b>\nDenyut kembali setelah ${fmtDur(dur)} offline.\nDashboard: ${DASH_URL}`);
  }

  // gate tekanan device (hanya saat ONLINE)
  if (state !== 'OFFLINE' && lastHb.mem != null) {
    const ok = lastHb.mem >= GATE.mem && lastHb.swap <= GATE.swap && lastHb.load <= GATE.load;
    if (ok) gateStreak++;
    else { gateStreak = 0; gateNotified = false; } // reset HANYA saat tekanan buruk
    if (gateStreak >= GATE.stableMin && !gateNotified) {
      gateNotified = true; // sekali saja sampai tekanan memburuk lagi
      await notify('GATE_AMAN',
        `tekanan device stabil ${gateStreak} mnt (mem ${lastHb.mem}MB, swap ${lastHb.swap}%, load ${lastHb.load})`,
        `✅ <b>ROCAI PULSE — TEKANAN DEVICE AMAN</b>\nStabil ${gateStreak} mnt berturut: mem ${lastHb.mem}MB ≥ ${GATE.mem}MB, swap ${lastHb.swap}% ≤ ${GATE.swap}%, load ${lastHb.load} ≤ ${GATE.load}.\nAman untuk meluncurkan tugas berat.\nDashboard: ${DASH_URL}`);
    }
  }
}

// ---------- http helpers ----------
function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 65536) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

// ---------- dashboard ----------
function esc(s) {
  return String(s).replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');
}

function sparkline(series, color) {
  if (!series || series.length < 2) return '<svg width="120" height="28"></svg>';
  const vals = series.filter((v) => v != null && isFinite(v));
  if (vals.length < 2) return '<svg width="120" height="28"></svg>';
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const h = 28, w = 120;
  const pts = series.map((v, i) => {
    if (v == null || !isFinite(v)) return null;
    const x = (i / (series.length - 1)) * w;
    const y = h - 3 - ((v - min) / span) * (h - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).filter(Boolean);
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline fill="none" stroke="${color}" stroke-width="1.5" points="${pts.join(' ')}"/></svg>`;
}

function dashboard() {
  const hb = lastHb;
  const ageMin = hb ? (Date.now() - hb.ts) / 60000 : null;
  const badge = state === 'ONLINE' ? '<span class="ok">● ONLINE</span>'
    : state === 'OFFLINE' ? '<span class="bad">● OFFLINE</span>'
    : '<span class="warn">● INIT</span>';
  const memSeries = hist.slice(-120).map((p) => p.mem);
  const swapSeries = hist.slice(-120).map((p) => p.swap);
  const loadSeries = hist.slice(-120).map((p) => p.load);
  const rows = [
    ['MemAvailable', hb ? `${hb.mem} MB` : '—', sparkline(memSeries, '#4ade80')],
    ['Swap terpakai', hb ? `${hb.swap} %` : '—', sparkline(swapSeries, '#f87171')],
    ['Load 1m', hb ? hb.load : '—', sparkline(loadSeries, '#60a5fa')],
    ['Gateway umur', hb && hb.gw_s ? `${Math.round(hb.gw_s / 60)} mnt` : '—', ''],
    ['Benchmark runner', hb ? (hb.runner > 0 ? `🟢 jalan (${hb.runner})` : 'tidak ada') : '—', ''],
    ['Robot OCI', hb ? (hb.oci > 0 ? `🟢 jalan (${hb.oci})` : 'tidak ada') : '—', ''],
  ].map(([k, v, s]) => `<tr><td>${k}</td><td class="v">${v}</td><td>${s}</td></tr>`).join('');
  const evRows = events.map((e) => `<tr><td class="t">${new Date(e.ts).toISOString().replace('T', ' ').slice(0, 19)}</td><td>${esc(e.kind)}</td><td>${esc(e.detail)}</td></tr>`).join('');
  return `<!doctype html>
<html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RocAI Pulse</title>
<meta http-equiv="refresh" content="60">
<style>
body{font-family:ui-monospace,Menlo,Consolas,monospace;background:#0b0f14;color:#cbd5e1;margin:0;padding:24px}
h1{font-size:18px;color:#f1f5f9;margin:0 0 4px}
.sub{color:#64748b;font-size:12px;margin-bottom:20px}
.ok{color:#4ade80}.bad{color:#f87171}.warn{color:#fbbf24}
.card{background:#111827;border:1px solid #1f2937;border-radius:10px;padding:16px;margin-bottom:20px;max-width:720px}
table{border-collapse:collapse;width:100%;font-size:13px}
td{padding:6px 10px;border-bottom:1px solid #1f2937}
td.v{color:#f1f5f9;text-align:right}
td.t{color:#64748b;white-space:nowrap}
.foot{color:#475569;font-size:11px;margin-top:8px}
</style></head><body>
<h1>ROCAI PULSE ${badge}</h1>
<div class="sub">denyut nadi device Ayah (Termux/Android) · hb tiap 3 mnt · offline > 8 mnt</div>
<div class="card"><table>${rows}</table></div>
<div class="card"><table>
<tr><td class="t">state</td><td class="v">${state}</td><td></td></tr>
<tr><td class="t">denyut terakhir</td><td class="v">${hb ? `${Math.round(ageMin)} mnt lalu` : 'belum ada'}</td><td></td></tr>
<tr><td class="t">gate streak</td><td class="v">${gateStreak} mnt (aman ≥ ${GATE.stableMin})</td><td></td></tr>
<tr><td class="t">monitor hidup sejak</td><td class="v">${new Date(bootedAt).toISOString().replace('T', ' ').slice(0, 19)}</td><td></td></tr>
</table></div>
<div class="card"><table><tr><td class="t">EVENTS</td><td></td><td></td></tr>${evRows || '<tr><td colspan="3" class="t">belum ada</td></tr>'}</table></div>
<div class="foot">RocAI Pulse v2 · stateless in-memory (Render free) · state hilang saat restart — by design</div>
</body></html>`;
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(dashboard());
      return;
    }
    if (req.method === 'GET' && req.url === '/healthz') {
      json(res, 200, { ok: true, state });
      return;
    }
    if (req.method === 'GET' && req.url === '/api/pulse') {
      const hb = lastHb;
      json(res, 200, {
        ok: true, state, bootedAt,
        lastHb: hb, ageMin: hb ? (Date.now() - hb.ts) / 60000 : null,
        gateStreak, gate: GATE,
        hist: hist.slice(-120), events,
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/hb') {
      const auth = req.headers.authorization || '';
      if (!PULSE_TOKEN || auth !== `Bearer ${PULSE_TOKEN}`) {
        json(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      const b = await readBody(req);
      const hb = {
        ts: Date.now(),
        mem: Number.isFinite(Number(b.mem)) && b.mem !== '' ? Number(b.mem) : null,
        swap: Number.isFinite(Number(b.swap)) ? Number(b.swap) : 0,
        load: Number.isFinite(Number(b.load)) ? Number(b.load) : 0,
        gw_s: Number.isFinite(Number(b.gw_s)) && b.gw_s !== '' ? Number(b.gw_s) : null,
        runner: Number.isFinite(Number(b.runner)) ? Number(b.runner) : 0,
        oci: Number.isFinite(Number(b.oci)) ? Number(b.oci) : 0,
        src: String(b.src || 'termux').slice(0, 32),
      };
      const wasOffline = state === 'OFFLINE';
      const gapMin = Number(b.gap_s) > 0 ? Number(b.gap_s) / 60 : 0;
      lastHb = hb;
      hist.push({ ts: hb.ts, mem: hb.mem, swap: hb.swap, load: hb.load });
      if (hist.length > HIST_MAX) hist.splice(0, hist.length - HIST_MAX);
      if (state === 'INIT') ev('ACTIVATED', 'heartbeat pertama diterima');
      state = 'ONLINE';
      json(res, 200, { ok: true, state, gateStreak });
      if (wasOffline || b.recovered) {
        const dur = wasOffline && offlineSince ? Math.max((Date.now() - offlineSince) / 60000, gapMin) : gapMin;
        offlineSince = null;
        await notify('RECOVERED',
          `denyut kembali (gap ${fmtDur(dur)})`,
          `🟢 <b>ROCAI PULSE — DEVICE ONLINE LAGI</b>\nDenyut kembali setelah gap ${fmtDur(dur)}.\nDashboard: ${DASH_URL}`);
      }
      return;
    }
    json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    json(res, 500, { ok: false, error: String(e && e.message || e) });
  }
});

server.listen(PORT, () => {
  ev('BOOT', 'monitor hidup (stateless in-memory)');
  console.log(`rocai-pulse listening on ${PORT}`);
  tg(`🤖 <b>ROCAI PULSE aktif</b>\nMonitor hidup di Render.\nDashboard: ${DASH_URL}`);
});

setInterval(() => { monitor().catch(() => {}); }, 60_000);
