# Vehicle Activity Log — context

## What this is

A standalone MyGeotab add-in report that reproduces a per-event vehicle activity
report a customer brought over from a previous system. One row per GPS log, with
a derived status, idling duration, running daily distance, spot speed, address,
coordinates and a link into MyGeotab.

Reference columns, in order:

`DATE | STATUS | DURATION | DAILY DISTANCE | SPEED | LOCATION | COORDINATES | REPLAY`

The last column is labelled **Trip History** here, not REPLAY. That is the one
deliberate difference from the reference export: see the naming note below.

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
versions, so fixes can be mirrored between the two repos. `smart-insights` has
its own `styles.css` that has drifted elsewhere but still shares the card rules
verbatim, so shared-component fixes go to all three. See below.

### Summary card accent stripe (v1.6.2)

The blue stripe on the summary cards did not line up with the card frame: at both
top corners the stripe stopped short with a square cut while the grey border arc
carried on past it, which reads as the two overlapping.

It was drawn as an absolutely positioned `::before`, 3px tall, `left:0; right:0`,
relying on the card's `overflow: hidden` to round it off. That can never line up.
An absolutely positioned child is clipped to the **padding** box, whose corner
radius is `10px - 1px border = 9px`, while the grey border draws the **10px outer**
curve. A 3px-tall bar clipped by a 9px curve loses roughly 7px off each end, so
the stripe physically cannot reach the corner the border is drawing.

Fixed by making the stripe the card's own `border-top: 3px`. The browser then
miters the thick top into the thin sides around one shared radius, so there is a
single continuous curve and nothing left to misalign. `--accent-mid: #7FBEEA` is
a new token equal to `--accent` at 50% over white, which is exactly what the old
`opacity: .5` produced, so the colour is unchanged. Top padding dropped 16px to
14px to absorb the 2px the thicker border adds, keeping card height identical.

Applied to all three repos; the card block is byte-identical in each. Asset query
strings were bumped in the same pass (`legacy-trip-report` to `?v=1.1.1`,
`smart-insights` to `?v=2.7.1`), because without that the patched CSS never
reaches a browser holding the old copy.

**Verified by rendering, not by reading.** `.diag/cards.html` loads the real
stylesheet with the real card markup; headless Chrome screenshots it at high
device-scale so the corner is actually inspectable:

```
"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless --disable-gpu \
  --force-device-scale-factor=14 --hide-scrollbars \
  --screenshot=.diag/corner.png --window-size=46,22 file:///.../.diag/cards.html
```

Use this for any future CSS change to these cards. Reasoning about clipping and
border-radius from the source is what produced the bug in the first place.

### Idling is not over-counted. It counts something wider than Geotab does

**The suspicion was wrong.** Every previous entry here assumed the 56.2 min against
Geotab's 00:26:34 was phantom idle produced by the sub-1 km/h threshold, and that the
fix was calibration. It is not. Measured on 19 Aug 2026 with `.diag/idle-compare.js`,
device `bA`, 18 Aug, against the 16 real `Trip` records:

| Our idle time | Minutes | What it is |
|---|---|---|
| Inside a trip's stop window | 26.88 | Parked between trips with the engine running |
| Inside a trip, start to stop | 23.74 | Stationary while on a trip: traffic, junctions, lights |
| Before the first trip began | 5.59 | Engine on at 06:38:22, first trip started 06:43:58 |
| **Total** | **56.20** | |

Geotab's summed `idlingDuration` over the same 16 trips is **26.57 min**, and Trips
History shows 00:26:34. Our first line is **26.88**. Those agree.

Lined up stop window by stop window, every single trip matches to 0.1 min:

```
  stop..next            stopDur   gIdle    ours    diff
  07:48:55..08:13:19      24.4    24.4    24.4+    0.0
  08:22:07..08:36:18      14.2     0.1     0.1+    0.0
  09:19:29..10:09:59      50.5     0.1     0.1+    0.0
  ... all 16, none off by more than 0.2
```

**So there is no arithmetic error. The two numbers measure different things.**
Geotab's `Trip.idlingDuration` is the engine-on portion of the stop **after** a trip
ends. It does not count stationary time during a trip. Ours counts every stationary
moment with the engine running, wherever it falls. Note trip 1: `stopDuration` 5:15 but
`idlingDuration` 2 seconds, because the engine was off for nearly all of that stop.
Geotab is measuring engine-on-while-parked, not stopped-ness.

**The extra 23.74 min is the thing the customer asked for.** It is 49 in-trip pauses,
median 16 seconds, 9 over 45 seconds, 2 over 2 minutes, longest 2.6 minutes. That is
the red-light and traffic idling the whole v1.7.2 conversation was about. Removing it
to match MyGeotab would delete the feature.

**But 23.74 is not all traffic. `Trip.stop` fires before the vehicle actually stops.**
Measured with `.diag/arrival-check.js` across all 16 trips: the ignition-off that ends
a trip lands **1 to 50 seconds after** `Trip.stop`, on 15 of 16 (the exception is a trip
whose stop has no adjacent off). So the standstill on arrival, engine still running,
falls *inside* `[trip.start, trip.stop]` and plain overlap arithmetic calls it traffic.
On 18 Aug that mislabelled 15 runs and **5.99 min**. The real split is **38.46 stopped,
17.75 mid-journey**. `splitIdle` corrects for it: a run that ended because the ignition
went off is arrival idling by definition and goes wholly to stopped.

The departure side needs no equivalent rule. `Trip.start` is the first movement, so
warm-up idling falls outside the trip window on its own, and the data shows zero
departure misclassifications.

An ignition-only rule ("moved before and after within one ignition cycle") cannot
replace the trip list. It would call the 24.4 min parked stop at 07:48:55..08:13:19
mid-journey, because the vehicle drove, sat 24 minutes with the engine running, and
drove on, all inside one ignition cycle.

**Consequence: do not "fix" this by tuning thresholds.** The sweep in
`.diag/idle-sweep.js` shows why nothing in that direction works. Varying the speed
threshold from 0.1 to 3 km/h moves the total between 56.2 and 58.0. Turning the v1.7.2
coalescing off entirely gives 50.4. Dropping every run under 3 minutes gives 32.8. None
of them approach 26.6 without also destroying the short-idle detail, because the gap
was never made of short idles: two runs alone (24.8 min and 8.0 min) are 33 of the 56.

**MyGeotab reports idling in two places and they do not agree with each other.**
Checked live in ILLE01 on 19 Aug 2026. Besides the Trips History column there is the
stock `Idling` exception rule, `RuleIdlingId`, active from 9 Jul 2026 on GroupCompanyId.
Its condition tree:

```
DurationLongerThan 201 s
  And
    IsDriving == 0
    And
      DurationBetweenGps < 201 s      (GPS still reporting, not a dead zone)
      Ignition == 1
```

So it fires on ignition-on, not-driving, for longer than **3 minutes 21 seconds**. For
`bA` on 18 Aug it produced exactly two events:

```
  06:38:22 .. 06:43:58    5.59 min     (before the first trip)
  07:48:55 .. 08:13:19   24.40 min     (the long parked stop)
                        ------
                         29.99 min
```

Both align with our runs to the second. So there are three native-or-derived figures for
one vehicle-day, and all three are defensible:

| Source | Minutes | What it excludes |
|---|---|---|
| Trips History `Idle` column | 26.57 | Anything not in a post-trip stop, including the 5.59 min warm-up |
| `Idling` exception rule | 29.99 | Anything under 3 min 21 s |
| This add-in | 56.21 | Nothing |

The 201 s floor is why the rule misses 26 minutes that we catch. It is a fuel-waste
alarm, not a measurement. **Do not treat either native number as the correct answer that
we are deviating from.** Bjorn's stated intent is "how long a car is kept on after
standing still", plus visibility of short repeated stops for route and driver efficiency.
Only the 56.21 answers that.

Untested on this day: whether the rule's `IsDriving == 0` would catch a long pause
*inside* a trip. The longest in-trip pause on 18 Aug was 2.6 min, under the 201 s floor,
so nothing distinguishes the two readings. Needs a vehicle that sat over 3:21 in traffic.

**Fixed in v1.8.0: the split is shown as a per-day insight, not a column.** The problem
was never the number, it was that one unexplained figure sat next to a different native
one. `splitIdle` divides each day's idling into time stopped and time standing still
mid-journey, and the day total row carries the breakdown in words.

It costs nothing. `fetchTrips` was already running per vehicle to build the Trip History
deep links, so the trip boundaries were on hand the whole time. **The earlier note in this
file claiming it needed one extra `Get` per device was wrong.** The duration-threshold
proxy was never needed either.

How it works:

- `buildActivity` now records every idle run in `day.idleRuns` as well as adding to
  `day.idleMins`. It has to: the split is only knowable once the trip list arrives, which
  is after the engine has finished, and a total cannot be divided after the fact.
- `closeIdle(endMs, endedBy)` replaced three separate hand-rolled `day.idleMins +=` sites.
  They had drifted into three copies of the same three lines. `endedBy` is `"moved"`,
  `"ignitionOff"` or `"endOfRange"` and records why the run finished, which `splitIdle`
  cannot work out for itself.
- `splitIdle(days, trips)` attributes minutes **by overlap**, so a run straddling a trip
  boundary is divided rather than assigned whole. Except a run with
  `endedBy === "ignitionOff"`, which goes wholly to stopped: `Trip.stop` lags the real
  halt by 1 to 50 seconds, so overlap alone calls arrival idling traffic. See the
  `Trip.stop` note above. `"endOfRange"` stays on plain overlap as the neutral choice.
- Rows are tagged by whichever side holds most of their run, not per row. Tagging per row
  would flip the last row of a stop to the in-traffic colour, because an `Idling end`
  lands exactly on the departure and so falls inside the trip that just started. One run
  changing colour part way down the table looks like a fault.
- With no trips the split is left `undefined`, not zero, so the UI hides the line instead
  of asserting a false 0.

Verified by `.diag/split-test.js`, 24 assertions, at all four detail levels: distance
429.71 km and idle 56.20 min unchanged, stopped 38.46, mid-journey 17.75, halves summing
to the total. `engine-harness.js` row counts identical at every level. `retry-test.js`
still 37/37.

**Colour choice is a constraint, not a preference. Bjorn is colour blind.** The two kinds
of idling use `#0072B2` blue and `#E69F00` orange, the Okabe-Ito colour-blind safe pair.
They separate on the blue-yellow axis rather than the red-green one, so they stay distinct
under the common forms. Neither is red or green: idling in traffic is not the driver's
fault and must not be coloured as a fault. Note `--warning` amber was already the idle dot
colour, so do not reintroduce amber here or the two meanings collide.

**Colour is never the only channel.** Stopped is a solid disc, mid-journey is a ring
(`box-shadow: inset 0 0 0 3px`). The wording in the insight line states the split outright,
and the PDF export prints it as plain italic text with no colour at all, because these get
printed in black and white. If you touch this, keep the redundancy.

**Tooling.** `.diag/idle-compare.js` needs `bA_trips.json` alongside the log and
ignition pulls:

```
cli-mygeotab trip list --device-id bA --from 2026-08-17T23:00:00Z --to 2026-08-18T23:00:00Z -o json --quiet
```

PowerShell's `Out-File -Encoding utf8` writes a BOM on 5.1 and `JSON.parse` rejects it;
the loader strips it. `.diag/load-app.js` can override any top-level `var NAME = value`
constant in app.js before evaluating, which is how the sweep tests alternative
thresholds against the real engine instead of a reimplementation that might disagree.

Note when reading rows in a diagnostic: rows carry `t` (ISO) but **not** `ms`.
`reduceRows` adds `ms`, and at the `all` level it returns early, so parse `t` yourself.
Reading `r.ms` there silently yields NaN, every comparison goes false, and the script
reports zeroes that look like a finding.

### A failed fetch rendered as "0 km" (v1.7.3, actually fixed in v1.7.4)

**Symptom.** 171 WX 2519 SPARE, 18 Aug 2026: the report showed one row (an
`Ignition off` at 18:36:07 BST), `0 km`, `1 event`, `0m idling`. Trips History for the
same device and day showed 430 km, 6h20 driving, 16 stops, 43 exceptions.

**What was checked, against live ILLE01 (device id `bA`).** All of this is measured,
not inferred:

- `LogRecord` for the local day returns **3,957 records**, 2 of them boundary records,
  none missing coordinates. The data exists.
- `StatusData` on `DiagnosticIgnitionId` returns **31 records**: an opening boundary
  at `data=0` and 30 real transitions, first on at 06:38:22Z, last off at 17:36:07Z.
  That last record is exactly the single row the report displayed.
- Running the **real `buildActivity`** over those two pulls produces
  **429.71 km** against Trips History's 430 km, 15 ignition cycles, and 480 rows on
  Balanced. The engine is correct.
- A sweep of seven candidate search windows (local day, UTC day, next day, and four
  truncated windows) produces either the full 480 rows or zero rows. **No window
  reproduces the observed one-row output.** `tzInstant` builds the window correctly
  for Europe/Dublin.

**Cause.** `fetchLogRecords` had `function () { cb([]); }` as its error handler. An
API failure returned the same empty array as a genuinely idle vehicle, with no
warning. The empty array flowed through the engine, the ignition transition borrowed
its position from a boundary record, and the vehicle rendered as a confident `0 km`.

The exact trigger for the failed call is **not** established — it was transient and
did not reproduce. What is established is the code path that turns any such failure
into a plausible-looking wrong number.

**Fix, part one (v1.7.3): stop lying.** `cb(null)` means the fetch failed, `cb([])`
means it succeeded and found nothing. The two are now distinct, the split path
propagates `null` rather than concatenating half a window, and `runReport` skips a
failed vehicle instead of rendering it. A second guard covers a vehicle that returns
ignition activity but no real GPS logs, which also produces defensible-looking zeroes
from nothing.

**This part is not a fix and must not be recorded as one.** It converts a wrong number
into a missing vehicle. Better, but a van that crossed Ireland is still absent from a
report you would hand to a customer. That was the gap in the v1.7.3 write-up and Bjorn
caught it: *"that doesn't fix anything."*

**Fix, part two (v1.7.4): don't accept the first failure.** `apiCall` now retries with
1 s, 3 s and 9 s backoff, so every request in the add-in gets four attempts across 13
seconds before anything is declared unreadable. This is where the actual repair lives.
The failures that cost the vehicle here (a timeout, a 502, the rate limiter) all
succeed on a second attempt moments later.

Deliberately **not** retried: anything the server understood and rejected. A bad
parameter, an expired session or a malformed request fails identically forever, so
repeating it only makes the operator wait longer for the same answer. `OverLimit` is
the exception among 4xx, because it means "later", not "no". See `isRetryable`.

**Fix, part three (v1.7.4): make the hole impossible to miss.** A vehicle that fails
all four attempts is no longer a note in the collapsed panel. `addFailure` puts it in
`#val-failed`: red, always open, above the results, naming every affected vehicle, and
saying in as many words that this is not a sign they were parked. Notes and holes are
different classes of thing and must not share a container.

**Rule this establishes: never let a fetch failure reach the renderer as data, and
never let one failed attempt end a fetch.** Silence is the worst outcome, an absence is
the second worst, and only the retry actually avoids both. A vehicle reporting 0 km
when it drove 430 is unrecoverable because nobody has a reason to question it.

**Investigating the failed call (what was tried, what is left).**

Ruled out by measurement, on 19 Aug 2026 against live ILLE01:

- **The query is not fragile.** The exact failing Get, 30 times in series: 30 clean,
  averaging 639 ms, slowest 1.7 s. No failures.
- **It is not rate limiting at this scale.** The same Get, 12 at once: 12 clean, slowest
  943 ms. A single-vehicle day is nowhere near the limit.

Neither test can reach the real suspect, and that is the useful conclusion. The CLI
speaks to `my.geotab.com` over its own HTTP client. The add-in goes through the `api`
object MyGeotab injects into the page, carrying the page's session. Anything living in
that layer — a session expiring mid-run, a federation failover, the browser dropping a
request, an extension or proxy interfering — is invisible from outside the browser.
More CLI probing will not find it.

So the remaining hypotheses, and what now distinguishes them, all from the copied
diagnostics:

| Hypothesis | What the log will show |
|---|---|
| Session expired mid-run | `InvalidUserException` / "Invalid session"; now retried, so the SDK re-auths |
| Database moved in the federation | `DbUnavailableException`; now retried |
| Rate limiter on a large group run | `OverLimitException`; now retried, and the timestamps show the burst |
| Browser dropped the request | An `Error` with a network message and no Geotab type |
| Something else entirely | Whatever `describeError` captured, which is the point |

**The instrumentation is the investigation.** `recordApiFailure` logs every failed
attempt, retried or not, with method, typeName, device id, the search window, the
attempt number and a full unpacking of the error. `describeError` exists because
`JSON.stringify(new Error("boom"))` is `"{}"` — Error properties are non-enumerable, so
the naive approach records nothing. It also handles a non-Error, since the shape the
injected `api` object passes its failure callback is not documented.

The operator copies it out of the red block as plain text. A pasted log beats a
reproduction attempt for something this rare.

**Note on `isRetryable`, because the first version had it backwards.** Session and
federation errors are retried on purpose. Geotab's guidance is that
`DbUnavailableException` means the database moved servers in the federation and that
the API object makes a single re-authentication attempt when it or
`InvalidUserException` comes back. Retrying is what gives it the chance. Only
request-shape errors (`ArgumentException`, `MissingMethod`, a bad parameter) are fatal,
because those fail identically forever. Default is retry.

**Tests.** `.diag/retry-test.js` runs the real `apiCall` against a fake `api.call` that
fails a set number of times: 37 assertions covering the retry count, the ~13 s total
backoff, what is and is not retried, error unpacking, and the copied text. It caught
the `DbUnavailableException` mistake above. Run it after touching `apiCall`,
`isRetryable` or `describeError`. `.diag/load-app.js` holds the shared vm loader.

**Harness.** `.diag/engine-harness.js` runs the real `buildActivity` from `src/app.js`
against JSON pulled from a live database, with no browser and no MyGeotab session. It
loads app.js as text, injects an export just before the IIFE closes, and evaluates it
against a stub window/document — app.js is not modified on disk. `.diag/window-sweep.js`
builds on it to test candidate search windows, emulating the boundary records MyGeotab
manufactures at each end. Pull inputs with:

```
cli-mygeotab log record --device-id bA --from 2026-08-17T23:00:00Z --to 2026-08-18T23:00:00Z --limit 60000 -o json --quiet
cli-mygeotab log status --device-id bA --diagnostic-id DiagnosticIgnitionId --from ... --to ... -o json --quiet
node .diag/engine-harness.js logs.json ign.json <fromIso> <toIso>
```

Use this before theorising about engine behaviour again. Reasoning from the source is
what produced three wrong hypotheses here before the harness settled it in one run.

**Note on the CLI's `speedKph` field: it is wrong.** `log record` emits both `speed`
and `speedKph`, and `speedKph` is `speed * 3.6`, which turns a 90 km/h motorway run
into 324. `LogRecord.speed` is already km/h. Use `speed`, ignore `speedKph`.

**Open, and now measurable: idling is roughly double.** The engine reports 56.2 min
for this device-day; Trips History reports 00:26:34. Same data, same day. This is the
over-count the sub-1 km/h threshold was always suspected of causing, and it is now
reproducible offline through the harness rather than needing a live run. Size and fix
it before showing idling to a customer.

### Idle runs are coalesced across GPS jitter (v1.7.2)

**Symptom after v1.7.1.** 45 rows shown of 448, zero idling rows, and a 2-minute
idling total. Every individual idle on that day was under 45 seconds, so the whole
total was made of fragments.

**Cause, and it was the real one.** A stop was ending the first time GPS reported
1 km/h. A stationary vehicle reads 0.4, 1.3, 0.6, 1.1 as the fix wanders, so one
90-second wait at a light was recorded as four stops with three departures between
them. No duration threshold can rescue that: the fragments are short because the
stop was chopped up, not because the vehicle was moving.

**Fix.** When speed rises the idle is held open and its rows are buffered rather
than emitted. The stop ends only once the vehicle covers `IDLE_RESUME_KM` (50 m) or
stays above the threshold for `IDLE_RESUME_MS` (30 s). Distance does the work: a
real departure clears 50 m in seconds, a wandering fix at a standstill never does.
Time is the backstop for genuine creeping.

Three states, in `buildDays`: `openPending` (speed rose, decision deferred),
`confirmPending` (vehicle left — first buffered point becomes `Idling end`, the rest
become `Moving`, exactly what the old code emitted for a clean departure), and
`cancelPending` (it was noise — buffered points become `Idling` rows and
`idleStartMs` is untouched, so the stop stays one run). Pending is also confirmed on
ignition off and at the end of the log stream, and reset in `startDay` alongside
`inIdle`.

**This changes the idling total, deliberately and upward.** The old total summed the
fragments and lost the gaps between them. The new one counts a coalesced stop end to
end, which is what actually happened. Expect the day figure to rise slightly. It is
still detail-level independent.

**Thresholds revised** now that runs are whole: Balanced 45 s (a typical red-light
wait, since a signal cycle is 60-120 s and one approach holds red for a third to a
half of it), Key events 120 s (the bad wait at a large junction, so only stops longer
than any red light reach that view). Detailed and Every GPS log unchanged.

If a day still shows no idling rows after this, that is now a finding rather than an
artefact: switch to Every GPS log and read what the total is actually made of before
touching the thresholds again.

### Short idling is hidden, not uncounted (v1.7.1)

**Symptom.** On Balanced detail the table filled with `Idling start` / `Idling end`
pairs one to five seconds long, several per minute, at addresses walking pace apart
(10 Glebe Manor, 12 Glebe Manor, 1-9 Glebe Rd). Not stop-and-go at a light: a vehicle
manoeuvring out of a residential street.

**Cause.** `IDLE_SPEED_KMH = 1` is the only test for idling, with no duration floor,
and status-change rows bypass `minGapMs`. So every dip below 1 km/h — a junction, a
speed bump, GPS noise at walking pace — produced two rows that no detail level could
suppress.

**Fix.** A `minIdleMs` per detail level: 3 minutes on Key events, 1 minute on Balanced,
0 on Detailed, and no reduction at all on Every GPS log. Applied in `reduceRows`,
which marks the whole run (`Idling start`, intervening `Idling`, closing `Idling end`)
with `drop` and skips it before the status-change and first/last-row exemptions. The
run is dropped whole or not at all; keeping the end without the start would show an
idle that never began.

**The property that matters: the idling total does not move.** `reduceRows` runs after
the engine and after `day.idleMins` is totalled, so this rule only chooses rows. The
same vehicle-day reports the same idling figure at every detail level. Do not push
this threshold down into the engine. The moment the total depends on which dropdown
the operator picked, the number is unusable in front of a customer.

Consequence, deliberate: on Balanced the listed idle events no longer sum to the
vehicle's idling total. Distance already behaves this way and the notice says so
outright ("still calculated from every GPS log, including any idling too short to be
listed").

**The values are provisional.** 60s and 180s exclude the observed 1-5s blips and keep
a normal red-light stop, but they are a judgement, not a measurement. Pending ILLE01:
run the native Idling report for one vehicle-day and compare. If MyGeotab applies its
own minimum idle duration, match it. The SDK explorer could not answer this — `Trip`
is not in the object list and `search idling` returns only `FuelAndEnergyUsed` and
`FuelUsed` — so the empirical comparison is the only route.

Separately still open: the *total* is inflated by the same phantom idles, since every
sub-1 km/h dip contributes its seconds. That is a counting question, not a display
one, and it is what the ILLE01 comparison will size.

### Fleet summary removed, notice collapsed (v1.7.0)

**The five summary cards are gone.** Do not add them back without a reason that
answers the objection below. They totalled vehicles, days, distance, idling and
events across every vehicle in the run. Four problems, in order of weight:

1. The per-vehicle line above each table already carries the same measures scoped
   to the vehicle it describes (`1 day · 106 events · 30.83 km · 5m idling`).
   The cards restated them summed across unrelated vehicles, so the reader had to
   work out which figure applied to what they were looking at.
2. Fleet-wide aggregation is a Smart Insights question. This report answers
   per-vehicle, per-day, per-event.
3. Screen only. Neither the PDF nor the CSV contained it, so nothing in it could
   be cited from the document the customer actually circulates.
4. It was not in the report this one recreates.

`.summary-card` and `.report-summary` stay in `styles.css`, unchanged and still
used by legacy-trip-report and smart-insights. Only this report stopped using them.

**The notice panel is now a collapsed `<details>` titled "Report Information".**
On a normal run its only entry is the row-emission explanation, which is worth
reading once rather than on every run. Same yellow frame and colours, so it still
signals "look at this", but closed it is one line. The header carries a note count
so a run that produced a real warning (missing ignition data, a truncated fetch)
looks different from a routine one without being opened.

Two details that are load-bearing:

- The default disclosure marker is hidden (`list-style: none` for Firefox,
  `::-webkit-details-marker` for Chrome and Edge) and replaced with a CSS triangle
  on `summary::before`. The native marker cannot be positioned consistently across
  browsers.
- `open` is reset to `false` exactly once per run, where `S.warnings` is cleared.
  `renderWarnings` never touches it, because the browser preserves the attribute
  across an `innerHTML` change and a panel the operator opened mid-run should stay
  open as later warnings arrive.

### Summary cards must not reflow (v1.6.3)

The stripe fix above was real but it was not the reported problem. The actual
complaint was cards appearing to run into each other, with the right-hand edge
missing on every card except the last.

The container was `repeat(auto-fill, minmax(150px, 1fr))`. `auto-fill` recounts
how many 150px tracks fit whenever the container's CSS-pixel width changes.
Browser zoom changes exactly that, so zooming in stretched the columns and then
wrapped them to a second row. Confirmed by the symptom: gaps widened with zoom
and the cards eventually staggered vertically.

Now `grid-auto-flow: column` with `grid-auto-columns: 1fr`. That pins the column
count to the number of cards rendered, so the block is a fixed frame and zoom
scales it rather than re-laying it out. Chosen over `repeat(5, 1fr)` because the
same rule is shared by three reports that do not all render five cards. Verified
by rendering at 100%, 175% and 250%: one row throughout, no wrap.

Trade-off accepted deliberately: the cards no longer wrap on a narrow container,
so at small widths they compress instead of stacking. That is what was asked for.

**Still open.** The missing right-hand border did not reproduce in headless
Chrome at 100/125/150% scaling or at any of the zoom levels above. The working
theory is device-pixel snapping: a 1px border on a fractional track boundary can
round to zero device pixels, which fits the border reappearing at 175% zoom where
it covers nearly two. Equal fixed columns land on cleaner boundaries than
auto-fill tracks did, so this change may resolve it as a side effect. If it does
not, the fix is to draw the frame as `box-shadow: 0 0 0 1px var(--border)`, which
antialiases instead of snapping. Do not try that until the grid change has been
checked on the affected machine.

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
2. Fetch `StatusData` with `diagnosticSearch: { id: "DiagnosticIgnitionId" }`,
   over exactly the reporting window. Ignition status is only written on state
   change, so the state at the start of the range would be unknown, except that
   MyGeotab returns a boundary record at each end of the window carrying the
   state at that instant. That record seeds the starting state and is never
   emitted as a row. See the v1.6.0 section.
3. Collapse the ignition records into on/off transitions, then merge them with
   the logs into one time-ordered stream and walk it:
   - An **Ignition on** / **Ignition off** row keeps the transition's own
     timestamp and borrows only a position from the nearest log in time.
   - With the ignition on, a log below 1 km/h is idling. The first of a run is
     **Idling start**, the rest are **Idling**, and the log where speed reaches
     1 km/h (or ignition drops) is **Idling end**, carrying
     `Idling time: [3m 08s]`.
   - Any other log with the ignition on is **Moving**.
   - An ignition-off closes any open idle run first. Logs recorded while the
     ignition is off produce no rows.
4. Daily distance is a running cumulative haversine between consecutive logs,
   reset at local midnight. Segments where both endpoints are below 1 km/h are
   skipped so GPS jitter at a standstill does not inflate the total. Boundary
   records do count here, which is what anchors a day's distance at midnight
   rather than at the first log after it. The day total is closed on the running
   figure, not on the last row, because the last row can precede the day's last
   GPS log.
5. Speed shows `--` below 1 km/h, matching the reference.
6. Days are bucketed by calendar day in the **MyGeotab user's** timezone
   (`localDayKey`), not UTC and not the browser's. See the timezone section.

`IDLE_SPEED_KMH = 1` matches Geotab's own definition of idling: speed below
1 km/h with the ignition on.

## Which rows get written (v1.3.0)

Geotab devices log every 10 to 60 seconds. The customer's reference report sits
around 1 to 3 minutes apart, so one row per GPS log is denser than the thing being
replicated.

v1.2.0 solved that with a fixed interval picker. **v1.3.0 replaced it**, because a
fixed interval makes the user tune a number they have no basis for choosing and
produces rows that carry no information: three identical `Moving` rows on a
motorway, one row for a slow crawl through a town.

Rows are now written **when something changes**. `reduceRows()` walks the day and
keeps a row only when it says something the previous kept row did not.

| Trigger | Balanced default | Cost |
|---|---|---|
| Any status change | always, ignores the floor | free |
| Distance travelled since the last row | 1.5 km | free, already computed |
| Absolute change in spot speed | 20 km/h | free |
| Change in direction of travel | 45 degrees | free, bearing from consecutive coordinates |
| Ceiling: nothing changed for | 5 minutes | free |
| Floor: never two rows closer than | 30 seconds | free |

Presets in the toolbar: **Key changes only** (5 km / 30 km/h / 90 deg / 15 min /
60 s), **Balanced detail** (the default, above), **High detail** (0.5 km / 10 km/h
/ 30 deg / 2 min / 15 s), and **Every GPS log**, which skips the reduction.

### Why these triggers and not the obvious ones

**Distance, not time.** In the customer's reference screenshot the daily distance
runs 0, 0.95, 2.49, 4.02: deltas of roughly 0.95, 1.54, 1.53 km while the time gaps
vary from 1 to 3 minutes. Near-constant distance with varying time is a distance
trigger. A clock would give the opposite. Small sample, but it is the only evidence
available until the customer's full export arrives, and that is the single check
worth running on it: are the distance deltas near-constant, or the time deltas?

**Absolute speed change, not a percentage.** 20% of 2 km/h is 0.4 km/h, which is
inside GPS speed noise, so a relative threshold fires nonstop at low speed. At the
other end, 90 to 108 km/h is 20% and means nothing. An absolute km/h delta behaves
the same at both ends.

**Heading change instead of street name.** A street-name trigger sounds right and is
the one genuinely expensive idea here, for three reasons:

- It inverts the pipeline. You cannot know the street changed without reverse
  geocoding **every** log before deciding what to keep. A vehicle logging every
  20 seconds over an 8-hour shift is about 1,500 points; at the old 1-minute
  sampling roughly 480 were geocoded. That is around 3x the `GetAddresses` volume,
  and `GEOCODE_MAX_PTS` would be reached after 4 to 8 vehicle-days instead of 25.
- The signal is noisy. `GetAddresses` snaps a coordinate to a nearby segment, and
  near junctions or parallel service roads that snap flips between two names for a
  stationary vehicle, producing phantom rows.
- It is wrong in both directions at once. An hour on a motorway is one street name,
  so one row for an hour. A town centre gives a new street every 15 seconds, denser
  than logging every fix.

There is also direct evidence against it: the reference report repeats the same
location across consecutive rows, which it could not do if street change were a
trigger.

Heading change is the cheap, deterministic stand-in. It is computed from consecutive
coordinates, so it costs nothing, and a 45-degree turn is what "we are on a
different street" actually looks like in the data. Bearings are only computed when
the vehicle moved at least 20 m between logs, since a bearing over a few metres is
noise, and the trigger is ignored below 1 km/h.

### What is preserved

`reduceRows()` runs at the end of `buildActivity`, after the status engine and after
the day total is taken. What that ordering buys:

- **Distance still accumulates over every log.** The Daily distance column is the
  cumulative value at that row, so dropping intermediate rows leaves the numbers
  correct and still ending on the day total.
- **Idling is still measured start to end**, not between surviving rows.
- **Every status change survives.** Only `Moving` and `Idling` continuation rows
  are candidates for dropping. Ignition on, Ignition off, Idling start and Idling
  end are always kept, as are the first and last rows of the day.

Reduction also happens **before** geocoding, so it cuts `GetAddresses` volume by
roughly the same factor it cuts rows. This is exactly the ordering a street-name
trigger would destroy.

Nothing is hidden silently. Three things say so on screen:

- a notice above the table spells out the active thresholds in plain words
- a reduced day's total line reads `42 of 310 logs` rather than `42 events`
- **every row carries a `why`**, shown as a tooltip on its time cell: "Shown
  because: travelled 1.5 km". That is what makes an uneven row count explainable,
  which is the one real cost of event-driven emission over a fixed interval.

## Known limits and things to verify

- **Ignition off rows are unverified.** The customer's reference screenshot is
  truncated before any appear, so the exact label and placement need confirming
  against their full export.
- **Distance is GPS-derived**, so a day total can drift slightly from Geotab's
  odometer-based `Trip.Distance`. If the customer needs the two to agree, scale
  the day's haversine total to the summed `Trip.Distance` for that day.
- **Replay links** use the `devices` grammar confirmed from a hand-made URL in
  v1.1.3. See below for the format and how four earlier versions got it wrong.
- **Fallback when there is no ignition data.** If a vehicle returns no ignition
  records, the engine treats the ignition as on for the whole range and derives
  idling from GPS speed alone. A visible warning says so, because those totals
  will not match the native Idling report.

## Trip History link

### What it is called, and why (v1.6.1)

The customer's reference export heads this column `REPLAY`. It is **Trip History**
here instead. Renamed on the colleague's call, and the reasoning is worth keeping:

- Geotab's own page is **Trips History**, plural, because it lists many trips.
  The button is scoped to the one trip containing the clicked row, so the label
  is deliberately singular. It is not a typo, and it should not be "corrected"
  to match the menu.
- A user who clicks "Replay" and later wants that page again has no word to
  search the Geotab menu for. "Trip History" gets them there.

Against that, "Replay" was accurate about the landing state, since the URL sets
`isReplayPlayerHidden:!f` and the playback control does open. That is now carried
by the tooltip rather than the label.

Changed in four user-facing places: the on-screen column and link text, the CSV
header, and the PDF header and cell. The internal names (`replayUrl`,
`.val-replay`, `REPLAY_PAD_MS`) were left alone, because they describe the
mechanism, which is still the replay player, and renaming them would be churn
across the one part of this file that took four versions to get right.

The cell text reads `Trip History`, in the same case as its column header, not
the all-caps `REPLAY` the reference export uses. The `.4px` tracking on
`.val-replay` went with it: that was there to open up the capitals and only
loosens mixed case.

PDF column 7 went from 16 mm to 21 mm. `Trip History` at 7.5pt bold measures
14.9 mm, so 18.1 mm is the true minimum with the 1.6 mm padding either side;
21 mm is deliberate slack, because `overflow: "linebreak"` means a cell 1 mm too
narrow wraps at the space and makes **every** row in the table taller. Every
other column is fixed, so those 5 mm come out of Location, the only auto-sized
column, which had roughly 101 mm for a single address line.

**Flag this difference** during the side-by-side against the customer's export.
It is the only column whose header does not match.

### Building the URL

**Do not use the SDK guide for this.** The examples in
[Using MyGeotab URLs](https://developers.geotab.com/myGeotab/guides/myGeotabUrls/)
date from 2015, Geotab simplified MyGeotab URLs in 2022, and the guide was never
updated. `entityType` and `selectedEntities` are dead names. Building from the
documentation cost four broken versions.

The grammar below is ground truth: a URL copied out of the address bar after
selecting one vehicle and a custom date range by hand in `demo_smb_onboarding_uk`.

```
#tripsHistory,
dateRange:(endDate:'2026-08-18T22:59:59.000Z',label:Custom,startDate:'2026-08-17T23:00:00.000Z'),
devices:!(bC),
expandedCardIds:!('bC_UnknownDriverId_Tue+Aug+18'),
isReplayPlayerHidden:!f,
mapBounds:!(42.36028,-8.31496,41.7536,-9.18288),
routes:(bC:!((start:'2026-08-18T02:46:00.700Z',stop:'2026-08-18T02:51:47.700Z'),…))
```

| Parameter | What it does | Generated? |
|---|---|---|
| `devices` | **The vehicle filter.** A rison list of bare device ids. | Yes |
| `routes` | Map of device id to segments to draw. Does **not** select the vehicle. MyGeotab fills it with every trip in the range; the add-in sends exactly one, since the point is the moment in the row. | Yes, one segment |
| `isReplayPlayerHidden:!f` | Rison `!f` is false, so the replay player opens. Without it the page draws a static route. | Yes |
| `dateRange` | Scopes the trip list. `label:Custom` goes with an explicit start and end. | Yes, row's local day |
| `expandedCardIds` | Opens the matching trip card in the side list. `<deviceId>_<driverId>_<Ddd+Mmm+D>`, spaces as `+`. | Yes, when a trip matched |
| `mapBounds` | Viewport only. | No, so the map fits the route |

Keys are emitted alphabetically, matching MyGeotab's own serialisation order.

### Why Trip is fetched

`routes` needs a segment's exact start and stop. A row carries a single
timestamp, so v1.1.0 added one `Get` on `Trip` per vehicle and binary-searches for
the trip containing each row's timestamp. Used **only** for the Replay link;
nothing in the report body depends on it.

Verified against the ground-truth URL: for device `bC` on 18 Aug the add-in
selected `02:46:00.700Z` to `02:51:47.700Z`, identical to MyGeotab's own first
segment. The trip matching is correct.

Rows with no containing trip (idling with the ignition on between trips) fall
back to the timestamp plus or minus 15 minutes (`REPLAY_PAD_MS`). Whether the
page accepts an arbitrary window rather than real trip boundaries is untested.

### Trip History links in the exports (v1.2.0)

Both exports carry the link.

**PDF.** A Replay column, blue and bold, with a real PDF link annotation over each
cell. A link in a PDF is a rectangle annotation rather than styled text, so it can
only be drawn once the cell's final page position is known. That happens in
autoTable's `didDrawCell`, against a per-table `pdfUrls` array, since
`data.row.index` is table-relative and this report emits one table per day.

**CSV.** A `Replay` column holding the raw URL. Excel and Sheets both linkify it.

### How this went wrong, so it does not repeat

Four versions failed before one capture from the address bar settled it:

| Version | Theory | Reality |
|---|---|---|
| v1.0.0–v1.0.2 | Documented `selectedEntities` grammar, wrong quoting, then host resolution | Never emitted a complete URL; nothing was actually under test |
| v1.1.0 | Docs are stale, `routes` replaces the vehicle filter | `routes` does not select the vehicle |
| v1.1.1 | `esc()` truncated every href at the first apostrophe | Correct, and the real defect all along |
| v1.1.2 | Restore `entityType` / `selectedEntities` alongside `routes` | Both names are dead |
| v1.1.3 | `devices:!(id)`, from a hand-made URL | Ground truth |

The lesson is cheap to state: for MyGeotab URL grammar, one address-bar capture
beats any amount of documentation and reasoning. Ask for it first.

### The apostrophe bug (v1.1.1)

The actual reason Trips History opened blank in every version up to and including
v1.1.0 was not the URL grammar. It was `esc()`, which escaped `"` but not `'`,
while every attribute in `app.js` is written with **single-quoted** delimiters:

```js
"<a href='" + esc(url) + "' target='_blank' …"
```

Rison quotes its date values with apostrophes, so the browser closed the `href`
attribute at the first one and every Replay link was truncated to:

```
…/#tripsHistory,dateRange:(endDate:
```

`esc()` now escapes `'` as `&#39;`. It is HTML-only and is not used by the CSV or
PDF export, so nothing else is affected.

This bug also masked the grammar problem: no version before v1.1.1 ever emitted a
complete URL, so nothing about the parameters was ever really under test.

### Unverified in this format

- **`expandedCardIds` day number is not zero-padded** (`Aug+8`, not `Aug+08`).
  The one real sample has a two-digit day so it does not settle the question. If
  it is wrong the card just does not expand; the route and replay still work.
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

## Timezone and time format (fixed in v1.4.0)

**All times are 24-hour, in the MyGeotab user's own timezone.**

### The bug this replaced

Up to v1.3.0 days were bucketed by the **browser's** timezone via
`Date.getFullYear()` / `getMonth()` / `getDate()`, and times were rendered with
`toLocaleTimeString`, which follows the browser locale and gives AM/PM on a US
machine. Both were wrong whenever the operator is not sitting in the database's
timezone, and the day-boundary failure was silent: wrong day splits and a daily
distance that reset at the wrong moment.

It was live, not theoretical. The real Trips History URL for a UK database shows
`startDate:'2026-08-18T23:00:00.000Z'` for "Today", so that database is on UTC+1
while the browser running the report was on UTC+2.

### How it works now

`User.timeZoneId` is read from the session user. The SDK describes it as "The IANA
Timezone Id of the user. All data will be displayed in this Timezone", which is
exactly the contract this report needs, and an IANA id is what `Intl` wants.

| Helper | Purpose |
|---|---|
| `setTimeZone(id, via)` | Sets the zone and drops the cached formatter |
| `tzParts(iso)` | Wall-clock y/mo/d/h/mi/s/dow of an instant, in that zone |
| `tzOffsetMs(utcMs)` | How far ahead of UTC the zone is at that instant |
| `tzInstant(y,mo,d,h,mi,s)` | The UTC instant of a wall-clock time in that zone |

`tzInstant` resolves the offset **twice**, because the offset at the guessed
instant can differ from the offset at the real one across a DST change. Verified
against Europe/London: 25 Oct 2026 is a 25-hour day and both its boundaries come
out right, as do the 18 Aug boundaries in the ground-truth Replay URL
(`2026-08-17T23:00:00.000Z` to `2026-08-18T22:59:59.000Z`).

Four things depend on this, all of which were wrong before:

- `localDayKey` — which day a row belongs to, and where daily distance resets
- `fmtTime` — now `pad2(h):pad2(mi):pad2(s)`, always 24-hour, never locale-driven
- `replayUrl` — the `dateRange` day boundaries, built with `tzInstant`
- `cardDatePart` — `expandedCardIds` uses the trip's start day in the user's zone

The API query window in `runReport` uses `tzInstant` too. The date pickers mean
days in the user's timezone, so the window has to be anchored there rather than at
the browser's midnight.

### When it cannot be read

`S.tzId` empty means no profile timezone was available, and everything falls back
to the browser exactly as before. That is not silent: a notice says so and warns
that day boundaries may be wrong. An unrecognised zone id is caught on the first
formatter build rather than throwing on every row.

The diagnostic strip above the results always states the active zone and where it
came from, next to the Replay host.

### Still browser-dependent, deliberately

`fmtDayReadable` builds a weekday from `new Date(y, m-1, d)`. That is a bare
calendar date with no instant attached, so the browser's zone cannot shift it.

## Units, metric or imperial (added in v1.5.0)

`User.isMetric` is read from the profile in the same `Get` that reads
`timeZoneId`, so both regional settings cost one call. SDK type is Boolean and
the SDK default is `true`. Description: "Whether the current regional settings is
in metric units of measurement (or US/Imperial)."

The rule that keeps this from going wrong:

**Everything inside `app.js` is metric.** `LogRecord.Speed` is km/h no matter who
is logged in, and every distance is haversine kilometres. Imperial is a display
conversion applied at the last possible moment, in `fmtDist` and `fmtSpeed`.
Convert any earlier and the idling threshold, the change triggers and the data
start disagreeing with each other.

| Helper | Does |
|---|---|
| `distUnit()` / `speedUnit()` | `"km"`/`"km/h"` or `"mi"`/`"mph"` |
| `toDist(km)` / `toSpeed(kmh)` | Numeric conversion only, no label |
| `fmtDist(km)` / `fmtSpeed(kmh)` | The only two places a unit label is produced |

`IDLE_SPEED_KMH` stays 1 km/h in both systems, because it is Geotab's own
definition of idling, not a user-facing figure.

### Why `DETAIL_LEVELS` carries two threshold pairs

Each level holds a `metric` and an `imperial` pair rather than one pair that gets
converted. Converting 1.5 km would print "0.9 mi" in an imperial notice, which
reads like a rounding artefact rather than a chosen setting. The imperial numbers
are round numbers picked to sit near their metric siblings, not derived from
them. `activeRules(key)` resolves a level into metric comparison values
(`distKm`, `speedKmh`, used by `reduceRows`) plus display labels (`distLabel`,
`speedLabel`, used by `describeRules`). Nothing should read `DETAIL_LEVELS`
directly.

`S.rules` is set in `runReport`, not at load, so the thresholds always match
whichever unit system the profile read settled on.

### When the read fails

`S.isMetric` defaults to `true` and `S.unitsVia` stays empty, which triggers a
notice saying units could not be read and metric is being shown. The profile
value is only accepted when it is explicitly `true` or `false`, so an absent
field cannot silently flip a metric database into miles. The diagnostic strip
above the results names the active units alongside the timezone and Replay host.

## Boundary records, and why ignition events keep their own time (v1.6.0)

### The bug

A report showed a block of 70 to 105 rows, all alternating Ignition off / on,
all stamped `00:00:00`, all on identical coordinates, all `0 km`. It looked like
noise from testbot data. It was not: it reproduced on a real vehicle in ILLE01.

Two causes, both confirmed against raw API pulls rather than by reading code.

### Cause 1: MyGeotab returns synthetic boundary records

A `Get` on `LogRecord` or `StatusData` with a `fromDate`/`toDate` returns a
manufactured record at **each end** of the window, carrying the state or
position at that exact instant so a map can draw a continuous line to the edge.

**They have no `id` and no `version`.** Real records have both. That is the only
reliable way to tell them apart. Do not test the timestamp against the window
edge: a genuine record can land on midnight.

Measured on ILLE01 device b19:

```
log status --from 2026-08-18 --to 2026-08-19        (no lookback at all)
  SYNTHETIC 2026-08-17T23:00:00.000Z data=0     <- exactly local midnight
  real      2026-08-18T05:46:11.433Z data=1
  ...
  SYNTHETIC 2026-08-18T23:00:00.000Z data=0

log record --from 2026-08-18
  SYNTHETIC 2026-08-17T23:00:00.000Z  54.67593,-5.94538  spd=0
  bDD99B    2026-08-17T23:22:58.758Z  54.67593,-5.94538  spd=0
```

Those coordinates are the ones that appeared on every junk row.

The rule the code now follows:

| Use | Boundary record | Why |
|---|---|---|
| Seed ignition state at window start | **Yes** | Exactly what it is for |
| Position / distance baseline | **Yes** | Real position; anchors the day at midnight |
| Emit a status row | **No** | Nothing happened at that instant |
| Count as an event | **No** | Inflates the total |

`pts[].boundary` is set from `!l.id`. Boundary points take part in distance
accumulation and then `continue` before any row is written.

Note that window splitting (`MAX_RECORDS`) creates a boundary record on each
side of every split point. They share an instant, so the dedupe key
`"boundary:" + dateTime` collapses them, and they are skipped as rows anyway.

### Consequence: the 24-hour lookback is gone

`fetchIgnition` used to query 24 h before `fromDate` to learn the starting
ignition state. That was the source of the junk rows, and it was never needed:
the opening boundary record states the answer at the exact instant, which is
strictly better than inferring it from the last change some hours earlier.

One less API call per vehicle, and 70 to 105 phantom rows per report that are
now never fetched rather than fetched and filtered.

### Cause 2: ignition events were pinned to log timestamps

Up to v1.5.0 the engine walked GPS logs and drained any ignition transitions it
had passed, stamping each with **the log's** timestamp and position. Three
failures fell out of that:

- Every transition before the first log landed on that one log. With the
  lookback in place that was a day's worth, all sharing one timestamp.
- Any transition after the last log of the day was silently dropped. Real case:
  on 18 Aug the last GPS log is 20:05 and the last ignition off is 21:22, so the
  day's final Ignition off never appeared.
- Every ignition row was shown at the wrong time, off by up to the logging
  interval, which is around 30 minutes on a parked vehicle.

`StatusData` carries its own `dateTime`. It carries no coordinates, which is the
only reason a log was ever involved.

**Now:** logs and transitions are merged into one time-ordered `stream`, and an
ignition row keeps its own timestamp while borrowing only a position from the
nearest log in time (`nearestPt`, binary search). On a tie the ignition change
sorts first, so an "on" precedes the moving row it enables and an "off"
suppresses the row at the same instant.

Day totals now close on the running `cumKm` rather than on the last row's
`distKm`, because the last row of a day can precede the day's last GPS log.

### Verified

`.diag/harness.js` runs the real `buildActivity` against raw ILLE01 pulls
(the folder is gitignored; re-pull with `cli-mygeotab log record` / `log status`).
Results for device b19, 18 to 19 Aug 2026:

```
rows stamped 00:00:00                : 0
duplicate time+status rows           : 0
rows at the screenshot's junk coords : 0
ignition rows sharing one timestamp  : NONE
rows in time order within each day   : true
last ignition row                    : 22:22:08 Ignition off   (was dropped)
```

Distance is identical across all detail levels (532.37 km over 17 to 18 Aug),
confirming the reduction rules never touched the totals. Against the original
screenshot's 412.28 km, the engine gives 401.81 km for 18 Aug plus the part of
19 Aug before the screenshot was taken, so distance was always right; only the
row count was inflated.

### On ignition bounce

Checked, and deliberately **not** filtered. Across 4 days of b19: 11 ignition-on
periods under 60 s and 6 off periods under 60 s, out of 280 transitions. Median
gap 6.8 minutes. Most short cycles are genuine (moving a van a few metres, a
stall and restart). Only one, a 7 s off inside a 41 s on, looks like real bounce.
A filter loose enough to catch it would delete genuine short trips. The event
counts are high because this vehicle really does cycle its ignition a lot.

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
- **Day boundaries.** Use a vehicle driving across midnight and confirm the day
  splits correctly and Daily Distance resets. The maths is unit-checked against
  Europe/London including the DST day, but the profile-timezone read itself is
  untested against a live session as of v1.5.0. The strip above the results names
  the active zone; confirm it matches the timezone on the MyGeotab profile.
- **Units.** Log in as a US/Imperial profile and confirm the strip says miles and
  mph, that every distance and speed on screen, in the CSV and in the PDF carries
  the same unit, and that the detail notice quotes the imperial thresholds. Then
  switch the profile to metric and confirm it flips on the next run.
- **No phantom rows (v1.6.0 regression).** On any vehicle and range, confirm no
  row is stamped at exactly local midnight with `0 km` and a repeated position,
  and that the ignition rows are all at distinct times. `.diag/harness.js` runs
  this against raw pulls without needing the add-in installed.
- **Last event of the day.** Pick a vehicle whose ignition goes off well after
  its last GPS log and confirm that Ignition off appears, at its own time.
- **Volume.** Run a group over a week; confirm the notices fire and the progress
  line moves rather than appearing to hang.
- **Trip History links.** Click three rows from different days and confirm each lands on the
  right vehicle in the right window.
- **Row triggers.** On Balanced, confirm the rows land roughly 1 to 3 minutes apart
  at road speed, and hover a few times to check the stated reason matches what the
  vehicle was doing. Untested against live data as of v1.3.0; the thresholds are
  reasoned from twelve rows of the customer's screenshot, not measured.
- **Side by side.** Put the output next to the customer's reference export and
  check column for column. While it is open, measure whether the distance deltas
  between their rows are near-constant or the time deltas are. That settles their
  actual rule and lets the defaults be set from data instead of inference.

## Hosting

Published to its own GitHub Pages site, separate from Smart Insights:

`https://bjornvandenwijngaert-tech.github.io/Activity-Detail/index.html`

That is the URL in `config.json`. `index.html` and the whole `src/` folder are
served from the repository root, so the relative paths in `index.html` work
unchanged.

Cache note: the asset links are versioned with `?v=1.6.2`. Bump that query
string in `index.html` whenever `app.js`, `activity.css` or `styles.css` change,
otherwise MyGeotab will keep serving the cached copy.

Still outstanding, unrelated to this add-in:

- `~/repos/legacy-trip-report` is not a git repository, so it has no route to
  publication, and its files show as deleted (unstaged) in the `smart-insights`
  working tree.

## Later

The intent is to fold this into Smart Insights as a tab. The IIFE and the single
`S` state object are what make that a copy-in rather than a rewrite.
