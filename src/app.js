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
  var IDLE_SPEED_KMH  = 1;
  var MAX_RECORDS     = 50000;  // hard cap on a single Get
  var SPLIT_DEPTH     = 6;      // how many times to halve a window that hits the cap
  var GEOCODE_CHUNK   = 400;    // GetAddresses accepts up to 400 coordinates per call
  var GEOCODE_MAX_PTS = 12000;  // 30 calls, well inside the 450/min limit
  var MAX_DEVICES     = 25;     // guard against a whole-fleet run
  var PDF_MAX_ROWS    = 5000;
  var COORD_DP        = 4;      // ~11 m dedupe grid for geocoding
  var GEOTAB_NAVY     = [39, 50, 93];

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
    running:    false
  };

  // ─── Generic helpers ─────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }

  function apiCall(method, params, onSuccess, onError) {
    S.api.call(method, params, onSuccess, onError || function (err) {
      console.error("[VehicleActivityLog]", method, err);
    });
  }

  function esc(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function fmtDateInput(d) { return d.toISOString().slice(0, 10); }

  // Local calendar day, not UTC. A vehicle driving at 23:30 local must land on
  // the local day, otherwise the daily distance resets in the wrong place.
  function localDayKey(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
  }

  function fmtDayReadable(dayKey) {
    var parts = dayKey.split("-");
    var d = new Date(+parts[0], +parts[1] - 1, +parts[2]);
    return d.toLocaleDateString(undefined, { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
  }

  function fmtDayShort(dayKey) {
    var p = dayKey.split("-");
    return p[2] + "/" + p[1] + "/" + p[0];
  }

  function fmtTime(iso) {
    return iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--";
  }

  function tzLabel(iso) {
    try {
      var parts = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(new Date(iso));
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

  function fmtKm(km) {
    if (km == null || isNaN(km)) return "";
    if (km === 0) return "0 km";
    return String(parseFloat(km.toFixed(2))) + " km";
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

  function renderWarnings() {
    var el = $("val-notice");
    if (!S.warnings.length) { el.classList.add("hidden"); el.innerHTML = ""; return; }
    el.innerHTML = "<strong>Please note</strong><ul>" +
      S.warnings.map(function (w) { return "<li>" + esc(w) + "</li>"; }).join("") + "</ul>";
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
            fetchLogRecords(deviceId, mid, toIso, depth + 1, function (b) { cb(a.concat(b)); });
          });
          return;
        }
        addWarning("A vehicle returned the maximum of 50,000 GPS records even after splitting the range. Some rows are missing. Shorten the date range.");
      }
      cb(recs);
    }, function () { cb([]); });
  }

  // Ignition StatusData is written on state change, so the window is extended
  // back 24 h to pick up the state the vehicle was already in at fromDate.
  function fetchIgnition(deviceId, fromIso, toIso, cb) {
    var back = new Date(new Date(fromIso).getTime() - 24 * 3600 * 1000).toISOString();
    apiCall("Get", {
      typeName: "StatusData",
      search: {
        fromDate: back, toDate: toIso,
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
      var k = l.id || (l.dateTime + "");
      if (seen[k]) return;
      seen[k] = 1;
      pts.push({
        t: l.dateTime,
        ms: new Date(l.dateTime).getTime(),
        lat: l.latitude,
        lng: l.longitude,
        speed: l.speed == null ? 0 : l.speed
      });
    });
    pts.sort(function (a, b) { return a.ms - b.ms; });

    // Build a collapsed on/off transition list.
    var transitions = [];
    var hasIgnition = ignitionRecs !== null && ignitionRecs.length > 0;
    if (hasIgnition) {
      var sorted = ignitionRecs.slice().sort(function (a, b) {
        return new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime();
      });
      var last = null;
      sorted.forEach(function (r) {
        var on = Number(r.data) >= 0.5;
        if (last === null || on !== last) {
          transitions.push({ ms: new Date(r.dateTime).getTime(), on: on });
          last = on;
        }
      });
    }

    var ti = 0;
    // State before the first transition: if the first known transition is an
    // "off", the vehicle must have been on beforehand; otherwise assume off.
    var curIgn = hasIgnition ? (transitions.length && !transitions[0].on) : true;

    var days = [];
    var day = null;
    var curDayKey = null;
    var prevPt = null;
    var cumKm = 0;
    var inIdle = false;
    var idleStartMs = 0;

    function startDay(key) {
      day = { dayKey: key, rows: [], distKm: 0, idleMins: 0 };
      days.push(day);
      curDayKey = key;
      cumKm = 0;
      prevPt = null;
      inIdle = false;
    }

    function push(status, cls, pt, durText, showSpeed) {
      day.rows.push({
        t: pt.t,
        status: status,
        cls: cls,
        duration: durText || "",
        distKm: cumKm,
        speed: showSpeed ? pt.speed : null,
        lat: pt.lat,
        lng: pt.lng
      });
    }

    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      var key = localDayKey(p.t);
      if (key !== curDayKey) startDay(key);

      // Cumulative daily distance. Segments where both ends are stationary are
      // skipped so GPS jitter at a standstill does not inflate the total.
      if (prevPt && !(prevPt.speed < IDLE_SPEED_KMH && p.speed < IDLE_SPEED_KMH)) {
        cumKm += haversineKm(prevPt, p);
      }
      prevPt = p;

      // Advance the ignition state to this log's timestamp, emitting a row for
      // each transition we cross, positioned on this log (the nearest one).
      while (hasIgnition && ti < transitions.length && transitions[ti].ms <= p.ms) {
        var tr = transitions[ti++];
        if (tr.on === curIgn) continue;
        curIgn = tr.on;
        if (curIgn) {
          push("Ignition on", "ignon", p, "", false);
        } else {
          if (inIdle) {
            push("Idling end", "idle", p, "Idling time: [" + fmtDurPrecise((tr.ms - idleStartMs) / 60000) + "]", false);
            day.idleMins += (tr.ms - idleStartMs) / 60000;
            inIdle = false;
          }
          push("Ignition off", "ignoff", p, "", false);
        }
      }

      if (!curIgn) continue;  // no rows while the ignition is off

      if (p.speed < IDLE_SPEED_KMH) {
        if (!inIdle) {
          inIdle = true;
          idleStartMs = p.ms;
          push("Idling start", "idle", p, "", false);
        } else {
          push("Idling", "idle", p, "", false);
        }
      } else {
        if (inIdle) {
          var mins = (p.ms - idleStartMs) / 60000;
          day.idleMins += mins;
          inIdle = false;
          push("Idling end", "idle", p, "Idling time: [" + fmtDurPrecise(mins) + "]", true);
        } else {
          push("Moving", "moving", p, "", true);
        }
      }
    }

    // Close an idle run still open at the end of the window.
    if (inIdle && day && pts.length) {
      var lastPt = pts[pts.length - 1];
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
    days.forEach(function (d) { d.distKm = d.rows[d.rows.length - 1].distKm; });

    return { days: days, hasIgnition: hasIgnition };
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
  // This is a real URL copied out of the address bar of a live database:
  //
  //   #tripsHistory,
  //   dateRange:(endDate:'2026-08-19T22:59:59.000Z',label:Today,startDate:'2026-08-18T23:00:00.000Z'),
  //   expandedCardIds:!('b11_UnknownDriverId_Tue+Aug+18'),
  //   isReplayPlayerHidden:!f,
  //   mapBounds:!(42.62073,2.82396,37.62609,-4.1194),
  //   routes:(b11:!((start:'2026-08-18T21:14:40.557Z',stop:'2026-08-18T23:38:26.557Z')))
  //
  // What each part does:
  //   routes                a map of device id to trip segments. This is what
  //                         picks the vehicle AND draws the segment. It replaces
  //                         entityType and selectedEntities entirely.
  //   isReplayPlayerHidden  rison !f is false, so the replay player opens.
  //                         Without it the page shows a static route.
  //   dateRange             scopes the trip list. label is a UI convenience and
  //                         is omitted here, since explicit dates are given.
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

  function cardDatePart(iso) {
    var d = new Date(iso);
    return DOW_SHORT[d.getDay()] + "+" + MON_SHORT[d.getMonth()] + "+" + d.getDate();
  }

  function replayUrl(deviceId, iso, trip) {
    if (!S.server || !S.dbName) return "";

    var d = new Date(iso);
    var dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
    var dayEnd   = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 0);

    var segStart, segStop, cardId = "";
    if (trip) {
      segStart = trip.startIso;
      segStop  = trip.stopIso;
      cardId   = deviceId + "_" + trip.driverId + "_" + cardDatePart(trip.startIso);
    } else {
      segStart = new Date(d.getTime() - REPLAY_PAD_MS).toISOString();
      segStop  = new Date(d.getTime() + REPLAY_PAD_MS).toISOString();
    }

    var url = "https://" + S.server + "/" + S.dbName + "/#tripsHistory,"
      + "dateRange:(endDate:'" + dayEnd.toISOString() + "',startDate:'" + dayStart.toISOString() + "'),";
    if (cardId) url += "expandedCardIds:!('" + cardId + "'),";
    url += "isReplayPlayerHidden:!f,"
      + "routes:(" + deviceId + ":!((start:'" + segStart + "',stop:'" + segStop + "')))";
    return url;
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
    if (S.server && S.dbName) {
      el.innerHTML = "Replay links open <code>" + esc(S.server + "/" + S.dbName)
        + "</code> <span class='val-muted'>(host read from " + esc(S.hostVia || "session") + ")</span>";
      el.classList.remove("hidden");
    } else {
      el.innerHTML = "Replay links are disabled: could not work out the MyGeotab server or database name for this page.";
      el.classList.remove("hidden");
    }
  }

  // Only reached when no host resolved, so no URL could be built at all. The
  // previous gotoPage fallback passed entityType and selectedEntities, which the
  // page no longer reads, so it landed on an empty Trips History and looked like
  // a broken link rather than a missing host. Say so instead.
  function openReplay() {
    alert("Could not work out the MyGeotab address for this database, so the Replay link cannot be built.");
  }

  // ─── Rendering ───────────────────────────────────────────────────────────
  var COLS = ["Date", "Status", "Duration", "Daily distance", "Speed", "Location", "Coordinates", "Replay"];

  function renderDevice(dev) {
    var block = document.createElement("div");
    block.className = "val-vehicle-block";

    var totalKm   = dev.days.reduce(function (s, d) { return s + d.distKm; }, 0);
    var totalIdle = dev.days.reduce(function (s, d) { return s + d.idleMins; }, 0);
    var totalRows = dev.days.reduce(function (s, d) { return s + d.rows.length; }, 0);

    var html = "<h3 class='val-vehicle-name'>" + esc(dev.name) + "</h3>"
      + "<div class='val-vehicle-meta'>" + dev.days.length + " day" + (dev.days.length === 1 ? "" : "s")
      + " &middot; " + totalRows.toLocaleString() + " events &middot; " + fmtKm(totalKm)
      + " &middot; " + fmtDurWhole(totalIdle) + " idling</div>";

    dev.days.forEach(function (d) {
      var body = "";
      d.rows.forEach(function (r, i) {
        var dateCell = i === 0
          ? "<strong>" + esc(fmtDayShort(d.dayKey)) + "</strong> " + esc(fmtTime(r.t)) + " <span class='val-tz'>" + esc(tzLabel(r.t)) + "</span>"
          : esc(fmtTime(r.t));
        var speedCell = r.speed == null || r.speed < IDLE_SPEED_KMH
          ? "<span class='val-muted'>--</span>"
          : Math.round(r.speed) + " km/h";
        var url = replayUrl(dev.id, r.t, r.trip);
        body += "<tr>"
          + "<td class='val-num'>" + dateCell + "</td>"
          + "<td><span class='val-status'><span class='val-dot val-dot-" + r.cls + "'></span>" + esc(r.status) + "</span></td>"
          + "<td class='val-dur'>" + esc(r.duration) + "</td>"
          + "<td class='val-num'>" + esc(fmtKm(r.distKm)) + "</td>"
          + "<td class='val-num'>" + speedCell + "</td>"
          + "<td>" + esc(addressFor(r)) + "</td>"
          + "<td class='val-coords'>" + r.lat.toFixed(5) + ", " + r.lng.toFixed(5) + "</td>"
          // A real href, not "#": the browser status bar then shows where the
          // link goes, and middle-click / copy-link-address both work, which is
          // what makes this diagnosable without a debugger.
          + "<td><a href='" + esc(url || "#") + "' target='_blank' rel='noopener' class='val-replay'"
          + " data-device='" + esc(dev.id) + "' data-time='" + esc(r.t) + "'"
          + " title='" + esc(url || "No MyGeotab host resolved, so no Replay link could be built.") + "'>REPLAY</a></td>"
          + "</tr>";
      });

      body += "<tr class='val-day-total'>"
        + "<td colspan='3'>" + esc(fmtDayReadable(d.dayKey)) + " total</td>"
        + "<td class='val-num'>" + esc(fmtKm(d.distKm)) + "</td>"
        + "<td colspan='4'>" + esc(fmtDurWhole(d.idleMins)) + " idling &middot; " + d.rows.length + " events</td>"
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

  function renderSummary() {
    var totalKm = 0, totalIdle = 0, totalRows = 0, dayKeys = {};
    S.devices.forEach(function (dev) {
      dev.days.forEach(function (d) {
        totalKm += d.distKm; totalIdle += d.idleMins; totalRows += d.rows.length; dayKeys[d.dayKey] = 1;
      });
    });
    var cards = [
      ["Vehicles", S.devices.length, ""],
      ["Days", Object.keys(dayKeys).length, ""],
      ["Distance", parseFloat(totalKm.toFixed(1)), " km"],
      ["Idling", fmtDurWhole(totalIdle), ""],
      ["Events", totalRows.toLocaleString(), ""]
    ].map(function (c) {
      return "<div class='summary-card'><div class='summary-label'>" + c[0] + "</div>"
        + "<div class='summary-value'>" + c[1] + "<span class='summary-unit'>" + c[2] + "</span></div></div>";
    });
    var el = $("val-summary");
    el.innerHTML = cards.join("");
    el.classList.remove("hidden");
  }

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
            fmtKm(r.distKm),
            (r.speed == null || r.speed < IDLE_SPEED_KMH) ? "--" : Math.round(r.speed) + " km/h",
            addressFor(r),
            r.lat.toFixed(5) + ", " + r.lng.toFixed(5)
          ]);
        });
      });
    });
    return out;
  }

  var CSV_HEAD = ["Vehicle", "Date", "Time", "Status", "Duration", "Daily distance", "Speed", "Location", "Coordinates"];

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

        var body = [];
        for (var ri = 0; ri < d.rows.length; ri++) {
          if (emitted >= PDF_MAX_ROWS) { truncated = true; break; }
          var r = d.rows[ri];
          body.push([
            fmtTime(r.t), r.status, r.duration, fmtKm(r.distKm),
            (r.speed == null || r.speed < IDLE_SPEED_KMH) ? "--" : Math.round(r.speed) + " km/h",
            addressFor(r), r.lat.toFixed(5) + ", " + r.lng.toFixed(5)
          ]);
          emitted++;
        }
        body.push([
          { content: "Day total", styles: { fontStyle: "bold", fillColor: [245, 245, 245] } },
          { content: "", styles: { fillColor: [245, 245, 245] } },
          { content: fmtDurWhole(d.idleMins) + " idling", styles: { fontStyle: "bold", fillColor: [245, 245, 245] } },
          { content: fmtKm(d.distKm), styles: { fontStyle: "bold", fillColor: [245, 245, 245] } },
          { content: "", styles: { fillColor: [245, 245, 245] } },
          { content: d.rows.length + " events", styles: { fillColor: [245, 245, 245] } },
          { content: "", styles: { fillColor: [245, 245, 245] } }
        ]);

        doc.autoTable({
          startY: yPos,
          head: [["Time", "Status", "Duration", "Daily distance", "Speed", "Location", "Coordinates"]],
          body: body,
          margin: { left: margin, right: margin },
          styles: { fontSize: 7.5, cellPadding: 1.6, textColor: [45, 55, 72], overflow: "linebreak" },
          headStyles: { fillColor: [0, 120, 212], textColor: 255, fontStyle: "bold", fontSize: 7.5 },
          columnStyles: { 0: { cellWidth: 20 }, 1: { cellWidth: 22 }, 2: { cellWidth: 38 }, 3: { cellWidth: 24 }, 4: { cellWidth: 18 }, 6: { cellWidth: 34 } }
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
    var fromIso = new Date(from + "T00:00:00").toISOString();
    var toIso   = new Date(to   + "T23:59:59").toISOString();

    S.running = true;
    S.devices = [];
    S.warnings = [];
    S.addrMap = {};
    if (!resolveHost()) {
      addWarning("The MyGeotab server or database name could not be worked out for this page, so the Replay links will not work. Everything else in the report is unaffected.");
    }
    renderLinkInfo();
    renderWarnings();
    $("val-summary").classList.add("hidden");
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
          renderSummary();
          $("val-csv").classList.remove("hidden");
          $("val-pdf").classList.remove("hidden");
          finish(null);
          return;
        }
        var dev = devices[i++];
        setProgress("Loading " + dev.name + " (" + i + " of " + devices.length + ")...");

        fetchLogRecords(dev.id, fromIso, toIso, 0, function (logs) {
          fetchIgnition(dev.id, fromIso, toIso, function (ign) {
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
    var today = new Date();
    $("val-from").value = fmtDateInput(today);
    $("val-to").value   = fmtDateInput(today);

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
            $("val-db").textContent = freshState.database;
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
                $("val-db").textContent = session.database;
              }
              resolveHost();
              renderLinkInfo();
            });
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
