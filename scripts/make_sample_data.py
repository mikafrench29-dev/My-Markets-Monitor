#!/usr/bin/env python3
"""Writes clearly labelled SAMPLE data (random walks) so the site can be previewed before
the real updater has run. The website shows a 'sample data' banner whenever sample=true.
Run the real updater (scripts/update_data.py) to replace it."""
import json
import os
import random
import sys
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from update_data import WATCHLIST, OUT, build_entry, spread  # noqa: E402

random.seed(7)
START = {
    "SPY": 600, "QQQ": 520, "IWM": 230, "UUP": 28, "EWU": 38, "FEZ": 55, "EWG": 40, "EWJ": 75,
    "FXI": 36, "EWH": 21, "EWA": 26, "GLD": 330, "GBPUSD": 1.30, "EURGBP": 0.87, "EURUSD": 1.13,
    "USDJPY": 150, "AUDUSD": 0.66, "USDCNH": 7.15, "BRENT": 70, "UST2Y": 4.0, "UST10Y": 4.6,
    "GILT5Y": 4.2, "GILT10Y": 4.7, "DE10Y": 2.9, "FR10Y": 3.6, "IT10Y": 3.9, "JGB10Y": 1.6,
}
STEPS = {"FEDFUNDS": [4.33, 4.08, 3.83], "BANKRATE": [4.25, 4.0, 3.75], "ECBDFR": [2.0, 2.25, 2.5]}
MONTHLY = {"DE10Y", "FR10Y", "IT10Y", "JGB10Y"}


def business_days(n):
    d, out = date.today(), []
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d -= timedelta(days=1)
    return sorted(out)


RATES = {"UST2Y", "UST10Y", "GILT5Y", "GILT10Y", "DE10Y", "FR10Y", "IT10Y", "JGB10Y"}
FX = {"GBPUSD", "EURGBP", "EURUSD", "USDJPY", "AUDUSD", "USDCNH"}


def walk(key, dates):
    v, out = START[key], []
    monthly = key in MONTHLY
    for d in dates:
        if key in RATES:
            v += random.gauss(0, 0.05 if monthly else 0.03)
        else:
            vol = 0.004 if key in FX else 0.018 if key == "BRENT" else 0.011
            v *= 1 + random.gauss(0.0002, vol)
        out.append([d.isoformat(), round(v, 4)])
    return out


def main():
    wl = json.load(open(WATCHLIST))
    days = business_days(260)
    months = [date(date.today().year - 3 + (m // 12), m % 12 + 1, 1) for m in range(date.today().month - 1, date.today().month + 35)]
    raw = {}
    for k in START:
        raw[k] = walk(k, months if k in MONTHLY else days)
    for k, levels in STEPS.items():
        thirds = len(days) // 3
        raw[k] = [[d.isoformat(), levels[min(i // thirds, 2)]] for i, d in enumerate(days)]
    raw["FRDE"] = spread(raw["FR10Y"], raw["DE10Y"])
    raw["ITDE"] = spread(raw["IT10Y"], raw["DE10Y"])
    result = {}
    for k, m in wl["instruments"].items():
        src = "calc" if m["source"] == "calc" else m["source"]
        result[k] = build_entry(k, m, raw[k], src)
        if m.get("hidden"):
            result[k]["hidden"] = True
    json.dump({"updated": date.today().isoformat() + "T12:00:00Z", "sample": True, "instruments": result},
              open(OUT, "w"), separators=(",", ":"))
    print(f"Wrote sample data for {len(result)} instruments to {OUT}")


if __name__ == "__main__":
    main()
