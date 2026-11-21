# RocAI Pulse

Denyut nadi device Ayah (Termux/Android localhost) — **monitor kill-cycle Android**.

## Kenapa
Device Termux berkali-kali dibunuh Android LMK (kill-cycle 8–24 mnt saat memori sempit: avail <~1GB, swap >60%, load >30). Seluruh pohon proses Termux mati; boot-stack dibangkitkan ulang oleh Termux:Boot, tapi proses side-job (benchmark runner, finalizer, launcher) **tidak** — mati permanen tanpa ada yang tahu. RocAI Pulse memberi tahu Ayah via Telegram saat device offline.

## Arsitektur
```
Termux (cron */3) --POST /hb--> Render free (server.js, stateless in-memory) --alert--> Telegram
```
- **pulse-sender.sh** (device): kirim metrik tiap 3 mnt — MemAvailable, swap %, load, umur gateway, jumlah runner benchmark & robot OCI. Deteksi gap pasca-mati via stamp file (`~/.roca-ops/pulse-last-ok`) → flag `recovered`.
- **server.js** (Render): stateless in-memory, zero-dependency Node. Alert OFFLINE setelah 8 mnt tanpa denyut (sebelum spin-down Render 15 mnt), RECOVERED saat denyut kembali, GATE_AMAN saat tekanan device stabil 3 mnt (mem ≥1400MB, swap ≤55%, load ≤10 — ambang sama dengan delayed-launcher benchmark v4), BLIND saat monitor restart tapi device tak kirim hb 10 mnt.
- **worker.js**: versi Cloudflare Workers + KV (upgrade path bila free tier Render kurang).

## Endpoint
| Method | Path | Fungsi |
|---|---|---|
| GET | `/` | dashboard (auto-refresh 60 dtk) |
| GET | `/healthz` | health check |
| GET | `/api/pulse` | JSON state lengkap |
| POST | `/hb` | heartbeat (Bearer PULSE_TOKEN) |

## Env
- `PULSE_TOKEN` — auth heartbeat
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — alert
- `PORT` — di-set Render otomatis

## Instalasi sender (device)
```bash
cp pulse-sender.sh ~/.roca-ops/pulse-sender.sh && chmod +x ~/.roca-ops/pulse-sender.sh
# PULSE_URL + PULSE_TOKEN di ~/.agent/rocai/.env
crontab -l | { cat; echo '*/3 * * * * /data/data/com.termux/files/usr/bin/bash /data/data/com.termux/files/home/.roca-ops/pulse-sender.sh >/dev/null 2>&1'; } | crontab -
```

## Drill (uji alarm)
1. Matikan cron sender → tunggu ~9,5 mnt → harus ada alert OFFLINE (Telegram) + event di dashboard.
2. Nyalakan lagi + jalankan manual → event RECOVERED + alert Telegram.

## Catatan desain
- Stateless = chart mulai baru tiap restart/spin-down Render. Wajar untuk free tier; deteksi kebutaan pasca-restart ditangani flag `recovered` dari sender + alert BLIND.
- Ambang GATE_AMAN sengaja sama dengan delayed-launcher benchmark v4 — satu bahasa tekanan device.
- Bash murni + curl untuk sender: ringan, tahan LMK, tanpa dependensi.
