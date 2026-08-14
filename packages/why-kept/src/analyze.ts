import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { init, parse } from "es-module-lexer";
import type { Mod, Snapshot } from "./capture.ts";

export interface Cause {
  kind: "cjs" | "side-effect-import" | "no-sideeffects-flag" | "export-star";
  confidence: "high" | "medium" | "low";
  detail: string;
  fix: string;
}

export interface ExportsDiff {
  id: string;
  format: string;
  kept: string[];
  removed: string[];
  bytes: number;
}

export function findTargets(snap: Snapshot, query: string): Mod[] {
  const asPackage = `/node_modules/${query}/`;
  const all = [...snap.modules.values()];
  const hits = all.filter((m) => m.id.includes(asPackage));
  return hits.length > 0 ? hits : all.filter((m) => m.id.includes(query));
}

export function chainToEntry(snap: Snapshot, from: string): string[] {
  const prev = new Map<string, string>([[from, ""]]);
  const queue = [from];
  for (const id of queue) {
    const m = snap.modules.get(id);
    if (!m) continue;
    if (m.isEntry) {
      const chain: string[] = [];
      for (let cur: string | undefined = id; cur; cur = prev.get(cur)) chain.push(cur);
      return chain;
    }
    for (const importer of [...m.importers, ...m.dynamicImporters]) {
      if (!prev.has(importer)) {
        prev.set(importer, id);
        queue.push(importer);
      }
    }
  }
  return [from];
}

export function exportsDiff(snap: Snapshot, targets: Mod[]): ExportsDiff[] {
  return targets
    .filter((t) => snap.rendered.has(t.id))
    .map((t) => {
      const r = snap.rendered.get(t.id)!;
      return {
        id: t.id,
        format: t.format,
        kept: r.exports,
        removed: t.exports.filter((e) => !r.exports.includes(e)),
        bytes: r.bytes,
      };
    })
    .sort((a, b) => b.bytes - a.bytes);
}

export async function classify(
  snap: Snapshot,
  targets: Mod[],
  query: string,
  root = process.cwd(),
): Promise<Cause[]> {
  await init;
  const causes: Cause[] = [];
  const kept = targets.filter((t) => snap.rendered.has(t.id));

  const cjs = kept.filter((t) => t.format === "cjs");
  if (cjs.length > 0) {
    causes.push({
      kind: "cjs",
      confidence: "high",
      detail: `${cjs.length} of ${kept.length} kept modules are CommonJS; Rolldown tree-shakes CJS exports, but interop retains more than ESM would`,
      fix: "prefer an ESM build or an ESM alternative of this package",
    });
  }

  causes.push(...scanImportStatements(snap, query, root));

  const pkg = kept.length > 0 ? nearestPackageJson(kept[0].id) : null;
  if (pkg && pkg.json.sideEffects === undefined && kept.some((t) => t.sideEffects !== false)) {
    causes.push({
      kind: "no-sideeffects-flag",
      confidence: "medium",
      detail: `${pkg.json.name}/package.json does not declare "sideEffects", so every imported module is assumed side-effectful and kept whole`,
      fix: 'check the measured "if marked side-effect free" delta below; if it is large, ask upstream for a "sideEffects" declaration',
    });
  }

  return dedupe(causes);
}

function scanImportStatements(snap: Snapshot, query: string, root: string): Cause[] {
  const causes: Cause[] = [];
  for (const m of snap.modules.values()) {
    if (!m.code) continue;
    const [imports] = parse(m.code);
    for (const s of imports) {
      if (s.d !== -1 || !s.n || !matchesQuery(s.n, query)) continue;
      const statement = m.code.slice(s.ss, s.se);
      if (/^import\s*['"]/.test(statement)) {
        causes.push({
          kind: "side-effect-import",
          confidence: "high",
          detail: `${shortId(m.id, root)}: \`${statement}\``,
          fix: "a bare import keeps the module purely for its side effects; remove it or import bindings instead",
        });
      } else if (/^export\s*\*/.test(statement)) {
        causes.push({
          kind: "export-star",
          confidence: "low",
          detail: `${shortId(m.id, root)}: \`${statement}\` re-exports everything; namespace re-exports can defeat export-level tree-shaking`,
          fix: "re-export named bindings instead of `export *`",
        });
      }
    }
  }
  return causes;
}

function matchesQuery(specifier: string, query: string): boolean {
  return (
    specifier === query || specifier.startsWith(`${query}/`) || specifier.includes(`/${query}/`)
  );
}

function nearestPackageJson(
  id: string,
): { path: string; json: { name?: string; sideEffects?: unknown } } | null {
  let dir = dirname(id.split("?")[0]);
  while (dir.includes("node_modules") && dir !== dirname(dir)) {
    const path = join(dir, "package.json");
    try {
      return { path, json: JSON.parse(readFileSync(path, "utf8")) };
    } catch {
      dir = dirname(dir);
    }
  }
  return null;
}

function dedupe(causes: Cause[]): Cause[] {
  const seen = new Set<string>();
  return causes.filter((c) => {
    const key = c.kind + c.detail;
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

export function shortId(id: string, root = process.cwd()): string {
  const i = id.lastIndexOf("node_modules/");
  return i === -1 ? id.replace(`${root}/`, "") : id.slice(i + "node_modules/".length);
}
