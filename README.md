# Markets Monitor

A dashboard tracking equities, government bond yields, central bank rates and FX across North America, the UK, the eurozone and Asia Pacific. Each region has two tabs, **Equities** and **Fixed Income & Macro**, and a separate **Weekly summary** page holds your write-ups.

- **Website:** plain HTML/CSS/JavaScript, hosted free on Vercel.
- **Data:** a scheduled GitHub Action runs `scripts/update_data.py` every 30 minutes on weekdays (07:00–21:30 UTC). It fetches the data and saves it to `data/data.json`. Your API keys stay secret in GitHub and never appear in the website code.

## Files

| File | What it does |
|---|---|
| `watchlist.json` | What to track and which region it belongs to. Edit labels or move items here. |
| `content/summaries.json` | Your weekly summaries: a headline, an overview, and an equities and a Fixed Income & Macro paragraph per region. |
| `scripts/update_data.py` | Fetches the data (Twelve Data, FRED, Bank of England, OECD). |
| `.github/workflows/update-data.yml` | Runs the updater on a schedule. |
| `data/data.json` | The data the site displays. It currently holds **sample data** until the updater first runs. |
| `index.html`, `assets/` | The website itself. |

## Setup (about 20 minutes)

1. **Get two free API keys**
   - Twelve Data: sign up at twelvedata.com (Basic plan, no card needed) and copy your API key.
   - FRED: create an account at fred.stlouisfed.org, then request an API key under *My Account → API Keys*.

2. **Put the project on GitHub**
   - Create a new **public** repository (public repos get unlimited free Actions minutes).
   - Upload everything in this folder, including the hidden `.github` folder. On a Mac, press Cmd+Shift+. in Finder to show hidden files, or use GitHub Desktop.

3. **Add your keys as secrets**
   - In the repo: *Settings → Secrets and variables → Actions → New repository secret*.
   - Add `TWELVE_DATA_API_KEY` and `FRED_API_KEY`.

4. **Run the updater once**
   - Go to the *Actions* tab, enable workflows if asked, choose **Update market data**, then click **Run workflow**.
   - It takes about 3 minutes, because the free Twelve Data plan allows 8 requests a minute and the script waits between batches. When it finishes, `data/data.json` holds real data and the sample banner disappears.

5. **Deploy on Vercel**
   - Sign in at vercel.com with GitHub, choose *Add New → Project*, import the repo, set *Framework preset* to **Other**, and leave the build settings empty.
   - Every time the Action saves new data, Vercel redeploys automatically. You get a public link to put on your CV.

6. **Write your weekly summary**
   - Edit `content/summaries.json` (you can do this directly on GitHub). Each Friday, copy the week block, paste it at the **top** of the `weeks` list, change `week_ending`, and fill in the text. Older weeks move into the archive on the Weekly summary page automatically.

## Preview locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

To regenerate sample data: `python3 scripts/make_sample_data.py`.

## Things to know

- **Indices are shown through ETF proxies** (SPY for the S&P 500, FEZ for the Euro Stoxx 50, and so on), because index levels are licensed data that free APIs don't include. The site labels each proxy.
- **The free Twelve Data plan covers US-listed securities, FX and crypto only.** London-listed ETFs such as ISF (FTSE 100) and MIDD (FTSE 250) need a paid plan, so the UK uses EWU (MSCI UK, US-listed) for now. If you upgrade, change `EWU` in `watchlist.json` to `ISF` and add `MIDD`.
- **UK yields:** the Bank of England publishes daily gilt par yields at 5, 10 and 20 years, so the site shows the 5y gilt rather than the 2y. If the BoE ever blocks the automated request, the 10y gilt falls back to a monthly series from FRED.
- **Eurozone and Japan 10y yields are monthly averages** (OECD data via FRED), so the France–Germany and Italy–Germany spreads are monthly too. For daily data later, the Bundesbank, Banque de France and Japan's Ministry of Finance publish daily yields.
- **Prices update about every 30 minutes**, not tick by tick. Truly live data needs a paid plan and a different setup.
- **US–Japan inflation spread:** US CPI year on year (BLS, via FRED) minus Japan CPI year on year (OECD data API, no key). Both are monthly, and the spread uses the latest month both have published, so it can trail the US release by a month.
- **Licensing:** Twelve Data's Basic plan is described as for personal, internal use. Check their terms (or ask them) before promoting the site publicly. FRED and the Bank of England require attribution, which is in the site footer.
- If any single source fails, the site keeps its last good value and marks it "Stale" rather than going blank.
