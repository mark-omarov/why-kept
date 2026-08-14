import type { Snapshot } from "./capture.ts";
import type { Cause, ChainLink, ExportsDiff } from "./analyze.ts";
import { SIDE_EFFECT_FREE_LABEL, type Delta } from "./counterfactual.ts";
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
  chain: ChainLink[];
  exports: ExportsDiff[];
  causes: Cause[];
  deltas: Delta[];
}

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (text: string) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = paint("1");
const dim = paint("2");
const green = paint("32");
const yellow = paint("33");
const marks = { high: "●", medium: "◐", low: "○" };

export function reconcile(causes: Cause[], deltas: Delta[]): Cause[] {
  const flag = deltas.find((delta) => delta.label === SIDE_EFFECT_FREE_LABEL);
  if (!flag || flag.gzip !== 0) return causes;
  return causes.map((cause) =>
    cause.kind === "no-sideeffects-flag"
      ? { ...cause, detail: `${cause.detail} (measured below: adding the flag saves nothing here)` }
      : cause,
  );
}

export function buildReport(
  query: string,
  root: string,
  env: string,
  versions: string | null,
  snap: Snapshot,
  chain: ChainLink[],
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
    keptBytes: exports.reduce((sum, row) => sum + row.bytes, 0),
    totalBytes: snap.bytes,
    totalGzip: snap.gzip,
    chain,
    exports,
    causes,
    deltas,
  };
}

export function render(report: Report, limit = 8): string {
  const plural = report.keptModules === 1 ? "module" : "modules";
  const envTag = report.env === "client" ? "" : ` ${dim(`[env: ${report.env}]`)}`;
  const rows = report.exports.slice(0, limit);
  const width = Math.max(...rows.map((row) => kb(row.bytes).length));
  const lines = [
    `${bold(`why-kept ${report.query}`)}${envTag} — ${report.keptModules} ${plural} kept · bundle ${kb(report.totalBytes)} (${kb(report.totalGzip)} gzip)`,
    ...(report.versions ? [`${bold("versions")} ${report.versions}`] : []),
    "",
    bold("import chain"),
    `  ${report.chain
      .map(
        (link, index) =>
          (index === 0 ? "" : dim(link.dynamic ? " ⇢ " : " → ")) + shortId(link.id, report.root),
      )
      .join("")}`,
    ...(report.chain.some((link) => link.dynamic) ? [dim("  ⇢ dynamic import")] : []),
    "",
    bold(`kept modules ${dim("(largest first, sizes before minify)")}`),
    ...rows.map(
      (row) =>
        `  ${kb(row.bytes).padStart(width)}  ${shortId(row.id, report.root)}  ${
          row.format === "cjs"
            ? dim("cjs")
            : dim(`kept ${row.kept.length} exports, removed ${row.removed.length}`)
        }`,
    ),
    ...(report.exports.length > limit
      ? [
          dim(
            `  … ${report.exports.length - limit} more (--limit ${report.exports.length} or --json for all)`,
          ),
        ]
      : []),
    "",
    bold("why it is kept"),
    ...report.causes.flatMap((cause) => [
      `  ${yellow(marks[cause.confidence])} ${bold(cause.kind)}${confidenceTag(cause.confidence)} — ${cause.detail}`,
      dim(`      fix: ${cause.fix}`),
    ]),
    ...(report.causes.length === 0 ? [dim("  nothing suspicious — imported and used")] : []),
    "",
    bold("measured by rebuilding"),
    ...report.deltas.flatMap((delta) => [
      delta.gzip === null || delta.bytes === null
        ? dim(`  ${delta.label}`)
        : delta.gzip === 0
          ? `  ${delta.label}: ${dim("no change")}`
          : `  ${delta.label}: bundle shrinks ${green(`${kb(delta.gzip)} gzip`)} ${dim(`(${kb(delta.bytes)} raw)`)}`,
      ...(delta.note ? [dim(`      ${delta.note}`)] : []),
    ]),
  ];
  return lines.join("\n");
}

function confidenceTag(confidence: "high" | "medium" | "low"): string {
  return confidence === "high" ? "" : dim(confidence === "medium" ? " (likely)" : " (possible)");
}

function kb(bytes: number): string {
  return bytes < 1000 ? `${bytes} B` : `${(bytes / 1000).toFixed(1)} kB`;
}
