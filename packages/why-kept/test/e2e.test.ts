import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { capture, loadConfigWithout } from "../src/capture.ts";
import { chainToEntry, classify, findTargets } from "../src/analyze.ts";
import { measure, sideEffectFreePlugin } from "../src/counterfactual.ts";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url));
const matches = (query: string) => (id: string) => id.includes(`/node_modules/${query}/`);

describe("lodash (CommonJS)", () => {
  test("classifies cjs and measures a real removal delta", { timeout: 120_000 }, async () => {
    const root = fixture("lodash-cjs");
    const snap = await capture(root, matches("lodash"));
    const targets = findTargets(snap, "lodash");
    const kept = targets.filter((t) => snap.rendered.has(t.id));

    expect(kept.length).toBeGreaterThanOrEqual(1);
    expect(kept.some((t) => t.format === "cjs")).toBe(true);
    expect(snap.rendered.get(kept[0].id)!.bytes).toBeGreaterThan(50_000);

    const causes = await classify(snap, targets, "lodash");
    expect(causes.some((c) => c.kind === "cjs")).toBe(true);

    const chain = chainToEntry(snap, kept[0].id);
    expect(snap.modules.get(chain[0].id)?.isEntry).toBe(true);

    const deltas = await measure(root, "lodash", snap, { isPackage: true, hasEsm: false });
    const removal = deltas.find((d) => d.label === "without lodash");
    expect(removal!.gzip).toBeGreaterThan(1000);
  });
});

describe("core-js (bare side-effect import)", () => {
  test("detects the bare import as the cause", { timeout: 120_000 }, async () => {
    const root = fixture("side-effect");
    const snap = await capture(root, matches("core-js"));
    const targets = findTargets(snap, "core-js");
    expect(targets.filter((t) => snap.rendered.has(t.id)).length).toBeGreaterThan(0);

    const causes = await classify(snap, targets, "core-js");
    const bare = causes.find((c) => c.kind === "side-effect-import");
    expect(bare?.detail).toContain("core-js");
  });

  test(
    "side-effect-free variant overrides a declared sideEffects flag",
    { timeout: 120_000 },
    async () => {
      const root = fixture("side-effect");
      const plain = await capture(root, () => false);
      const flagged = await capture(root, () => false, {
        plugins: [sideEffectFreePlugin("core-js")],
      });
      const of = (snap: typeof plain) =>
        [...snap.modules.values()].filter((m) => m.id.includes("/node_modules/core-js/"));
      expect(of(plain).length).toBeGreaterThan(0);
      expect(of(plain).some((m) => m.sideEffects === false)).toBe(false);
      expect(of(flagged).every((m) => m.sideEffects === false)).toBe(true);
    },
  );
});

describe("marked (no sideEffects flag)", () => {
  test("flags the missing sideEffects declaration", { timeout: 120_000 }, async () => {
    const root = fixture("no-flag");
    const snap = await capture(root, matches("marked"));
    const targets = findTargets(snap, "marked");
    expect(targets.filter((t) => snap.rendered.has(t.id)).length).toBeGreaterThan(0);

    const causes = await classify(snap, targets, "marked");
    expect(causes.some((c) => c.kind === "no-sideeffects-flag")).toBe(true);
  });
});

describe("dynamic import", () => {
  test("captures split chunks and crosses the dynamic boundary", { timeout: 120_000 }, async () => {
    const snap = await capture(fixture("dynamic"), matches("marked"));
    const kept = findTargets(snap, "marked").filter((t) => snap.rendered.has(t.id));
    expect(kept.length).toBeGreaterThan(0);

    const chain = chainToEntry(snap, kept[0].id);
    expect(snap.modules.get(chain[0].id)?.isEntry).toBe(true);
    expect(chain.some((l) => l.dynamic)).toBe(true);
  });
});

describe("scoped package", () => {
  test("matches @scope/name queries", { timeout: 120_000 }, async () => {
    const snap = await capture(fixture("scoped"), matches("@sindresorhus/is"));
    const kept = findTargets(snap, "@sindresorhus/is").filter((t) => snap.rendered.has(t.id));
    expect(kept.length).toBeGreaterThan(0);
  });
});

describe("environments", () => {
  test("client build excludes ssr-only dependencies", { timeout: 120_000 }, async () => {
    const snap = await capture(fixture("env-ssr"), matches("marked"), {}, "client");
    expect(findTargets(snap, "marked")).toHaveLength(0);
  });

  test("--env ssr sees marked as externalized, not bundled", { timeout: 120_000 }, async () => {
    const snap = await capture(fixture("env-ssr"), matches("marked"), {}, "ssr");
    const targets = findTargets(snap, "marked");
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((t) => !snap.rendered.has(t.id))).toBe(true);
    expect(targets.some((t) => t.id === "marked")).toBe(true);
  });

  test("unknown environment fails with the available list", { timeout: 120_000 }, async () => {
    await expect(capture(fixture("env-ssr"), matches("marked"), {}, "edge")).rejects.toThrow(
      /available: client, ssr/,
    );
  });
});

describe("--exclude-plugin", () => {
  test("strips a named plugin from the loaded config", { timeout: 120_000 }, async () => {
    const root = fixture("excluded-plugin");
    await expect(capture(root, () => false)).rejects.toThrow(/boom plugin ran/);

    const overrides = await loadConfigWithout(root, ["boom"]);
    const snap = await capture(root, () => false, overrides);
    expect(snap.bytes).toBeGreaterThan(0);
  });
});
