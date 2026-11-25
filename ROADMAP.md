# SAIAS roadmap

Goal: make SAIAS a serious open-source, local replacement for Claude and Codex that any PC user can install and use.

Today the "self-updating" promise lives only in the README: models are hard-coded in the installer, and several settings only fit the original developer machine. The items below are ordered by impact.

## 1. Deliver "Always up to date" (the core promise)

- **Published model catalog instead of hard-coded models.** A versioned `catalog.json` describes each profile (`flash`, `smart`, `pro`) and its candidate models per hardware tier (VRAM, RAM, CPU only, Apple Silicon), with URLs, sha256 hashes, the runtime to use and its settings. The installer and the hub read it instead of the `$Catalog` in `scripts/Install-SAIAS.ps1`. Downloads are verified by hash, not only by size.
- **Stable profile names, changing models.** Hermes, OpenCode or an IDE keep `saias-smart` forever; the model behind it improves with each catalog release. This is the main difference from Ollama and LM Studio.
- **`saias update`.** Downloads in the background, swaps the model atomically, keeps the previous one for rollback and shows what changed.
- **Public benchmarks.** "Stop comparing benchmarks" is only credible if SAIAS publishes its own. A small agent-focused evaluation suite (tool calling, coding, long context) runs on every candidate before it enters the catalog, and the results are published in the repository.
- **First-run micro-benchmark.** Measure real speed on the machine (generation tokens/s, prompt processing) to tune the quantization and the GPU/RAM split instead of estimating it.

## 2. Easy installation for anyone

- **A real installer.** A signed `.exe` (Inno Setup or MSIX) and a `winget install saias` package: no `git clone`, no PowerShell. Without code signing, SmartScreen warnings stop most users.
- **A tray app instead of console windows.** Starts with Windows, shows the loaded model and available updates, opens Llama Chat. The native C++ app (advisor, chat, Hermes guide) can become this single entry point.
- **Remove machine-specific settings:**
  - the `D:\LLM\bonsai2` fallback;
  - `threads = 12`;
  - the two-GPU Vulkan split in `Saias-models.ini`;
  - the `MotionUpBonsaiAutoStop` name;
  - the separate `Inkling2Mini` and `Bonsai2` folders, replaced by one `%LOCALAPPDATA%\SAIAS\{runtimes,models}` folder.
- **Disk space handling.** Check free space before downloading and let users choose the model drive (`saias-pro` alone needs more than 18 GB).
- **Bundle a portable Node.js** instead of depending on winget.

## 3. Replace Claude and Codex: the agent and coding experience

- **Connect coding tools automatically**, as is already done for Hermes. The installer asks one question: "Which tools do you want to connect?"
  - OpenCode;
  - Continue, Cline or Roo in VS Code;
  - Aider;
  - Codex CLI through a custom provider (check which API it currently requires);
  - Claude Code, by exposing the Anthropic Messages API (`/v1/messages`) on the hub and pointing `ANTHROPIC_BASE_URL` at it. Recent llama-server builds provide it; check the builds SAIAS uses.
- **Tool-calling reliability first.** For an agent it matters more than raw model scores. Add a tool-calling test per profile to the evaluation suite and ship validated chat templates. A 1.7B model like `saias-flash` cannot carry agent work: present it as "fast, for chat" and do not offer it as the default for coding.
- **Honest performance per hardware tier.** 500k tokens of context on 12 GB of VRAM works in theory but is slow for agentic coding, which resends large prompts every turn. Optimize KV cache reuse and state clearly what to expect on each machine.

## 4. Simplify the architecture

- **Target upstream llama.cpp, no forks.** Depending on three builds (PrismML, Unsloth Vulkan, Unsloth CUDA) is the project's biggest fragility and the only reason the hub has to emulate router mode. If the catalog favors models that upstream llama.cpp runs, one router is enough. The hub stays as a stable facade: profile names, OpenAI and Anthropic APIs, optional access token.
- **One CLI**, `saias install | start | update | status | doctor`, instead of today's mix of `.cmd`, PowerShell and Node scripts. This is also the path to **macOS (Apple Silicon) and Linux**, a large share of local LLM users.

## 5. Open-source project hygiene

- **Model weight licenses.** They vary by model; show them and require acceptance in the installer. For example, the LFM license limits commercial use.
- **GitHub Actions CI.** Build the native app, test the hub and the web search MCP server, publish releases with a changelog.
- **Repository front page.** README with a demo GIF, an honest comparison with Ollama, LM Studio and Jan, `CONTRIBUTING.md`, issue templates and a no-telemetry statement. Optionally, opt-in anonymous performance reports to improve hardware recommendations.

## Order of work

1. Model catalog and `saias update`.
2. Remove machine-specific settings and unify the data folder.
3. Connect coding tools (OpenCode, Continue, Claude Code).
4. Signed installer and tray app, then macOS and Linux.
