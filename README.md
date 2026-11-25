# SAIAS

**Self-updating Artificial Intelligence Agent System.** Local AI. Always up to date.

**Never search for a local AI model again.**

Stop comparing benchmarks, searching for models, choosing quantizations and configuring inference engines. SAIAS selects the best open-weight models for your hardware and keeps them up to date. Chat, code and automate, locally.

- **Hardware-aware.** Adapted to your machine.
- **Always evolving.** Each release ships the best open-weight models available. Pull the update and run the installer again to get them.
- **Local-first.** Your hardware, your data.
- **Agentic by design.** Beyond simple conversations, with web search and Hermes Agent built in.

Tools such as Ollama and LM Studio make local models easier to use. SAIAS takes model management off the user's plate entirely: you never need to know what Qwen, Gemma, parameter counts or quantization are. You pick a profile, `saias-flash`, `saias-smart` or `saias-pro`, and SAIAS supplies the right model and runtime for your PC.

This repository, saias-llm, contains the installer, the model catalog, the SAIAS hub with Llama Chat and web search, the agent evaluation suite and the SAIAS Windows app.

## Quick start (Windows)

**Installer.** Run `SAIAS-Setup-<version>.exe`. It installs SAIAS for your user account (no administrator rights), then opens a console that picks, downloads and verifies the models for your PC. SAIAS then lives in the notification area.

**From the source.**

1. Clone this repository, or download it as a ZIP and extract it.
2. Run `Install-SAIAS.cmd`. It installs a private copy of Node.js if needed, checks your hardware, recommends profiles, downloads and verifies the runtimes and models, sets up web search, and connects Hermes Agent and the coding tools it finds (OpenCode, Codex, Claude Code). It can also put `saias` on your PATH and create a **SAIAS** desktop shortcut. Running it again is safe: verified files are kept and interrupted downloads resume.
3. Run `Start-SAIAS.cmd` or the **SAIAS** shortcut. It opens [Llama Chat](http://127.0.0.1:8090/) with every installed profile and the web tools. Hermes and the coding tools use the same server at `http://127.0.0.1:8090`.

Already have model files or llama.cpp builds on disk? Run `saias adopt <folder>` before installing so they are reused instead of downloaded.

## Linux and macOS

```sh
git clone https://github.com/saias-o/saias-llm.git && cd saias-llm
./saias install
./saias start --open
```

`./saias` uses Node.js 22 or later, or installs a private, checksum-verified copy. The catalog has Linux x64 variants (CUDA, Vulkan, or CPU) and Apple Silicon variants (Metal); `saias-pro` on a Mac needs 48 GB of unified memory. These variants are new and less tested than the Windows ones. The SAIAS desktop app is Windows-only; on Linux and macOS, `saias status` and `saias recommend` give the same information.

## Privacy

SAIAS sends no telemetry. It connects to the internet only to download the catalog (GitHub), runtimes and models (GitHub and Hugging Face) and Node.js (nodejs.org), and, when a model uses the web tools, to search engines and the pages it reads. The SAIAS app checks the catalog for updates at start and every six hours. Conversations, settings and models stay on your PC.

## How SAIAS compares

| | SAIAS | Ollama | LM Studio | Jan |
| --- | --- | --- | --- | --- |
| Who picks the model | The catalog, for your hardware | You, by name | You, in a model browser | You |
| Model names in your tools | Stable profiles (`saias-pro`) | Model tags | Model files | Model names |
| Agent tools set up for you | Hermes, OpenCode, Codex, Claude Code, web search | No | No | No |
| Open source | Yes (GPL-3.0) | Yes | No | Yes |

SAIAS builds on the same llama.cpp engine. Ollama, LM Studio and Jan are better choices when you want to pick and try many models yourself.

## Command line

`saias.cmd` (or `node src/cli.js` on any system with Node.js 22+) manages everything:

| Command | What it does |
| --- | --- |
| `saias install` | Detects the hardware, installs the recommended profiles and connects your tools. Options: `--profiles flash,smart,pro`, `--yes`, `--check`, `--no-tools`, `--no-path`, `--no-shortcut`. |
| `saias connect [tool...]` | Points `hermes`, `opencode`, `codex` or `claude` at SAIAS; without names, every detected tool. |
| `saias start` | Starts the hub. `--open` opens Llama Chat. |
| `saias stop` | Stops the hub and its model servers. |
| `saias claude` | Runs Claude Code on a SAIAS model (`--profile smart`; other options go to Claude Code). |
| `saias update` | Fetches the latest catalog and installs the newer models it selects for this PC. `--check` only reports. |
| `saias rollback` | Returns to the models installed before the last update. |
| `saias adopt <folder>` | Registers runtimes and model files already on disk. `--move` moves them into the SAIAS folder (same drive only), `--verify` checks their sha256. |
| `saias status` | Shows the hardware, the installed profiles, their measured speed and the hub state. `--json` for scripts. |
| `saias recommend` | Shows which profile suits this PC best, from the catalog and measured speeds. `--json` for scripts. |
| `saias clean` | Deletes files no installed or previous profile uses. |

## How SAIAS works

**Profiles, not models.** Clients only ever see three stable names: `saias-flash`, `saias-smart` and `saias-pro`. The [catalog](catalog/catalog.json) says which model, llama.cpp runtime and server settings each profile uses on which hardware. A new catalog version can replace the model behind a profile, and `saias update` installs it without any change in Llama Chat, Hermes or other clients.

**Catalog.** It lists:

- `runtimes`: llama.cpp builds with their platform, GPU backend, the model formats they support, and archive URLs with sha256;
- `models`: model files with sizes, sha256 and licenses, plus what they need from a runtime (for example `ptq1_0` weights);
- `profiles`: ordered variants, each with hardware requirements (`nvidiaVramGB`, `ramGB`), a model, a runtime, llama-server settings and a reasoning map.

The installer picks the first variant the PC can run. `"device": "auto"` selects the GPU with the most memory, or the CPU when there is none.

**Hub.** `saias start` runs `src/hub.js` on port 8090. Each profile runs in its own llama-server, started when it is first requested; by default one model is kept in memory at a time (`SAIAS_HUB_EXCLUSIVE=0` keeps several). A llama-server in router mode without models serves Llama Chat and the web tools. Server logs are in `%LOCALAPPDATA%\SAIAS\logs`.

**Reasoning.** Clients send the standard OpenAI `reasoning_effort` (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`). The hub translates it into the chat template arguments of the model behind the profile and uses the nearest level the model supports. `GET /v1/models` lists each profile's levels, vision support and context length.

**Network access.** The hub listens on `127.0.0.1` only. To use SAIAS from another device, set `SAIAS_HUB_HOST=0.0.0.0` and `SAIAS_API_KEY`; requests from other devices that reach a model or a tool then need `Authorization: Bearer <key>`, and Llama Chat asks for the key in its settings. See [SECURITY.md](SECURITY.md).

**Runtimes.** The published llama.cpp builds lack three chat parser fixes that tool calls need. [runtimes/](runtimes/) keeps them as patches with a script that builds SAIAS runtimes on top of the official archives.

**Data folder.** Runtimes, models, logs and the installation state live in `%LOCALAPPDATA%\SAIAS` (set `SAIAS_HOME` to use another drive). Downloads are verified against the catalog sha256 before use.

## Profiles in the current catalog

| Profile | Model | Runtime | Context | Requirements |
| --- | --- | --- | ---: | --- |
| `saias-flash` | LFM3 1.7B Q4_K_M | llama.cpp b12631: Vulkan or CPU, Metal on macOS | 262,144 | Any PC |
| `saias-smart` | Ternary Bonsai 2 27B PTQ1_0, images | PrismML llama.cpp b12128: CUDA, Metal; Vulkan or CPU is slower | 200,000 (65,536 on Vulkan or CPU) | NVIDIA GPU with 8 GB VRAM, Apple Silicon with 16 GB, or 16 GB RAM |
| `saias-pro` | Inkling 2 Mini UD-Q4_K_XL, images | llama.cpp b12631: CUDA, Metal | 500,000 (200,000 on Metal) | NVIDIA GPU with 8 GB VRAM and 32 GB RAM, or Apple Silicon with 48 GB |

`saias-flash` is fast but small: use it for chat, and `saias-smart` or `saias-pro` for agent and coding work. Model licenses are shown, and must be accepted, during installation.

## Web search

`mcp/saias-web.js` is an MCP server shipped with SAIAS-LLM. It needs no API key and gives the models three tools:

| Tool | Use |
| --- | --- |
| `web_search` | Searches DuckDuckGo and Bing and merges the results. Accepts a region such as `fr-fr` and a time range. |
| `web_fetch` | Reads a page or PDF as Markdown. Pages that need JavaScript are rendered with the installed Chrome, Edge or Brave. Long pages are paginated. |
| `web_research` | Searches and reads the best pages in one call. |

The hub starts it for Llama Chat, which asks before each tool call until you choose **Always allow**. Local and private network addresses are blocked unless `SAIAS_WEB_ALLOW_PRIVATE=1` is set. Set `SAIAS_BROWSER` to use another Chromium browser. Test it from a terminal with `node mcp\saias-web.js search "your query"`.

## Coding tools

The hub serves three APIs on `http://127.0.0.1:8090`: OpenAI Chat Completions and Responses (`/v1/chat/completions`, `/v1/responses`) and the Anthropic Messages API (`/v1/messages`). The reasoning level each tool asks for (`reasoning_effort`, `reasoning.effort` or Anthropic `thinking`) is translated for the model behind the profile.

| Tool | Set up by `saias connect` | Use |
| --- | --- | --- |
| OpenCode | Adds a `saias` provider to `~/.config/opencode/opencode.json`. Your default model changes only if you agree. | `/models`, then `saias/saias-pro` |
| Codex | Adds a `saias` provider and profile to `~/.codex/config.toml`; your default model is not changed. | `codex --profile saias` |
| Claude Code | Nothing: your Claude Code settings are not changed. | `saias claude`, or `saias claude --profile smart` |
| Hermes Agent | Adds a `saias` provider and the web search server (see below). | `/model custom:saias:saias-pro` |

Every config file is copied to `<file>.bak-saias-<timestamp>` before it is changed. Tools started this way start the hub in the background if it is not running; `saias stop` stops it. The hub keeps one model in memory at a time, so use one profile per tool session: switching profiles reloads the model. `saias claude` therefore points every Claude Code model slot (main, background and subagents) at the same profile.

Other OpenAI-compatible tools (Continue, Cline, Aider, ...) work with the base URL `http://127.0.0.1:8090/v1`, any API key, and a model named `saias-flash`, `saias-smart` or `saias-pro`.

## Hermes

`saias install` installs Hermes Agent with the official installer if it is missing. It adds a `saias` provider for `http://127.0.0.1:8090/v1` and the `saias-web` MCP server to the Hermes `config.yaml`, after saving a `.bak-saias-*` copy, and can make SAIAS the default model. Switch models in a chat with `/model custom:saias:saias-flash`, `/model custom:saias:saias-smart` or `/model custom:saias:saias-pro`.

## Evaluation and benchmarks

These commands load models, so they take a while; nothing runs them automatically except the optional speed measurement at the end of `saias install`.

**`saias bench`** measures, for each installed profile, the load time, the prompt reading speed (512, 4,096 and 16,384 tokens) and the generation speed (256 tokens), from llama-server's own timings. Results are saved in the installation state, shown by `saias status` with a rating (`fast` from 20 tokens/s, `usable` from 8, otherwise `slow`), and turned into advice such as the best interactive profile for this PC.

**`saias eval`** runs an agent-focused evaluation and saves a JSON report:

| Suite | What it checks |
| --- | --- |
| `tools` | Calling the right tool with valid, typed arguments; not calling tools when none is needed; parallel calls; using tool results; a multi-step file exploration with a simulated project. |
| `code` | Writing or fixing JavaScript functions, checked by hidden tests that run in a separate Node.js process with the permission model and a time limit. |
| `context` | Finding and combining facts hidden at different depths of 4k to 128k-token inputs; sizes beyond the model's context are skipped. |
| `instruct` | Strict JSON output, exact list formats and system prompt rules. |

`--endpoint URL --model NAME` evaluates any OpenAI-compatible server, which is how a candidate model is compared with the current profile before it enters the catalog. `--repeat 3` averages runs, `--reasoning medium` sets the reasoning level, `--list` shows the tasks.

`npm test` checks the suites, the benchmark and the core logic against a fake server, without loading any model.

## SAIAS app (Windows)

`SAIAS.exe` is the desktop app. It stays in the notification area: right-click the icon to open Llama Chat, see which profile is loaded, start or stop SAIAS, check for updates or quit. Closing the window keeps it running; **Quit SAIAS** also stops the models. **Start with Windows** starts it hidden (`SAIAS.exe --tray`) and gets the hub ready.

Model updates stay manual. The app checks the published catalog at start and every six hours (`saias update --check --json`); when a newer one is available, a banner lists the profile changes and the download size, with an **Update** button. The update runs in a console so its progress is visible, and the hub restarts with the new models.

### Hardware advisor

The advisor reads your CPU, installed RAM, GPU and VRAM. It recommends the most capable profile your hardware is expected to run and an everyday profile with a target of 20 generated tokens per second on a short prompt. If no profile is expected to reach that target, it recommends `saias-flash`. These estimates use hardware rules and require no model downloads or benchmarks.

On Windows, open **Hermes Setup** in the advisor for an installation walkthrough and a copyable Hermes configuration for the SAIAS profiles.

Build with CMake 3.20 or newer and a C++20 compiler. On Windows, with Visual Studio and its C++ desktop workload installed, run the following from the repository root in PowerShell.

```powershell
cmake -S SAIAS-LLM -B build
cmake --build build --config Release
.\build\Release\SAIAS.exe
```

With a single-configuration CMake generator, the executable is `build\SAIAS.exe`. The Linux and macOS builds use a terminal interface.

```sh
cmake -S SAIAS-LLM -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
./build/SAIAS
```

**Installer.** `scripts\Build-Installer.ps1` builds the app in `build-release` and packages it with [Inno Setup 6](https://jrsoftware.org/isinfo.php) into `dist\SAIAS-Setup-<version>.exe` (version from `package.json`). Set `SAIAS_SIGN_CERT` to a code signing certificate thumbprint to sign the app and the installer with `signtool`; unsigned installers trigger a SmartScreen warning. Uninstalling stops SAIAS and asks before deleting the downloaded models in `%LOCALAPPDATA%\SAIAS`.

### Chat

Open **Chat** and choose a model and a reasoning setting. If SAIAS is not running, Chat offers to start it and sends your draft once the selected model is ready. If you cancel startup, the draft stays in the composer. Each request includes the previous turns in that conversation. Conversations are saved under `%LOCALAPPDATA%\SAIAS\Conversations`.

- **Attachments** accepts PDFs with every model. The app extracts text locally and uses Windows OCR on scanned pages. Scanned pages require a Windows OCR language. PDFs are limited to 32 MB per file.
- **Images** accept PNG and JPEG files up to 5 MB on `saias-smart` and `saias-pro`. Earlier images appear as filename references when a conversation switches to `saias-flash`.
- **Options** has separate **Memory** and **System Prompt** tabs. Saved settings apply to the next message in every conversation on this PC and are stored in `%LOCALAPPDATA%\SAIAS\settings.json`.

The Windows CMake build fetches a pinned PDFium runtime and copies `pdfium.dll` next to the executable. Keep those files together for PDF extraction. An offline build can use `-DSAIAS_PDFIUM_DIR=<extracted directory>`. [PDFium downloads](https://github.com/bblanchon/pdfium-binaries/releases/tag/chromium%2F8165)

## Adding or changing a model

1. Add the model to `models` in [catalog/catalog.json](catalog/catalog.json) with pinned URLs (a commit, not `main`), sizes, sha256 values and its license. Hugging Face lists sha256 values in `https://huggingface.co/api/models/<repo>/tree/<revision>`; GitHub lists release asset digests in its releases API.
2. Add a runtime if it needs one, with `supports` listing the model formats it can run.
3. Add or change a variant under the profile. Variants are tried in order, so put the fastest one first.
4. Increase `version` (a date, `YYYY.MM.DD`). Installed copies pick it up with `saias update`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md): model proposals come with `saias eval` reports, and `npm test` runs without any model.

## License

The project is distributed under [GPL-3.0](LICENSE). The chat templates adapt the original Thinking Machines Lab template and are distributed under the [Apache 2.0 license](templates/LICENSE-APACHE). [Upstream Inkling 2 Mini chat template](https://huggingface.co/thinkingmachines/Inkling-2-Mini/blob/b85c3cfa615fc413cc9af3379f491b963f3b586a/chat_template.jinja)

The bundled [PicoJSON header](SAIAS-LLM/third_party/picojson.h) is distributed under its BSD 2-Clause license.
