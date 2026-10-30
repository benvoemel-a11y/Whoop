#!/usr/bin/env python3
"""Holt deine Garmin-Werte und speichert sie als eine Datei für die App.

Benutzung im Terminal:
    python3 garmin_export.py        # letzte 30 Tage
    python3 garmin_export.py 7      # letzte 7 Tage

Beim ersten Start fragt das Programm nach deiner Garmin-E-Mail und deinem
Passwort (und evtl. einem Code). Danach bleibt die Anmeldung gespeichert
(Ordner ~/.garminconnect), dein Passwort wird nicht gespeichert.

Die Datei landet in iCloud Drive im Ordner "Whoop" (sonst in Downloads).
Auf dem iPhone: App > Mehr > Datei auswählen > iCloud Drive > Whoop > garmin.json
"""
import datetime as dt
import getpass
import json
import os
import sys
from pathlib import Path

try:
    from garminconnect import Garmin
except ImportError:
    sys.exit("Bitte zuerst installieren:  pip3 install garminconnect")

TOKENS = str(Path("~/.garminconnect").expanduser())

TYPE = {
    "running": "running", "treadmill_running": "running", "trail_running": "running", "track_running": "running",
    "indoor_running": "running", "virtual_run": "running",
    "strength_training": "weightlifting", "indoor_cardio": "hiit", "hiit": "hiit",
    "walking": "walking", "hiking": "walking", "casual_walking": "walking", "speed_walking": "walking",
    "cycling": "cycling", "indoor_cycling": "cycling", "road_biking": "cycling", "mountain_biking": "cycling",
    "virtual_ride": "cycling", "lap_swimming": "swimming", "open_water_swimming": "swimming",
    "yoga": "yoga", "pilates": "yoga", "breathwork": "yoga",
}
STAGE = {0: "deep", 1: "light", 2: "rem", 3: "wake"}


def login():
    if Path(TOKENS).exists():
        try:
            g = Garmin()
            g.login(TOKENS)
            return g
        except Exception:
            print("Gespeicherte Anmeldung abgelaufen, bitte neu anmelden.")
    email = input("Garmin-E-Mail: ").strip()
    pw = getpass.getpass("Garmin-Passwort (wird nicht angezeigt): ")
    g = Garmin(email, pw, prompt_mfa=lambda: input("Code aus E-Mail/App: ").strip())
    g.login(TOKENS)
    return g


def safe(g, name, *a):
    """Ruft eine Garmin-Funktion auf, falls diese Version sie kennt."""
    fn = getattr(g, name, None)
    if fn is None:
        return None
    try:
        return fn(*a)
    except Exception:
        return None


def gmt_ms(v):
    """Garmin-Zeitangaben (ms oder 'YYYY-MM-DD HH:MM:SS' in GMT) -> Unix-ms."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return int(v)
    s = str(v).replace("T", " ").split(".")[0]
    try:
        return int(dt.datetime.strptime(s, "%Y-%m-%d %H:%M:%S").replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
    except ValueError:
        return None


def mins(sec):
    return None if sec is None else round(sec / 60)


def day(g, d):
    out = {"date": d}
    st = safe(g, "get_stats", d) or {}
    out["steps"] = st.get("totalSteps")
    out["kcal"] = st.get("totalKilocalories")
    out["akcal"] = st.get("activeKilocalories")
    out["rhr"] = st.get("restingHeartRate")
    stress = st.get("averageStressLevel")
    out["stress"] = stress if stress is not None and stress >= 0 else None

    sl = safe(g, "get_sleep_data", d) or {}
    s = sl.get("dailySleepDTO") or {}
    out["sleep"] = mins(s.get("sleepTimeSeconds"))
    out["deep"] = mins(s.get("deepSleepSeconds"))
    out["light"] = mins(s.get("lightSleepSeconds"))
    out["rem"] = mins(s.get("remSleepSeconds"))
    out["wake"] = mins(s.get("awakeSleepSeconds"))
    out["bed"] = gmt_ms(s.get("sleepStartTimestampGMT"))
    out["up"] = gmt_ms(s.get("sleepEndTimestampGMT"))
    out["resp"] = s.get("averageRespirationValue")
    if out["rhr"] is None:
        out["rhr"] = sl.get("restingHeartRate")
    levels = []
    for lv in sl.get("sleepLevels") or []:
        a, b = gmt_ms(lv.get("startGMT")), gmt_ms(lv.get("endGMT"))
        stg = STAGE.get(int(lv.get("activityLevel", 1)))
        if a and b and stg:
            levels.append([a, b, stg])

    hrv = safe(g, "get_hrv_data", d) or {}
    out["hrv"] = (hrv.get("hrvSummary") or {}).get("lastNightAvg") or sl.get("avgOvernightHrv")

    rec = None
    mtr = safe(g, "get_morning_training_readiness", d)
    if isinstance(mtr, dict):
        rec = mtr.get("score")
    if rec is None:
        tr = safe(g, "get_training_readiness", d)
        if isinstance(tr, list) and tr:
            rec = tr[-1].get("score")
    if rec is None:
        rec = st.get("bodyBatteryAtWakeTime") or st.get("bodyBatteryHighestValue")
    out["rec"] = rec

    mm = safe(g, "get_max_metrics", d)
    if isinstance(mm, list):
        mm = mm[0] if mm else {}
    if isinstance(mm, dict):
        gen = mm.get("generic") or {}
        vo2 = gen.get("vo2MaxPreciseValue") or gen.get("vo2MaxValue")
        if vo2:
            out["vo2"] = round(float(vo2), 1)
    return {k: v for k, v in out.items() if v is not None}, levels


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 30
    g = login()
    today = dt.date.today()
    start = today - dt.timedelta(days=n - 1)
    days, sleep = [], {}
    for i in range(n):
        d = (start + dt.timedelta(days=i)).isoformat()
        print(f"\rHole {d} ({i + 1}/{n}) ...", end="", flush=True)
        rec, levels = day(g, d)
        if len(rec) > 1:
            days.append(rec)
        if levels:
            sleep[d] = levels
    print()

    workouts = []
    for a in safe(g, "get_activities_by_date", start.isoformat(), today.isoformat()) or []:
        t0 = gmt_ms(a.get("startTimeGMT"))
        dur = a.get("duration")
        if not t0 or not dur:
            continue
        key = ((a.get("activityType") or {}).get("typeKey") or "").lower()
        workouts.append({
            "date": (a.get("startTimeLocal") or "")[:10],
            "start": t0, "end": t0 + int(dur * 1000), "dur": round(dur / 60),
            "type": TYPE.get(key, key or "activity"), "avg": a.get("averageHR"),
            "max": a.get("maxHR"), "kcal": a.get("calories"),
        })

    bc = safe(g, "get_body_composition", start.isoformat(), today.isoformat()) or {}
    weights = {}
    for w in bc.get("dateWeightList") or []:
        if w.get("weight"):
            weights[w.get("calendarDate")] = {"weight": round(w["weight"] / 1000, 1),
                                               **({"fat": w["bodyFat"]} if w.get("bodyFat") else {})}
    for rec in days:
        rec.update(weights.pop(rec["date"], {}))
    days += [{"date": d, **v} for d, v in weights.items()]

    fa = safe(g, "get_fitnessage_data", today.isoformat()) or {}
    fitness_age = fa.get("fitnessAge") if isinstance(fa, dict) else None

    data = {"app": "whoop-by-me", "fitnessAge": round(fitness_age, 1) if fitness_age else None, "source": "garmin", "created": dt.datetime.now().isoformat(timespec="seconds"),
            "days": days, "sleep": sleep, "workouts": workouts}
    icloud = Path("~/Library/Mobile Documents/com~apple~CloudDocs").expanduser()
    folder = icloud / "Whoop" if icloud.exists() else Path("~/Downloads").expanduser()
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "garmin.json"
    path.write_text(json.dumps(data))
    print(f"Fertig: {len(days)} Tage, {len(workouts)} Aktivitäten")
    print(f"Datei: {path}")


if __name__ == "__main__":
    main()
