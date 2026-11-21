#!/data/data/com.termux/files/usr/bin/bash
# RocAI Pulse — pengirim denyut nadi device ke layanan Render (rocai-pulse).
# Dipanggil cron tiap 2 menit. Sumber env: ~/.agent/rocai/.env
# (RENDER_PULSE_URL + RENDER_PULSE_TOKEN). Log: ~/rocai-tmp/pulse-sender.log (auto-cap).

ENVF="$HOME/.agent/rocai/.env"
LOG="$HOME/rocai-tmp/pulse-sender.log"

# env
URL=$(grep '^RENDER_PULSE_URL=' "$ENVF" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' )
TOK=$(grep '^RENDER_PULSE_TOKEN=' "$ENVF" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"')
[ -n "$URL" ] && [ -n "$TOK" ] || { echo "$(date '+%F %T') env belum lengkap (RENDER_PULSE_URL/TOKEN)" >> "$LOG"; exit 0; }

# ---- metrik ----
read -r MEM SWAP LOAD < <(
  free -m | awk '/^Mem:/{m=$7} /^Swap:/{s=($2>0)?sprintf("%.1f",$3*100/$2):0} END{printf "%d %s", m, s}'
  uptime | awk -F'load average:' '{split($2,a,","); gsub(/ /,"",a[1]); print a[1]}'
)

# uptime gateway (detik)
GW_S=$(ps -eo etimes,args 2>/dev/null | awk '/[g]ateway\.cjs/{print $1; exit}')
[ -n "$GW_S" ] || GW_S=0

# proses keluarga
RUNNER=0; pgrep -f 'run_crypto_swarm|finalize_v4' >/dev/null 2>&1 && RUNNER=1
OCI=0;    pgrep -f 'roc-vm-grab' >/dev/null 2>&1 && OCI=1
LAUNCHER=0; pgrep -f 'delayed_launch_v4' >/dev/null 2>&1 && LAUNCHER=1

# uptime device (jam)
UP_H=$(uptime 2>/dev/null | awk '{print $3}' | tr -d ',')

PAYLOAD=$(printf '{"src":"device","mem":%s,"swap":%s,"load":%s,"gw_s":%s,"runner":%s,"oci":%s,"extra":{"launcher":%s,"up_h":"%s"}}' \
  "${MEM:-0}" "${SWAP:-0}" "${LOAD:-0}" "${GW_S:-0}" "$RUNNER" "$OCI" "$LAUNCHER" "${UP_H:-?}")

CODE=$(curl -s -o /tmp/pulse-resp.$$ -w '%{http_code}' -m 12 -X POST "$URL/hb" \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d "$PAYLOAD" 2>/dev/null)
RC=$?
BODY=$(cat /tmp/pulse-resp.$$ 2>/dev/null); rm -f /tmp/pulse-resp.$$

if [ "$RC" -ne 0 ] || [ "$CODE" != "200" ]; then
  echo "$(date '+%F %T') GAGAL rc=$RC http=$CODE body=${BODY:0:120}" >> "$LOG"
else
  echo "$(date '+%F %T') ok mem=$MEM swap=$SWAP load=$LOAD gw=${GW_S}s runner=$RUNNER oci=$OCI" >> "$LOG"
fi

# cap log 2000 baris
[ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 2000 ] && tail -1000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
exit 0
