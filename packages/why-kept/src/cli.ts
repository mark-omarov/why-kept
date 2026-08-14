#!/usr/bin/env node
import { parseArgs } from "node:util";
import { isAbsolute, resolve } from "node:path";

import { capture, loadConfigWithout } from "./capture.ts";
import { chainToEntry, classify, exportsDiff, findTargets, versionSummary } from "./analyze.ts";
import { measure } from "./counterfactual.ts";
import { buildReport, reconcile, render } from "./report.ts";

const { values, positionals } = parseArgs({
  options: {
    root: { type: "string", default: "." },
    env: { type: "string", default: "client" },
    "exclude-plugin": { type: "string", multiple: true, default: [] },
    limit: { type: "string", default: "8" },
    json: { type: "boolean", default: false },
    "skip-measure": { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const { env, json, "exclude-plugin": excludePlugins, "skip-measure": skipMeasure } = values;

const [query] = positionals;
if (!query) {
  console.error(
    "usage: why-kept <package-or-path> [--root <dir>] [--env <name>] [--exclude-plugin <name>] [--limit <n>] [--json] [--skip-measure]",
  );
  process.exit(1);
}

process.env.WHY_KEPT = "1";
const root = resolve(values.root);
const matchesTarget = (id: string) => id.includes(`/node_modules/${query}/`) || id.includes(query);

const progress = (msg: string) => {
  if (process.stderr.isTTY) process.stderr.write(`\x1b[2m${msg}\x1b[0m\n`);
};

const exitEarly = (result: string, message: string) => {
  console.log(json ? JSON.stringify({ query, result }) : message);
  process.exit(0);
};

try {
  const baseOverrides = await loadConfigWithout(root, excludePlugins);
  progress(`building (${env})…`);
  const snap = await capture(root, matchesTarget, baseOverrides, env);
  const targets = findTargets(snap, query);
  if (targets.length === 0) {
    exitEarly("not-in-graph", `"${query}" is not in the module graph — nothing was kept.`);
  }
  const kept = targets.filter((target) => snap.rendered.has(target.id));
  if (kept.length === 0) {
    const external = targets.some(
      (target) => !isAbsolute(target.id) && !target.id.startsWith("\0"),
    );
    if (external) {
      exitEarly(
        "external",
        `"${query}" is external in this build — imported at runtime, not bundled (typical for SSR environments).`,
      );
    }
    exitEarly(
      "tree-shaken",
      `"${query}" is in the module graph but fully tree-shaken out — nothing was kept.`,
    );
  }

  const largest = kept.reduce((max, target) =>
    (snap.rendered.get(target.id)?.bytes ?? 0) > (snap.rendered.get(max.id)?.bytes ?? 0)
      ? target
      : max,
  );
  const chain = chainToEntry(snap, largest.id);
  const measured = {
    isPackage: kept.some((target) => target.id.includes(`/node_modules/${query}/`)),
    hasEsm: kept.some((target) => target.format !== "cjs"),
  };
  if (!skipMeasure) progress("measuring with variant rebuilds…");
  const deltas = skipMeasure ? [] : await measure(root, query, snap, measured, baseOverrides, env);
  const causes = reconcile(await classify(snap, targets, query, root), deltas);
  const report = buildReport(
    query,
    root,
    env,
    versionSummary(kept),
    snap,
    chain,
    exportsDiff(snap, targets),
    causes,
    deltas,
  );

  const limit = Number(values.limit);
  console.log(
    json
      ? JSON.stringify(report, null, 2)
      : render(report, Number.isFinite(limit) && limit > 0 ? limit : 8),
  );
} catch (error) {
  console.error(`build failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
