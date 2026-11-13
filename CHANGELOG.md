# Changelog

## 1.1.0-dev.6

### Fixed

- Reject malformed numerical history and invalid persisted power without
  overwriting existing data
- Include the new energy route in the upstream authorization test manifest
- Preserve the authorization manifest and uppercase branch URL in dev packaging

### Added

- Populated SQLite upgrade, clean-install, non-admin isolation and scheduled
  outage-recovery regression tests

## 1.1.0-dev.5

### Added

- HL-21: estimate missing UPS load from valid output watts and nominal real watts,
  preserving device-reported load and labeling estimated values across live views
- Reject VA-only capacity as watts; keep existing load history reported-only

## 1.1.0-dev.4

### Added

- Live NUT currents, reported real power and explicitly enabled DC power calculations
- Battery and driver metadata with searchable read-only NUT diagnostics
- An isolated `ups-dev-manager` preview package for side-by-side testing
- Selectable visible Overview refresh from 1 to 30 seconds, with non-overlapping
  live requests and a separate 30-second history sampling limit
- Durable observed output Wh/kWh with independent tracking epochs and explicit
  coverage, missing-data and persistence-health reporting
- Canonical scheduled energy/history sampling isolated from live refreshes
- Time-weighted power/current history, sampled power ranges, per-segment and
  cumulative observed energy, with 24-hour/7-day/30-day views
- Gap-aware time-proportional charts and an accessible absolute-time data table
- Explicit Host Metrics timestamp-service prerequisite; CPU/memory correlation
  remains unavailable and does not start additional host collection

## 1.0.0

### Added

- A UPS tab for each host that reads UPS devices through NUT, apcupsd or an SNMP card
- Battery charge, runtime, load, input and output voltage, temperature and last self test
- Charts for the last 24 hours, 7 days and 30 days
- A power event log for every UPS
- Alerts when power is lost, the battery is low or needs replacing, the UPS is overloaded, a self test fails or the UPS stops answering
- Start a battery self test, mute the beeper and send other NUT commands, with a check before anything that can cut power
- UPS devices show in the All hosts table, and power status, charge and runtime show as status tiles
- A dashboard card with every UPS on your hosts, worst first

### Changed

- Needs Termix 26.11.1 or newer
