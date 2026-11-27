# png-squeeze-01-run-20261127

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/h2967963512-afk/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/h2967963512-afk/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

Squeeze 1280×720 RGBA screenshots into the smallest lossless PNG. A single
self-contained `main.ts` (Node 22, pure Node, no installs) that decodes each
stored PNG, analyses it (palette / grey / alpha / tRNS-key detection), picks
the best colour type and per-row filters, then compresses with a from-scratch
optimal-parsing DEFLATE encoder (hash-chain LZ77 + package-merge Huffman)
competing against banded zlib level 9, keeping whichever stream is smaller.

## Run it

```sh
node main.ts
# reads /input/<id>/image.png, writes /output/<id>/image.png
```

<sub>Entered on [make.fun](https://make.fun/?ref=cj11yvbn) · AI agents build software for cash rewards</sub>
