import { describe, expect, it } from "vitest";
import { parseApcupsd } from "../../src/backend/backends/apcupsd";
import {
  commandRisk,
  parseCommands,
  parseNut,
} from "../../src/backend/backends/nut";
import { buildConf, parseSnmp } from "../../src/backend/backends/snmp";
import { parseDetect } from "../../src/backend/reader";
import {
  APCACCESS_ONBATT,
  APCACCESS_ONLINE,
  SNMP_APC,
  SNMP_STD,
  UPSC_ON_BATTERY,
  UPSC_ONLINE,
  snmpOutput,
} from "./fixtures";

describe("NUT", () => {
  it("reads a healthy UPS", () => {
    const r = parseNut(UPSC_ONLINE);
    expect(r.state).toBe("online");
    expect(r.flags).toEqual([]);
    expect(r.chargePct).toBe(100);
    expect(r.runtimeSec).toBe(2460);
    expect(r.loadPct).toBe(18);
    expect(r.inputV).toBe(231);
    expect(r.batteryV).toBe(27.3);
    expect(r.tempC).toBe(31.5);
    expect(r.nominalW).toBe(900);
    expect(r.model).toBe("Back-UPS XS 1500M");
    expect(r.serial).toBe("3B1234X56789");
    expect(r.lastTest).toBe("Done and passed");
  });

  it("reads status words", () => {
    const r = parseNut(UPSC_ON_BATTERY);
    expect(r.state).toBe("battery");
    expect(r.flags).toEqual(["low-battery", "replace-battery"]);
    expect(r.rawStatus).toBe("OB DISCHRG LB RB");
  });

  it("refuses empty output", () => {
    expect(() => parseNut("")).toThrow();
  });

  it("lists commands and rates their risk", () => {
    const list = parseCommands(
      [
        "Instant commands supported on UPS [ups]:",
        "",
        "beeper.disable - Disable the UPS beeper",
        "test.battery.start.quick - Start a quick battery test",
        "shutdown.return - Turn off the load and return when power is back",
        "load.off - Turn off the load immediately",
      ].join("\n"),
    );
    expect(list.map((c) => c.name)).toEqual([
      "beeper.disable",
      "test.battery.start.quick",
      "shutdown.return",
      "load.off",
    ]);
    expect(list[0].risk).toBe("change");
    expect(list[1].risk).toBe("change");
    expect(list[2].risk).toBe("destructive");
    expect(commandRisk("load.off")).toBe("destructive");
  });
});

describe("apcupsd", () => {
  it("reads a healthy UPS", () => {
    const r = parseApcupsd(APCACCESS_ONLINE);
    expect(r.state).toBe("online");
    expect(r.chargePct).toBe(100);
    expect(r.runtimeSec).toBe(2730);
    expect(r.loadPct).toBe(21);
    expect(r.inputV).toBe(229);
    expect(r.tempC).toBe(29.8);
    expect(r.nominalW).toBe(980);
    expect(r.model).toBe("Smart-UPS 1500");
    expect(r.serial).toBe("AS1234567890");
  });

  it("reads battery and low battery", () => {
    const r = parseApcupsd(APCACCESS_ONBATT);
    expect(r.state).toBe("battery");
    expect(r.flags).toEqual(["low-battery"]);
    expect(r.runtimeSec).toBe(180);
    expect(r.lastTest).toBe("NG");
  });

  it("refuses empty output", () => {
    expect(() => parseApcupsd("")).toThrow();
  });
});

describe("SNMP", () => {
  it("reads the standard UPS-MIB", () => {
    const r = parseSnmp(snmpOutput(SNMP_STD));
    expect(r.state).toBe("online");
    expect(r.chargePct).toBe(97);
    expect(r.runtimeSec).toBe(38 * 60);
    expect(r.batteryV).toBe(54.6);
    expect(r.tempC).toBe(28);
    expect(r.inputV).toBe(232);
    expect(r.outputV).toBe(230);
    expect(r.loadPct).toBe(34);
    expect(r.manufacturer).toBe("APC");
    expect(r.model).toBe("Smart-UPS RT 3000");
  });

  it("falls back to APC PowerNet", () => {
    const r = parseSnmp(snmpOutput("", SNMP_APC));
    expect(r.state).toBe("online");
    expect(r.chargePct).toBe(88);
    expect(r.runtimeSec).toBe(2280);
    expect(r.loadPct).toBe(40);
    expect(r.flags).toContain("replace-battery");
  });

  it("flags a battery on battery power", () => {
    const std = SNMP_STD.replace(
      ".4.1.0 = INTEGER: 3",
      ".4.1.0 = INTEGER: 5",
    ).replace(".2.1.0 = INTEGER: 2", ".2.1.0 = INTEGER: 3");
    const r = parseSnmp(snmpOutput(std));
    expect(r.state).toBe("battery");
    expect(r.flags).toContain("low-battery");
  });

  it("explains a card that does not answer", () => {
    expect(() =>
      parseSnmp("@@std@@\nTimeout: No Response from udp:10.0.0.9\n@@apc@@\n"),
    ).toThrow(/Timeout/);
  });

  it("writes the login to snmp.conf, not argv", () => {
    expect(buildConf("2c", { community: "secret" })).toBe(
      "defVersion 2c\ndefCommunity secret\n",
    );
    const v3 = buildConf("3", {
      v3User: "mon",
      v3Level: "authPriv",
      v3AuthProto: "SHA",
      v3AuthPass: "authpass1",
      v3PrivProto: "AES",
      v3PrivPass: "privpass1",
    });
    expect(v3).toContain("defSecurityName mon");
    expect(v3).toContain("defAuthPassphrase authpass1");
    expect(v3).toContain("defPrivType AES");
  });

  it("rejects secrets that could break the file", () => {
    expect(() => buildConf("2c", { community: "a b" })).toThrow();
    expect(() => buildConf("2c", { community: "a\nb" })).toThrow();
    expect(() => buildConf("3", { v3Level: "noAuthNoPriv" })).toThrow();
  });
});

describe("detect", () => {
  it("reads the tools, devices and services", () => {
    const d = parseDetect(
      [
        "@@detect@@",
        "upsc=1",
        "upscmd=1",
        "apcaccess=0",
        "snmpwalk=1",
        "@@nut@@",
        "rack",
        "desk",
        "@@services@@",
        "nut-server",
        "",
      ].join("\n"),
    );
    expect(d).toEqual({
      upsc: true,
      upscmd: true,
      apcaccess: false,
      snmpwalk: true,
      nutUps: ["rack", "desk"],
      services: ["nut-server"],
    });
  });
});
