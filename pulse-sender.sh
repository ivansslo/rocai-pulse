#!/data/data/com.termux/files/usr/bin/bash
# RocAI Pulse — pengirim heartbeat device -> Render.
# Cron tiap 3 menit. Bash murni + curl (ringan, tahan LMK).
set -u

ENV_FILE="$HOME/.agent/rocai/.env"
LOG="$HOME/.roca-ops/pulse-sender.log"
STAMP="$HOME/.roca-ops/pulse-last-ok"   # epoch detik hb terakhir yang berhasil

URL="$(grep -m1 '^PULSE_URL=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'")"
TOK="$(grep -m1 '^PULSE_TOKEN=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'")"
[ -n "$URL" ] || { echo "$(date -Is) PULSE_URL kosong" >> "$LOG"; exit 1; }
[ -n "$TOK" ] || { echo "$(date -Is) PULSE_TOKEN kosong" >> "$LOG"; exit 1; }

# rotasi log (>64KB -> potong jadi 100 baris terakhir)
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 65536 ]; then
  tail -100 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
fi

# ---- metrik device ----
MEM=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)
SWAP_PCT=$(awk '/^SwapTotal:/{t=$2} /^SwapFree:/{f=$2} END{if(t>0) printf "%d", (t-f)*100/t; else print 0}' /proc/meminfo)
LOAD=$(cut -d' ' -f1 /proc/loadavg)
# umur proses gateway (detik) — proses 'rocai gateway run' utama
GW_PID=$(pgrep -f 'rocai gateway run' | head -1)
GW_S=0
[ -n "$GW_PID" ] && GW_S=$(ps -o etimes= -p "$GW_PID" 2>/dev/null | tr -d ' ')
[ -n "$GW_S" ] || GW_S=0
# jumlah proses benchmark / robot OCI yang jalan
RUNNER=$(pgrep -fc 'run_crypto_swarm' 2>/dev/null); RUNNER=${RUNNER:-0}
OCI=$(pgrep -fc 'roc-vm-grab' 2>/dev/null); OCI=${OCI:-0}

# ---- deteksi gap pasca-mati (utk flag recovered) ----
NOW=$(date +%s)
LAST_OK=$(cat "$STAMP" 2>/dev/null)
GAP_S=0
[ -n "$LAST_OK" ] && [ "$LAST_OK" -gt 0 ] 2>/dev/null && GAP_S=$((NOW - LAST_OK))
RECOVERED=false
[ "$GAP_S" -gt 480 ] && RECOVERED=true   # >8 mnt = melewati ambang OFFLINE

PAYLOAD=$(printf '{"mem":%s,"swap":%s,"load":%s,"gw_s":%s,"runner":%s,"oci":%s,"src":"termux","recovered":%s,"gap_s":%s}' \
  "${MEM:-0}" "${SWAP_PCT:-0}" "${LOAD:-0}" "${GW_S:-0}" "${RUNNER:-0}" "${OCI:-0}" "$RECOVERED" "$GAP_S")

HTTP=$(curl -s -m 75 -o /dev/null -w '%{http_code}' -X POST "$URL/hb" \
  -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' \
  -d "$PAYLOAD")

if [ "$HTTP" = "200" ]; then
  echo "$NOW" > "$STAMP"
  echo "$(date -Is) ok mem=${MEM:-?}MB swap=${SWAP_PCT:-?}% load=${LOAD:-?} gw=${GW_S:-?}s runner=$RUNNER oci=$OCI gap=${GAP_S}s" >> "$LOG"
else
  echo "$(date -Is) GAGAL http=$HTTP payload=$PAYLOAD" >> "$LOG"
  exit 1
fi
