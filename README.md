# RocAI Pulse ❤️

Denyut nadi device — layanan pemantau heartbeat untuk device Termux/Android milik keluarga RocAI.

## Kenapa ada ini
Device (HP Android tempat seluruh keluarga RocAI berjalan) kadang dibunuh Android LMK saat memori sempit (kill-cycle). Yang di dalam device tidak bisa memberi tahu Ayah kalau dirinya mati — makanya denyut nadi ini dipindah ke luar device: **Render (cloud) + Neon (Postgres) + Telegram (alert)**.

## Cara kerja
1. **Device** (`pulse-sender.sh`, cron tiap 2 menit) mengumpulkan metrik: mem avail, swap %, load 1 mnt, uptime gateway, status runner benchmark v4 & robot OCI → POST ke `/hb`.
2. **Service** (Render, zero-dependency Node) menyimpan ke Neon, memantau tiap 60 dtk:
   - Denyut putus > 6 mnt → 🔴 alert Telegram "kill-cycle / mati total"
   - Denyut kembali → 🟢 alert "hidup lagi"
   - Device aman stabil 3 mnt (avail≥1400MB, swap≤55%, load≤10) → ✅ alert "launcher benchmark v4 seharusnya meluncur"
3. **Dashboard** `GET /` — status AMAN/WASPADA/BAHAYA/OFFLINE, sparkline 6 jam, daftar peristiwa. Auto-refresh 60 dtk.

## Endpoint
| Endpoint | Fungsi |
|---|---|
| `POST /hb` | heartbeat device (auth Bearer PULSE_TOKEN) |
| `GET /` | dashboard HTML |
| `GET /api/pulse` | JSON riwayat 24 jam |
| `GET /healthz` | health check |

## Env vars
| Var | Isi |
|---|---|
| `DATABASE_URL` | connection string Neon (HTTP API) |
| `PULSE_TOKEN` | shared secret device ↔ service |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | tujuan alert |

Tidak ada rahasia di repo ini — semua via env vars. Zero npm dependency.

## Skema DB (dibuat otomatis saat boot)
- `rocai_pulse(ts, src, mem_avail_mb, swap_pct, load1, gw_s, runner_v4, oci_robot, extra)` — retensi 7 hari
- `rocai_pulse_events(ts, kind, detail)` — OFFLINE / RECOVERED / GATE_AMAN / BOOT
