#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { capture } from "./capture.ts";
import { chainToEntry, classify, exportsDiff, findTargets } from "./analyze.ts";
import { measure } from "./counterfactual.ts";
import { buildReport, render } from "./report.ts";

const { values, positionals } = parseArgs({
  options: {
    root: { type: "string", default: "." },
    json: { type: "boolean", default: false },
    "skip-measure": { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const query = positionals[0];
if (!query) {
  console.error("usage: why-kept <package-or-path> [--root <dir>] [--json] [--skip-measure]");
  process.exit(1);
}

const root = resolve(values.root);
const matchesTarget = (id: string) => id.includes(`/node_modules/${query}/`) || id.includes(query);

try {
  const snap = await capture(root, matchesTarget);
  const targets = findTargets(snap, query);
  if (targets.length === 0) {
    console.log(`"${query}" is not in the module graph — nothing was kept.`);
    process.exit(0);
  }
  const kept = targets.filter((t) => snap.rendered.has(t.id));
  if (kept.length === 0) {
    console.log(`"${query}" is in the module graph but fully tree-shaken out — nothing was kept.`);
    process.exit(0);
  }

  const chain = chainToEntry(snap, kept[0].id);
  const causes = await classify(snap, targets, query, root);
  const hasEsmTargets = kept.some((t) => t.format !== "cjs");
  const deltas = values["skip-measure"] ? [] : await measure(root, query, snap, hasEsmTargets);
  const report = buildReport(query, root, snap, chain, exportsDiff(snap, targets), causes, deltas);

  console.log(values.json ? JSON.stringify(report, null, 2) : render(report));
} catch (error) {
  console.error(`build failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
