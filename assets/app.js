(function () {
  "use strict";

  var state = { wl: null, data: null, sums: { weeks: [] }, selected: {}, range: {} };
  var MINUS = "−";
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var DAILY_RANGES = [["1M", 31], ["3M", 92], ["6M", 183], ["1Y", 366]];
  var MONTHLY_RANGES = [["1Y", 366], ["2Y", 731], ["3Y", 1096]];
  var DESKS = [["equities", "Equities"], ["macro", "Fixed Income & Macro"]];
  var ARROW = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4"/></svg>';

  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function getJSON(url) {
    return fetch(url + "?v=" + Date.now(), { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(url + " " + r.status);
      return r.json();
    });
  }

  // ---------- formatting
  function signed(n, digits) {
    var s = Math.abs(n).toFixed(digits);
    if (Number(s) === 0) return s;
    return (n > 0 ? "+" : MINUS) + s;
  }
  function fmtValue(inst, v) {
    v = v == null ? inst.last : v;
    switch (inst.kind) {
      case "rate": return v.toFixed(2) + "%";
      case "spread": return Math.round(v) + " bp";
      case "fx": return v.toFixed(v >= 20 ? 2 : 4);
      default: return "$" + v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
  }
  function isRate(inst) { return inst.kind === "rate" || inst.kind === "spread"; }
  function fmtChange(inst) {
    if (isRate(inst)) return signed(inst.change, 1) + " bp";
    return inst.changePct == null ? "" : signed(inst.changePct, 2) + "%";
  }
  function dirOf(inst) {
    var c = isRate(inst) ? inst.change : inst.changePct;
    if (!c || Math.abs(c) < 1e-9) return "flat";
    return c > 0 ? "up" : "down";
  }
  function fmtDate(iso, monthly) {
    var p = iso.split("-");
    var m = MONTHS[Number(p[1]) - 1];
    return monthly ? m + " " + p[0].slice(2) : Number(p[2]) + " " + m;
  }
  function fmtDateLong(iso, withDay) {
    var p = iso.split("-");
    var s = Number(p[2]) + " " + MONTHS[Number(p[1]) - 1] + " " + p[0];
    if (withDay) s = DAYS[new Date(iso + "T12:00:00Z").getUTCDay()] + " " + s;
    return s;
  }
  function subLine(inst) {
    var bits = [];
    if (inst.proxy) bits.push(esc(inst.proxy) + " (ETF proxy)");
    else if (inst.kind === "spread") bits.push("10y yield gap");
    else if (inst.unit && inst.unit !== "%" && inst.unit !== "bp") bits.push(esc(inst.unit));
    bits.push("as of " + fmtDateLong(inst.asof));
    return bits.join(" · ");
  }
  function tags(inst) {
    var t = "";
    if (inst.freq === "monthly") t += '<span class="tag">Monthly</span>';
    if (inst.stale) t += '<span class="tag stale" title="Latest update failed; showing the last good value">Stale</span>';
    return t;
  }

  // ---------- charts
  function sparkline(series, cls) {
    var pts = series.slice(-60);
    if (pts.length < 2) return "";
    var w = 72, h = 26, min = Infinity, max = -Infinity;
    pts.forEach(function (p) { if (p[1] < min) min = p[1]; if (p[1] > max) max = p[1]; });
    var span = max - min || 1;
    var d = pts.map(function (p, i) {
      return (i ? "L" : "M") + (i / (pts.length - 1) * w).toFixed(1) + "," + (h - 2 - (p[1] - min) / span * (h - 4)).toFixed(1);
    }).join("");
    return '<svg class="' + (cls || "spark") + '" viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none" aria-hidden="true"><path d="' + d + '" fill="none" stroke="var(--ink)" stroke-opacity=".75" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>';
  }

  function niceTicks(min, max, count) {
    var span = max - min || Math.abs(max) || 1;
    var step = Math.pow(10, Math.floor(Math.log10(span / count)));
    var err = (span / count) / step;
    step *= err >= 7.5 ? 10 : err >= 3 ? 5 : err >= 1.5 ? 2 : 1;
    var ticks = [];
    for (var t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) ticks.push(t);
    return ticks;
  }

  function drawChart(box, inst, rangeDays) {
    var all = inst.history;
    var last = new Date(all[all.length - 1][0]);
    var cutoff = new Date(last.getTime() - rangeDays * 864e5).toISOString().slice(0, 10);
    var pts = all.filter(function (p) { return p[0] >= cutoff; });
    if (pts.length < 2) pts = all.slice(-2);
    var W = Math.max(box.clientWidth, 280), H = box.clientHeight || 260;
    var pad = { l: 2, r: 60, t: 10, b: 24 };
    var min = Infinity, max = -Infinity;
    pts.forEach(function (p) { if (p[1] < min) min = p[1]; if (p[1] > max) max = p[1]; });
    var padY = (max - min) * 0.08 || Math.abs(max) * 0.01 || 1;
    min -= padY; max += padY;
    var x = function (i) { return pad.l + i / (pts.length - 1) * (W - pad.l - pad.r); };
    var y = function (v) { return pad.t + (1 - (v - min) / (max - min)) * (H - pad.t - pad.b); };
    var monthly = inst.freq === "monthly";
    var line = pts.map(function (p, i) { return (i ? "L" : "M") + x(i).toFixed(1) + "," + y(p[1]).toFixed(1); }).join("");
    var area = line + "L" + x(pts.length - 1).toFixed(1) + "," + (H - pad.b) + "L" + x(0).toFixed(1) + "," + (H - pad.b) + "Z";
    var svg = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(inst.label) + ' chart">';
    niceTicks(min, max, 4).forEach(function (t) {
      svg += '<line class="grid" x1="' + pad.l + '" x2="' + (W - pad.r) + '" y1="' + y(t).toFixed(1) + '" y2="' + y(t).toFixed(1) + '"/>';
      svg += '<text class="axis" x="' + (W - pad.r + 10) + '" y="' + (y(t) + 4).toFixed(1) + '">' + esc(fmtValue(inst, t)) + "</text>";
    });
    [0, Math.floor((pts.length - 1) / 2), pts.length - 1].forEach(function (i, k) {
      var anchor = k === 0 ? "start" : k === 2 ? "end" : "middle";
      svg += '<text class="axis" text-anchor="' + anchor + '" x="' + x(i).toFixed(1) + '" y="' + (H - 6) + '">' + fmtDate(pts[i][0], monthly) + "</text>";
    });
    svg += '<path d="' + area + '" fill="var(--accent)" fill-opacity="var(--area)" style="fill-opacity:var(--area)"/>';
    svg += '<path d="' + line + '" fill="none" stroke="var(--ink)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
    svg += '<circle cx="' + x(pts.length - 1).toFixed(1) + '" cy="' + y(pts[pts.length - 1][1]).toFixed(1) + '" r="3.5" fill="var(--ink)"/>';
    svg += '<line class="hover-line" x1="0" x2="0" y1="' + pad.t + '" y2="' + (H - pad.b) + '" stroke="var(--muted)" stroke-dasharray="3 3" visibility="hidden"/>';
    svg += '<circle class="hover-dot" r="4.5" fill="var(--accent)" stroke="var(--ink)" stroke-width="1.5" visibility="hidden"/>';
    svg += '</svg><div class="tooltip"></div>';
    box.innerHTML = svg;

    var s = box.querySelector("svg"), hl = s.querySelector(".hover-line"), hd = s.querySelector(".hover-dot"), tip = box.querySelector(".tooltip");
    function move(ev) {
      var rect = s.getBoundingClientRect();
      var px = (ev.clientX - rect.left) * (W / rect.width);
      var i = Math.round((px - pad.l) / (W - pad.l - pad.r) * (pts.length - 1));
      i = Math.max(0, Math.min(pts.length - 1, i));
      var cx = x(i), cy = y(pts[i][1]);
      hl.setAttribute("x1", cx); hl.setAttribute("x2", cx); hl.setAttribute("visibility", "visible");
      hd.setAttribute("cx", cx); hd.setAttribute("cy", cy); hd.setAttribute("visibility", "visible");
      tip.style.display = "block";
      tip.style.left = (cx * rect.width / W) + "px";
      tip.style.top = (cy * rect.height / H) + "px";
      tip.textContent = fmtDateLong(pts[i][0]) + " · " + fmtValue(inst, pts[i][1]);
    }
    function leave() { hl.setAttribute("visibility", "hidden"); hd.setAttribute("visibility", "hidden"); tip.style.display = "none"; }
    s.addEventListener("mousemove", move);
    s.addEventListener("mouseleave", leave);
    s.addEventListener("touchstart", function (e) { move(e.touches[0]); }, { passive: true });
    s.addEventListener("touchmove", function (e) { move(e.touches[0]); }, { passive: true });
  }

  // ---------- routing
  function parseRoute() {
    var h = location.hash.slice(1);
    if (h === "summary") return { page: "summary" };
    var desk = "equities";
    DESKS.forEach(function (d) {
      var suffix = "-" + d[0];
      if (h.length > suffix.length && h.slice(-suffix.length) === suffix) { desk = d[0]; h = h.slice(0, -suffix.length); }
    });
    var region = state.wl.regions.filter(function (r) { return r.id === h; })[0] || state.wl.regions[0];
    return { page: "region", region: region, desk: desk };
  }

  // ---------- page parts
  function inst(key) { return state.data.instruments[key]; }

  function renderNav(route) {
    var current = route.page === "summary" ? "summary" : route.region.id;
    var links = state.wl.regions.map(function (r) { return [r.id, r.name]; }).concat([["summary", "Weekly summary"]]);
    $("#nav").innerHTML = links.map(function (l) {
      return '<a href="#' + l[0] + '"' + (l[0] === current ? ' aria-current="page"' : "") + ">" + esc(l[1]) + "</a>";
    }).join("");
  }

  function globalHTML() {
    return '<section class="global" aria-label="Global markets">' + state.wl.global.map(function (k) {
      var i = inst(k);
      if (!i) return "";
      return '<div class="gcard"><div><div class="g-label">' + esc(i.label) + tags(i) + "</div><small>" + subLine(i) + "</small></div>" +
        '<div><div class="g-value num">' + esc(fmtValue(i)) + '</div><div class="g-chg num ' + dirOf(i) + '">' + esc(fmtChange(i)) + "</div></div>" +
        '<div class="g-spark">' + sparkline(i.history, "spark").replace('class="spark"', 'class="spark" style="width:100%;height:34px"') + "</div></div>";
    }).join("") + "</section>";
  }

  function regionPage(route) {
    var r = route.region, deskName = DESKS.filter(function (d) { return d[0] === route.desk; })[0][1];
    var keys = (route.desk === "equities" ? r.equities : r.macro).filter(function (k) { return inst(k) && !inst(k).hidden; });
    var id = r.id + "-" + route.desk;
    if (!state.selected[id] || keys.indexOf(state.selected[id]) < 0) state.selected[id] = keys[0];
    var rows = keys.map(function (k) {
      var i = inst(k);
      var sub = i.proxy ? esc(i.proxy) : esc((i.kind === "spread" ? "10y, " : "") + (i.freq === "monthly" ? "monthly average" : "daily"));
      sub = sub.charAt(0).toUpperCase() + sub.slice(1);
      return '<li class="row" role="option" tabindex="0" data-panel="' + id + '" data-key="' + k + '" aria-selected="' + (k === state.selected[id]) + '">' +
        '<div><div class="row-label">' + esc(i.label) + (i.stale ? '<span class="tag stale">Stale</span>' : "") + '</div><div class="row-sub">' + sub + "</div></div>" +
        '<div class="spark-cell">' + sparkline(i.history) + "</div>" +
        '<div class="row-right"><div class="row-value num">' + esc(fmtValue(i)) + '</div><div class="row-chg num ' + dirOf(i) + '">' + esc(fmtChange(i)) + "</div></div></li>";
    }).join("");
    var subtabs = DESKS.map(function (d) {
      return '<a class="pill" href="#' + r.id + "-" + d[0] + '"' + (d[0] === route.desk ? ' aria-current="page"' : "") + ">" + d[1] + "</a>";
    }).join("");
    var body = keys.length
      ? '<div class="desk"><div class="panel" id="feat-' + id + '"></div>' +
        '<div class="panel list"><h3>' + esc(deskName) + " · " + keys.length + (keys.length === 1 ? " instrument" : " instruments") + '</h3><ul class="rows" role="listbox" aria-label="' + esc(deskName) + '">' + rows + "</ul></div></div>"
      : '<p class="empty">No data yet.</p>';
    return globalHTML() +
      '<section class="page-head"><div><h1>' + esc(r.name) + '</h1><p class="lede">' + esc(r.blurb || "") + "</p></div>" +
      '<nav class="subtabs" aria-label="' + esc(r.name) + ' sections">' + subtabs + "</nav></section>" +
      body +
      '<div class="note-strip"><p>Click any row to chart it. Changes are against the previous day, or the previous month for monthly series.</p>' +
      '<a class="go" href="#summary">Read my weekly summary ' + ARROW + "</a></div>";
  }

  function renderFeature(id) {
    var key = state.selected[id], i = inst(key), box = $("#feat-" + id);
    if (!i || !box) return;
    var ranges = i.freq === "monthly" ? MONTHLY_RANGES : DAILY_RANGES;
    var current = state.range[id + key] || (i.freq === "monthly" ? "3Y" : "6M");
    var days = (ranges.filter(function (r) { return r[0] === current; })[0] || ranges[ranges.length - 1])[1];
    box.innerHTML =
      '<div class="feature-top"><div><div class="feature-label">' + esc(i.label) + tags(i) + '</div><div class="feature-meta">' + subLine(i) + " · " + esc(i.source) + "</div></div>" +
      '<div><div class="feature-value num">' + esc(fmtValue(i)) + '</div><div class="feature-change"><span class="num ' + dirOf(i) + '">' + esc(fmtChange(i)) + "</span> " + (i.freq === "monthly" ? "vs prior month" : "vs prior day") + "</div></div></div>" +
      '<div class="ranges">' + ranges.map(function (r) {
        return '<button class="range" type="button" data-panel="' + id + '" data-range="' + r[0] + '" aria-pressed="' + (r[0] === current) + '">' + r[0] + "</button>";
      }).join("") + "</div>" +
      '<div class="chart" id="chart-' + id + '"></div>';
    drawChart($("#chart-" + id), i, days);
  }

  function text(s) {
    return s && s.trim() ? "<p>" + esc(s) + "</p>" : '<p class="placeholder">Not written yet.</p>';
  }
  function weekRegions(week) {
    return '<div class="sum-grid">' + state.wl.regions.map(function (r) {
      var w = (week.regions || {})[r.id] || {};
      return '<article class="sum-card"><div class="card-top"><h3>' + esc(r.name) + '</h3><a class="go" href="#' + r.id + '">Data ' + ARROW + "</a></div>" +
        '<div class="part"><h4>Equities</h4>' + text(w.equities) + "</div>" +
        '<div class="part"><h4>Fixed Income &amp; Macro</h4>' + text(w.macro) + "</div></article>";
    }).join("") + "</div>";
  }

  function summaryPage() {
    var weeks = (state.sums.weeks || []).slice().sort(function (a, b) { return a.week_ending < b.week_ending ? 1 : -1; });
    if (!weeks.length) return '<section class="page-head"><div><h1>Weekly summary</h1><p class="lede">No summaries yet.</p></div></section>';
    var w = weeks[0];
    var archive = weeks.slice(1).map(function (o) {
      return '<details><summary><span>' + esc(o.title || "Week ending " + fmtDateLong(o.week_ending)) + '</span><span class="meta">' + fmtDateLong(o.week_ending) + "</span></summary>" +
        (o.overview ? '<p style="margin:12px 0 4px;color:var(--muted)">' + esc(o.overview) + "</p>" : "") + weekRegions(o) + "</details>";
    }).join("");
    return '<section class="page-head"><div><div class="issue-line"><span class="dot"></span>Week ending ' + fmtDateLong(w.week_ending, true) + "</div>" +
      '<h1>Weekly summary</h1><p class="lede">What moved in each region this week, why it moved, and what I expect next.</p></div></section>' +
      '<section class="lead-view"><div><div class="who"><i>MM</i>The week in brief</div><h2>' + esc(w.title || "This week") + "</h2></div><div>" + text(w.overview) + "</div></section>" +
      weekRegions(w) +
      (archive ? '<section class="archive"><h2>Archive</h2>' + archive + "</section>" : "");
  }

  function render() {
    var route = parseRoute();
    renderNav(route);
    var main = $("#view");
    if (route.page === "summary") {
      main.innerHTML = summaryPage();
      document.title = "Weekly summary · Markets Monitor";
    } else {
      main.innerHTML = regionPage(route);
      renderFeature(route.region.id + "-" + route.desk);
      document.title = route.region.name + " · Markets Monitor";
    }
  }

  // ---------- events
  function select(row) {
    var id = row.getAttribute("data-panel");
    state.selected[id] = row.getAttribute("data-key");
    var list = row.parentNode.querySelectorAll(".row");
    for (var j = 0; j < list.length; j++) list[j].setAttribute("aria-selected", String(list[j] === row));
    renderFeature(id);
  }
  document.addEventListener("click", function (e) {
    var row = e.target.closest(".row");
    if (row) return select(row);
    var btn = e.target.closest(".range");
    if (btn) {
      var id = btn.getAttribute("data-panel");
      state.range[id + state.selected[id]] = btn.getAttribute("data-range");
      renderFeature(id);
    }
  });
  document.addEventListener("keydown", function (e) {
    var row = e.target.closest && e.target.closest(".row");
    if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); select(row); }
  });
  window.addEventListener("hashchange", function () { render(); window.scrollTo(0, 0); });
  var resizeTimer;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      var f = document.querySelector('[id^="feat-"]');
      if (f) renderFeature(f.id.slice(5));
    }, 150);
  });
  $("#theme-btn").addEventListener("click", function () {
    var r = document.documentElement;
    var dark = r.dataset.theme ? r.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    r.dataset.theme = dark ? "light" : "dark";
    var f = document.querySelector('[id^="feat-"]');
    if (f) renderFeature(f.id.slice(5));
  });

  // ---------- boot
  Promise.all([
    getJSON("watchlist.json"),
    getJSON("data/data.json"),
    getJSON("content/summaries.json").catch(function () { return { weeks: [] }; })
  ]).then(function (res) {
    state.wl = res[0]; state.data = res[1]; state.sums = res[2];
    var d = new Date(state.data.updated);
    $("#updated").textContent = isNaN(d) ? "" : "Updated " + d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
    $("#sample-banner").hidden = !state.data.sample;
    render();
  }).catch(function (err) {
    $("#view").innerHTML = '<p class="empty">Could not load market data (' + esc(err.message) + ").</p>";
  });
})();
