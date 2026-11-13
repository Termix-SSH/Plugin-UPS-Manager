UPS Manager shows the state of your UPS devices from Termix. It reads the battery charge, runtime left, load, voltage and temperature, keeps a history, and alerts you when something goes wrong with your power.

It works with three kinds of UPS: a UPS managed by NUT, a UPS managed by apcupsd, and a network card that speaks SNMP. Termix reads them over SSH, the same way the terminal does. Nothing is installed by this plugin.

## Set up a host

1. Pick the host that can reach the UPS. This is the machine running NUT or apcupsd, or any host on the same network as an SNMP card.
2. Open the host in Manage and turn on UPS Manager.
3. Save. Open the host's menu and pick UPS.
4. In Devices, press Add UPS and pick how to read it.

Reading never needs root. The SSH user only needs the UPS tools in its path.

## Development preview

Run `npm run pack:dev -- --out /path/to/packages` to test, type-check, build,
validate and package an isolated **UPS Manager dev**. The build uses a temporary
copy with ID `ups-dev-manager`, separate tables, settings, history, services and
operation IDs. It does not rename the upstream plugin in the working source.
Do not install the normal `npm run pack` output for side-by-side testing.

Enable Plugin developer mode in Termix and install the development `.tmxplug`
through Plugins, Install from file. The package is unsigned; do not attach the
official plugin's signature or bypass a server policy requiring signed plugins.
The official UPS Manager can remain installed with its data unchanged.

Enable **UPS Manager dev** separately for the chosen host and add a device in its
own **Devices** view. Sources and settings are not copied from the official
plugin. Use existing read-only SSH credentials, leave command credentials blank,
and disable development alerts to avoid duplicate notifications. Configure DC
calculation before enabling the development plugin's **UPS read only** setting,
which also blocks source edits. The normal plugin's settings remain unchanged.

Termix rejects `ups-manager-dev` because its table prefix overlaps the official
`ups-manager` namespace, so the preview deliberately uses `ups-dev-manager`.

Uninstall only `ups-dev-manager` to remove the preview. Its stored data is
independent of the official plugin; keep a Termix backup before testing.

## NUT

Install the NUT client (`nut-client` on Debian and Ubuntu) on the host. Add the device name that `upsc -l` lists, like `ups`. For a NUT server on another machine, use `ups@192.168.1.5:3493`.

To send commands, add a NUT user and password from `upsd.users` with the `instcmds` right. Termix passes them to `upscmd` on the host. They are visible in the process list there for a moment while the command runs. Reading never needs a login.

### Electrical telemetry

The Overview grid also shows available input, output and battery current in
amperes (A), and real input/output power in watts (W). Reported output power uses
`output.realpower`, falling back to `ups.realpower`; input power uses
`input.realpower`. Apparent power (VA) and nominal ratings are not substituted.
Missing measurements stay unavailable rather than becoming zero.

For a DC device, edit its entry in Devices and explicitly confirm **Input is DC**
and/or **Output is DC**. These options default off and do not write to the UPS.
Only the confirmed domain can calculate watts from its voltage and current in
the same poll, and reported real power takes precedence. Do not enable these
options for AC domains: voltage times current alone does not establish AC watts.

Calculated values are labelled **Calculated DC power - sensor accuracy
unverified**. For example, 20.54 V times 0.470 A is 9.6538 W, but a mathematically
correct result does not validate the current sensor. Cross-check readings before
relying on them. Output power is the UPS load, not AC wall consumption; it only
represents one host if that host is the sole powered load.

Battery chemistry, charge thresholds and driver/USB metadata appear as information
rows. A manufacturing-date placeholder such as `OPEN` is not shown as a date.
The collapsed **Advanced NUT variables** section filters variable names and values
and displays bounded, read-only diagnostics. Values such as `battery.capacity`
remain raw when their units are undocumented; they are not labelled as Ah.

The history view includes scheduled electrical observations, observed output
energy and measured coverage. Existing charge/runtime/voltage history is retained;
old voltage-only samples cannot be backfilled into watts or energy.

### Estimated UPS load

Live views prefer valid device-reported load, including zero and overload values.
If absent, NUT readings can use `output watts / rated real watts * 100`, labeled
**Estimated UPS load**. Reported output real watts take precedence; voltage times
current is used only after explicit output-DC confirmation. Sensor accuracy is
unverified. This percentage is UPS capacity utilization, not CPU utilization,
battery charge or AC wall consumption.

The denominator must be positive `ups.realpower.nominal` in watts. Apparent-power
capacity `ups.power.nominal` in VA is never treated as watts. For confirmed ratings,
NUT can supply `default.ups.realpower.nominal = 150` (or the applicable rating).
Missing/invalid power or capacity stays unavailable; zero watts is valid zero load.
For example, 20.54 V × 0.470 A / 150 W × 100 is approximately 6.44%.
Percentages above 100 remain visible; only the progress indicator is capped.

Summary/API readings include `loadOrigin` (`reported`, `estimated`, `unavailable`).
Existing load history remains **device-reported only**: estimates are not stored
in its provenance-free load column. Electrical power/energy history is unchanged.
No synthetic value is written back to NUT; the official plugin is unaffected.

### Observed energy collection

Only the canonical background sampler contributes energy and stored history.
Interactive refreshes update the live view but cannot increase the energy total,
change sample weighting or fill historical gaps. Sources are sampled nominally
every 30 seconds with scheduling jitter; reads, settings edits and deletion are
serialized per source. Repeated scheduled calls within the minimum 25-second
jitter window are deduplicated.

For adjacent valid output-power observations, energy uses trapezoidal integration:

```text
Wh = (previous watts + current watts) / 2 * elapsed seconds / 3600
```

Elapsed time is monotonic within the process. UTC timestamps define chart
boundaries. Intervals must be positive, no longer than 60 seconds, and agree
with the wall clock within one second. A first observation, restart, known read
failure (including a live failure), permission loss, disabled collection or
excessive gap breaks continuity. Missing watts and unsupported telemetry are not
zero watts; valid zero watts still contributes measured coverage. No period is
extrapolated to complete coverage. Sensor uncertainty remains, and this is not
billing-grade energy or AC wall consumption.

Overview shows accumulated Wh/kWh for the current tracking epoch. Changes to
source identity (reader host, backend, target, SNMP version, DC configuration,
manufacturer/model/serial) or output power method start separate epochs. Renaming
or changing credentials does not reset energy. The History view lists each
epoch's totals independently and explicitly labels period totals spanning epochs;
different physical devices must not be interpreted as one continuous meter.
Undetected replacement is possible when a device exposes no distinguishing ID.

History supports 24 hours, 7 days and 30 days:

- Input/output watts and input/output/battery current, when available. These
  optional channels are retained even when output watts are unavailable.
- Observed output Wh per segment and cumulative observed Wh for the selected range.
- Period energy, integrated seconds, measured coverage, time-weighted average
  output watts and the largest sampled output power (not a hardware peak).
- Separate, time-proportional charts with explicit gaps and absolute-time,
  timezone-bearing tooltips. A keyboard-accessible data table follows the charts.
- Raw scheduled intervals for 24 hours (up to 6,000), aggregated into nominal
  five-minute continuous chart segments. UTC hourly rollups for 30 days (up to
  2,160 epoch/hour combinations) sum Wh and coverage and retain sampled min/max.
  Separate input/current channels use time-weighted endpoint observations.

Totals for a selected period conservatively include only whole stored intervals
or rollups inside that range. A partial boundary bucket is excluded rather than
prorated from missing observations; coverage reflects that omission. The trailing
time since the last scheduled observation is also not estimated. Lifetime epoch
totals survive rolling-history pruning.

### Persistence, upgrades and recovery

An additive `energy_states` table stores one versioned document per source.
Each canonical observation writes its full totals, epoch list and rolling
electrical history as one SQL insert/update and then calls the SDK's non-lazy
durable persist operation. No multi-statement accumulator transaction or
dialect-specific upsert is needed. A retry writes the identical document, not
another increment. Only acknowledged writes are presented as committed totals;
after a failed write the UI reports an error, the energy-history endpoint returns
503, and continuity is broken. Pending writes are retried on the next scheduled
observation. A crash can lose in-flight/unacknowledged observations; restart never
integrates across downtime.

The original charge/runtime/voltage file remains separate and uses serialized
atomic-replacement saves. File errors are logged and surfaced by the history API.
Malformed energy state is never silently reset or overwritten. If persistence
fails, check Termix logs, storage capacity and database health; restore a matching
backup rather than deleting the state to make the error disappear.

Back up the Termix database and persistent plugin data together before upgrading.
Keep the previous package. Code-only downgrade is not a data rollback; restoring
the matching backup may be necessary. Source deletion removes its energy totals,
epochs, history and events and warns about this before confirmation.

SQLite migrations and runtime persistence are exercised by the automated tests.
MySQL and PostgreSQL migration files are generated and validated, but have not
been exercised against live database servers.

### CPU/memory correlation prerequisite

CPU/memory correlation is deliberately blocked in this release. The existing
`host-metrics.viewers` service can manage collection, but
`plugin.host-metrics.snapshot` does not provide a measurement timestamp and may
contain cached readings. Event receipt time is not measurement time. The plugin
does not guess timestamps, read another plugin's database or open an extra SSH
sampler.

A future Host Metrics public service must return timestamped, authorized CPU and
memory percentages and preserve per-user host access and lifecycle semantics.
Only then can an explicit, independently authorized powered-host mapping pair
samples within 30 seconds and support optional background collection. Sole-load
confirmation remains required for host-consumption attribution. This release
adds no such background collection or cross-plugin event capability.

## apcupsd

Install apcupsd on the host. Leave the address empty to read the daemon on the host, or use `host` or `host:3551` for another machine. Termix runs `apcaccess status`. apcupsd has no commands, so the Commands view is hidden.

## SNMP cards

Install the net-snmp tools (`snmp` on Debian and Ubuntu) on the host, which then polls the card. Enter the card address and its community, or the v3 user and passwords.

Termix reads the standard UPS-MIB, and the APC PowerNet values when the card does not answer the standard ones. The login is saved sealed and goes to the host in a temporary config file, never on the command line. SNMP cards are read only.

## What you see

Overview has a **Live refresh** selector for 1, 2, 5, 10 or 30 seconds, defaulting
to 1 second for each opened panel. Live polling pauses when the panel, browser
page or Overview is hidden, and while editing a device. Slow requests do not
overlap within a panel; missed refresh ticks are skipped. A failed request shows
an error while keeping the last reading, and the next tick retries.

This setting only changes live viewing, not the NUT driver's own polling rate.
For example, a driver polling every 2 seconds may repeat a value between reads.
Each visible panel performs read-only SSH queries, so use a slower interval when
monitoring many devices. Background polling stays at 30 seconds, and stored
history uses only canonical scheduled samples, regardless of the live refresh
interval. The selector resets to 1 second when the panel is reopened.

- Overview: power state, battery charge, runtime left, load, input, output and battery voltage, temperature, model, serial number and the last self test.
- History: charge, load, runtime and voltage alongside electrical power/current, observed Wh and coverage for 24 hours, 7 days and 30 days.
- Events: every power event, newest first. The last 300 are kept per UPS.
- Commands: the instant commands a NUT UPS supports. Beeper and test commands run after one click. Anything that can cut power asks first.
- Devices: add, edit and remove UPS devices.

## Alerts

Alerts go to the user who added the UPS, through the Alerts plugin and the channels they set up. You get one alert when a problem starts, and the event log shows when it clears.

- On battery: power was lost
- Battery low: the UPS says the battery is low
- Replace battery: the UPS says the battery is worn out
- Overload: the UPS is overloaded
- Low charge and low runtime: under the limits you set while on battery
- Self test problem: the last test did not pass
- Unreachable: the UPS did not answer three scheduled checks in a row (live-view refreshes do not accelerate this alert)

You can set the charge and runtime limits per UPS, and turn alerts off for one UPS.

## Self tests and the beeper

The actions Start battery self test and Set the UPS beeper work for NUT devices that support them. They can be run from Operations Center, the assistant and the CLI. Calibrate runtime drains the battery, so it is marked destructive and asks first.

## Host settings

- UPS Manager: turns the tab on for the host
- UPS read only: blocks changes and commands on the host's UPS devices

## Permissions

Everyone with the use permission can see the UPS devices on hosts they can connect to. Adding, changing and removing a UPS and sending commands needs edit access to the host.

## Dashboard card

The dashboard card lists every UPS on your hosts, worst first, with the power state, charge, runtime and load. It uses the readings Termix already took, so it opens no new connections.
