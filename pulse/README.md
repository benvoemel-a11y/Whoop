# Pulse

Eigene Gesundheits-App für das Whoop 4.0 (ohne Abo): Schlaf, Schlafdefizit, Schlafphasen, Qualität und Bedarf, Erholung, Belastung, HRV, Ruhe-HF, Schritte, Gewicht, Stress im Tagesverlauf und Fitnessalter. Dazu Logbuch, Trends, Training (Ausdauer und Kraft) und ein KI-Coach (Google Gemini oder Anthropic).

Whoop 4.0 direkt per Bluetooth (in Bluefy, Kopplung auf Basis von OpenWhoop, MIT – siehe ble/LICENSE-OpenWhoop) oder per Import: Whoop über OpenStrap Edge (CSV), Garmin (`tools/garmin_export.py` → garmin.json), Withings (PDF/CSV), Apple Health (export.xml) oder manuell. Alles bleibt lokal im Browser.

Neue Version: `version.txt` und `APP_BUILD` in `index.html` auf denselben Wert setzen.
