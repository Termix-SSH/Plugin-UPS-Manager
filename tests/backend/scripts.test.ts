import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { readScript as apcScript } from "../../src/backend/backends/apcupsd";
import {
  listCommandsScript,
  readScript as nutScript,
  runCommandScript,
} from "../../src/backend/backends/nut";
import { readScript as snmpScript } from "../../src/backend/backends/snmp";
import { DETECT_SCRIPT } from "../../src/backend/reader";

const hasBash = spawnSync("bash", ["--version"]).status === 0;

function syntax(script: string): string {
  const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  return result.status === 0 ? "" : result.stderr;
}

describe.skipIf(!hasBash)("generated scripts", () => {
  it("are valid bash", () => {
    const scripts: Record<string, string> = {
      detect: DETECT_SCRIPT,
      nut: nutScript("ups@10.0.0.5:3493"),
      nutList: listCommandsScript("ups"),
      nutRun: runCommandScript("ups", "beeper.mute", {
        user: "admin",
        password: "p'w\"$x",
      }),
      apcLocal: apcScript(""),
      apcRemote: apcScript("10.0.0.5:3551"),
      snmp2c: snmpScript("10.0.0.9", "2c", { community: "public" }),
      snmp3: snmpScript("10.0.0.9:161", "3", {
        v3User: "mon",
        v3Level: "authPriv",
        v3AuthPass: "authpass1",
        v3PrivPass: "privpass1",
      }),
    };
    for (const [name, script] of Object.entries(scripts)) {
      expect(syntax(script), name).toBe("");
    }
  });
});

describe("script safety", () => {
  it("never puts SNMP secrets in the script text", () => {
    const script = snmpScript("10.0.0.9", "2c", { community: "s3cretcomm" });
    expect(script).not.toContain("s3cretcomm");
    expect(script).toContain("base64 -d");
  });

  it("quotes the NUT target", () => {
    expect(nutScript("ups@10.0.0.5:3493")).toContain("'ups@10.0.0.5:3493'");
  });

  it("refuses a command name that is not plain", () => {
    const login = { user: "a", password: "b" };
    expect(() => runCommandScript("ups", "x; rm -rf /", login)).toThrow();
    expect(() => runCommandScript("ups", "$(id)", login)).toThrow();
  });

  it("needs a login to send a command", () => {
    expect(() => runCommandScript("ups", "beeper.mute", null)).toThrow(
      /NUT login/,
    );
  });

  it("checks the command against the UPS list", () => {
    const script = runCommandScript("ups", "beeper.mute", {
      user: "a",
      password: "b",
    });
    expect(script).toContain("upscmd -l 'ups'");
    expect(script).toContain("grep -q");
  });
});
