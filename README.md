# site-generator-speed-01-entry

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Rahadian1702/site-generator-speed-01-entry/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Rahadian1702/site-generator-speed-01-entry/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast static site generator for make.fun's site-generator-speed-01: `run(input)` returns byte-for-byte the same output tree makefun-site 1.0.0's `build` returns for the same input — the same pages, the same tag and index pages, the same build report — only faster. Pure JavaScript, standard library only, no dependencies.

## How it is faster

- **Markdown**: inline rendering escapes bulk text between special characters with one replace instead of escaping character by character, recurses on ranges instead of slicing nested content, and the block lexer dispatches on a line's first character with manual checks instead of running a regex per line. Word counts are taken during lexing, not by a second pass over the body.
- **Templates**: each parsed template is compiled once to a straight-line JavaScript function (via `new Function`) instead of being walked node by node on every render, and the `loop` object of a for-loop is only built when the loop's body — including through includes — actually reads it.
- **Slugs**: memoized, with an ASCII fast path that avoids normalization and the per-code-point loop.
- **Front matter**: scanned by line offsets without splitting and rejoining the whole file.
- **Pipeline**: `site`, `tags` and `recent` are built once per case and shared through one root scope instead of being re-spread into every render.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22 or later, standard library only, no install. `main.ts` reads `cases.json` from the input directory, answers each case with `run`, and writes `answers.json` to the output directory.

## Layout

- `solve.js` — the generator: front matter, Markdown, templates, and the build pipeline. `run(input)` returns the output tree (path → text).
- `main.ts` — the harness driver: reads the cases, answers each with `run`, writes the answers.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
