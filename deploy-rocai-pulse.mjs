#!/usr/bin/env node
/**
 * deploy-rocai-pulse.mjs — buat service Render "rocai-pulse" (free, Singapore)
 * dari repo github.com/ivansslo/rocai-pulse, lalu poll sampai deploy LIVE.
 * Jalankan: node ~/rocai-tmp/deploy-rocai-pulse.mjs
 * Secret dibaca dari ~/.agent/rocai/.env — TIDAK pernah dicetak.
 */
'use strict';
import { readFileSync } from 'node:fs';

const ENV = readFileSync(process.env.HOME + '/.agent/rocai/.env', 'utf8');
function env(k) {
  const m = ENV.match(new RegExp('^' + k + '=(.*)$', 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}
const KEY = env('RENDER_API_KEY');
const PULSE_TOKEN = env('RENDER_PULSE_TOKEN');
const TG_TOKEN = env('TELEGRAM_BOT_TOKEN');
const TG_CHAT = env('TELEGRAM_HOME_CHANNEL') || env('TELEGRAM_CHAT_ID');

if (!KEY || !PULSE_TOKEN || !TG_TOKEN || !TG_CHAT) {
  console.error('ENV KURANG: cek RENDER_API_KEY / RENDER_PULSE_TOKEN / TELEGRAM_BOT_TOKEN / TELEGRAM_HOME_CHANNEL');
  process.exit(1);
}

const API = 'https://api.render.com/v1';
const H = { Authorization: `Bearer ${KEY}`, 'content-type': 'application/json', accept: 'application/json' };

// 0. cek apakah service sudah ada (idempoten)
const list = await (await fetch(`${API}/services?limit=100`, { headers: H })).json();
const existing = (Array.isArray(list) ? list : []).find((s) => s.name === 'rocai-pulse');
if (existing) {
  console.log('service sudah ada:', existing.id, existing.serviceDetails?.url || existing.slug);
  process.exit(0);
}

// 1. ownerId
const owners = await (await fetch(`${API}/owners`, { headers: H })).json();
const ownerId = Array.isArray(owners) && (owners[0]?.owner?.id || owners[0]?.id);
if (!ownerId) { console.error('GAGAL ambil ownerId:', JSON.stringify(owners).slice(0, 300)); process.exit(1); }
console.log('ownerId: OK');

// 2. buat service web free (type di level atas — bentuk yang diterima API v1)
const body = {
  ownerId,
  type: 'web_service',
  name: 'rocai-pulse',
  repo: 'https://github.com/ivansslo/rocai-pulse',
  branch: 'main',
  autoDeploy: 'yes',
  serviceDetails: {
    runtime: 'node',
    buildCommand: 'npm install',
    startCommand: 'node server.js',
    plan: 'free',
    region: 'singapore',
    envSpecificDetails: {
      env: 'production',
    },
    envVars: [
      { key: 'PULSE_TOKEN', value: PULSE_TOKEN },
      { key: 'TELEGRAM_BOT_TOKEN', value: TG_TOKEN },
      { key: 'TELEGRAM_CHAT_ID', value: TG_CHAT },
    ],
  },
};
const create = await fetch(`${API}/services`, { method: 'POST', headers: H, body: JSON.stringify(body) });
const svc = await create.json();
if (!create.ok) { console.error('CREATE GAGAL:', create.status, JSON.stringify(svc).slice(0, 500)); process.exit(1); }
const id = svc.id;
const url = svc.serviceDetails?.url || `https://${svc.slug}.onrender.com`;
console.log('service dibuat:', id, '->', url);

// 3. poll deploy sampai live (max ~10 menit)
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 10000));
  const deps = await (await fetch(`${API}/services/${id}/deploys?limit=1`, { headers: H })).json();
  const d = Array.isArray(deps) ? (deps[0]?.deploy || deps[0]) : null;
  console.log(`[${i * 10}s] deploy: ${d?.status ?? '?'}`);
  if (d?.status === 'live') { console.log('LIVE:', url); process.exit(0); }
  if (['build_failed', 'update_failed', 'canceled', 'deactivated'].includes(d?.status)) {
    console.error('DEPLOY GAGAL:', d?.status);
    process.exit(1);
  }
}
console.error('TIMEOUT menunggu live (10 mnt) — cek manual di dashboard Render');
process.exit(1);
