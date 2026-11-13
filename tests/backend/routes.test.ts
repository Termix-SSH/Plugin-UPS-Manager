import { afterEach, describe, expect, it, vi } from "vitest";
import { startServer, type TestServer } from "./helpers";
import {
  APCACCESS_ONLINE,
  SNMP_STD,
  UPSC_ON_BATTERY,
  UPSC_ONLINE,
  snmpOutput,
} from "./fixtures";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
  vi.restoreAllMocks();
});

const NUT = { backend: "nut", label: "Rack", target: "ups" };

async function withNut(
  options: Parameters<typeof startServer>[0] = {},
): Promise<TestServer> {
  server = await startServer(options);
  server.ssh.replies.push({ match: "upsc ", stdout: UPSC_ONLINE });
  return server;
}

describe("sources", () => {
  it("persists explicit DC configuration across reads and older-client edits", async () => {
    const s = await withNut();
    s.ssh.replies[0].stdout =
      "ups.status: OL\noutput.voltage: 20.54\noutput.current: 0.470\n";
    const tested = await s.request("POST", "/1/test-source", {
      ...NUT,
      outputDc: true,
    });
    expect(tested.body.reading.electrical.outputPowerW).toBeCloseTo(9.6538);
    const created = await s.request("POST", "/1/sources", {
      ...NUT,
      outputDc: true,
    });
    expect(created.status).toBe(200);
    expect(created.body.outputDc).toBe(true);
    expect(created.body.reading.electrical.outputPowerOrigin).toBe(
      "calculated-dc",
    );
    const id = created.body.id;
    const updated = await s.request("PUT", `/1/sources/${id}`, NUT);
    expect(updated.body.outputDc).toBe(true);
    expect(updated.body.reading.electrical.outputPowerW).toBeCloseTo(9.6538);
    const disabled = await s.request("PUT", `/1/sources/${id}`, {
      ...NUT,
      outputDc: false,
    });
    expect(disabled.body.reading.electrical.outputPowerW).toBeNull();
    const fresh = await s.request("GET", `/1/sources/${id}/status`);
    expect(fresh.body.outputDc).toBe(false);
    expect(fresh.body.reading.electrical.outputPowerW).toBeNull();
  });

  it("rejects malformed or unsupported DC settings before SSH", async () => {
    const s = await withNut();
    for (const body of [
      { ...NUT, outputDc: "true" },
      { backend: "apcupsd", label: "AC", target: "", outputDc: true },
    ]) {
      expect((await s.request("POST", "/1/test-source", body)).status).toBe(
        400,
      );
    }
    expect(s.ssh.calls).toHaveLength(0);
  });

  it("adds a UPS and reads it", async () => {
    const s = await withNut();
    const res = await s.request("POST", "/1/sources", {
      ...NUT,
      secrets: { nutUser: "admin", nutPassword: "pw" },
    });
    expect(res.status).toBe(200);
    expect(res.body.label).toBe("Rack");
    expect(res.body.hasSecrets).toBe(true);
    expect(res.body.reading.chargePct).toBe(100);
    expect(res.text).not.toContain("admin");
    expect(res.text).not.toContain('"pw"');

    const list = await s.request("GET", "/1/sources");
    expect(list.status).toBe(200);
    expect(list.body.canEdit).toBe(true);
    expect(list.body.sources).toHaveLength(1);
    expect(list.text).not.toContain("nutPassword");
  });

  it("seals the login in the database", async () => {
    const s = await withNut();
    await s.request("POST", "/1/sources", {
      ...NUT,
      secrets: { nutUser: "admin", nutPassword: "hunter2" },
    });
    const rows = s.sqlite
      .prepare("SELECT secrets FROM p_ups_manager_sources")
      .all() as Array<{ secrets: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].secrets).toMatch(/^sealed:/);
    expect(rows[0].secrets).not.toContain("hunter2");
  });

  it("rejects a bad target", async () => {
    const s = await withNut();
    const res = await s.request("POST", "/1/sources", {
      ...NUT,
      target: "ups;id",
    });
    expect(res.status).toBe(400);
    expect(s.ssh.calls).toHaveLength(0);
  });

  it("changes and removes a UPS", async () => {
    const s = await withNut();
    const added = await s.request("POST", "/1/sources", NUT);
    const id = added.body.id;
    const changed = await s.request("PUT", `/1/sources/${id}`, {
      ...NUT,
      label: "Desk",
      lowCharge: 50,
    });
    expect(changed.status).toBe(200);
    expect(changed.body.label).toBe("Desk");
    expect(changed.body.lowCharge).toBe(50);
    const gone = await s.request("DELETE", `/1/sources/${id}`);
    expect(gone.status).toBe(200);
    expect((await s.request("GET", "/1/sources")).body.sources).toHaveLength(0);
  });

  it("will not touch a UPS of another host", async () => {
    const s = await withNut();
    const added = await s.request("POST", "/1/sources", NUT);
    const res = await s.request("DELETE", `/2/sources/${added.body.id}`);
    expect(res.status).toBe(404);
  });

  it("tests a UPS without saving it", async () => {
    const s = await withNut();
    const res = await s.request("POST", "/1/test-source", NUT);
    expect(res.status).toBe(200);
    expect(res.body.reading.state).toBe("online");
    expect((await s.request("GET", "/1/sources")).body.sources).toHaveLength(0);
  });

  it("reads apcupsd and SNMP", async () => {
    server = await startServer();
    server.ssh.replies.push(
      { match: "apcaccess status", stdout: APCACCESS_ONLINE },
      { match: "snmpwalk", stdout: snmpOutput(SNMP_STD) },
    );
    const apc = await server.request("POST", "/1/sources", {
      backend: "apcupsd",
      label: "APC",
      target: "",
    });
    expect(apc.body.reading.model).toBe("Smart-UPS 1500");
    const snmp = await server.request("POST", "/1/sources", {
      backend: "snmp",
      label: "Card",
      target: "10.0.0.9",
      secrets: { community: "public" },
    });
    expect(snmp.body.reading.chargePct).toBe(97);
    expect(snmp.text).not.toContain('"public"');
  });

  it("limits the sources per host", async () => {
    const s = await withNut();
    for (let i = 0; i < 8; i++) {
      expect(
        (await s.request("POST", "/1/sources", { ...NUT, label: `U${i}` }))
          .status,
      ).toBe(200);
    }
    expect((await s.request("POST", "/1/sources", NUT)).status).toBe(400);
  });
});

describe("access", () => {
  it("isolates readings, history, energy, summaries and mutations between actors", async () => {
    const s = await withNut();
    const own = await s.request("POST", "/1/sources", NUT);
    const other = await s.request("POST", "/2/sources", {
      ...NUT,
      label: "Private UPS",
    });
    s.mock.setActor("user-2");
    Object.assign(s.mock.ctx.hosts, {
      checkAccess: async (id: number, need = "connect") => ({
        hasAccess: id === 1 && need === "connect",
        isOwner: false,
        isShared: id === 1,
        permissionLevel: id === 1 ? "connect" : undefined,
      }),
    });
    for (const suffix of ["status", "history", "energy", "events"]) {
      expect(
        (await s.request("GET", `/1/sources/${own.body.id}/${suffix}`)).status,
      ).toBe(200);
      expect(
        (await s.request("GET", `/2/sources/${other.body.id}/${suffix}`))
          .status,
      ).toBe(404);
      expect(
        (await s.request("GET", `/1/sources/${other.body.id}/${suffix}`))
          .status,
      ).toBe(404);
    }
    const summary = await s.request("GET", "/summary");
    expect(summary.body.map((r: { hostId: number }) => r.hostId)).toEqual([1]);
    expect(summary.text).not.toContain("Private UPS");
    expect(
      (await s.request("PUT", `/1/sources/${own.body.id}`, NUT)).status,
    ).toBe(403);
    expect(
      (await s.request("DELETE", `/2/sources/${other.body.id}`)).status,
    ).toBe(404);
  });

  it("requires the plugin permission for every new data route", async () => {
    const s = await withNut({ permissions: [] });
    for (const path of [
      "/summary",
      "/1/sources/1/status",
      "/1/sources/1/history",
      "/1/sources/1/energy",
    ])
      expect((await s.request("GET", path)).status).toBe(403);
    expect(s.ssh.calls).toHaveLength(0);
  });
  it("needs edit access to add", async () => {
    const s = await withNut({ level: "connect" });
    const res = await s.request("POST", "/1/sources", NUT);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("HOST_EDIT_REQUIRED");
    expect((await s.request("GET", "/1/sources")).body.canEdit).toBe(false);
  });

  it("hides hosts the user cannot reach", async () => {
    const s = await withNut({ level: "none" });
    expect((await s.request("GET", "/1/sources")).status).toBe(404);
  });

  it("is off until the host turns it on", async () => {
    const s = await withNut({ hostSettings: { enableUps: false } });
    const res = await s.request("GET", "/1/sources");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("disabled");
  });

  it("blocks changes on a read only host", async () => {
    const s = await withNut({ hostSettings: { readOnly: true } });
    const res = await s.request("POST", "/1/sources", NUT);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("readOnly");
    expect((await s.request("GET", "/1/sources")).body.canEdit).toBe(false);
  });

  it("needs the use permission", async () => {
    const s = await withNut({ permissions: [] });
    expect((await s.request("GET", "/1/sources")).status).toBe(403);
  });
});

describe("history, events and summary", () => {
  it("carries estimated load provenance through readings and dashboard summaries", async () => {
    const s = await withNut();
    s.ssh.replies[0].stdout =
      "ups.status: OL\nups.realpower: 15\nups.realpower.nominal: 150\n";
    const added = await s.request("POST", "/1/sources", NUT);
    const status = await s.request("GET", `/1/sources/${added.body.id}/status`);
    expect(status.body.reading).toMatchObject({
      loadPct: 10,
      loadOrigin: "estimated",
    });
    const summary = await s.request("GET", "/summary");
    expect(summary.body[0]).toMatchObject({
      loadPct: 10,
      loadOrigin: "estimated",
    });
  });
  it("preserves durable energy when source deletion fails", async () => {
    const s = await withNut();
    s.ssh.replies[0].stdout = "ups.status: OL\nups.realpower: 100\n";
    const added = await s.request("POST", "/1/sources", NUT);
    await s.mock.scheduled.find((job) => job.ms === 30_000)!.fn();
    const query = s.sqlite.prepare(
      "SELECT payload FROM p_ups_manager_energy_states ORDER BY source_id",
    );
    const before = query.all();
    expect(before).toHaveLength(1);
    s.sqlite.exec(
      "CREATE TRIGGER reject_source_delete BEFORE DELETE ON p_ups_manager_sources BEGIN SELECT RAISE(FAIL, 'delete failed'); END;",
    );
    expect(
      (await s.request("DELETE", `/1/sources/${added.body.id}`)).status,
    ).toBe(500);
    expect(query.all()).toEqual(before);
  });

  it("serializes simultaneous live and scheduled SSH reads", async () => {
    let active = 0;
    let maximum = 0;
    const s = await withNut({
      exec: async () => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return {
          stdout: UPSC_ONLINE,
          stderr: "",
          code: 0,
          timedOut: false,
          truncated: false,
        };
      },
    });
    const added = await s.request("POST", "/1/sources", NUT);
    await Promise.all([
      s.mock.scheduled.find((job) => job.ms === 30_000)!.fn(),
      ...Array.from({ length: 5 }, () =>
        s.request("GET", `/1/sources/${added.body.id}/status`),
      ),
    ]);
    expect(maximum).toBe(1);
  });

  it("surfaces non-lazy database persistence failures in the energy API", async () => {
    const s = await withNut();
    s.ssh.replies[0].stdout = "ups.status: OL\nups.realpower: 100\n";
    const added = await s.request("POST", "/1/sources", NUT);
    const persist = vi
      .spyOn(s.mock.ctx.db, "persist")
      .mockRejectedValueOnce(new Error("disk full"));
    await s.mock.scheduled.find((job) => job.ms === 30_000)!.fn();
    const report = await s.request("GET", `/1/sources/${added.body.id}/energy`);
    expect(report.status).toBe(503);
    expect(report.body.error).toContain("Energy persistence failed");
    expect(persist).toHaveBeenCalledWith();
  });

  it("persists canonical energy with live reads excluded and source access enforced", async () => {
    const s = await withNut();
    s.ssh.replies[0].stdout = "ups.status: OL\nups.realpower: 100\n";
    const added = await s.request("POST", "/1/sources", NUT);
    const id = added.body.id;
    const clock = vi.spyOn(performance, "now");
    const wall = vi.spyOn(Date, "now");
    const start = 1_800_000_000_000;
    const sample = s.mock.scheduled.find((job) => job.ms === 30_000)!;
    for (let second = 0; second <= 60; second += 30) {
      clock.mockReturnValue(second * 1000);
      wall.mockReturnValue(start + second * 1000);
      await Promise.all([sample.fn(), sample.fn()]);
      for (let i = 0; i < 5; i++)
        await s.request("GET", `/1/sources/${id}/status`);
    }
    const report = await s.request("GET", `/1/sources/${id}/energy?range=24h`);
    expect(report.status).toBe(200);
    expect(report.body.observedWh).toBeCloseTo((100 * 60) / 3600, 8);
    expect(report.body.coveredSec).toBe(60);
    expect(report.body.epochs).toHaveLength(1);
    expect(
      s.sqlite.prepare("SELECT payload FROM p_ups_manager_energy_states").all(),
    ).toHaveLength(1);
    expect((await s.request("GET", `/2/sources/${id}/energy`)).status).toBe(
      404,
    );
    expect(
      (await s.request("GET", `/1/sources/${id}/energy?range=bad`)).status,
    ).toBe(400);

    await s.request("PUT", `/1/sources/${id}`, { ...NUT, enabled: false });
    clock.mockReturnValue(90_000);
    wall.mockReturnValue(start + 90_000);
    await sample.fn();
    await s.request("PUT", `/1/sources/${id}`, NUT);
    await sample.fn();
    const after = await s.request("GET", `/1/sources/${id}/energy`);
    expect(after.body.coveredSec).toBe(60);
    await s.request("DELETE", `/1/sources/${id}`);
    expect(
      s.sqlite.prepare("SELECT payload FROM p_ups_manager_energy_states").all(),
    ).toEqual([]);
  });

  it("breaks canonical energy on an interactive read failure within 60 seconds", async () => {
    const s = await withNut();
    s.ssh.replies[0].stdout = "ups.status: OL\nups.realpower: 100\n";
    const added = await s.request("POST", "/1/sources", NUT);
    const id = added.body.id;
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const wall = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const job = s.mock.scheduled.find((j) => j.ms === 30_000)!;
    await job.fn();
    s.ssh.replies[0].code = 1;
    await s.request("GET", `/1/sources/${id}/status`);
    s.ssh.replies[0].code = 0;
    clock.mockReturnValue(30_000);
    wall.mockReturnValue(1_800_000_030_000);
    await job.fn();
    const report = await s.request("GET", `/1/sources/${id}/energy`);
    expect(report.body.observedWh).toBe(0);
    expect(report.body.coveredSec).toBe(0);
  });

  it("recovers after a scheduled outage without bridging the failed interval", async () => {
    const s = await withNut();
    s.ssh.replies[0].stdout = "ups.status: OL\nups.realpower: 100\n";
    const added = await s.request("POST", "/1/sources", NUT);
    const clock = vi.spyOn(performance, "now");
    const wall = vi.spyOn(Date, "now");
    const job = s.mock.scheduled.find((j) => j.ms === 30_000)!;
    for (let second = 0; second <= 120; second += 30) {
      clock.mockReturnValue(second * 1000);
      wall.mockReturnValue(1_800_000_000_000 + second * 1000);
      s.ssh.replies[0].code = second === 60 ? 1 : 0;
      await job.fn();
    }
    const status = await s.request("GET", `/1/sources/${added.body.id}/status`);
    expect(status.body.error).toBe("");
    const report = await s.request("GET", `/1/sources/${added.body.id}/energy`);
    expect(report.body.coveredSec).toBe(60);
    expect(report.body.observedWh).toBeCloseTo((100 * 60) / 3600, 8);
    expect(report.body.coveragePct).toBe(50);
    expect(report.body.points).toHaveLength(2);
  });

  it("reports corrupt durable energy as unavailable without replacing it", async () => {
    const s = await withNut({ energyPayload: "broken" });
    const added = await s.request("POST", "/1/sources", NUT);
    const id = added.body.id;
    const report = await s.request("GET", `/1/sources/${id}/energy`);
    expect(report.status).toBe(503);
    expect(report.body.error).toContain("Energy state unavailable");
    const rows = s.sqlite
      .prepare("SELECT payload FROM p_ups_manager_energy_states")
      .all();
    expect(rows).toEqual([{ payload: "broken" }]);
  });

  it("records history only from the canonical scheduler, not interactive reads", async () => {
    const s = await withNut();
    const added = await s.request("POST", "/1/sources", NUT);
    const id = added.body.id;
    await s.request("GET", `/1/sources/${id}/status`);
    const before = await s.request("GET", `/1/sources/${id}/history?range=24h`);
    expect(before.body.points).toEqual([]);
    await s.mock.scheduled.find((job) => job.ms === 30_000)!.fn();
    const res = await s.request("GET", `/1/sources/${id}/history?range=24h`);
    expect(res.status).toBe(200);
    expect(res.body.range).toBe("24h");
    expect(res.body.points.length).toBeGreaterThan(0);
    const bad = await s.request("GET", `/1/sources/${id}/history?range=9y`);
    expect(bad.body.range).toBe("24h");
  });

  it("logs power events and alerts the owner", async () => {
    const s = await withNut();
    const added = await s.request("POST", "/1/sources", NUT);
    const id = added.body.id;
    s.ssh.replies.length = 0;
    s.ssh.replies.push({ match: "upsc ", stdout: UPSC_ON_BATTERY });
    await s.request("GET", `/1/sources/${id}/status`);
    const events = await s.request("GET", `/1/sources/${id}/events`);
    const types = events.body.map((e: { type: string }) => e.type);
    expect(types).toContain("on-battery");
    expect(types).toContain("low-battery");
    const sent = s.mock.notifications.map((n) => n.notification);
    expect(sent.some((n) => n.title === "Rack is running on battery")).toBe(
      true,
    );
    expect(
      sent.every((n) => JSON.stringify(n.audience).includes("user-1")),
    ).toBe(true);

    const count = sent.length;
    await s.request("GET", `/1/sources/${id}/status`);
    expect(s.mock.notifications).toHaveLength(count);

    s.ssh.replies.length = 0;
    s.ssh.replies.push({ match: "upsc ", stdout: UPSC_ONLINE });
    await s.request("GET", `/1/sources/${id}/status`);
    const after = await s.request("GET", `/1/sources/${id}/events`);
    expect(after.body.map((e: { type: string }) => e.type)).toContain(
      "on-battery-cleared",
    );
  });

  it("does not alert when alerts are off", async () => {
    const s = await withNut();
    const added = await s.request("POST", "/1/sources", {
      ...NUT,
      alerts: false,
    });
    s.ssh.replies.length = 0;
    s.ssh.replies.push({ match: "upsc ", stdout: UPSC_ON_BATTERY });
    await s.request("GET", `/1/sources/${added.body.id}/status`);
    expect(s.mock.notifications).toHaveLength(0);
    const events = await s.request("GET", `/1/sources/${added.body.id}/events`);
    expect(events.body.length).toBeGreaterThan(0);
  });

  it("marks a UPS unreachable after three misses in a row", async () => {
    const s = await withNut();
    const added = await s.request("POST", "/1/sources", NUT);
    const id = added.body.id;
    s.ssh.replies.length = 0;
    s.ssh.replies.push({
      match: "upsc ",
      stdout: "SCRIPT_ERR:Error: Data stale",
      code: 1,
    });
    const clock = vi.spyOn(performance, "now");
    for (let i = 0; i < 3; i++) {
      clock.mockReturnValue(i * 30_000);
      await s.mock.scheduled.find((job) => job.ms === 30_000)!.fn();
      await s.request("GET", `/1/sources/${id}/status`);
    }
    const events = await s.request("GET", `/1/sources/${id}/events`);
    expect(events.body.map((e: { type: string }) => e.type)).toContain(
      "unreachable",
    );
    const view = await s.request("GET", `/1/sources/${id}/status`);
    expect(view.body.error).toContain("Data stale");
    expect(view.body.reading.chargePct).toBe(100);
  });

  it("summarizes the latest readings without opening SSH", async () => {
    const s = await withNut();
    await s.request("POST", "/1/sources", NUT);
    const calls = s.ssh.calls.length;
    const res = await s.request("GET", "/summary");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      label: "Rack",
      state: "online",
      chargePct: 100,
    });
    expect(s.ssh.calls.length).toBe(calls);
  });

  it("reads every source on the timer", async () => {
    const s = await withNut();
    await s.request("POST", "/1/sources", NUT);
    const calls = s.ssh.calls.length;
    await s.mock.runScheduled();
    expect(s.ssh.calls.length).toBeGreaterThan(calls);
  });
});

describe("detect and commands", () => {
  it("detects tools and devices", async () => {
    const s = await withNut();
    s.ssh.replies.unshift({
      match: "@@detect@@",
      stdout:
        "@@detect@@\nupsc=1\nupscmd=1\napcaccess=0\nsnmpwalk=0\n@@nut@@\nups\n@@services@@\n",
    });
    const res = await s.request("GET", "/1/detect");
    expect(res.status).toBe(200);
    expect(res.body.nutUps).toEqual(["ups"]);
    expect(res.body.upsc).toBe(true);
  });

  it("lists and runs NUT commands", async () => {
    const s = await withNut();
    const added = await s.request("POST", "/1/sources", {
      ...NUT,
      secrets: { nutUser: "admin", nutPassword: "pw" },
    });
    const id = added.body.id;
    s.ssh.replies.unshift({
      match: "upscmd -u",
      stdout: "OK\n",
    });
    s.ssh.replies.push({
      match: "upscmd -l",
      stdout:
        "Instant commands supported on UPS [ups]:\n\nbeeper.mute - Temporarily mute the UPS beeper\nload.off - Turn off the load\n",
    });
    const list = await s.request("GET", `/1/sources/${id}/commands`);
    expect(list.body.map((c: { name: string }) => c.name)).toEqual([
      "beeper.mute",
      "load.off",
    ]);
    const run = await s.request("POST", `/1/sources/${id}/commands`, {
      command: "beeper.mute",
    });
    expect(run.status).toBe(200);
    const last = s.ssh.calls[s.ssh.calls.length - 1];
    expect(last.stdin).toContain("'beeper.mute'");
    const events = await s.request("GET", `/1/sources/${id}/events`);
    expect(events.body[0].type).toBe("command");
  });

  it("needs a NUT login to run a command", async () => {
    const s = await withNut();
    const added = await s.request("POST", "/1/sources", NUT);
    const res = await s.request(
      "POST",
      `/1/sources/${added.body.id}/commands`,
      { command: "beeper.mute" },
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("nut-login");
  });

  it("only NUT takes commands", async () => {
    server = await startServer();
    server.ssh.replies.push({
      match: "apcaccess status",
      stdout: APCACCESS_ONLINE,
    });
    const added = await server.request("POST", "/1/sources", {
      backend: "apcupsd",
      label: "A",
      target: "",
    });
    const res = await server.request(
      "GET",
      `/1/sources/${added.body.id}/commands`,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("unsupported");
  });
});
