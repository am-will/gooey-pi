# Reference and clean-room record

Prime Work is an independently authored desktop client for Prime Agent. It follows common macOS split-view, chat, terminal, browser, and code-review interaction patterns. No proprietary application source code or bundled assets were copied.

Public product references consulted for feature behavior and high-level visual study:

- https://learn.chatgpt.com/docs/app
- https://learn.chatgpt.com/docs/use-chatgpt
- https://learn.chatgpt.com/docs/projects
- https://learn.chatgpt.com/docs/browser
- https://learn.chatgpt.com/docs/integrated-terminal
- https://learn.chatgpt.com/docs/code-review
- https://learn.chatgpt.com/docs/environments/git-worktrees
- https://learn.chatgpt.com/docs/plugins
- https://learn.chatgpt.com/docs/automations
- https://learn.chatgpt.com/docs/app-server

The OMP pi-plug mark (`assets/brand/omp-icon.svg`) is sourced from the MIT-licensed oh-my-pi repository (`can1357/oh-my-pi`, `assets/icon.svg`, © Mario Zechner and Can Bölük). OMP integration behavior was derived from the public docs at https://omp.sh/ and the oh-my-pi repository documentation; see `docs/omp-integration.md`.

The bundled Persian/Arabic UI face (`public/fonts/vazirmatn-arabic-var.woff2`) is derived from Vazirmatn (© Saber Rastikerdar), licensed under the SIL Open Font License 1.1; the license text ships alongside it as `public/fonts/LICENSE-vazirmatn.txt`. It was produced locally from the unmodified upstream release archive `https://github.com/rastikerdar/vazirmatn/releases/download/v33.003/vazirmatn-v33.003.zip` (release `v33.003`, archive SHA-256 `0a9afd41967e6f57096a56a181a23f81a2b999b62f1f2a4e4b26736580854fdb`) by subsetting `fonts/variable/Vazirmatn[wght].ttf` to the Arabic-script code points declared in the `@font-face` `unicode-range` in `src/styles/base.css`, retaining the `wght` axis and every layout feature: `pyftsubset 'Vazirmatn[wght].ttf' --output-file=vazirmatn-arabic-var.woff2 --flavor=woff2 --with-zopfli --layout-features='*' --name-IDs='*' --name-legacy --notdef-outline --no-hinting --unicodes='U+0600-06FF,U+0750-077F,U+08A0-08FF,U+FB50-FDFF,U+FE70-FEFF,U+200C-200E,U+2010-2011,U+204F,U+2E41'`. The committed subset is 44,604 bytes, SHA-256 `ab1a8bda119e1d380bb3199997ea7d00182fe026ee35c911027dfa54e5add87b`. Renderer assets are not covered by `scripts/release/dependency-pins.json`, which pins executable and npm supply-chain artifacts under `vendor/`; git history over `public/fonts/` and this record form the integrity boundary for the font bytes.

The Prime Intellect butterfly mark is sourced from the MIT-licensed Prime Agent repository (`PrimeIntellect-ai/prime-agent`, `assets/brand/prime-butterfly*.svg`) and from the official Prime Intellect website wordmark. The Prime Work app-icon tile, product name, copy, CSS tokens, components, and application code were authored for this client. Reference screenshots downloaded into `research/` are research-only and are not distributed in packaged application files. OpenAI, ChatGPT, and Codex are trademarks of their respective owner; Prime Work does not imply affiliation with them.
