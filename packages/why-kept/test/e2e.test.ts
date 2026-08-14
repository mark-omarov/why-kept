import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { capture } from "../src/capture.ts";
import { chainToEntry, classify, findTargets } from "../src/analyze.ts";
import { measure } from "../src/counterfactual.ts";

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
    expect(snap.modules.get(chain[0])?.isEntry).toBe(true);

    const deltas = await measure(root, "lodash", snap, false);
    const removal = deltas.find((d) => d.label === "if removed entirely");
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
