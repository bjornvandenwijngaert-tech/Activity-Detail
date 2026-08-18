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
- **Replay links** use the documented URL format but have not been clicked in a
  live database since the v1.0.1 fix. See below.
- **Fallback when there is no ignition data.** If a vehicle returns no ignition
  records, the engine treats the ignition as on for the whole range and derives
  idling from GPS speed alone. A visible warning says so, because those totals
  will not match the native Idling report.

## Replay link

The URL format is documented in the Geotab SDK guide
[Using MyGeotab URLs](https://developers.geotab.com/myGeotab/guides/myGeotabUrls/):

```
https://<server>/<db>/#tripsHistory,dateRange:(interval:custom,startDate:'…Z',endDate:'…Z'),entityType:Device,selectedEntities:!(b1,b7,b21)
```

`selectedEntities` takes **bare device ids** in a rison list. v1.0.0 wrapped them
as `!((id:b12))`, which parses without erroring but selects no vehicle, so the
page opened blank. Fixed in v1.0.1.

The second reason v1.0.0 looked empty: Trips History lists **trips over a range**,
not the vehicle's state at an instant. A few minutes either side of one GPS fix
can contain no whole trip, so the page has nothing to draw. The range is now the
row's **full local day**, which always lands on that vehicle's trip list for that
date with the trip containing the moment visible in it. Set `REPLAY_WHOLE_DAY` to
`false` in `app.js` to switch back to a narrow window (`REPLAY_PAD_MS`, 15 min).

There is no documented MyGeotab page that scopes to an instant. `map` takes
`liveVehicleIds`, `planRoutes` and `highlightGroup` only, all of which are live
rather than historical, so `tripsHistory` is the closest available target.

The documented URL is the primary route and opens in a new tab.
`state.gotoPage("tripsHistory", …)` is only the fallback for when the session
does not hand back a server or database name, because gotoPage's parameter shape
is not documented anywhere. If the session gives no server, the report says so in
a notice at run time rather than leaving dead links unexplained.

The MyGeotab host comes from `api.getSession`, not `window.location`, because the
add-in is hosted off-domain on GitHub Pages.

Every REPLAY link carries the URL it will open in its `title` attribute, so
hovering a row shows exactly where it goes before you click.

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

Cache note: the asset links are versioned with `?v=1.0.0`. Bump that query
string in `index.html` whenever `app.js`, `activity.css` or `styles.css` change,
otherwise MyGeotab will keep serving the cached copy.

Still outstanding, unrelated to this add-in:

- `~/repos/legacy-trip-report` is not a git repository, so it has no route to
  publication, and its files show as deleted (unstaged) in the `smart-insights`
  working tree.

## Later

The intent is to fold this into Smart Insights as a tab. The IIFE and the single
`S` state object are what make that a copy-in rather than a rewrite.
