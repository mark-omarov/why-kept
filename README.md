# why-kept

`why-kept` is a command-line tool that explains why a package survived tree-shaking in a Vite 8 (Rolldown) build, and measures what it costs by rebuilding your app without it. Bundle analyzers like [Sonda](https://sonda.dev) or the official [Vite DevTools](https://devtools.vite.dev) show what is in the bundle. `why-kept` answers the follow-up question: why is it still there, and what would a fix save?

```sh
npx why-kept lodash
```

```
why-kept lodash — 1 module kept · bundle 70.2 kB (25.6 kB gzip)

import chain
  index.html → main.js → lodash/lodash.js

kept modules (largest first, sizes before minify)
  177.1 kB  lodash/lodash.js  cjs

why it is kept
  ● cjs — 1 of 1 kept modules are CommonJS, which limits tree-shaking
      fix: look for an ESM build or an ESM alternative
  ◐ no-sideeffects-flag (likely) — lodash/package.json has no "sideEffects" field,
    so bundlers keep every imported module whole
      fix: if the measured saving below is large, ask upstream to add "sideEffects": false

measured by rebuilding
  without lodash: bundle shrinks 25.1 kB gzip (69.5 kB raw)
      upper bound: a replacement would add its own weight back
  as side-effect free: n/a for CommonJS (the flag only works on ESM)
```

When there is nothing to blame, it says so. The same command against a well-packaged dependency:

```
why it is kept
  nothing suspicious — imported and used

measured by rebuilding
  without @sindresorhus/is: bundle shrinks 3.4 kB gzip (11.0 kB raw)
  as side-effect free: no change
```

## How it works

1. Runs your Vite build in memory. Nothing is written to `dist/`. A plugin snapshots the module graph and Rolldown's per-module `renderedExports`, the post-linking record of what tree-shaking kept and removed.
2. Reports a cause only when it can point at evidence: a CommonJS module format, a bare `import 'pkg'` statement it quotes back to you, a `sideEffects` field it read (or failed to find) in the package.json, an `export *` it found in the code.
3. Rebuilds the app in variants, once without the package and once with it forced side-effect free, then diffs the real minified and gzipped output. Every byte number in the report comes from a build, not an estimate.

Statement-level explanations ("this call survived because Rolldown could not prove it pure") are out of scope. Rolldown keeps no trace of those decisions ([rolldown#4145](https://github.com/rolldown/rolldown/issues/4145), [rolldown#6425](https://github.com/rolldown/rolldown/issues/6425)), and guessing them from outside produces confident nonsense.

## Usage

```sh
why-kept <package-or-path> [--root <dir>] [--env <name>] [--exclude-plugin <name>] [--limit <n>] [--json] [--skip-measure]
```

- `<package-or-path>` matches an npm package name (`lodash`, `@scope/pkg`) or a substring of a module path
- `--root` sets the project root containing your Vite config (default: current directory)
- `--env` picks the Vite environment to analyze (default: `client`; try `--env ssr`)
- `--exclude-plugin` strips a named plugin from the analysis builds, repeatable
- `--limit` caps the kept-modules table (default: 8)
- `--skip-measure` skips the rebuild measurements

The same report is available as data, for scripts, CI, and agents:

```sh
why-kept lodash --json
```

Analysis builds run with `WHY_KEPT=1` in the environment. A config can use it to skip plugins that upload or deploy things on build:

```js
plugins: [react(), !process.env.WHY_KEPT && sentryVitePlugin()]
```

If the graph contains several copies of the package, the report lists each bundled version with its module count. That usually means a dedupe is available.

## Tested on real apps

| App | Stack | Result |
|---|---|---|
| [vitesse](https://github.com/antfu-collective/vitesse) | Vue, Vite 7, 13 plugins | traced a CJS nprogress, measured 1.7 kB gzip |
| [vitesse-lite](https://github.com/antfu-collective/vitesse-lite) | Vue | vue-router: no cause to report, 12.5 kB gzip measured |
| [eftb](https://github.com/shish/eftb) | React, TanStack Router, Vite 8.2 | react-dom: 4 CJS modules, 54.6 kB gzip measured |

`scripts/validate.sh <git-url> <package> [subdir]` runs the tool against any repo.

## Limits

- The project must build with plain `vite build`. Frameworks that orchestrate their own build with virtual entries (Slidev, Nuxt-style setups) are not supported.
- Analysis runs on why-kept's own Vite 8. For a Vite 7 project the result is a preview of that app under Vite 8, and legacy peer tooling (an old `sass`, for example) can fail the build. Vite 5-era stacks generally will.
- CommonJS modules show no export-level data. Their exports resolve at runtime.
- "without X" is an upper bound. If your code imports the package, removing it means replacing it, and the replacement has a size too.
- Per-module sizes in the table are pre-minification and will not sum to the bundle total. The measured numbers are post-minify, post-gzip.

## Development

pnpm workspace. The tool is [`packages/why-kept`](packages/why-kept), about 500 lines across five files. Fixtures in [`fixtures/`](fixtures) are real packages (lodash, core-js, marked, and friends) chosen because each one genuinely exhibits the failure mode its test asserts. Toolchain: tsdown, vitest, oxlint, oxfmt.

```sh
pnpm install
pnpm test
pnpm build
```

MIT
