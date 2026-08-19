/* Vehicle Activity Log — MyGeotab add-in report
 *
 * Replicates a per-event vehicle activity report: one row per GPS log, with a
 * derived status (Ignition on / Idling start / Idling / Idling end / Moving /
 * Ignition off), idling duration, running daily distance, spot speed, address,
 * coordinates and a Replay link.
 *
 * NAMESPACING: MyGeotab add-in pages are injected into the host page, not
 * iframed, so every add-in in a database shares one JS scope. Everything here
 * lives inside this IIFE and the single `geotab.addin.vehicleActivityLog` entry
 * point. Do not introduce bare top-level names — legacy-trip-report already
 * declares a top-level `var state` and would collide.
 */
(function () {
  "use strict";

  if (typeof window.geotab === "undefined") { window.geotab = { addin: {} }; }
  if (!window.geotab.addin) { window.geotab.addin = {}; }

  // ─── Constants ───────────────────────────────────────────────────────────
  // Geotab defines idling as speed below 1 km/h with the ignition on.
  //
  // Every speed and distance INSIDE this file is metric, because that is what
  // the API returns: LogRecord.speed is km/h regardless of who is logged in.
  // Imperial is a display conversion applied at the last moment, in fmtDist and
  // fmtSpeed. Do not convert earlier or thresholds start disagreeing with data.
  // Stamped into the copied diagnostics, so a pasted failure report says which
  // build produced it. Keep in step with index.html and config.json.
  var APP_VERSION     = "1.7.4";

  var IDLE_SPEED_KMH  = 1;
  var IDLE_RESUME_KM  = 0.05;   // 50 m of ground covered ends a stop
  var IDLE_RESUME_MS  = 30000;  // or 30 s above the speed threshold, whichever first
  var KM_PER_MILE     = 1.609344;
  var MAX_RECORDS     = 50000;  // hard cap on a single Get
  var SPLIT_DEPTH     = 6;      // how many times to halve a window that hits the cap
  var GEOCODE_CHUNK   = 400;    // GetAddresses accepts up to 400 coordinates per call
  var GEOCODE_MAX_PTS = 12000;  // 30 calls, well inside the 450/min limit
  var MAX_DEVICES     = 25;     // guard against a whole-fleet run
  var PDF_MAX_ROWS    = 5000;
  var COORD_DP        = 4;      // ~11 m dedupe grid for geocoding
  var GEOTAB_NAVY     = [39, 50, 93];

  // Row emission rules. A row is written when something actually changed, not
  // on a timer, which is what the customer's reference report appears to do:
  // its rows sit 1 to 3 minutes apart but the distance between them is close to
  // constant, which is a distance trigger, not a clock.
  //
  //   distKm      cumulative distance since the last row
  //   speedKmh    absolute change in spot speed since the last row. Absolute,
  //               not a percentage: 20% of 2 km/h is 0.4 km/h, which is inside
  //               GPS noise, so a relative threshold fires nonstop at low speed
  //               and never fires on a motorway.
  //   headingDeg  change in direction of travel, computed from consecutive
  //               coordinates. This is the cheap stand-in for "we are on a
  //               different street". Street name itself would mean reverse
  //               geocoding every single log before deciding what to keep,
  //               roughly 3x the GetAddresses volume, and the name flips
  //               between parallel roads at junctions.
  //   maxGapMs    ceiling: emit anyway after this long with nothing changing,
  //               so a steady motorway run still shows signs of life.
  //   minGapMs    floor: never two rows closer than this, so a roundabout does
  //               not produce six rows in ten seconds. Status changes ignore
  //               the floor.
  //   minIdleMs   an idle run shorter than this writes no rows at all at this
  //               level. Status changes bypass minGapMs, which is why a car
  //               creeping through 1 km/h for two seconds still produced an
  //               Idling start and an Idling end on Balanced. Below this
  //               length we do not believe it was a stop worth reporting. The
  //               time is still counted in the day total, so the headline
  //               idling figure is the same whichever level is picked. Only
  //               the rows differ.
  //               45 s on Balanced is a typical wait at a red light: a signal
  //               cycle runs 60-120 s and your approach holds red for a third
  //               to a half of it. 120 s on Key events is the bad wait at a
  //               large junction, so only stops longer than any red light
  //               reach that view.
  //
  // Each level carries a metric and an imperial pair rather than one pair that
  // gets converted. Converting 1.5 km would put "0.9 mi" in front of an imperial
  // user, which reads like a rounding artefact. These are round numbers in both
  // systems and close enough to each other that the output density matches.
  var DETAIL_LEVELS = {
    key:      { metric: { dist: 5,   speed: 30 }, imperial: { dist: 3,   speed: 20 }, headingDeg: 90, maxGapMs: 900000, minGapMs: 60000, minIdleMs: 120000 },
    balanced: { metric: { dist: 1.5, speed: 20 }, imperial: { dist: 1,   speed: 12 }, headingDeg: 45, maxGapMs: 300000, minGapMs: 30000, minIdleMs: 45000  },
    detailed: { metric: { dist: 0.5, speed: 10 }, imperial: { dist: 0.3, speed: 6  }, headingDeg: 30, maxGapMs: 120000, minGapMs: 15000, minIdleMs: 0      },
    all:      null
  };

  // Resolve a level into the metric thresholds the engine compares against, plus
  // the labels to show the operator in their own units.
  function activeRules(key) {
    var L = DETAIL_LEVELS[key];
    if (!L) return null;
    var u = S.isMetric ? L.metric : L.imperial;
    return {
      distKm:     S.isMetric ? u.dist  : u.dist  * KM_PER_MILE,
      speedKmh:   S.isMetric ? u.speed : u.speed * KM_PER_MILE,
      distLabel:  u.dist  + " " + distUnit(),
      speedLabel: u.speed + " " + speedUnit(),
      headingDeg: L.headingDeg,
      maxGapMs:   L.maxGapMs,
      minGapMs:   L.minGapMs,
      minIdleMs:  L.minIdleMs
    };
  }

  // ─── State ───────────────────────────────────────────────────────────────
  var S = {
    api:        null,
    gState:     null,   // the MyGeotab state object (gotoPage lives here)
    dbName:     "",
    server:     "",
    hostVia:    "",   // which source the server name came from, shown on screen
    addrMap:    {},     // "lat,lng" -> resolved address
    devices:    [],     // [{ id, name, days: [{ dayKey, rows, distKm, idleMins }] }]
    warnings:   [],
    failed:     [],     // vehicle names left out of the report; see addFailure
    apiLog:     [],     // every failed attempt this run; see recordApiFailure
    running:    false,
    rules:      null,   // active DETAIL_LEVELS entry; null shows every GPS log
    tzId:       "",     // MyGeotab User.timeZoneId; "" falls back to the browser
    tzVia:      "",
    isMetric:   true,   // MyGeotab User.isMetric; SDK default is true
    unitsVia:   "",
    userName:   "",
    datesTouched: false // true once the operator has picked a date themselves
  };

  // ─── Generic helpers ─────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }

  // Retry before giving up. A dropped request used to cost a whole vehicle:
  // 171 WX 2519 SPARE drove 430 km across Ireland on 18 Aug 2026 and the report
  // showed nothing for it, because one Get failed and nothing tried again.
  //
  // Most failures here are transient: a timed-out request, a 502 from the load
  // balancer, or MyGeotab's rate limiter. All three succeed on a second attempt
  // moments later. Backoff is 1 s, 3 s, then 9 s, so a vehicle is only declared
  // unreadable after 13 seconds of the server refusing.
  //
  // What is NOT retried is a request the server understood and rejected: a bad
  // parameter, a missing entity, or an expired session. Repeating those just
  // makes the operator wait longer for the same answer. OverLimit is the one
  // 4xx worth repeating, because it means "later", not "no".
  var RETRY_DELAYS_MS = [1000, 3000, 9000];

  // The failure that cost us 171 WX 2519 SPARE on 18 Aug 2026 left nothing behind
  // to look at: the error went to console.error in a session nobody had DevTools
  // open on, and by the time it was reported the evidence was gone. Three days of
  // work went into proving where it did NOT happen.
  //
  // So every failed attempt is now recorded, retried or not, and can be copied
  // out of the red block as text. The next occurrence is diagnosable from a
  // screenshot-and-paste instead of a reproduction attempt.
  var MAX_API_LOG = 200;

  // An Error does not survive JSON.stringify: own properties on Error instances
  // are non-enumerable, so it serialises to "{}". Walk it by hand instead, and
  // take whatever a non-Error object carries, because the shape the add-in `api`
  // object hands the failure callback is not documented and may not be an Error
  // at all. Recording everything is the point.
  function describeError(err) {
    if (err == null) return { note: "error callback fired with " + String(err) };
    if (typeof err !== "object") return { value: String(err), jsType: typeof err };
    var out = { jsType: Object.prototype.toString.call(err) };
    ["name", "message", "type", "code", "stack", "id", "requestIndex"].forEach(function (k) {
      if (err[k] != null) out[k] = String(err[k]).slice(0, 800);
    });
    // Geotab nests the useful part: error.data.type / error.data.info.
    if (err.data && typeof err.data === "object") {
      out.data = {};
      ["type", "id", "requestIndex"].forEach(function (k) {
        if (err.data[k] != null) out.data[k] = String(err.data[k]);
      });
      if (err.data.info != null) {
        try { out.data.info = JSON.stringify(err.data.info).slice(0, 800); }
        catch (e) { out.data.info = String(err.data.info).slice(0, 800); }
      }
    }
    // Anything enumerable we did not name above.
    try {
      Object.keys(err).forEach(function (k) {
        if (out[k] === undefined && k !== "data") {
          out[k] = String(err[k]).slice(0, 400);
        }
      });
    } catch (e) { /* exotic proxy; the named fields above are enough */ }
    return out;
  }

  function recordApiFailure(method, params, attempt, willRetry, err) {
    if (S.apiLog.length >= MAX_API_LOG) return;
    var p = params || {};
    S.apiLog.push({
      at:       new Date().toISOString(),
      method:   method,
      typeName: p.typeName || "",
      // The device and window are what make a failure reproducible later.
      device:   (p.search && p.search.deviceSearch && p.search.deviceSearch.id) ||
                (p.search && p.search.id) || "",
      from:     (p.search && p.search.fromDate) || "",
      to:       (p.search && p.search.toDate) || "",
      attempt:  attempt,
      retried:  willRetry,
      error:    describeError(err)
    });
  }

  // Plain text, because it has to survive being pasted into an email or a ticket.
  function apiLogText() {
    return "Vehicle Activity Log " + APP_VERSION + " API failures\n" +
      "database: " + (S.dbName || "?") + "  server: " + (S.server || "?") + "\n" +
      "user: " + (S.userName || "?") + "  browser tz: " +
      (Intl.DateTimeFormat().resolvedOptions().timeZone || "?") + "\n" +
      "generated: " + new Date().toISOString() + "\n\n" +
      S.apiLog.map(function (e, i) {
        return (i + 1) + ". " + e.at + "  " + e.method +
          (e.typeName ? " " + e.typeName : "") +
          "\n   device=" + (e.device || "-") +
          "  window=" + (e.from || "-") + " .. " + (e.to || "-") +
          "\n   attempt " + e.attempt + (e.retried ? " (retried)" : " (gave up)") +
          "\n   " + JSON.stringify(e.error);
      }).join("\n\n");
  }

  // The only thing NOT retried is a request the server understood and rejected on
  // its shape: a bad parameter, an unknown type, a malformed search. Those fail
  // identically forever, so repeating one only makes the operator wait longer for
  // the same answer.
  //
  // Everything else is retried, and the session and database errors are retried
  // deliberately. Geotab's guidance is that DbUnavailableException means the
  // database has moved servers in the federation, and that the API object makes a
  // single re-authentication attempt when that or InvalidUserException comes back.
  // Retrying is what gives it the chance to do that and land on the new server.
  // Treating either as fatal, which this function first did, would throw away a
  // vehicle over a failover the SDK was about to recover from by itself.
  //
  // So the default is retry. An unrecognised error costs 13 seconds if it was
  // hopeless and saves a vehicle if it was not. That trade is not close.
  function isRetryable(err) {
    var text = [
      (err && (err.name || err.type)) || "",
      (err && err.message) || "",
      (err && err.data && err.data.type) || "",
      typeof err === "string" ? err : ""
    ].join(" ");
    return !/ArgumentException|InvalidArgument|Missing[ _]?[Pp]arameter|MissingMethod|UnknownMethod|NotSupported|InvalidCast/i.test(text);
  }

  function apiCall(method, params, onSuccess, onError) {
    var attempt = 0;

    function fail(err) {
      if (onError) { onError(err); return; }
      console.error("[VehicleActivityLog]", method, err);
    }

    function go() {
      S.api.call(method, params, onSuccess, function (err) {
        var willRetry = attempt < RETRY_DELAYS_MS.length && isRetryable(err);
        // Recorded whether or not we retry. A call that failed twice and then
        // succeeded still says something about what is going wrong, and that is
        // exactly the evidence the 18 Aug failure did not leave behind.
        recordApiFailure(method, params, attempt + 1, willRetry, err);
        if (willRetry) {
          var wait = RETRY_DELAYS_MS[attempt];
          attempt++;
          console.warn("[VehicleActivityLog] " + method + " failed, retry " +
                       attempt + " of " + RETRY_DELAYS_MS.length + " in " + wait + "ms", err);
          setTimeout(go, wait);
          return;
        }
        fail(err);
      });
    }

    go();
  }

  // Single quotes MUST be escaped here. Every attribute in this file is written
  // with single-quoted delimiters, and rison URLs quote their date values with
  // apostrophes, so leaving ' alone silently truncates every Replay href at the
  // first date. That was the real cause of the blank Trips History page in
  // v1.0.0 through v1.1.0, not the URL grammar.
  function esc(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ─── Time and timezone ───────────────────────────────────────────────────
  // Everything on screen is rendered in the MyGeotab user's own timezone
  // (`User.timeZoneId`), not the browser's.
  //
  // Before v1.4.0 this used Date.getHours() and friends, which read the machine
  // running the browser. Whenever the operator is not sitting in the database's
  // timezone the days were bucketed at the wrong boundary and the daily distance
  // reset at the wrong moment, silently. That is a real gap, not a theoretical
  // one: a UK database reports midnight as 23:00Z while a browser on UTC+2 calls
  // that 01:00 the next day.
  //
  // S.tzId empty means no profile timezone was readable, and everything falls
  // back to the browser as before, with a notice saying so.

  var TZ_FMT = null;

  function setTimeZone(id, via) {
    S.tzId  = id || "";
    S.tzVia = via || "";
    TZ_FMT  = null;   // cached formatter is bound to the old zone
  }

  function tzFormatter() {
    if (TZ_FMT) return TZ_FMT;
    var opts = {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23", weekday: "short"
    };
    if (S.tzId) {
      try {
        opts.timeZone = S.tzId;
        TZ_FMT = new Intl.DateTimeFormat("en-GB", opts);
        return TZ_FMT;
      } catch (e) {
        // An unrecognised zone id would otherwise throw on every single row.
        delete opts.timeZone;
        setTimeZone("", "");
        addWarning("The timezone on your MyGeotab profile was not recognised, so times are shown in this computer's timezone instead.");
      }
    }
    TZ_FMT = new Intl.DateTimeFormat("en-GB", opts);
    return TZ_FMT;
  }

  // Wall-clock parts of an instant, in the report timezone.
  function tzParts(iso) {
    var d = iso instanceof Date ? iso : new Date(iso);
    if (isNaN(d.getTime())) return null;
    var p = tzFormatter().formatToParts(d), o = {}, i;
    for (i = 0; i < p.length; i++) o[p[i].type] = p[i].value;
    return {
      y: +o.year, mo: +o.month, d: +o.day,
      h: (+o.hour) % 24, mi: +o.minute, s: +o.second,
      dow: o.weekday
    };
  }

  // How far the report timezone is ahead of UTC at a given instant.
  function tzOffsetMs(utcMs) {
    var p = tzParts(new Date(utcMs));
    if (!p) return 0;
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - (utcMs - (utcMs % 1000));
  }

  // The UTC instant of a given wall-clock time in the report timezone. The
  // offset is resolved twice because the offset at the guessed instant can
  // differ from the offset at the real one across a DST change.
  function tzInstant(y, mo, d, h, mi, s) {
    var guess = Date.UTC(y, mo - 1, d, h, mi, s);
    var t = guess - tzOffsetMs(guess);
    return guess - tzOffsetMs(t);
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function fmtDateInput(d) {
    var p = tzParts(d);
    return p ? p.y + "-" + pad2(p.mo) + "-" + pad2(p.d) : "";
  }

  // Calendar day in the report timezone. A vehicle driving at 23:30 must land on
  // that day, otherwise the daily distance resets in the wrong place.
  function localDayKey(iso) {
    var p = tzParts(iso);
    return p ? p.y + "-" + pad2(p.mo) + "-" + pad2(p.d) : "";
  }

  function fmtDayReadable(dayKey) {
    var p = dayKey.split("-");
    // A bare calendar date with no instant attached, so plain Date is correct.
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    return DOW_SHORT[d.getDay()] + " " + pad2(+p[2]) + " " + MON_SHORT[+p[1] - 1] + " " + p[0];
  }

  function fmtDayShort(dayKey) {
    var p = dayKey.split("-");
    return p[2] + "/" + p[1] + "/" + p[0];
  }

  // 24-hour throughout, deliberately. toLocaleTimeString follows the browser
  // locale and gives AM/PM on a US machine, which does not match the report
  // being replicated.
  function fmtTime(iso) {
    var p = tzParts(iso);
    return p ? pad2(p.h) + ":" + pad2(p.mi) + ":" + pad2(p.s) : "--";
  }

  function tzLabel(iso) {
    try {
      var opts = { timeZoneName: "short" };
      if (S.tzId) opts.timeZone = S.tzId;
      var parts = new Intl.DateTimeFormat("en-GB", opts).formatToParts(new Date(iso));
      for (var i = 0; i < parts.length; i++) { if (parts[i].type === "timeZoneName") return parts[i].value; }
    } catch (e) {}
    return "";
  }

  // "3m 08s" / "1h 03m 08s" — matches the reference report's idling label.
  function fmtDurPrecise(mins) {
    if (mins == null || isNaN(mins)) return "";
    var total = Math.max(0, Math.round(mins * 60));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    var mm = (m < 10 ? "0" : "") + m;
    var ss = (s < 10 ? "0" : "") + s;
    return h > 0 ? h + "h " + mm + "m " + ss + "s" : m + "m " + ss + "s";
  }

  function fmtDurWhole(mins) {
    if (mins == null || isNaN(mins)) return "0m";
    var total = Math.round(mins);
    var h = Math.floor(total / 60), m = total % 60;
    return h > 0 ? h + "h " + m + "m" : m + "m";
  }

  // ─── Units ───────────────────────────────────────────────────────────────
  // Read from User.isMetric. The API is always metric, so these convert only at
  // the point of display.
  function distUnit()  { return S.isMetric ? "km"   : "mi"; }
  function speedUnit() { return S.isMetric ? "km/h" : "mph"; }
  function toDist(km)   { return S.isMetric ? km   : km   / KM_PER_MILE; }
  function toSpeed(kmh) { return S.isMetric ? kmh  : kmh  / KM_PER_MILE; }

  function fmtDist(km) {
    if (km == null || isNaN(km)) return "";
    var v = toDist(km);
    if (v === 0) return "0 " + distUnit();
    return String(parseFloat(v.toFixed(2))) + " " + distUnit();
  }

  function fmtSpeed(kmh) {
    if (kmh == null || isNaN(kmh)) return "--";
    return Math.round(toSpeed(kmh)) + " " + speedUnit();
  }

  function haversineKm(a, b) {
    if (!a || !b || a.lat == null || b.lat == null) return 0;
    var R = 6371;
    var dLat = (b.lat - a.lat) * Math.PI / 180;
    var dLon = (b.lng - a.lng) * Math.PI / 180;
    var la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Direction of travel from a to b, 0-360 degrees clockwise from north.
  function bearingDeg(a, b) {
    var la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
    var dLon = (b.lng - a.lng) * Math.PI / 180;
    var y = Math.sin(dLon) * Math.cos(la2);
    var x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  // Shortest angle between two bearings, so 350 and 10 are 20 degrees apart.
  function angleDelta(a, b) {
    var d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  function downloadCsvBlob(rows, filename) {
    var csv = rows.map(function (r) {
      return r.map(function (c) { return '"' + String(c == null ? "" : c).replace(/"/g, '""') + '"'; }).join(",");
    }).join("\n");
    var blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  // ─── Notices ─────────────────────────────────────────────────────────────
  function addWarning(msg) {
    if (S.warnings.indexOf(msg) === -1) S.warnings.push(msg);
    renderWarnings();
  }

  // A vehicle that could not be read is not a note. It is a hole in the report,
  // and the operator has to know before sending it to a customer. So it gets its
  // own block, always open, above the results, listing every affected vehicle by
  // name. Notes stay in the collapsed panel where they belong.
  function addFailure(name) {
    if (S.failed.indexOf(name) === -1) S.failed.push(name);
    renderFailures();
  }

  function renderFailures() {
    var el = $("val-failed");
    if (!el) return;

    // The block also appears when nothing was lost but calls failed and
    // recovered, because a run that needed three attempts is worth knowing
    // about before it becomes a run that needed five.
    if (!S.failed.length && !S.apiLog.length) {
      el.classList.add("hidden"); el.innerHTML = ""; return;
    }

    var html = "";
    if (S.failed.length) {
      var n = S.failed.length;
      el.classList.remove("val-failed-soft");
      html += "<strong>" + (n === 1 ? "1 vehicle is missing from this report."
                                    : n + " vehicles are missing from this report.") +
        "</strong><ul>" +
        S.failed.map(function (v) { return "<li>" + esc(v) + "</li>"; }).join("") +
        "</ul><p>MyGeotab did not return their data after four attempts. This is not a " +
        "sign that they were parked. Run the report again, or run those vehicles on " +
        "their own, before sending it to anyone.</p>";
    } else {
      el.classList.add("val-failed-soft");
      html += "<strong>" + S.apiLog.length + " request" +
        (S.apiLog.length === 1 ? "" : "s") + " to MyGeotab failed and were retried " +
        "successfully.</strong><p>Nothing is missing from this report. Recorded so " +
        "the failures can be looked at if they become frequent.</p>";
    }

    html += "<p class='val-failed-actions'>" +
      "<button type='button' id='val-diag-copy'>Copy technical detail</button>" +
      "<button type='button' id='val-diag-show'>Show technical detail</button>" +
      "</p><pre id='val-diag' class='val-diag hidden'></pre>";

    el.innerHTML = html;
    el.classList.remove("hidden");

    $("val-diag-show").addEventListener("click", function () {
      var pre = $("val-diag");
      var open = !pre.classList.contains("hidden");
      pre.classList.toggle("hidden", open);
      if (!open) pre.textContent = apiLogText();
      this.textContent = open ? "Show technical detail" : "Hide technical detail";
    });

    $("val-diag-copy").addEventListener("click", function () {
      var btn = this, text = apiLogText();
      function done(ok) { btn.textContent = ok ? "Copied" : "Copy failed, use Show instead"; }
      // clipboard.writeText needs a secure context and can be blocked inside the
      // MyGeotab page, so fall back rather than silently doing nothing.
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); },
                                                 function () { done(false); });
      } else {
        done(false);
      }
    });
  }

  // A <details> rather than an always-open panel: on most runs the only entry is
  // the row-emission explanation, which is worth reading once and not on every
  // run. Collapsed it is one line; the yellow frame still marks it as something
  // to look at. The count is in the header on purpose, so a run that produced a
  // real warning (missing ignition data, a truncated fetch) is visibly different
  // from a routine one without having to open it.
  //
  // Nothing sets `open` here. The browser keeps the attribute across an innerHTML
  // change, so a panel the operator opened mid-run stays open as later warnings
  // arrive. It is reset to closed once per run, where S.warnings is cleared.
  function renderWarnings() {
    var el = $("val-notice");
    if (!S.warnings.length) { el.classList.add("hidden"); el.innerHTML = ""; return; }
    var n = S.warnings.length;
    el.innerHTML = "<summary>Report Information"
      + "<span class='val-notice-count'>" + n + (n === 1 ? " note" : " notes") + "</span>"
      + "</summary><ul>"
      + S.warnings.map(function (w) { return "<li>" + esc(w) + "</li>"; }).join("")
      + "</ul>";
    el.classList.remove("hidden");
  }

  function setProgress(msg) {
    var p = $("val-progress");
    if (!p) return;
    p.textContent = msg;
  }

  // ─── Data fetch ──────────────────────────────────────────────────────────
  function loadGroups() {
    apiCall("Get", { typeName: "Group" }, function (groups) {
      var sel = $("val-group");
      (groups || [])
        .filter(function (g) { return g.name && g.id !== "GroupEverythingId"; })
        .sort(function (a, b) { return a.name.localeCompare(b.name); })
        .forEach(function (g) {
          var o = document.createElement("option");
          o.value = g.id; o.textContent = g.name;
          sel.appendChild(o);
        });
    });
  }

  // The two regional settings the report has to honour, both on the User record:
  //   timeZoneId  IANA id such as "Europe/London", which is what Intl wants
  //   isMetric    false means US/Imperial, so miles and mph
  // One Get covers both.
  function loadUserPrefs() {
    if (!S.userName) { onPrefsKnown(); return; }
    apiCall("Get", { typeName: "User", search: { name: S.userName } }, function (users) {
      var u = users && users[0];
      if (u) {
        if (u.timeZoneId) setTimeZone(u.timeZoneId, "your MyGeotab profile");
        // Explicitly false, not just falsy: an absent field must not silently
        // flip a metric database into miles.
        if (u.isMetric === false || u.isMetric === true) {
          S.isMetric = u.isMetric;
          S.unitsVia = "your MyGeotab profile";
        }
      }
      onPrefsKnown();
    }, function () { onPrefsKnown(); });
  }

  function onPrefsKnown() {
    if (!S.tzId) {
      addWarning("Your MyGeotab profile timezone could not be read, so days and times are shown in this computer's timezone. If the two differ, day boundaries and daily distance will be wrong.");
    }
    if (!S.unitsVia) {
      addWarning("Your MyGeotab profile units could not be read, so distances and speeds are shown in metric. Check the figures against MyGeotab if your profile is set to US/Imperial.");
    }
    // The default dates were filled in before the timezone was known. Correct
    // them unless the operator has already chosen their own.
    if (!S.datesTouched) applyDefaultDates();
    renderLinkInfo();
  }

  function applyDefaultDates() {
    var today = fmtDateInput(new Date());
    $("val-from").value = today;
    $("val-to").value   = today;
  }

  function loadDevices(groupId) {
    var sel = $("val-vehicle");
    sel.innerHTML = "<option value=''>All vehicles in group</option>";
    var search = groupId ? { groups: [{ id: groupId }] } : {};
    apiCall("Get", { typeName: "Device", search: search, resultsLimit: 5000 }, function (devices) {
      (devices || [])
        .filter(function (d) { return d.name; })
        .sort(function (a, b) { return a.name.localeCompare(b.name); })
        .forEach(function (d) {
          var o = document.createElement("option");
          o.value = d.id; o.textContent = d.name;
          sel.appendChild(o);
        });
    });
  }

  // Halve the window whenever a Get hits the 50 000 record cap, so a busy
  // vehicle over a long range still comes back complete.
  //
  // cb(null) means the fetch FAILED. cb([]) means it succeeded and the vehicle
  // has no logs. Up to v1.7.2 both were [], which is how a vehicle that drove
  // 430 km rendered as a confident "0 km, 1 event": the Get failed, the empty
  // array flowed through the engine, and the only row left was an ignition
  // change borrowing its position from a boundary record. Verified against
  // ILLE01 device bA on 18 Aug 2026 — the API had 3,957 log records and the
  // engine reproduces 429.71 km from them, so nothing was wrong except that a
  // failed call looked exactly like an idle vehicle. A wrong number stated
  // confidently is worse than an error, so failure must never be silent here.
  function fetchLogRecords(deviceId, fromIso, toIso, depth, cb) {
    apiCall("Get", {
      typeName: "LogRecord",
      search: { fromDate: fromIso, toDate: toIso, deviceSearch: { id: deviceId } }
    }, function (recs) {
      recs = recs || [];
      if (recs.length >= MAX_RECORDS) {
        if (depth < SPLIT_DEPTH) {
          var mid = new Date((new Date(fromIso).getTime() + new Date(toIso).getTime()) / 2).toISOString();
          fetchLogRecords(deviceId, fromIso, mid, depth + 1, function (a) {
            if (a === null) { cb(null); return; }   // half the window is missing
            fetchLogRecords(deviceId, mid, toIso, depth + 1, function (b) {
              cb(b === null ? null : a.concat(b));
            });
          });
          return;
        }
        addWarning("A vehicle returned the maximum of 50,000 GPS records even after splitting the range. Some rows are missing. Shorten the date range.");
      }
      cb(recs);
    }, function (err) {
      console.error("[VehicleActivityLog] LogRecord fetch failed", deviceId, fromIso, toIso, err);
      cb(null);
    });
  }

  // Ignition StatusData is only written on state change, so the state at the
  // start of the range comes from before the range. Up to v1.5.0 this was
  // solved by extending the window back 24 h, which was wrong twice over: it
  // dragged in a whole day of unrelated events, and it still only inferred the
  // starting state from the last record before the window.
  //
  // No lookback is needed. MyGeotab returns a boundary record at each end of
  // the search window carrying the state at that exact instant. It has no id
  // and no version, which is how it is told apart from a real record. Verified
  // against ILLE01 device b19: a query for 18 Aug alone returns
  // 2026-08-17T23:00:00Z data=0 with no id, followed by the first real change
  // at 05:46. See CONTEXT.md.
  function fetchIgnition(deviceId, fromIso, toIso, cb) {
    apiCall("Get", {
      typeName: "StatusData",
      search: {
        fromDate: fromIso, toDate: toIso,
        deviceSearch: { id: deviceId },
        diagnosticSearch: { id: "DiagnosticIgnitionId" }
      }
    }, function (recs) { cb(recs || []); }, function () { cb(null); });
  }

  // Trips are fetched only to build Replay links. The Trips History page keys
  // its replay off a trip's exact start and stop, so a row can only deep-link
  // into the replay if we know which trip contains it. One extra Get per
  // vehicle; the report itself does not use this data.
  function fetchTrips(deviceId, fromIso, toIso, cb) {
    apiCall("Get", {
      typeName: "Trip",
      search: { fromDate: fromIso, toDate: toIso, deviceSearch: { id: deviceId } }
    }, function (trips) {
      var out = (trips || []).filter(function (t) { return t.start && t.stop; }).map(function (t) {
        return {
          startIso: t.start,
          stopIso:  t.stop,
          startMs:  new Date(t.start).getTime(),
          stopMs:   new Date(t.stop).getTime(),
          // Trip.driver is a Driver entity, or the "UnknownDriverId" sentinel
          // when nobody was assigned. The card id in the URL needs whichever.
          driverId: (t.driver && t.driver.id) ? t.driver.id : "UnknownDriverId"
        };
      });
      out.sort(function (a, b) { return a.startMs - b.startMs; });
      cb(out);
    }, function () { cb([]); });
  }

  // Trips are sorted and do not overlap, so a binary search is enough.
  function tripAt(trips, ms) {
    var lo = 0, hi = trips.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (ms < trips[mid].startMs)      hi = mid - 1;
      else if (ms > trips[mid].stopMs)  lo = mid + 1;
      else return trips[mid];
    }
    return null;
  }

  // ─── Status engine ───────────────────────────────────────────────────────
  // Returns [{ dayKey, rows, distKm, idleMins }] for one device.
  function buildActivity(logs, ignitionRecs, fromIso, toIso) {
    // Normalise and de-duplicate logs (window splitting can overlap on the boundary).
    var seen = {};
    var pts = [];
    logs.forEach(function (l) {
      if (!l || l.latitude == null || l.longitude == null) return;
      // A boundary record has no id, so fall back to the timestamp. Window
      // splitting produces one at each side of the split point, and they share
      // an instant, so this also de-duplicates them.
      var k = l.id || ("boundary:" + l.dateTime);
      if (seen[k]) return;
      seen[k] = 1;
      pts.push({
        t: l.dateTime,
        ms: new Date(l.dateTime).getTime(),
        lat: l.latitude,
        lng: l.longitude,
        speed: l.speed == null ? 0 : l.speed,
        // MyGeotab manufactures a record at each end of the search window so a
        // map can draw a continuous line to the window edge. The position is
        // real and worth having, because it anchors the day's distance at
        // midnight instead of at the first log after it. But nothing happened
        // at that instant, so it must never become a row.
        boundary: !l.id
      });
    });
    pts.sort(function (a, b) { return a.ms - b.ms; });

    // Nearest log in time. StatusData carries no coordinates, so an ignition
    // event borrows a position from the closest log. It borrows the position
    // only; the timestamp stays its own.
    function nearestPt(ms) {
      if (!pts.length) return null;
      var lo = 0, hi = pts.length - 1;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (pts[mid].ms < ms) lo = mid + 1; else hi = mid;
      }
      var a = pts[lo], b = pts[lo > 0 ? lo - 1 : 0];
      return Math.abs(a.ms - ms) <= Math.abs(b.ms - ms) ? a : b;
    }

    // Collapse the ignition records into real state changes. Boundary records
    // seed the starting state and are never emitted: see fetchIgnition.
    var transitions = [];
    var seedIgn = null;
    var hasIgnition = ignitionRecs !== null && ignitionRecs.length > 0;
    if (hasIgnition) {
      var sorted = ignitionRecs.slice().sort(function (a, b) {
        return new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime();
      });
      var last = null, sawReal = false;
      sorted.forEach(function (r) {
        var on = Number(r.data) >= 0.5;
        var changed = (last === null || on !== last);
        last = on;
        if (!r.id) {
          // Only the opening boundary is a seed. The closing one restates a
          // state we already know and would otherwise overwrite it.
          if (!sawReal && seedIgn === null) seedIgn = on;
          return;
        }
        sawReal = true;
        if (changed) transitions.push({ t: r.dateTime, ms: new Date(r.dateTime).getTime(), on: on });
      });
    }

    // One time-ordered stream of logs and ignition changes. Merging them is
    // what lets an ignition event keep its own timestamp: up to v1.5.0 events
    // were drained onto whichever log came next, which stacked several events
    // on one timestamp and dropped any change after the last log of the day.
    // On a tie the ignition change goes first, so an "on" precedes the moving
    // row it enables and an "off" suppresses the row at the same instant.
    var stream = [], si;
    for (si = 0; si < pts.length; si++)        stream.push({ ms: pts[si].ms, ign: null, pt: pts[si] });
    for (si = 0; si < transitions.length; si++) stream.push({ ms: transitions[si].ms, ign: transitions[si], pt: null });
    stream.sort(function (a, b) {
      if (a.ms !== b.ms) return a.ms - b.ms;
      return (a.ign ? 0 : 1) - (b.ign ? 0 : 1);
    });

    var curIgn;
    if (!hasIgnition)             curIgn = true;        // no ignition data: show everything
    else if (seedIgn !== null)    curIgn = seedIgn;     // boundary record knows the answer
    else if (transitions.length)  curIgn = !transitions[0].on;
    else                          curIgn = false;

    var days = [];
    var day = null;
    var curDayKey = null;
    var prevPt = null;
    var cumKm = 0;
    var inIdle = false;
    var idleStartMs = 0;

    function startDay(key) {
      // Close the previous day on the running total rather than on its last
      // row, because the last row of a day can precede its last GPS log.
      if (day) day.distKm = cumKm;
      day = { dayKey: key, rows: [], distKm: 0, idleMins: 0 };
      days.push(day);
      curDayKey = key;
      cumKm = 0;
      prevPt = null;
      inIdle = false;
      pend = null;   // same pre-existing gap as inIdle: an idle open across
                     // local midnight is abandoned rather than split
    }

    // A stop is not over the first time GPS reports 1 km/h. A vehicle standing
    // at a light reads 0.4, 1.3, 0.6, 1.1 as the fix wanders, and the old code
    // read that as four separate stops with three departures in between. That is
    // what produced a day of one-to-five-second idles that summed to two minutes
    // but contained no single idle worth a row.
    //
    // So when speed rises we hold the idle open and buffer the rows instead of
    // emitting them. The stop is only over once the vehicle has covered
    // IDLE_RESUME_KM of ground or stayed above the threshold for IDLE_RESUME_MS.
    // Distance is the test that does the work: a real departure clears 50 m in
    // seconds, while a fix wandering at a standstill never does. The time test
    // is the backstop for genuine creeping.
    //
    // pend is null when no idle is being held open, otherwise
    // { ms, km, buf } captured at the moment speed first rose.
    var pend = null;

    function openPending(p) {
      pend = { ms: p.ms, km: cumKm, buf: [p] };
    }

    // The vehicle really did leave. The first buffered point becomes the
    // Idling end, the rest become Moving, which is what the old code produced
    // for a departure with no jitter.
    function confirmPending() {
      var b = pend.buf, first = b[0];
      var mins = (first.ms - idleStartMs) / 60000;
      day.idleMins += mins;
      inIdle = false;
      pushAt(first.t, "Idling end", "idle", first,
             "Idling time: [" + fmtDurPrecise(mins) + "]", true);
      for (var k = 1; k < b.length; k++) pushAt(b[k].t, "Moving", "moving", b[k], "", true);
      pend = null;
    }

    // It was noise. The buffered points belong to the stop, so they are Idling
    // rows and idleStartMs is left alone: the stop is one continuous run.
    function cancelPending() {
      for (var k = 0; k < pend.buf.length; k++) {
        pushAt(pend.buf[k].t, "Idling", "idle", pend.buf[k], "", false);
      }
      pend = null;
    }

    // iso is the event's own time; pt supplies only the position.
    function pushAt(iso, status, cls, pt, durText, showSpeed) {
      day.rows.push({
        t: iso,
        status: status,
        cls: cls,
        duration: durText || "",
        distKm: cumKm,
        speed: showSpeed ? pt.speed : null,
        lat: pt.lat,
        lng: pt.lng
      });
    }

    for (var i = 0; i < stream.length; i++) {
      var ev = stream[i];

      if (ev.ign) {
        var tr = ev.ign;
        if (tr.on === curIgn) continue;
        var at = nearestPt(tr.ms);
        if (!at) continue;                       // no position to put it on
        // The engine stopping settles any idle we were holding open: whatever
        // the vehicle was doing, it is over now.
        if (pend) confirmPending();
        if (localDayKey(tr.t) !== curDayKey) startDay(localDayKey(tr.t));
        curIgn = tr.on;
        if (curIgn) {
          pushAt(tr.t, "Ignition on", "ignon", at, "", false);
        } else {
          if (inIdle) {
            var im = (tr.ms - idleStartMs) / 60000;
            day.idleMins += im;
            inIdle = false;
            pushAt(tr.t, "Idling end", "idle", at, "Idling time: [" + fmtDurPrecise(im) + "]", false);
          }
          pushAt(tr.t, "Ignition off", "ignoff", at, "", false);
        }
        continue;
      }

      var p = ev.pt;
      if (localDayKey(p.t) !== curDayKey) startDay(localDayKey(p.t));

      // Cumulative daily distance. Segments where both ends are stationary are
      // skipped so GPS jitter at a standstill does not inflate the total.
      // Boundary records take part: that is the point of keeping them.
      if (prevPt && !(prevPt.speed < IDLE_SPEED_KMH && p.speed < IDLE_SPEED_KMH)) {
        cumKm += haversineKm(prevPt, p);
      }
      prevPt = p;

      if (p.boundary) continue;   // real position, but no event happened here
      if (!curIgn) continue;      // no rows while the ignition is off

      if (p.speed < IDLE_SPEED_KMH) {
        if (pend) { cancelPending(); continue; }   // the excursion was jitter
        if (!inIdle) {
          inIdle = true;
          idleStartMs = p.ms;
          pushAt(p.t, "Idling start", "idle", p, "", false);
        } else {
          pushAt(p.t, "Idling", "idle", p, "", false);
        }
      } else {
        if (inIdle && !pend) {
          // Do not close the idle here. Hold it open until we know whether the
          // vehicle actually left. See openPending.
          openPending(p);
          continue;
        }
        if (pend) {
          pend.buf.push(p);
          if (p.ms - pend.ms >= IDLE_RESUME_MS || cumKm - pend.km >= IDLE_RESUME_KM) {
            confirmPending();
          }
          continue;
        }
        pushAt(p.t, "Moving", "moving", p, "", true);
      }
    }

    if (pend) confirmPending();   // ran out of logs while holding an idle open

    if (day) day.distKm = cumKm;

    // Close an idle run still open at the end of the window, on the last real
    // log rather than on a boundary record.
    var realPts = pts.filter(function (q) { return !q.boundary; });
    if (inIdle && day && realPts.length) {
      var lastPt = realPts[realPts.length - 1];
      var openMins = (lastPt.ms - idleStartMs) / 60000;
      if (openMins > 0) {
        day.idleMins += openMins;
        day.rows.push({
          t: lastPt.t, status: "Idling end", cls: "idle",
          duration: "Idling time: [" + fmtDurPrecise(openMins) + "] (still idling at end of range)",
          distKm: cumKm, speed: null, lat: lastPt.lat, lng: lastPt.lng
        });
      }
    }

    // A day where the ignition never came on produces no rows — drop it.
    days = days.filter(function (d) { return d.rows.length > 0; });

    // Reduce AFTER the engine has run and AFTER the day total is taken, so the
    // rules only affect which rows are shown. Distance still accumulates over
    // every GPS log and idling is still measured start to end.
    reduceRows(days, S.rules);

    return { days: days, hasIgnition: hasIgnition };
  }

  // A device reporting every 10 to 60 seconds produces far more rows than the
  // customer's reference report. Rather than a fixed interval, keep a row only
  // when it says something the previous kept row did not: see DETAIL_LEVELS.
  //
  // Every status change survives regardless, as does the first and last row of
  // the day, so the running distance still ends on the day total.
  function reduceRows(days, rules) {
    if (!rules) return;

    days.forEach(function (d) {
      var rows = d.rows, i, r;
      if (rows.length < 3) return;

      // Heading at each row, taken from the previous row's position. Null when
      // the vehicle moved less than 20 m, because a bearing over a few metres
      // is GPS noise rather than a turn.
      var prev = null;
      for (i = 0; i < rows.length; i++) {
        r = rows[i];
        r.ms  = new Date(r.t).getTime();
        r.hdg = (prev && haversineKm(prev, r) >= 0.02) ? bearingDeg(prev, r) : null;
        prev = r;
      }

      // Mark idle runs too short to be worth a row at this level. A run is an
      // "Idling start", any "Idling" rows after it, and the "Idling end" that
      // closes it. The engine always closes a run, including when the ignition
      // goes off mid-idle and at the end of the range, so the pairing holds.
      //
      // The whole run is dropped or none of it is. Dropping the start and
      // keeping the end would leave an idle that ends without beginning.
      //
      // This only hides rows. day.idleMins was totalled before reduceRows ran,
      // so the vehicle's idling figure is the same at every detail level.
      if (rules.minIdleMs > 0) {
        var runStart = -1;
        for (i = 0; i < rows.length; i++) {
          if (rows[i].status === "Idling start") {
            runStart = i;
          } else if (rows[i].status === "Idling end" && runStart >= 0) {
            if (rows[i].ms - rows[runStart].ms < rules.minIdleMs) {
              for (var j = runStart; j <= i; j++) rows[j].drop = true;
            }
            runStart = -1;
          }
        }
      }

      var kept = [], lastKept = null;
      for (i = 0; i < rows.length; i++) {
        r = rows[i];
        // Checked before everything else, including the status-change and
        // first/last-row exemptions, or a two-second idle at the top of the day
        // would survive on the strength of being first.
        if (r.drop) continue;

        var isChange = (r.status !== "Moving" && r.status !== "Idling");
        var why = "";

        if (isChange)                  why = "status change";
        else if (!lastKept)            why = "first row of the day";
        else if (i === rows.length - 1) why = "last row of the day";
        else {
          var gap = r.ms - lastKept.ms;
          // Below the floor nothing qualifies, so a burst of triggers at a
          // junction collapses into one row.
          if (gap >= rules.minGapMs) {
            var spd     = r.speed == null ? 0 : r.speed;
            var lastSpd = lastKept.speed == null ? 0 : lastKept.speed;

            if (r.distKm - lastKept.distKm >= rules.distKm) {
              why = "travelled " + rules.distLabel;
            } else if (Math.abs(spd - lastSpd) >= rules.speedKmh) {
              why = "speed changed by " + rules.speedLabel + " or more";
            } else if (r.hdg != null && lastKept.hdg != null && spd >= IDLE_SPEED_KMH &&
                       angleDelta(r.hdg, lastKept.hdg) >= rules.headingDeg) {
              why = "changed direction by " + rules.headingDeg + " degrees or more";
            } else if (gap >= rules.maxGapMs) {
              why = "nothing changed for " + Math.round(rules.maxGapMs / 60000) + " minutes";
            }
          }
        }

        if (!why) continue;
        r.why = why;
        kept.push(r);
        lastKept = r;
      }

      if (kept.length < rows.length) d.logCount = rows.length;
      d.rows = kept;
    });
  }

  // "1 minute" reads better than "60 seconds" in the notice, and "3 minutes"
  // better than "180 seconds". Anything not a whole minute stays in seconds.
  function describeMs(ms) {
    var s = Math.round(ms / 1000);
    if (s % 60 !== 0) return s + " seconds";
    var m = s / 60;
    return m + (m === 1 ? " minute" : " minutes");
  }

  // Plain-language version of the active rules, for the notice above the table.
  function describeRules(r) {
    return "A row is written whenever something changes: any status change, " +
      r.distLabel + " travelled, a speed change of " + r.speedLabel + ", a turn of " +
      r.headingDeg + " degrees, or " + Math.round(r.maxGapMs / 60000) +
      " minutes with none of those. Rows are never closer together than " +
      Math.round(r.minGapMs / 1000) + " seconds, except for status changes. " +
      (r.minIdleMs > 0
        ? "Idling shorter than " + describeMs(r.minIdleMs) + " is not shown as an " +
          "idling event, because at that length it is usually a junction or a speed " +
          "bump rather than a stop. "
        : "") +
      "Daily distance and idling times are still calculated from every GPS log, " +
      "including any idling too short to be listed. " +
      "Hover over a time to see why that row is there, or pick 'Every GPS log' to see them all.";
  }

  // ─── Reverse geocoding ───────────────────────────────────────────────────
  function coordKey(lat, lng) { return lat.toFixed(COORD_DP) + "," + lng.toFixed(COORD_DP); }

  function formatReverseGeocodeAddress(addr) {
    if (!addr) return null;
    if (addr.formattedAddress) return addr.formattedAddress;
    var parts = [];
    if (addr.streetNumber) parts.push(addr.streetNumber);
    if (addr.street || addr.streetName) parts.push(addr.street || addr.streetName);
    if (addr.city) parts.push(addr.city);
    if (addr.postalCode) parts.push(addr.postalCode);
    return parts.length ? parts.join(" ") : null;
  }

  function resolveAddresses(days, onProgress, cb) {
    var uniq = {};
    days.forEach(function (d) {
      d.rows.forEach(function (r) {
        if (r.lat == null) return;
        var k = coordKey(r.lat, r.lng);
        if (!uniq[k] && !S.addrMap[k]) uniq[k] = { x: r.lng, y: r.lat };
      });
    });
    var keys = Object.keys(uniq);
    if (keys.length > GEOCODE_MAX_PTS) {
      addWarning("This run has " + keys.length.toLocaleString() + " distinct locations. Only the first " +
        GEOCODE_MAX_PTS.toLocaleString() + " were converted to addresses; the rest show coordinates instead. Narrow the range to resolve all of them.");
      keys = keys.slice(0, GEOCODE_MAX_PTS);
    }
    if (!keys.length) { cb(); return; }

    var idx = 0;
    (function runChunk() {
      if (idx >= keys.length) { cb(); return; }
      var slice = keys.slice(idx, idx + GEOCODE_CHUNK);
      onProgress(Math.min(idx + slice.length, keys.length), keys.length);
      var coords = slice.map(function (k) { return { x: uniq[k].x, y: uniq[k].y }; });
      apiCall("GetAddresses", { coordinates: coords }, function (results) {
        (results || []).forEach(function (a, i) {
          var v = formatReverseGeocodeAddress(a);
          if (v) S.addrMap[slice[i]] = v;
        });
        idx += GEOCODE_CHUNK;
        runChunk();
      }, function () {
        // Leave the failed batch unresolved; those rows fall back to coordinates.
        idx += GEOCODE_CHUNK;
        runChunk();
      });
    })();
  }

  function addressFor(r) {
    if (r.lat == null) return "(location unknown)";
    return S.addrMap[coordKey(r.lat, r.lng)] || (r.lat.toFixed(5) + ", " + r.lng.toFixed(5));
  }

  // ─── Replay link ─────────────────────────────────────────────────────────
  // The format in the SDK guide ("Using MyGeotab URLs") is stale: its examples
  // date from 2015 and Geotab simplified the URLs in 2022. entityType and
  // selectedEntities are no longer read by the Trips History page, which is why
  // v1.0.0 to v1.0.2 all opened a blank page.
  //
  // This is a real URL, copied out of the address bar after selecting one
  // vehicle and a custom date range by hand in a live database:
  //
  //   #tripsHistory,
  //   dateRange:(endDate:'2026-08-18T22:59:59.000Z',label:Custom,startDate:'2026-08-17T23:00:00.000Z'),
  //   devices:!(bC),
  //   expandedCardIds:!('bC_UnknownDriverId_Tue+Aug+18'),
  //   isReplayPlayerHidden:!f,
  //   mapBounds:!(42.36028,-8.31496,41.7536,-9.18288),
  //   routes:(bC:!((start:'2026-08-18T02:46:00.700Z',stop:'2026-08-18T02:51:47.700Z'),…))
  //
  // What each part does:
  //   devices               THE vehicle filter. Not entityType/selectedEntities,
  //                         which are stale documentation names and do nothing.
  //   routes                a map of device id to trip segments to draw. Does not
  //                         select the vehicle on its own; devices does that.
  //                         MyGeotab populates every trip in the range here. One
  //                         segment is deliberate: the point is to land on the
  //                         moment in the row, not redraw the whole day.
  //   isReplayPlayerHidden  rison !f is false, so the replay player opens.
  //                         Without it the page shows a static route.
  //   dateRange             scopes the trip list. label:Custom accompanies an
  //                         explicit start and end.
  //   expandedCardIds       opens the matching trip card in the side list.
  //                         "<deviceId>_<driverId>_<Ddd+Mmm+D>", spaces as "+".
  //   mapBounds             viewport only; omitted so the map fits the route.
  //
  // Segment boundaries come from the Trip containing the row's timestamp. For a
  // row with no trip (idling with the ignition on between trips, for example)
  // the window falls back to the timestamp plus or minus 15 minutes.
  var REPLAY_PAD_MS = 15 * 60 * 1000;

  var DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MON_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // MyGeotab builds this id from the trip's start in the *user's* timezone, so
  // it has to come from tzParts rather than the browser clock.
  function cardDatePart(iso) {
    var p = tzParts(iso);
    if (!p) return "";
    return p.dow + "+" + MON_SHORT[p.mo - 1] + "+" + p.d;
  }

  function replayUrl(deviceId, iso, trip) {
    if (!S.server || !S.dbName) return "";

    var d = new Date(iso);
    var wall = tzParts(iso);
    if (!wall) return "";
    // Midnight to 23:59:59 of that day in the user's timezone, as UTC instants,
    // which is what MyGeotab itself puts in dateRange.
    var dayStart = new Date(tzInstant(wall.y, wall.mo, wall.d, 0, 0, 0));
    var dayEnd   = new Date(tzInstant(wall.y, wall.mo, wall.d, 23, 59, 59));

    var segStart, segStop, cardId = "";
    if (trip) {
      segStart = trip.startIso;
      segStop  = trip.stopIso;
      cardId   = deviceId + "_" + trip.driverId + "_" + cardDatePart(trip.startIso);
    } else {
      segStart = new Date(d.getTime() - REPLAY_PAD_MS).toISOString();
      segStop  = new Date(d.getTime() + REPLAY_PAD_MS).toISOString();
    }

    // Keys are emitted alphabetically, which is the order MyGeotab itself
    // serialises them in. Order should not matter to a rison parser, but
    // matching the app removes one variable while this is still being proven.
    var parts = [
      "dateRange:(endDate:'" + dayEnd.toISOString() + "',label:Custom,startDate:'" + dayStart.toISOString() + "')",
      "devices:!(" + deviceId + ")"
    ];
    if (cardId) parts.push("expandedCardIds:!('" + cardId + "')");
    parts.push("isReplayPlayerHidden:!f");
    parts.push("routes:(" + deviceId + ":!((start:'" + segStart + "',stop:'" + segStop + "')))");

    return "https://" + S.server + "/" + S.dbName + "/#tripsHistory," + parts.join(",");
  }

  // Where the MyGeotab host comes from, best source first.
  //
  // Add-in pages are injected into the MyGeotab page rather than iframed, so
  // window.location is normally already the real MyGeotab URL:
  //   https://my.geotab.com/<database>/#ActivityLink/...
  // That is more reliable than api.getSession, which in v1.0.1 was the only
  // source and evidently came back without a server on this database. When it
  // does, replayUrl returned "" and the click fell through to the undocumented
  // gotoPage path, landing on Trips History with nothing selected.
  function resolveHost() {
    var found = { server: S.server, db: S.dbName, via: S.hostVia };

    if (!found.server) {
      var host = window.location.hostname || "";
      // Ignore the case where the page really is being served from its own host.
      if (host && !/(^|\.)github\.io$/i.test(host) && host !== "localhost" && host !== "127.0.0.1") {
        found.server = host;
        found.via = "window.location";
        var seg = window.location.pathname.split("/").filter(Boolean);
        if (!found.db && seg.length) found.db = decodeURIComponent(seg[0]);
      }
    }

    S.server  = found.server || "";
    S.dbName  = found.db || "";
    S.hostVia = found.via || "";
    return S.server && S.dbName;
  }

  function renderLinkInfo() {
    var el = $("val-linkinfo");
    if (!el) return;

    var tz = S.tzId
      ? "Times are 24-hour in <code>" + esc(S.tzId) + "</code> <span class='val-muted'>(from " + esc(S.tzVia) + ")</span>"
      : "Times are 24-hour in <code>this computer's timezone</code> <span class='val-muted'>(no profile timezone available)</span>";

    var host = (S.server && S.dbName)
      ? "Trip History links open <code>" + esc(S.server + "/" + S.dbName)
        + "</code> <span class='val-muted'>(host read from " + esc(S.hostVia || "session") + ")</span>"
      : "Trip History links are disabled: could not work out the MyGeotab server or database name for this page.";

    var units = "Distances in <code>" + distUnit() + "</code>, speeds in <code>" + speedUnit() + "</code> "
      + "<span class='val-muted'>(" + (S.unitsVia ? "from " + esc(S.unitsVia) : "profile units not available, showing metric") + ")</span>";

    el.innerHTML = tz + " &nbsp;&middot;&nbsp; " + units + " &nbsp;&middot;&nbsp; " + host;
    el.classList.remove("hidden");
  }

  // Only reached when no host resolved, so no URL could be built at all. The
  // previous gotoPage fallback passed entityType and selectedEntities, which the
  // page no longer reads, so it landed on an empty Trips History and looked like
  // a broken link rather than a missing host. Say so instead.
  function openReplay() {
    alert("Could not work out the MyGeotab address for this database, so the Trip History link cannot be built.");
  }

  // Says how many rows are shown, and how many logs are behind them when the
  // day has been sampled, so a thinned day never reads as a complete one.
  function eventCount(d) {
    return d.logCount
      ? d.rows.length + " of " + d.logCount + " logs"
      : d.rows.length + " events";
  }

  // ─── Rendering ───────────────────────────────────────────────────────────
  // The customer's reference export labels the last column REPLAY. It is called
  // "Trip History" here instead, singular, because the link opens one trip's
  // playback rather than the multi-trip Trips History listing the plural name
  // refers to. Flag the difference when the output is put next to their export.
  var COLS = ["Date", "Status", "Duration", "Daily distance", "Speed", "Location", "Coordinates", "Trip History"];

  function renderDevice(dev) {
    var block = document.createElement("div");
    block.className = "val-vehicle-block";

    var totalKm   = dev.days.reduce(function (s, d) { return s + d.distKm; }, 0);
    var totalIdle = dev.days.reduce(function (s, d) { return s + d.idleMins; }, 0);
    var totalRows = dev.days.reduce(function (s, d) { return s + d.rows.length; }, 0);

    var html = "<h3 class='val-vehicle-name'>" + esc(dev.name) + "</h3>"
      + "<div class='val-vehicle-meta'>" + dev.days.length + " day" + (dev.days.length === 1 ? "" : "s")
      + " &middot; " + totalRows.toLocaleString() + " events &middot; " + fmtDist(totalKm)
      + " &middot; " + fmtDurWhole(totalIdle) + " idling</div>";

    dev.days.forEach(function (d) {
      var body = "";
      d.rows.forEach(function (r, i) {
        var dateCell = i === 0
          ? "<strong>" + esc(fmtDayShort(d.dayKey)) + "</strong> " + esc(fmtTime(r.t)) + " <span class='val-tz'>" + esc(tzLabel(r.t)) + "</span>"
          : esc(fmtTime(r.t));
        var speedCell = r.speed == null || r.speed < IDLE_SPEED_KMH
          ? "<span class='val-muted'>--</span>"
          : esc(fmtSpeed(r.speed));
        var url = replayUrl(dev.id, r.t, r.trip);
        body += "<tr>"
          // The "why" tooltip is what makes an uneven row count explainable:
          // hovering a time says which rule put that row on the page.
          + "<td class='val-num'" + (r.why ? " title='Shown because: " + esc(r.why) + "'" : "") + ">" + dateCell + "</td>"
          + "<td><span class='val-status'><span class='val-dot val-dot-" + r.cls + "'></span>" + esc(r.status) + "</span></td>"
          + "<td class='val-dur'>" + esc(r.duration) + "</td>"
          + "<td class='val-num'>" + esc(fmtDist(r.distKm)) + "</td>"
          + "<td class='val-num'>" + speedCell + "</td>"
          + "<td>" + esc(addressFor(r)) + "</td>"
          + "<td class='val-coords'>" + r.lat.toFixed(5) + ", " + r.lng.toFixed(5) + "</td>"
          // A real href, not "#": the browser status bar then shows where the
          // link goes, and middle-click / copy-link-address both work, which is
          // what makes this diagnosable without a debugger.
          + "<td><a href='" + esc(url || "#") + "' target='_blank' rel='noopener' class='val-replay'"
          + " data-device='" + esc(dev.id) + "' data-time='" + esc(r.t) + "'"
          + " title='" + esc(url || "No MyGeotab host resolved, so no Trip History link could be built.") + "'>Trip History</a></td>"
          + "</tr>";
      });

      body += "<tr class='val-day-total'>"
        + "<td colspan='3'>" + esc(fmtDayReadable(d.dayKey)) + " total</td>"
        + "<td class='val-num'>" + esc(fmtDist(d.distKm)) + "</td>"
        + "<td colspan='4'>" + esc(fmtDurWhole(d.idleMins)) + " idling &middot; " + esc(eventCount(d)) + "</td>"
        + "</tr>";

      html += "<div class='val-table-wrap'><table class='dd-table'><thead><tr>"
        + COLS.map(function (c) { return "<th>" + c + "</th>"; }).join("")
        + "</tr></thead><tbody>" + body + "</tbody></table></div>";
    });

    block.innerHTML = html;

    // The anchor navigates on its own when it has a real href. Only step in
    // when there is none, so the fallback still has somewhere to go.
    block.addEventListener("click", function (ev) {
      var a = ev.target.closest ? ev.target.closest("a.val-replay") : null;
      if (!a) return;
      if (a.getAttribute("href") !== "#") return;
      ev.preventDefault();
      openReplay(a.getAttribute("data-device"), a.getAttribute("data-time"));
    });

    var out = $("val-output");
    var progress = $("val-progress");
    if (progress) out.insertBefore(block, progress); else out.appendChild(block);
  }

  // There is deliberately no fleet-wide summary here (removed v1.7.0). It totalled
  // distance, idling and events across every vehicle in the run, which is a fleet
  // question this report does not answer. The per-vehicle line above each table
  // ("1 day · 106 events · 30.83 km · 5m idling") carries the same measures scoped
  // to the vehicle they describe. The summary was also screen-only, so nothing in
  // it could be cited from the PDF or CSV, and it was not in the report this one
  // recreates. Fleet aggregates belong in Smart Insights.

  // ─── Exports ─────────────────────────────────────────────────────────────
  function flatRows() {
    var out = [];
    S.devices.forEach(function (dev) {
      dev.days.forEach(function (d) {
        d.rows.forEach(function (r) {
          out.push([
            dev.name,
            fmtDayShort(d.dayKey),
            fmtTime(r.t),
            r.status,
            r.duration,
            fmtDist(r.distKm),
            (r.speed == null || r.speed < IDLE_SPEED_KMH) ? "--" : fmtSpeed(r.speed),
            addressFor(r),
            r.lat.toFixed(5) + ", " + r.lng.toFixed(5),
            replayUrl(dev.id, r.t, r.trip)
          ]);
        });
      });
    });
    return out;
  }

  var CSV_HEAD = ["Vehicle", "Date", "Time", "Status", "Duration", "Daily distance", "Speed", "Location", "Coordinates", "Trip History"];

  function exportCsv() {
    if (!S.devices.length) { alert("Run the report first."); return; }
    var rows = [CSV_HEAD].concat(flatRows());
    downloadCsvBlob(rows, "vehicle_activity_log_" + $("val-from").value + "_to_" + $("val-to").value + ".csv");
  }

  function drawPdfHeaderLogo(doc, pageW, margin, barH) {
    if (typeof GEOTAB_LOGO_DATAURL === "undefined") return;
    var logoH = Math.min(9, barH - 6);
    var logoW = logoH * (GEOTAB_LOGO_W / GEOTAB_LOGO_H);
    try { doc.addImage(GEOTAB_LOGO_DATAURL, "PNG", pageW - margin - logoW, (barH - logoH) / 2, logoW, logoH); } catch (e) {}
  }

  function exportPdf() {
    if (!S.devices.length) { alert("Run the report first."); return; }
    var from = $("val-from").value, to = $("val-to").value;
    var doc = new jspdf.jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
    var pageW = doc.internal.pageSize.getWidth();
    var pageH = doc.internal.pageSize.getHeight();
    var margin = 12;

    doc.setFillColor(GEOTAB_NAVY[0], GEOTAB_NAVY[1], GEOTAB_NAVY[2]);
    doc.rect(0, 0, pageW, 24, "F");
    drawPdfHeaderLogo(doc, pageW, margin, 24);
    doc.setTextColor(255, 255, 255); doc.setFontSize(16); doc.setFont("helvetica", "bold");
    doc.text("Vehicle Activity Log", margin, 11);
    doc.setFontSize(9); doc.setFont("helvetica", "normal");
    doc.text(from + " to " + to + "   |   " + S.dbName, margin, 18);

    var yPos = 30;
    var emitted = 0;
    var truncated = false;

    for (var di = 0; di < S.devices.length && !truncated; di++) {
      var dev = S.devices[di];
      for (var dj = 0; dj < dev.days.length && !truncated; dj++) {
        var d = dev.days[dj];
        if (yPos > pageH - 40) { doc.addPage(); yPos = 16; }

        doc.setFontSize(10); doc.setFont("helvetica", "bold"); doc.setTextColor(39, 50, 93);
        doc.text(dev.name + "  |  " + fmtDayReadable(d.dayKey), margin, yPos);
        yPos += 4;

        // Row index in this table -> Replay URL, for the link annotations below.
        // Rebuilt per table, because autoTable's row.index is table-relative.
        var pdfUrls = [];

        var body = [];
        for (var ri = 0; ri < d.rows.length; ri++) {
          if (emitted >= PDF_MAX_ROWS) { truncated = true; break; }
          var r = d.rows[ri];
          var rUrl = replayUrl(dev.id, r.t, r.trip);
          body.push([
            fmtTime(r.t), r.status, r.duration, fmtDist(r.distKm),
            (r.speed == null || r.speed < IDLE_SPEED_KMH) ? "--" : fmtSpeed(r.speed),
            addressFor(r), r.lat.toFixed(5) + ", " + r.lng.toFixed(5),
            rUrl ? "Trip History" : ""
          ]);
          pdfUrls.push(rUrl);
          emitted++;
        }
        body.push([
          { content: "Day total", styles: { fontStyle: "bold", fillColor: [245, 245, 245] } },
          { content: "", styles: { fillColor: [245, 245, 245] } },
          { content: fmtDurWhole(d.idleMins) + " idling", styles: { fontStyle: "bold", fillColor: [245, 245, 245] } },
          { content: fmtDist(d.distKm), styles: { fontStyle: "bold", fillColor: [245, 245, 245] } },
          { content: "", styles: { fillColor: [245, 245, 245] } },
          { content: eventCount(d), styles: { fillColor: [245, 245, 245] } },
          { content: "", styles: { fillColor: [245, 245, 245] } },
          { content: "", styles: { fillColor: [245, 245, 245] } }
        ]);

        doc.autoTable({
          startY: yPos,
          head: [["Time", "Status", "Duration", "Daily distance", "Speed", "Location", "Coordinates", "Trip History"]],
          body: body,
          margin: { left: margin, right: margin },
          styles: { fontSize: 7.5, cellPadding: 1.6, textColor: [45, 55, 72], overflow: "linebreak" },
          headStyles: { fillColor: [0, 120, 212], textColor: 255, fontStyle: "bold", fontSize: 7.5 },
          columnStyles: {
            // Every column is fixed except 5 (Location), which absorbs whatever
            // is left of the 273 mm between the margins. "Trip History" at 7.5pt
            // bold measures 14.9 mm, so column 7 needs 18.1 mm with the 1.6 mm
            // padding either side. 21 mm leaves slack, because overflow is
            // "linebreak": a cell 1 mm too narrow wraps at the space and makes
            // every row in the table taller. The 5 mm over the old 16 mm comes
            // out of Location, which had ~101 mm for a single address line.
            0: { cellWidth: 20 }, 1: { cellWidth: 22 }, 2: { cellWidth: 38 }, 3: { cellWidth: 24 },
            4: { cellWidth: 18 }, 6: { cellWidth: 34 },
            7: { cellWidth: 21, textColor: [0, 120, 212], fontStyle: "bold" }
          },
          // A PDF link is an annotation over a rectangle, not styled text, so it
          // has to be drawn once the cell's final position on the page is known.
          didDrawCell: (function (urls) {
            return function (data) {
              if (data.section !== "body" || data.column.index !== 7) return;
              var u = urls[data.row.index];
              if (!u) return;
              doc.link(data.cell.x, data.cell.y, data.cell.width, data.cell.height, { url: u });
            };
          })(pdfUrls)
        });
        yPos = doc.lastAutoTable.finalY + 6;
      }
    }

    if (truncated) {
      doc.addPage();
      doc.setFontSize(10); doc.setTextColor(180, 60, 0);
      doc.text("Export stopped at " + PDF_MAX_ROWS.toLocaleString() + " events. Use Export CSV for the full data set.", margin, 20);
    }

    var pageCount = doc.internal.getNumberOfPages();
    for (var p = 1; p <= pageCount; p++) {
      doc.setPage(p); doc.setFontSize(8); doc.setTextColor(160, 160, 160);
      doc.text("Confidential", margin, pageH - 7);
      doc.text("Page " + p + " of " + pageCount, pageW - margin, pageH - 7, { align: "right" });
    }
    doc.save("vehicle_activity_log_" + from + "_to_" + to + ".pdf");
  }

  // ─── Run ─────────────────────────────────────────────────────────────────
  function runReport() {
    if (S.running) return;

    var from = $("val-from").value;
    var to   = $("val-to").value;
    if (!from || !to) { alert("Pick a from and to date."); return; }
    if (from > to)    { alert("The from date is after the to date."); return; }

    var groupId  = $("val-group").value;
    var deviceId = $("val-vehicle").value;
    // The date pickers mean days in the user's timezone, so the API window has
    // to be anchored there too, not at the browser's midnight.
    var f = from.split("-"), t = to.split("-");
    var fromIso = new Date(tzInstant(+f[0], +f[1], +f[2], 0, 0, 0)).toISOString();
    var toIso   = new Date(tzInstant(+t[0], +t[1], +t[2], 23, 59, 59)).toISOString();

    S.running = true;
    S.devices = [];
    S.warnings = [];
    S.failed = [];
    S.apiLog = [];
    renderFailures();               // clears last run's missing-vehicle block
    $("val-notice").open = false;   // collapsed at the start of every run
    S.addrMap = {};
    // Resolved here, not at load, so the thresholds match whichever unit system
    // the profile read settled on.
    S.rules = activeRules($("val-detail").value);
    if (S.rules) addWarning(describeRules(S.rules));
    if (!resolveHost()) {
      addWarning("The MyGeotab server or database name could not be worked out for this page, so the Trip History links will not work. Everything else in the report is unaffected.");
    }
    renderLinkInfo();
    renderWarnings();
    $("val-csv").classList.add("hidden");
    $("val-pdf").classList.add("hidden");
    $("val-run").disabled = true;
    $("val-output").innerHTML = "<p id='val-progress' class='report-placeholder'>Loading vehicles...</p>";

    var search = deviceId ? { id: deviceId } : (groupId ? { groups: [{ id: groupId }] } : {});
    apiCall("Get", { typeName: "Device", search: search, resultsLimit: 5000 }, function (devices) {
      devices = (devices || []).filter(function (d) { return d.name; })
        .sort(function (a, b) { return a.name.localeCompare(b.name); });

      if (!devices.length) { finish("No vehicles matched that group or vehicle."); return; }
      if (devices.length > MAX_DEVICES) {
        addWarning("That selection has " + devices.length + " vehicles. Only the first " + MAX_DEVICES +
          " (alphabetically) were run. Narrow the group or pick a single vehicle to see the rest.");
        devices = devices.slice(0, MAX_DEVICES);
      }

      var i = 0;
      (function next() {
        if (i >= devices.length) {
          if (!S.devices.length) { finish("No activity found for that selection and date range."); return; }
          $("val-csv").classList.remove("hidden");
          $("val-pdf").classList.remove("hidden");
          finish(null);
          return;
        }
        var dev = devices[i++];
        setProgress("Loading " + dev.name + " (" + i + " of " + devices.length + ")...");

        fetchLogRecords(dev.id, fromIso, toIso, 0, function (logs) {
          // A failed fetch is never rendered. Showing the vehicle with the rows
          // we happen to have would put "0 km" next to its name, which reads as
          // a fact about the vehicle rather than about the request.
          if (logs === null) {
            addFailure(dev.name);
            next();
            return;
          }

          // The Get succeeded but returned nothing but boundary records, which
          // MyGeotab manufactures at each end of the window. Real logs all carry
          // an id. Distance and every row come from real logs, so without them
          // the vehicle would report zeroes it cannot back up.
          var realLogs = 0;
          for (var li = 0; li < logs.length; li++) if (logs[li].id) realLogs++;

          fetchIgnition(dev.id, fromIso, toIso, function (ign) {
            if (!realLogs && ign && ign.length > 1) {
              addWarning("No GPS records for " + dev.name + " in this range, but it does have " +
                "ignition activity. Distance and idling for that vehicle are shown as zero because " +
                "there is nothing to measure them from, not because it stood still.");
            }
            if (ign === null) {
              addWarning("Ignition data could not be read for " + dev.name + ". Idling for that vehicle is estimated from GPS speed alone and will not match the native Idling report.");
            } else if (!ign.length) {
              addWarning("No ignition records for " + dev.name + " in this range. Idling for that vehicle is estimated from GPS speed alone and will not match the native Idling report.");
            }

            var built = buildActivity(logs, ign, fromIso, toIso);
            if (!built.days.length) { next(); return; }

            var entry = { id: dev.id, name: dev.name, days: built.days };

            // Attach the containing trip to every row, so the Replay link can
            // carry that trip's exact start and stop.
            fetchTrips(dev.id, fromIso, toIso, function (trips) {
              if (trips.length) {
                built.days.forEach(function (day) {
                  day.rows.forEach(function (r) { r.trip = tripAt(trips, new Date(r.t).getTime()); });
                });
              }

              setProgress("Resolving addresses for " + dev.name + "...");
              resolveAddresses(built.days, function (done, total) {
                setProgress("Resolving addresses for " + dev.name + " (" + done + " of " + total + ")...");
              }, function () {
                S.devices.push(entry);
                renderDevice(entry);
                next();
              });
            });
          });
        });
      })();
    }, function (err) {
      finish("Could not load vehicles: " + (err && err.message ? err.message : err));
    });

    function finish(message) {
      S.running = false;
      // Rendered once at the end rather than on each failure: a mid-run redraw
      // would wipe the technical-detail panel out from under anyone reading it.
      renderFailures();
      $("val-run").disabled = false;
      var p = $("val-progress");
      if (p) {
        if (message) p.textContent = message;
        else p.parentNode.removeChild(p);
      }
    }
  }

  // ─── Wiring ──────────────────────────────────────────────────────────────
  function setup() {
    applyDefaultDates();

    $("val-from").addEventListener("change", function () { S.datesTouched = true; });
    $("val-to").addEventListener("change",   function () { S.datesTouched = true; });
    $("val-group").addEventListener("change", function () { loadDevices(this.value); });
    $("val-run").addEventListener("click", runReport);
    $("val-csv").addEventListener("click", exportCsv);
    $("val-pdf").addEventListener("click", exportPdf);

    loadGroups();
    loadDevices("");
  }

  // ─── Add-in lifecycle ────────────────────────────────────────────────────
  geotab.addin.vehicleActivityLog = function () {
    return {
      initialize: function (api, freshState, callback) {
        try {
          S.api = api;
          S.gState = freshState;
          if (freshState && freshState.database) {
            S.dbName = freshState.database;
          }
          // getSession is one source for the MyGeotab host and not the best
          // one, so take whatever it gives and let resolveHost fill the gaps.
          if (api && typeof api.getSession === "function") {
            api.getSession(function (session, server) {
              if (server) {
                S.server = String(server).replace(/^https?:\/\//, "").replace(/\/$/, "");
                S.hostVia = "api.getSession";
              }
              if (!S.dbName && session && session.database) {
                S.dbName = session.database;
              }
              if (session && session.userName) S.userName = session.userName;
              resolveHost();
              renderLinkInfo();
              loadUserPrefs();
            });
          } else {
            onPrefsKnown();
          }
          setup();
          resolveHost();
          renderLinkInfo();
          $("val-loading").classList.add("hidden");
          $("val-main").classList.remove("hidden");
        } catch (err) {
          $("val-loading").innerHTML = "<p style='color:#DC2626'>Init error: " + esc(err.message) + "</p>";
        }
        if (callback) callback();
      },
      focus: function () {},
      blur: function () {}
    };
  };
})();
