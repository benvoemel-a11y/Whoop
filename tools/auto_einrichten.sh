#!/bin/bash
# Richtet ein, dass garmin_export.py dreimal am Tag automatisch läuft (7, 14, 22 Uhr).
# Ist der Mac zu der Zeit zugeklappt, läuft es, sobald er wieder aufwacht.
# Ausschalten:  bash auto_einrichten.sh aus

LABEL="de.bene.garminexport"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/garmin_export.log"

if [ "$1" = "aus" ]; then
  launchctl unload "$PLIST" 2>/dev/null
  rm -f "$PLIST"
  echo "Automatik ausgeschaltet."
  exit 0
fi

PY="$(command -v python3)"
SCRIPT="$HOME/garmin_export.py"
if [ ! -f "$SCRIPT" ]; then
  echo "garmin_export.py fehlt in $HOME. Bitte zuerst herunterladen."
  exit 1
fi
if [ ! -d "$HOME/.garminconnect" ]; then
  echo "Bitte zuerst einmal von Hand starten (python3 garmin_export.py), damit die Anmeldung gespeichert ist."
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$PY</string><string>$SCRIPT</string><string>3</string></array>
  <key>WorkingDirectory</key><string>$HOME</string>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>14</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>22</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null
launchctl load "$PLIST"
echo "Automatik eingerichtet: jeden Tag um 7:00, 14:00 und 22:00."
echo "Test läuft jetzt, bitte ca. 30 Sekunden warten ..."
launchctl start "$LABEL"
sleep 30
echo "----- Ergebnis -----"
tail -n 4 "$LOG"
