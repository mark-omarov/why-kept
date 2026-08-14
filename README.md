# why-kept

Explains **why a module survived tree-shaking** in your Vite 8 (Rolldown) build — and what it actually costs, measured by rebuilding, not estimated.

Bundle analyzers show you *what* is in your bundle. `why-kept` answers the next question: *why is it still there, and what would fixing it save?*

```sh
npx why-kept lodash
```

```
why-kept lodash — 1 module kept, 177.1 kB rendered (pre-minify); bundle: 70.2 kB minified, 25.6 kB gzip

import chain
  index.html → main.js → lodash/lodash.js

kept modules (largest first)
  lodash/lodash.js  177.1 kB  cjs

why it is kept
  ● [high] cjs — 1 of 1 kept modules are CommonJS; Rolldown tree-shakes CJS exports, but interop retains more than ESM would
      fix: prefer an ESM build or an ESM alternative of this package
  ◐ [medium] no-sideeffects-flag — lodash/package.json does not declare "sideEffects", so every imported module is assumed side-effectful and kept whole
      fix: check the measured "if marked side-effect free" delta below; if it is large, ask upstream for a "sideEffects" declaration

measured (variant rebuilds, whole-bundle delta)
  cost of presence: −25.1 kB gzip (−69.5 kB raw)
      upper bound of savings — a replacement would add its own weight
  if marked side-effect free: n/a — side-effect flags cannot drop CommonJS require chains
```

## How it works

1. **Capture** — runs your Vite build in-memory (`build.write: false`) with a plugin that snapshots the module graph at `buildEnd` and per-module `renderedExports` / `renderedLength` from the output chunks. These are Rolldown's post-linking ground truth, not estimates.
2. **Classify** — reports only evidence-backed causes, each labeled with confidence: CommonJS input format, bare side-effect imports (`import 'pkg'`), a missing `sideEffects` declaration, `export *` barrels.
3. **Measure** — rebuilds variants (package externalized; package forced side-effect-free) and diffs real minified+gzip output. Rolldown is fast enough that counterfactual rebuilds cost seconds, which is what makes this design practical at all.

What it deliberately does **not** do: guess statement-level purity decisions. Rolldown does not expose a tree-shaking decision trace ([rolldown#4145](https://github.com/rolldown/rolldown/issues/4145), [rolldown#6425](https://github.com/rolldown/rolldown/issues/6425)), and inferring those reasons from outside the bundler produces confidently wrong answers. Everything this tool asserts is either read from the build or measured by rebuilding.

## Usage

```sh
why-kept <package-or-path> [--root <dir>] [--env <name>] [--exclude-plugin <name>] [--limit <n>] [--json] [--skip-measure]
```

- `<package-or-path>` — an npm package name (`lodash`, `@scope/pkg`) or a path substring of a module id
- `--root` — project root containing your Vite config (default: cwd)
- `--env` — which Vite environment to analyze (default: `client`; e.g. `--env ssr`)
- `--exclude-plugin` — strip a named plugin from the analysis builds (repeatable); use for plugins with build side effects like sourcemap uploaders
- `--limit` — max rows in the kept-modules table (default 8)
- `--json` — machine-readable report
- `--skip-measure` — skip the variant rebuilds

Requires Vite ≥ 8 (Rolldown-based).

Analysis builds run with `WHY_KEPT=1` in the environment, so a config can self-gate side-effecting plugins:

```js
plugins: [react(), !process.env.WHY_KEPT && sentryVitePlugin()]
```

If a package appears multiple times in the graph (any depth), the report lists each bundled version with module counts — a dedupe opportunity.

## Known limits

- The analysis builds with why-kept's own Vite 8. Exact for Vite 8 projects; for older Vite projects it is a "your bundle under Vite 8" preview, and legacy peer tooling (e.g. old `sass`) can fail the build.
- Projects whose build is orchestrated by a framework CLI with virtual entries (Slidev, Nuxt-style setups) are out of scope — the project must be buildable by plain `vite build`.
- `renderedLength` is pre-minification; per-module sizes will not sum to the final bundle size. The measured deltas are post-minify and post-gzip — trust those.
- `sideEffects`-flag analysis reads the resolved value; a plugin overriding side effects at resolve/load time can blur package.json attribution.
- Export-level kept/removed data is only available for ESM modules; CJS exports resolve at runtime.

## Development

pnpm workspace: the tool lives in [`packages/why-kept`](packages/why-kept), real-package fixtures (lodash, core-js, marked) in [`fixtures/`](fixtures). Toolchain: tsdown, vitest, oxlint, oxfmt.

```sh
pnpm install
pnpm test
pnpm build
```
