import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseNut } from "../../src/backend/backends/nut";
import { History, RAW_LIMIT, downsample } from "../../src/backend/history";
import { UPSC_ONLINE } from "./fixtures";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

const NOW = 1_800_000_000;

describe("history", () => {
  it("keeps raw samples for 24h and averages by the hour after", () => {
    const h = new History(null);
    const r = parseNut(UPSC_ONLINE);
    for (let i = 0; i < 6; i++) {
      r.chargePct = 100 - i * 2;
      h.add(1, NOW - 3600 * 2 + i * 600, r);
    }
    expect(h.range(1, "24h", NOW)).toHaveLength(6);
    const week = h.range(1, "7d", NOW);
    expect(week.length).toBeGreaterThan(0);
    expect(week[0].c).toBeLessThanOrEqual(100);
    expect(h.range(2, "24h", NOW)).toEqual([]);
  });

  it("caps raw samples", () => {
    const h = new History(null);
    const r = parseNut(UPSC_ONLINE);
    for (let i = 0; i < RAW_LIMIT + 50; i++)
      h.add(1, NOW - 100_000 + i * 30, r);
    expect(h.range(1, "24h", NOW).length).toBeLessThanOrEqual(288);
  });

  it("saves to a file and loads it back", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ups-hist-"));
    dirs.push(dir);
    const a = new History(dir);
    a.add(7, NOW - 60, parseNut(UPSC_ONLINE));
    await a.flush();
    const b = new History(dir);
    await b.load();
    const points = b.range(7, "24h", NOW);
    expect(points).toHaveLength(1);
    expect(points[0].c).toBe(100);
    b.drop(7);
    expect(b.range(7, "24h", NOW)).toEqual([]);
  });

  it("starts empty when the file is damaged", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ups-hist-"));
    dirs.push(dir);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dir, "history.json"), "{not json");
    const h = new History(dir);
    await h.load();
    expect(h.range(1, "24h", NOW)).toEqual([]);
  });

  it("downsamples to the point limit", () => {
    const points = Array.from({ length: 1000 }, (_, i) => ({
      t: i,
      c: i % 100,
      r: null,
      l: null,
      i: null,
      o: null,
    }));
    const out = downsample(points, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out[0].r).toBeNull();
  });
});
