# sai-llm

Local PC LLM agents for real work. SAI-LLM includes three model profiles and a native C++ hardware advisor.

## Quick start (Windows)

1. Clone this repository.
2. Run `Install-SAI.cmd`. It checks your hardware, recommends profiles, installs Node.js 22 with winget if needed, downloads the runtimes and models, configures `sai-flash` for your GPU, sets up Hermes and creates an **SAI** desktop shortcut. Running it again is safe: complete files are kept and interrupted downloads resume.
3. Run `Start-SAI.cmd` or the **SAI** shortcut. It opens [Llama Chat](http://127.0.0.1:8090/) with `sai-flash`, `sai-smart` and `sai-pro` and the web tools. Hermes uses the same server at `http://127.0.0.1:8090/v1`.

`Install-SAI.cmd` options: `-Profiles flash,smart,pro` to choose profiles, `-Yes` to accept the defaults, `-Check` to report what is installed without changing anything, `-NoHermes` and `-NoShortcut`.

## Hardware advisor

The advisor reads your CPU, installed RAM, GPU and VRAM. It recommends the most capable profile your hardware is expected to run and an everyday profile with a target of 20 generated tokens per second on a short prompt. If no profile is expected to reach that target, it recommends `sai-flash`. These estimates use hardware rules and require no model downloads or benchmarks.

On Windows, open **Hermes Setup** in the advisor for an installation walkthrough and a copyable Hermes configuration for the SAI profiles.

Build with CMake 3.20 or newer and a C++20 compiler. On Windows, with Visual Studio and its C++ desktop workload installed, run the following from the repository root in PowerShell.

```powershell
cmake -S SAI-LLM -B build
cmake --build build --config Release
.\build\Release\SAI-LLM.exe
```

With a single-configuration CMake generator, the executable is `build\SAI-LLM.exe`. The Linux and macOS builds use a terminal interface.

```sh
cmake -S SAI-LLM -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
./build/SAI-LLM
```

## Chat

Open **Chat** and choose a model and a reasoning setting. If the server is offline, Chat offers to start it and sends your draft once the selected model is ready. If you cancel startup, the draft stays in the composer. Each request includes the previous turns in that conversation. Conversations are saved under `%LOCALAPPDATA%\SAI-LLM\Conversations`.

- **Attachments** accepts PDFs with every model. The app extracts text locally and uses Windows OCR on scanned pages. Scanned pages require a Windows OCR language. PDFs are limited to 32 MB per file.
- **Images** accept PNG and JPEG files up to 5 MB on `sai-smart` and `sai-pro`. Earlier images appear as filename references when a conversation switches to `sai-flash`.
- **Options** has separate **Memory** and **System Prompt** tabs. Saved settings apply to the next message in every conversation on this PC and are stored in `%LOCALAPPDATA%\SAI-LLM\settings.json`.

The Windows CMake build fetches a pinned PDFium runtime and copies `pdfium.dll` next to the executable. Keep those files together for PDF extraction. An offline build can use `-DSAI_PDFIUM_DIR=<extracted directory>`. [PDFium downloads](https://github.com/bblanchon/pdfium-binaries/releases/tag/chromium%2F8165)

## Llama Chat, Hermes and web search

`Start-SAI.cmd` runs the SAI hub, `hub/sai-hub.js`, on port 8090. The hub starts the `sai-flash` router, which serves Llama Chat, the llama.cpp web UI, and lists `sai-smart` and `sai-pro` next to `sai-flash` in its model selector. Selecting a model loads it and unloads the others; `sai-smart` and `sai-pro` start through `Launch-Inkling.cmd`. Set `SAI_HUB_EXCLUSIVE=0` to keep several models loaded, or `SAI_HUB_PORT` to change the port. Ctrl+C in the hub window stops the hub and the servers it started. Server logs are under `%LOCALAPPDATA%\SAI-LLM\BackendLogs`.

The hub is needed because no single llama-server build runs every profile: `sai-smart` requires the PrismML fork and `sai-pro` the Unsloth build. It also exposes the three profiles on one OpenAI-compatible endpoint, `http://127.0.0.1:8090/v1`, and loads a requested model automatically.

**Web search.** `mcp/sai-web.js` is an MCP server shipped with SAI-LLM. It needs no API key and gives the models three tools:

| Tool | Use |
| --- | --- |
| `web_search` | Searches DuckDuckGo and Bing and merges the results. Accepts a region such as `fr-fr` and a time range. |
| `web_fetch` | Reads a page or PDF as Markdown. Pages that need JavaScript are rendered with the installed Chrome, Edge or Brave. Long pages are paginated. |
| `web_research` | Searches and reads the best pages in one call. |

The `sai-flash` router starts it for Llama Chat, which asks before each tool call until you choose **Always allow**. Local and private network addresses are blocked unless `SAI_WEB_ALLOW_PRIVATE=1` is set. Set `SAI_BROWSER` to use another Chromium browser. Test it from a terminal with `node mcp\sai-web.js search "your query"`.

**Hermes.** `Install-SAI.cmd` installs Hermes with the official installer if it is missing. It adds a `sai` provider for `http://127.0.0.1:8090/v1` and the `sai-web` MCP server to the Hermes `config.yaml`, after saving a `.bak-sai-*` copy, and can make SAI the default model. Switch models in a chat with `/model custom:sai:sai-flash`, `/model custom:sai:sai-smart` or `/model custom:sai:sai-pro`.

## Model profiles

| Profile | Model weights | Context limit | Default reasoning |
| --- | --- | ---: | --- |
| `sai-pro` | Inkling 2 Mini UD-Q4_K_XL, 8 active experts | 500,000 | `xhigh` |
| `sai-smart` | PrismML Ternary Bonsai 2 27B PTQ1_0 | 200,000 | `medium` |
| `sai-flash` | LFM3-1.7B Q4_K_M | 262,144 | `off` |

SAI opens existing Inkling conversations saved under `sai-max` as `sai-pro`. The `sai-max` name is reserved for Qwen 4 27B in Q4 once its weights are available.

## Downloads

For `sai-smart`, use the PrismML build of llama.cpp. The tested version is `prism-b12128-d7b2896` for Windows x64 with CUDA 12.4. Extract its binary archive and CUDA runtime DLL archive into `%LOCALAPPDATA%\Bonsai2\bin\`. Put `Ternary-Bonsai-2-27B-PTQ1_0.gguf` and `Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf` under `%LOCALAPPDATA%\Bonsai2\models\`. Set `SAI_BONSAI_HOME` to reuse an installation elsewhere. The Windows launcher can also reuse `D:\LLM\bonsai2` when present. [Tested PrismML release](https://github.com/PrismML-Eng/llama.cpp/releases/tag/prism-b12128-d7b2896) · [Bonsai GGUF downloads](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/tree/main)

The Windows launcher expects the other profiles’ assets under `%LOCALAPPDATA%\Inkling2Mini`.

| Asset | Required for | Destination |
| --- | --- | --- |
| [Inkling-2-Mini-UD-IQ1_S.gguf](https://huggingface.co/unsloth/Inkling-2-Mini-GGUF/resolve/45fd08764f2b0bf16b03a5483a80e5c7aaec8772/Inkling-2-Mini-UD-IQ1_S.gguf) (7.76 GB) | Optional standalone Inkling CPU launcher | `models\` |
| [LFM3-1.7B-Q4_K_M.gguf](https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF/resolve/cd0c74c575b5c416f3011b5b4c298077f26ca8c2/LFM3-1.7B-Q4_K_M.gguf) (1.10 GB) | `sai-flash` | `models\` |
| [Unsloth llama.cpp Vulkan for Windows x64](https://github.com/unslothai/llama.cpp/releases/download/b12588-mix-c0c3de8/app-b12588-mix-c0c3de8-windows-x64-vulkan.zip) | Windows model router | Extract into `unsloth-vulkan\` |
| [Unsloth llama.cpp CPU for Windows x64](https://github.com/unslothai/llama.cpp/releases/download/b12588-mix-c0c3de8/app-b12588-mix-c0c3de8-windows-x64-cpu.zip) | Optional standalone Inkling launcher with a custom context argument | Extract into `unsloth-cpu\` |
| [Inkling-2-Mini-UD-Q4_K_XL.gguf](https://huggingface.co/unsloth/Inkling-2-Mini-GGUF/resolve/45fd08764f2b0bf16b03a5483a80e5c7aaec8772/Inkling-2-Mini-UD-Q4_K_XL.gguf) (17.63 GB) | `sai-pro` | `models\` |
| [mmproj-F16.gguf](https://huggingface.co/unsloth/Inkling-2-Mini-GGUF/resolve/45fd08764f2b0bf16b03a5483a80e5c7aaec8772/mmproj-F16.gguf) (639 MB) | `sai-pro` image support | `models\` |
| [Unsloth llama.cpp CUDA 12 portable for Windows x64](https://github.com/unslothai/llama.cpp/releases/download/b12631-mix-acc0843/app-b12631-mix-acc0843-windows-x64-cuda12-portable.zip) | `sai-pro` | Extract into `unsloth-cuda\` |

Extract each runtime ZIP so that `llama-server.exe` is directly inside its destination directory. Copy the two `.jinja` files from [`templates/`](templates/) directly into `%LOCALAPPDATA%\Inkling2Mini`. The model weights and runtimes retain their upstream licenses.

## Run the models

Run the command for the profile you want to use. Each server runs in its own terminal.

```powershell
.\Launch-Inkling.cmd smart
.\Launch-Inkling.cmd pro
.\Launch-Inkling.cmd
```

| Profile | Base URL | Notes |
| --- | --- | --- |
| `sai-smart` | `http://127.0.0.1:8080/v1` | Uses Bonsai CUDA with a 200,000-token context and a Q4 KV cache. The SAI chats can reuse an existing `bonsai-2-27b` server at its configured context size. |
| `sai-pro` | `http://127.0.0.1:8081/v1` | Uses Unsloth CUDA to split Inkling between NVIDIA VRAM and system RAM. |
| `sai-flash` | `http://127.0.0.1:8082/v1` | Uses `Sai-models.local.ini` if present, or `Sai-models.ini`. |

Set `BONSAI_CTX` or `BONSAI_EFFORT` before launch to override the [Bonsai launcher's](bonsai/Start-Bonsai.cmd) defaults of 200,000 tokens and `medium` reasoning effort. Stop Bonsai with Ctrl+C in its terminal or run `.\bonsai\Stop-Bonsai.ps1` in PowerShell. Use `-WhatIf` to check which process it would stop.

The Flash preset uses a two-device Vulkan split. For a single GPU, copy `Sai-models.local.ini.example` to `Sai-models.local.ini`. Run `llama-server.exe --list-devices` from the extracted Vulkan directory and set `device` in `[sai-flash]` to the reported name. For CPU-only Flash, set `device = none` and `n-gpu-layers = 0` in the local preset. Review `threads` and `threads-batch` to suit your CPU.

The optional standalone Inkling CPU launcher accepts a context size, an explicit port and `quality` to use all eight experts. For example, run `.\Launch-Inkling.cmd 10240 8083 quality`.

In Hermes, configure a custom OpenAI-compatible provider with the corresponding local endpoint and select the profile ID from the table. [Hermes provider setup](https://hermes-agent.nousresearch.com/docs/integrations/providers)

## License

The project is distributed under [GPL-3.0](LICENSE). The chat templates adapt the original Thinking Machines Lab template and are distributed under the [Apache 2.0 license](templates/LICENSE-APACHE). [Upstream Inkling 2 Mini chat template](https://huggingface.co/thinkingmachines/Inkling-2-Mini/blob/b85c3cfa615fc413cc9af3379f491b963f3b586a/chat_template.jinja)

The bundled [PicoJSON header](SAI-LLM/third_party/picojson.h) is distributed under its BSD 2-Clause license.
