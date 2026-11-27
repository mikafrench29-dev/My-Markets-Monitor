#!/usr/bin/env python3
"""
Fetches every instrument in watchlist.json and writes data/data.json for the website.

Sources
  - Twelve Data  (ETF proxies, FX pairs)   needs env TWELVE_DATA_API_KEY  (free Basic plan: 8 credits/minute)
  - FRED         (US rates, ECB rate, Brent, OECD 10y yields)   needs env FRED_API_KEY (free)
  - Bank of England database (Bank Rate, gilt yields)   no key
  - OECD data API (Japan CPI inflation)   no key

Runs with the Python standard library only, so GitHub Actions needs no installs.
If a source fails, the previous value in data/data.json is kept and marked stale,
so the website never goes blank because of one bad request.
"""
import csv
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WATCHLIST = os.path.join(ROOT, "watchlist.json")
OUT = os.path.join(ROOT, "data", "data.json")

TD_KEY = os.environ.get("TWELVE_DATA_API_KEY", "")
FRED_KEY = os.environ.get("FRED_API_KEY", "")

TD_CREDITS_PER_MINUTE = 8      # free Basic plan limit; raise it if you upgrade
DAILY_LOOKBACK_DAYS = 400      # about one year of daily data for the charts
MONTHLY_LOOKBACK_DAYS = 365 * 3
UA = "Mozilla/5.0 (compatible; markets-monitor/1.0; +https://github.com)"

SOURCE_NAMES = {
    "twelvedata": "Twelve Data",
    "fred": "FRED, Federal Reserve Bank of St. Louis",
    "boe": "Bank of England",
    "oecd": "OECD",
    "calc": "Calculated",
}


def log(msg):
    print(msg, flush=True)


def http_get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="replace")


# ---------------------------------------------------------------- Twelve Data
def fetch_twelvedata(symbols):
    """symbols: {key: twelve-data-symbol}. Returns {key: [[date, value], ...]}."""
    if not TD_KEY:
        log("! TWELVE_DATA_API_KEY not set; skipping Twelve Data")
        return {}
    out = {}
    items = list(symbols.items())
    chunks = [items[i:i + TD_CREDITS_PER_MINUTE] for i in range(0, len(items), TD_CREDITS_PER_MINUTE)]
    for n, chunk in enumerate(chunks):
        if n > 0:
            log(f"  waiting 62s for the Twelve Data rate limit ({n}/{len(chunks) - 1})")
            time.sleep(62)
        syms = ",".join(sym for _, sym in chunk)
        url = "https://api.twelvedata.com/time_series?" + urllib.parse.urlencode({
            "symbol": syms, "interval": "1day", "outputsize": 260, "apikey": TD_KEY, "order": "ASC",
        })
        try:
            payload = json.loads(http_get(url))
        except Exception as e:  # network or JSON error: keep going, old values are kept
            log(f"! Twelve Data request failed for {syms}: {e}")
            continue
        if len(chunk) == 1:  # single-symbol responses are not keyed by symbol
            payload = {chunk[0][1]: payload}
        for key, sym in chunk:
            block = payload.get(sym, {})
            if block.get("status") == "error" or "values" not in block:
                log(f"! Twelve Data {sym}: {block.get('message', 'no data')}")
                continue
            series = []
            for v in block["values"]:
                try:
                    series.append([v["datetime"][:10], float(v["close"])])
                except (KeyError, ValueError):
                    pass
            series.sort()
            if series:
                out[key] = series
                log(f"  {sym}: {len(series)} points, last {series[-1]}")
    return out


# ---------------------------------------------------------------- FRED
def fetch_fred(series_id, transform=None):
    if not FRED_KEY:
        raise RuntimeError("FRED_API_KEY not set")
    monthly = series_id.endswith("M156N") or transform == "yoy"
    days = MONTHLY_LOOKBACK_DAYS if monthly else DAILY_LOOKBACK_DAYS
    if transform == "yoy":
        days += 400  # an extra year so every month has a year-earlier value
    start = date.today() - timedelta(days=days)
    url = "https://api.stlouisfed.org/fred/series/observations?" + urllib.parse.urlencode({
        "series_id": series_id, "api_key": FRED_KEY, "file_type": "json",
        "observation_start": start.isoformat(),
    })
    obs = json.loads(http_get(url)).get("observations", [])
    series = [[o["date"], float(o["value"])] for o in obs if o.get("value") not in (".", "", None)]
    if not series:
        raise RuntimeError(f"FRED {series_id}: no observations")
    if transform == "yoy":
        series = yoy(series)
        if not series:
            raise RuntimeError(f"FRED {series_id}: not enough history for year-on-year")
    return series


def yoy(series):
    """Monthly index levels -> year-on-year % change."""
    level = {d[:7]: v for d, v in series}
    out = []
    for d, v in series:
        prior = f"{int(d[:4]) - 1}{d[4:7]}"
        if prior in level and level[prior]:
            out.append([d, round((v / level[prior] - 1) * 100, 4)])
    return out


# ---------------------------------------------------------------- OECD
def fetch_oecd(flows, key):
    """Tries each OECD dataflow in turn and keeps whichever has the most recent data.
    Monthly periods (2026-10) become first-of-month dates (2026-10-01) to line up with FRED."""
    start = (date.today() - timedelta(days=MONTHLY_LOOKBACK_DAYS)).strftime("%Y-%m")
    best, errors = [], []
    for flow in flows:
        url = f"https://sdmx.oecd.org/public/rest/data/{flow}/{key}?" + urllib.parse.urlencode({
            "startPeriod": start, "format": "csvfile",
        })
        try:
            rows = list(csv.DictReader(io.StringIO(http_get(url, timeout=60))))
        except Exception as e:
            errors.append(f"{flow}: {e}")
            continue
        series = []
        for r in rows:
            period, value = (r.get("TIME_PERIOD") or "").strip(), (r.get("OBS_VALUE") or "").strip()
            if len(period) == 7 and value:
                try:
                    series.append([period + "-01", float(value)])
                except ValueError:
                    pass
        series.sort()
        if series and (not best or series[-1][0] > best[-1][0]):
            best = series
    if not best:
        raise RuntimeError("no data (" + "; ".join(errors) + ")" if errors else "no data")
    return best


# ---------------------------------------------------------------- Bank of England
def fetch_boe(codes):
    """Returns {code: [[date, value], ...]} from the BoE database CSV export."""
    start = (date.today() - timedelta(days=DAILY_LOOKBACK_DAYS)).strftime("%d/%b/%Y")
    url = "https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?" + urllib.parse.urlencode({
        "csv.x": "yes", "Datefrom": start, "Dateto": "now", "SeriesCodes": ",".join(codes),
        "CSVF": "TN", "UsingCodes": "Y", "VPD": "Y", "VFD": "N",
    })
    text = http_get(url)
    rows = list(csv.reader(io.StringIO(text)))
    if not rows or "DATE" not in rows[0][0].upper():
        raise RuntimeError("unexpected Bank of England response (it may be blocking automated requests)")
    header = [h.strip() for h in rows[0]]
    out = {c: [] for c in codes}
    for row in rows[1:]:
        if not row or not row[0].strip():
            continue
        try:
            d = datetime.strptime(row[0].strip(), "%d %b %Y").date().isoformat()
        except ValueError:
            continue
        for i, col in enumerate(header[1:], start=1):
            if col in out and i < len(row) and row[i].strip():
                try:
                    out[col].append([d, float(row[i])])
                except ValueError:
                    pass
    return {c: sorted(v) for c, v in out.items() if v}


# ---------------------------------------------------------------- assembly
def guess_freq(series):
    if len(series) < 3:
        return "daily"
    d1 = date.fromisoformat(series[-1][0])
    d0 = date.fromisoformat(series[-3][0])
    return "monthly" if (d1 - d0).days > 40 else "daily"


def build_entry(key, meta, series, source):
    last_d, last_v = series[-1]
    prev_v = series[-2][1] if len(series) > 1 else last_v
    is_rate = meta["kind"] in ("rate", "spread")
    entry = {
        "label": meta["label"],
        "proxy": meta.get("proxy"),
        "kind": meta["kind"],
        "unit": meta.get("unit", "bp" if meta["kind"] == "spread" else ("%" if is_rate else "")),
        "source": SOURCE_NAMES.get(source, source),
        "freq": guess_freq(series),
        "asof": last_d,
        "last": round(last_v, 4),
        # rates and spreads: change in basis points; prices and FX: percent change
        "change": round((last_v - prev_v) * (1 if meta["kind"] == "spread" else 100), 1) if is_rate else round(last_v - prev_v, 4),
        "changePct": None if is_rate else (round((last_v / prev_v - 1) * 100, 2) if prev_v else None),
        "history": [[d, round(v, 4)] for d, v in series],
        "stale": False,
    }
    for extra in ("note", "sub"):
        if meta.get(extra):
            entry[extra] = meta[extra]
    return entry


def spread(a, b, scale=100):
    """a minus b on matching dates. scale=100 gives basis points; scale=1 keeps percentage points."""
    bmap = dict(b)
    return [[d, round((v - bmap[d]) * scale, 2)] for d, v in a if d in bmap]


def main():
    with open(WATCHLIST) as f:
        wl = json.load(f)
    instruments = wl["instruments"]

    try:
        with open(OUT) as f:
            previous = json.load(f)
        if previous.get("sample"):
            previous = {"instruments": {}}
    except (FileNotFoundError, json.JSONDecodeError):
        previous = {"instruments": {}}

    raw, used_source = {}, {}

    # Twelve Data (batched to respect the per-minute limit)
    td = {k: m["symbol"] for k, m in instruments.items() if m["source"] == "twelvedata"}
    log(f"Twelve Data: {len(td)} symbols")
    for k, s in fetch_twelvedata(td).items():
        raw[k], used_source[k] = s, "twelvedata"

    # Bank of England
    boe = {k: m["series"] for k, m in instruments.items() if m["source"] == "boe"}
    if boe:
        log(f"Bank of England: {list(boe.values())}")
        try:
            got = fetch_boe(list(boe.values()))
            for k, code in boe.items():
                if code in got:
                    raw[k], used_source[k] = got[code], "boe"
        except Exception as e:
            log(f"! Bank of England failed: {e}")

    # OECD
    for k, m in instruments.items():
        if m["source"] == "oecd":
            try:
                raw[k], used_source[k] = fetch_oecd(m["flows"], m["key"]), "oecd"
                log(f"  OECD {m['key']}: last {raw[k][-1]}")
            except Exception as e:
                log(f"! OECD {m['key']} failed: {e}")

    # FRED (plus fallbacks for anything still missing)
    for k, m in instruments.items():
        spec = m if m["source"] == "fred" else (m.get("fallback") if k not in raw else None)
        if not spec or spec.get("source") != "fred":
            continue
        try:
            raw[k], used_source[k] = fetch_fred(spec["series"], spec.get("transform")), "fred"
            log(f"  FRED {spec['series']}: last {raw[k][-1]}")
        except Exception as e:
            log(f"! FRED {spec['series']} failed: {e}")

    # Calculated spreads
    for k, m in instruments.items():
        if m["source"] == "calc":
            a, b = m["minus"]
            if a in raw and b in raw:
                s = spread(raw[a], raw[b], m.get("scale", 100))
                if s:
                    raw[k], used_source[k] = s, "calc"

    # Build output, keeping old values (marked stale) where a fetch failed
    result = {}
    for k, m in instruments.items():
        if k in raw and raw[k]:
            result[k] = build_entry(k, m, raw[k], used_source[k])
            if m["source"] == "calc":
                result[k]["source"] = m.get("source_note", "Calculated from OECD data via FRED")
        elif k in previous.get("instruments", {}):
            result[k] = dict(previous["instruments"][k], stale=True)
            log(f"! {k}: kept previous value (stale)")
        else:
            log(f"! {k}: no data yet")
        if k in result and m.get("hidden"):
            result[k]["hidden"] = True

    ok = sum(1 for v in result.values() if not v.get("stale"))
    if ok == 0:
        log("! Nothing fetched successfully; leaving data/data.json unchanged")
        sys.exit(1)

    data = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sample": False,
        "instruments": result,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    log(f"Wrote {OUT}: {ok} fresh, {len(result) - ok} stale, {len(instruments) - len(result)} missing")


if __name__ == "__main__":
    main()
