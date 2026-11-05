import { afterEach, describe, expect, it } from "vitest";
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
  it("serves history after a read", async () => {
    const s = await withNut();
    const added = await s.request("POST", "/1/sources", NUT);
    const id = added.body.id;
    await s.request("GET", `/1/sources/${id}/status`);
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
    for (let i = 0; i < 3; i++)
      await s.request("GET", `/1/sources/${id}/status`);
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
