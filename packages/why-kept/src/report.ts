import type { Snapshot } from "./capture.ts";
import type { Cause, ExportsDiff } from "./analyze.ts";
import type { Delta } from "./counterfactual.ts";
import { shortId } from "./analyze.ts";

export interface Report {
  query: string;
  root: string;
  env: string;
  versions: string | null;
  keptModules: number;
  keptBytes: number;
  totalBytes: number;
  totalGzip: number;
  chain: string[];
  exports: ExportsDiff[];
  causes: Cause[];
  deltas: Delta[];
}

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint("1");
const dim = paint("2");
const green = paint("32");
const yellow = paint("33");
const mark = { high: "●", medium: "◐", low: "○" };

export function reconcile(causes: Cause[], deltas: Delta[]): Cause[] {
  const flag = deltas.find((d) => d.label === "as side-effect free");
  if (!flag || flag.gzip !== 0) return causes;
  return causes.map((c) =>
    c.kind === "no-sideeffects-flag"
      ? { ...c, detail: `${c.detail} (measured below: adding the flag saves nothing here)` }
      : c,
  );
}

export function buildReport(
  query: string,
  root: string,
  env: string,
  versions: string | null,
  snap: Snapshot,
  chain: string[],
  exports: ExportsDiff[],
  causes: Cause[],
  deltas: Delta[],
): Report {
  return {
    query,
    root,
    env,
    versions,
    keptModules: exports.length,
    keptBytes: exports.reduce((sum, e) => sum + e.bytes, 0),
    totalBytes: snap.bytes,
    totalGzip: snap.gzip,
    chain,
    exports,
    causes,
    deltas,
  };
}

export function render(r: Report, limit = 8): string {
  const plural = r.keptModules === 1 ? "module" : "modules";
  const envTag = r.env === "client" ? "" : ` ${dim(`[env: ${r.env}]`)}`;
  const lines = [
    `${bold(`why-kept ${r.query}`)}${envTag} — ${r.keptModules} ${plural} kept · bundle ${kb(r.totalBytes)} (${kb(r.totalGzip)} gzip)`,
    ...(r.versions ? [`${bold("versions")} ${r.versions}`] : []),
    "",
    bold("import chain"),
    `  ${r.chain.map((id) => shortId(id, r.root)).join(dim(" → "))}`,
    "",
    bold(`kept modules ${dim("(largest first, sizes before minify)")}`),
    ...(() => {
      const rows = r.exports.slice(0, limit);
      const width = Math.max(...rows.map((e) => kb(e.bytes).length));
      return rows.map(
        (e) =>
          `  ${kb(e.bytes).padStart(width)}  ${shortId(e.id, r.root)}  ${
            e.format === "cjs"
              ? dim("cjs")
              : dim(`kept ${e.kept.length} exports, removed ${e.removed.length}`)
          }`,
      );
    })(),
    ...(r.exports.length > limit
      ? [
          dim(
            `  … ${r.exports.length - limit} more (--limit ${r.exports.length} or --json for all)`,
          ),
        ]
      : []),
    "",
    bold("why it is kept"),
    ...r.causes.flatMap((c) => [
      `  ${yellow(mark[c.confidence])} ${bold(c.kind)}${confidenceTag(c.confidence)} — ${c.detail}`,
      dim(`      fix: ${c.fix}`),
    ]),
    ...(r.causes.length === 0 ? [dim("  nothing suspicious — imported and used")] : []),
    "",
    bold("measured by rebuilding"),
    ...r.deltas.flatMap((d) => [
      Number.isNaN(d.gzip)
        ? dim(`  ${d.label}`)
        : d.gzip === 0
          ? `  ${d.label}: ${dim("no change")}`
          : `  ${d.label}: bundle shrinks ${green(`${kb(d.gzip)} gzip`)} ${dim(`(${kb(d.bytes)} raw)`)}`,
      ...(d.note ? [dim(`      ${d.note}`)] : []),
    ]),
  ];
  return lines.join("\n");
}

function confidenceTag(confidence: "high" | "medium" | "low"): string {
  return confidence === "high" ? "" : dim(confidence === "medium" ? " (likely)" : " (possible)");
}

function kb(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} kB`;
}
