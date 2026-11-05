/** Output shaped like the real tools print it. */

export const UPSC_ONLINE = `battery.charge: 100
battery.charge.low: 10
battery.runtime: 2460
battery.voltage: 27.3
device.mfr: American Power Conversion
device.model: Back-UPS XS 1500M
device.serial: 3B1234X56789
device.type: ups
input.voltage: 231.0
output.voltage: 231.0
ups.load: 18
ups.realpower.nominal: 900
ups.status: OL
ups.test.result: Done and passed
ups.temperature: 31.5
`;

export const UPSC_ON_BATTERY = `battery.charge: 27
battery.runtime: 280
battery.voltage: 24.9
device.model: Back-UPS XS 1500M
input.voltage: 0.0
output.voltage: 230.0
ups.load: 42
ups.status: OB DISCHRG LB RB
ups.test.result: Done and passed
`;

export const APCACCESS_ONLINE = `APC      : 001,036,0869
DATE     : 2026-11-05 10:00:05 +0000
HOSTNAME : zeus
UPSNAME  : rack
MODEL    : Smart-UPS 1500
STATUS   : ONLINE
LINEV    : 229.0 Volts
LOADPCT  : 21.0 Percent
BCHARGE  : 100.0 Percent
TIMELEFT : 45.5 Minutes
OUTPUTV  : 229.0 Volts
ITEMP    : 29.8 C
BATTV    : 27.4 Volts
SELFTEST : OK
NOMPOWER : 980 Watts
SERIALNO : AS1234567890
`;

export const APCACCESS_ONBATT = `UPSNAME  : rack
MODEL    : Smart-UPS 1500
STATUS   : ONBATT LOWBATT
LINEV    : 0.0 Volts
LOADPCT  : 21.0 Percent
BCHARGE  : 22.0 Percent
TIMELEFT : 3.0 Minutes
SELFTEST : NG
`;

export const SNMP_STD = `.1.3.6.1.2.1.33.1.1.1.0 = STRING: "APC"
.1.3.6.1.2.1.33.1.1.2.0 = STRING: "Smart-UPS RT 3000"
.1.3.6.1.2.1.33.1.2.1.0 = INTEGER: 2
.1.3.6.1.2.1.33.1.2.2.0 = INTEGER: 0
.1.3.6.1.2.1.33.1.2.3.0 = INTEGER: 38
.1.3.6.1.2.1.33.1.2.4.0 = INTEGER: 97
.1.3.6.1.2.1.33.1.2.5.0 = INTEGER: 546
.1.3.6.1.2.1.33.1.2.7.0 = INTEGER: 28
.1.3.6.1.2.1.33.1.3.3.1.3.1 = INTEGER: 232
.1.3.6.1.2.1.33.1.4.1.0 = INTEGER: 3
.1.3.6.1.2.1.33.1.4.4.1.2.1 = INTEGER: 230
.1.3.6.1.2.1.33.1.4.4.1.5.1 = INTEGER: 34
`;

export const SNMP_APC = `.1.3.6.1.4.1.318.1.1.1.1.1.1.0 = STRING: "Smart-UPS RT 3000"
.1.3.6.1.4.1.318.1.1.1.2.2.1.0 = Gauge32: 88
.1.3.6.1.4.1.318.1.1.1.2.2.3.0 = Timeticks: (228000) 0:38:00.00
.1.3.6.1.4.1.318.1.1.1.2.2.4.0 = INTEGER: 2
.1.3.6.1.4.1.318.1.1.1.3.2.1.0 = INTEGER: 231
.1.3.6.1.4.1.318.1.1.1.4.1.1.0 = INTEGER: 2
.1.3.6.1.4.1.318.1.1.1.4.2.1.0 = INTEGER: 230
.1.3.6.1.4.1.318.1.1.1.4.2.3.0 = Gauge32: 40
`;

export function snmpOutput(std: string, apc = ""): string {
  return `@@std@@\n${std}@@apc@@\n${apc}`;
}
