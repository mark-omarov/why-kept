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

const query = positionals[0];
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

try {
  const baseOverrides = await loadConfigWithout(root, values["exclude-plugin"]);
  progress(`building (${values.env})…`);
  const snap = await capture(root, matchesTarget, baseOverrides, values.env);
  const targets = findTargets(snap, query);
  if (targets.length === 0) {
    console.log(`"${query}" is not in the module graph — nothing was kept.`);
    process.exit(0);
  }
  const kept = targets.filter((t) => snap.rendered.has(t.id));
  if (kept.length === 0) {
    const external = targets.some((t) => !isAbsolute(t.id) && !t.id.startsWith("\0"));
    console.log(
      external
        ? `"${query}" is external in this build — imported at runtime, not bundled (typical for SSR environments).`
        : `"${query}" is in the module graph but fully tree-shaken out — nothing was kept.`,
    );
    process.exit(0);
  }

  const chain = chainToEntry(snap, kept[0].id);
  const hasEsmTargets = kept.some((t) => t.format !== "cjs");
  if (!values["skip-measure"]) progress("measuring with variant rebuilds…");
  const deltas = values["skip-measure"]
    ? []
    : await measure(root, query, snap, hasEsmTargets, baseOverrides, values.env);
  const causes = reconcile(await classify(snap, targets, query, root), deltas);
  const report = buildReport(
    query,
    root,
    values.env,
    versionSummary(kept),
    snap,
    chain,
    exportsDiff(snap, targets),
    causes,
    deltas,
  );

  console.log(values.json ? JSON.stringify(report, null, 2) : render(report, Number(values.limit)));
} catch (error) {
  console.error(`build failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
