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

const tty = process.stdout.isTTY;
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const mark = { high: "●", medium: "◐", low: "○" };

export function reconcile(causes: Cause[], deltas: Delta[]): Cause[] {
  const flag = deltas.find((d) => d.label === "if marked side-effect free");
  if (!flag || flag.gzip !== 0) return causes;
  return causes.map((c) =>
    c.kind === "no-sideeffects-flag"
      ? {
          ...c,
          detail: `${c.detail}; measured below: the flag would save nothing here — kept for its used exports`,
        }
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

export function render(r: Report): string {
  const plural = r.keptModules === 1 ? "module" : "modules";
  const envTag = r.env === "client" ? "" : ` ${dim(`[env: ${r.env}]`)}`;
  const lines = [
    `${bold(`why-kept ${r.query}`)}${envTag} — ${r.keptModules} ${plural} kept, ${kb(r.keptBytes)} rendered ${dim("(pre-minify)")}; bundle: ${kb(r.totalBytes)} minified, ${kb(r.totalGzip)} gzip`,
    ...(r.versions ? [`${bold("versions")} ${r.versions}`] : []),
    "",
    bold("import chain"),
    `  ${r.chain.map((id) => shortId(id, r.root)).join(dim(" → "))}`,
    "",
    bold("exports (kept / removed by tree-shaking)"),
    ...r.exports
      .slice(0, 8)
      .map(
        (e) =>
          `  ${shortId(e.id, r.root)}  ${dim(kb(e.bytes))}  ${
            e.format === "cjs"
              ? dim("cjs — export-level data n/a")
              : `kept ${e.kept.length}, removed ${e.removed.length}`
          }`,
      ),
    ...(r.exports.length > 8 ? [dim(`  … ${r.exports.length - 8} more`)] : []),
    "",
    bold("why it is kept"),
    ...r.causes.flatMap((c) => [
      `  ${mark[c.confidence]} [${c.confidence}] ${bold(c.kind)} — ${c.detail}`,
      dim(`      fix: ${c.fix}`),
    ]),
    ...(r.causes.length === 0
      ? [dim("  no specific cause detected; it is simply imported and used")]
      : []),
    "",
    bold("measured (variant rebuilds, whole-bundle delta)"),
    ...r.deltas.flatMap((d) => [
      Number.isNaN(d.gzip)
        ? dim(`  ${d.label}`)
        : `  ${d.label}: ${bold(`−${kb(d.gzip)} gzip`)} ${dim(`(−${kb(d.bytes)} raw)`)}`,
      ...(d.note ? [dim(`      ${d.note}`)] : []),
    ]),
  ];
  return lines.join("\n");
}

function kb(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} kB`;
}
