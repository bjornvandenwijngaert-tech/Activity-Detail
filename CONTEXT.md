# Vehicle Activity Log — context

## What this is

A standalone MyGeotab add-in report that reproduces a per-event vehicle activity
report a customer brought over from a previous system. One row per GPS log, with
a derived status, idling duration, running daily distance, spot speed, address,
coordinates and a Replay link.

Reference columns, in order:

`DATE | STATUS | DURATION | DAILY DISTANCE | SPEED | LOCATION | COORDINATES | REPLAY`

Statuses: Ignition on, Idling start, Idling, Idling end, Moving, Ignition off.

## Why it is a custom add-in and not a native report

Checked before building:

- Built-in reports (Trips History, Activity and Trips Summary, Trips Detail, the
  Idling reports) are trip-level or summary-level. None emits one row per GPS fix
  with a status transition.
- The custom Excel advanced-report route is structurally blocked. The report
  engine regenerates the report block from its first row only, so it emits
  exactly one report row per data-sheet row, and the available data source is
  trip-level. One trip cannot fan out into five status rows.
- The data does exist over the API: `LogRecord`, `StatusData` on
  `DiagnosticIgnitionId`, and `GetAddresses`.

Still open: the full list of system `ReportTemplate` records in a live database
was never enumerated, because the MyGeotab CLI needs an interactive login. Low
risk given the two structural blockers, but worth a look during testing.

## Files

```
config.json        Add-in registration; menu "Vehicle Activity Log", path ActivityLink/
index.html         Shell: filter toolbar, notice area, summary cards, output
src/app.js         All report logic
src/activity.css   Rules specific to this report
src/styles.css     Lifted verbatim from legacy-trip-report
src/logo-data.js   Lifted verbatim; Geotab logo for branded PDF export
src/geotab-logo.png
```

`styles.css` and `logo-data.js` are unmodified copies of the legacy-trip-report
versions, so fixes can be mirrored between the two repos.

## Namespacing (important)

MyGeotab add-in pages are injected into the host page, not iframed, so every
add-in installed in a database shares one JS scope. All of `src/app.js` lives
inside one IIFE with a single `S` state object and the single global entry point
`geotab.addin.vehicleActivityLog`. There are no bare top-level names.

This matters because `legacy-trip-report/src/app.js` declares a top-level
`var state` plus bare function names. If both add-ins are ever installed in the
same database, or when this is folded into Smart Insights, they would collide.
Do not introduce top-level names here.

## Status engine

Per device:

1. Fetch `LogRecord` for the range. If a `Get` returns 50,000 records (the hard
   cap), the window is halved recursively, up to 6 levels. Logs are de-duplicated
   by id, since split windows overlap on the boundary.
2. Fetch `StatusData` with `diagnosticSearch: { id: "DiagnosticIgnitionId" }`.
   The window is extended 24 hours before the from-date, because ignition status
   is only written on state change, so the state at the start of the range comes
   from an earlier record.
3. Collapse the ignition records into on/off transitions and walk the logs in
   time order:
   - Crossing an ignition-on transition emits **Ignition on**, positioned on the
     log being processed (the nearest one in time).
   - With the ignition on, a log below 1 km/h is idling. The first of a run is
     **Idling start**, the rest are **Idling**, and the log where speed reaches
     1 km/h (or ignition drops) is **Idling end**, carrying
     `Idling time: [3m 08s]`.
   - Any other log with the ignition on is **Moving**.
   - Crossing an ignition-off transition closes any open idle run, then emits
     **Ignition off**. Logs recorded while the ignition is off produce no rows.
4. Daily distance is a running cumulative haversine between consecutive logs,
   reset at local midnight. Segments where both endpoints are below 1 km/h are
   skipped so GPS jitter at a standstill does not inflate the total.
5. Speed shows `--` below 1 km/h, matching the reference.
6. Days are bucketed by local calendar day (`localDayKey`), not UTC.

`IDLE_SPEED_KMH = 1` matches Geotab's own definition of idling: speed below
1 km/h with the ignition on.

## Known limits and things to verify

- **Ignition off rows are unverified.** The customer's reference screenshot is
  truncated before any appear, so the exact label and placement need confirming
  against their full export.
- **Distance is GPS-derived**, so a day total can drift slightly from Geotab's
  odometer-based `Trip.Distance`. If the customer needs the two to agree, scale
  the day's haversine total to the summed `Trip.Distance` for that day.
- **Replay links** were rewritten in v1.1.0 against a real URL rather than the
  documentation, and have not been clicked in a live database since. See below.
- **Fallback when there is no ignition data.** If a vehicle returns no ignition
  records, the engine treats the ignition as on for the whole range and derives
  idling from GPS speed alone. A visible warning says so, because those totals
  will not match the native Idling report.

## Replay link

**The SDK documentation for this is wrong.** The examples in
[Using MyGeotab URLs](https://developers.geotab.com/myGeotab/guides/myGeotabUrls/)
date from 2015, and Geotab simplified MyGeotab URLs in 2022. `entityType` and
`selectedEntities` are no longer read by the Trips History page. Every version
from v1.0.0 to v1.0.2 sent them and opened a blank page.

v1.1.0 uses the real grammar, taken from a URL copied out of the address bar of a
live database:

```
#tripsHistory,
dateRange:(endDate:'2026-08-19T22:59:59.000Z',label:Today,startDate:'2026-08-18T23:00:00.000Z'),
expandedCardIds:!('b11_UnknownDriverId_Tue+Aug+18'),
isReplayPlayerHidden:!f,
mapBounds:!(42.62073,2.82396,37.62609,-4.1194),
routes:(b11:!((start:'2026-08-18T21:14:40.557Z',stop:'2026-08-18T23:38:26.557Z')))
```

| Parameter | What it does | Generated? |
|---|---|---|
| `routes` | Map of device id to trip segments. Picks the vehicle **and** draws the segment. Replaces `entityType` + `selectedEntities` entirely. | Yes |
| `isReplayPlayerHidden:!f` | Rison `!f` is false, so the replay player opens. Without it the page draws a static route. | Yes |
| `dateRange` | Scopes the trip list. `label` is a UI convenience, omitted since explicit dates are supplied. | Yes, row's local day |
| `expandedCardIds` | Opens the matching trip card in the side list. `<deviceId>_<driverId>_<Ddd+Mmm+D>`, spaces as `+`. | Yes, when a trip matched |
| `mapBounds` | Viewport only. | No, so the map fits the route |

### Why Trip is now fetched

`routes` needs a segment's exact start and stop. A row carries a single
timestamp, so v1.1.0 adds one `Get` on `Trip` per vehicle and binary-searches for
the trip containing each row's timestamp. That data is used **only** for the
Replay link; nothing in the report body depends on it.

Rows with no containing trip (idling with the ignition on between trips) fall
back to the timestamp plus or minus 15 minutes (`REPLAY_PAD_MS`). Whether the
page accepts an arbitrary window rather than real trip boundaries is untested.

### Unverified in this format

- **`expandedCardIds` day number is not zero-padded** (`Aug+8`, not `Aug+08`).
  The one real sample has a two-digit day so it does not settle the question. If
  it is wrong the card just does not expand; the route and replay still work.
- **`label` is omitted.** The real sample always carries one (`label:Today`). If
  the date range misbehaves, try `label:Custom`.
- **The card date uses browser local time**, so it inherits the timezone bug
  below. Same low blast radius: a wrong card id means an unexpanded card.

### Where the host comes from (v1.0.2)

v1.0.1 read the server from `api.getSession` alone, on the assumption that a page
served from GitHub Pages could not see the MyGeotab URL. That assumption was
wrong. Add-in pages are **injected into the MyGeotab page, not iframed**, so the
executing document is on the MyGeotab origin and `window.location` already holds
both the server and the database:

```
https://my.geotab.com/<database>/#ActivityLink/...
```

`resolveHost()` now takes `window.location` first (ignoring `*.github.io` and
localhost, for the case where the page really is served standalone) and falls
back to `getSession`. If `getSession` returns no server, as it appears to on at
least one database, v1.0.1 built an empty URL and the click fell through to the
undocumented `gotoPage` path, which lands on Trips History with nothing selected.
That is the most likely cause of the original "opens but shows nothing".

### Diagnostics

The report shows a strip above the results saying exactly which host and database
the Replay links point at and which source that came from. Every REPLAY link now
has a **real `href`** rather than `#`, so the browser status bar shows the
destination on hover, and copy-link-address and middle-click both work. If no
host resolves, the strip says so and a notice explains that only Replay is
affected.

### If it is still wrong

Copy a working URL out of the address bar of a real database again and diff it
against what the report generates. That beats the documentation every time, which
is how v1.1.0 was arrived at.

## Timezone (known bug, not yet fixed)

Days are bucketed by the **browser's** timezone, not the MyGeotab user's
`timeZoneId`. The two differ whenever the operator is not in the database's own
timezone, and the failure is silent: wrong day boundaries and a daily distance
that resets at the wrong moment.

This is live, not theoretical. The real Trips History URL for a UK database shows
`startDate:'2026-08-18T23:00:00.000Z'` for "Today", so that database is on UTC+1
while the browser running the report is on UTC+2.

The fix is to read `timeZoneId` from the session user and bucket against it
rather than against `Date.getFullYear()` / `getMonth()` / `getDate()`.

## Volume guards

| Guard | Value | Behaviour when hit |
|---|---|---|
| `MAX_DEVICES` | 25 | Runs the first 25 alphabetically, shows a notice naming the total |
| `MAX_RECORDS` | 50,000 | Halves the window recursively; warns if still capped after 6 splits |
| `GEOCODE_CHUNK` | 400 | `GetAddresses` per-call maximum; batches run sequentially |
| `GEOCODE_MAX_PTS` | 12,000 | Remaining rows show coordinates instead of an address, with a notice |
| `COORD_DP` | 4 | ~11 m dedupe grid for geocoding |
| `PDF_MAX_ROWS` | 5,000 | PDF stops and prints a page saying to use CSV instead |

None of these truncate silently. Every one writes a visible notice.

Vehicles render as each one finishes rather than after the whole set, so a
group-wide run shows output while it is still working.

## Verification checklist

- **Idle correctness (the one that matters).** Run the native Idling report for
  the same vehicle and day and confirm the total matches the sum of this
  report's Idling end durations. Pulling ignition status is the whole reason for
  the `StatusData` call.
- **Distance.** Compare the day's final Daily Distance against the Trips History
  daily total. Expect a small GPS versus odometer gap. More than a few percent
  means applying the trip-total scaling described above.
- **Status sequence.** Spot-check one vehicle-day against map playback. Every
  Idling start needs a matching Idling end, and no idling row may appear outside
  an ignition-on interval.
- **Day boundaries.** Use a vehicle driving across local midnight and confirm the
  day splits correctly and Daily Distance resets.
- **Volume.** Run a group over a week; confirm the notices fire and the progress
  line moves rather than appearing to hang.
- **Replay.** Click three rows from different days and confirm each lands on the
  right vehicle in the right window.
- **Side by side.** Put the output next to the customer's reference export and
  check column for column.

## Hosting

Published to its own GitHub Pages site, separate from Smart Insights:

`https://bjornvandenwijngaert-tech.github.io/Activity-Detail/index.html`

That is the URL in `config.json`. `index.html` and the whole `src/` folder are
served from the repository root, so the relative paths in `index.html` work
unchanged.

Cache note: the asset links are versioned with `?v=1.1.0`. Bump that query
string in `index.html` whenever `app.js`, `activity.css` or `styles.css` change,
otherwise MyGeotab will keep serving the cached copy.

Still outstanding, unrelated to this add-in:

- `~/repos/legacy-trip-report` is not a git repository, so it has no route to
  publication, and its files show as deleted (unstaged) in the `smart-insights`
  working tree.

## Later

The intent is to fold this into Smart Insights as a tab. The IIFE and the single
`S` state object are what make that a copy-in rather than a rewrite.
