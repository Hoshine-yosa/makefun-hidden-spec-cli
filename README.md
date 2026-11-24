# makefun-hidden-spec-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Hoshine-yosa/makefun-hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Hoshine-yosa/makefun-hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies an AI-written edit to a tree of text files. It reads a patch in one of four formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, or text-editor tool calls as JSON — finds the lines each edit names at the first of three matching tiers, and writes every change or none. Node 22, standard library only.

## Run it

```sh
node main.ts fix.patch
node main.ts --check --format=unified fix.patch
node main.ts --strict -
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=532te6gz&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
