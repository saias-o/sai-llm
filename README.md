# sai-llm

Local PC LLM agents for real work. SAI-LLM includes four model profiles and a native C++ hardware advisor.

## Hardware advisor

The advisor reads your CPU, installed RAM, GPU and VRAM. It recommends the most capable profile your hardware is expected to run and an everyday profile with a target of 20 generated tokens per second on a short prompt. If no profile is expected to reach that target, it recommends `sai-flash`. These estimates use hardware rules and require no model downloads or benchmarks.

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

## Model profiles

| Profile | Model weights | Context limit | Default reasoning |
| --- | --- | ---: | --- |
| `sai-max` | Official Inkling 2 Mini checkpoint, default 8 active experts | 1,048,576 | `xhigh` |
| `sai-big` | Inkling 2 Mini UD-IQ1_S, 5 active experts | 200,000 | `medium` |
| `sai-smart` | Inkling 2 Mini UD-IQ1_S, 4 active experts | 65,536 | `low` |
| `sai-flash` | LFM3-1.7B Q4_K_M | 262,144 | `off` |

## Downloads

Download the assets for the profiles you plan to use. The Windows launcher expects these paths under `%LOCALAPPDATA%\Inkling2Mini`.

| Asset | Required for | Destination |
| --- | --- | --- |
| [Inkling-2-Mini-UD-IQ1_S.gguf](https://huggingface.co/unsloth/Inkling-2-Mini-GGUF/resolve/45fd08764f2b0bf16b03a5483a80e5c7aaec8772/Inkling-2-Mini-UD-IQ1_S.gguf) (7.76 GB) | `sai-big`, `sai-smart` | `models\` |
| [LFM3-1.7B-Q4_K_M.gguf](https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF/resolve/cd0c74c575b5c416f3011b5b4c298077f26ca8c2/LFM3-1.7B-Q4_K_M.gguf) (1.10 GB) | `sai-flash` | `models\` |
| [Unsloth llama.cpp Vulkan for Windows x64](https://github.com/unslothai/llama.cpp/releases/download/b12588-mix-c0c3de8/app-b12588-mix-c0c3de8-windows-x64-vulkan.zip) | Windows model router | Extract into `unsloth-vulkan\` |
| [Unsloth llama.cpp CPU for Windows x64](https://github.com/unslothai/llama.cpp/releases/download/b12588-mix-c0c3de8/app-b12588-mix-c0c3de8-windows-x64-cpu.zip) | Optional standalone Inkling launcher with a custom context argument | Extract into `unsloth-cpu\` |
| [Official Inkling 2 Mini checkpoint](https://huggingface.co/thinkingmachines/Inkling-2-Mini) | `sai-max` | Docker downloads the revision pinned in `compose.sai-max.yaml` |

Extract each runtime ZIP so that `llama-server.exe` is directly inside its destination directory. Copy the two `.jinja` files from [`templates/`](templates/) directly into `%LOCALAPPDATA%\Inkling2Mini`. The model weights and runtimes retain their upstream licenses.

## Run the models

The Windows router presets ship with CPU defaults for `sai-big` and `sai-smart`, and a two-device Vulkan split for `sai-flash`. Run `llama-server.exe --list-devices` from the extracted Vulkan directory and check `Sai-modeles.ini` before starting. On a single GPU, set `device` in `[sai-flash]` to its reported name and remove `split-mode` and `tensor-split`. For CPU-only Flash, set `device = none` and `n-gpu-layers = 0`, and remove both split settings. On a different CPU, review `threads`, `threads-batch` and the `[sai-smart]` CPU affinity settings. Removing `cpu-mask` and `cpu-strict` lets the operating system schedule the threads.

```powershell
.\Lancer-Inkling.cmd
```

The router serves `sai-big`, `sai-smart` and `sai-flash` at `http://127.0.0.1:8080/v1` and keeps one model loaded at a time.

For `sai-max`, run the Compose service on a host that meets the GPU and driver requirements in the [official vLLM recipe](https://recipes.vllm.ai/thinkingmachines/Inkling-2-Mini). The service preserves the original model quantization and serves `sai-max` at `http://127.0.0.1:8081/v1`. The context setting reserves capacity for up to 1,048,576 tokens, subject to the host's available GPU memory.

```sh
docker compose -f compose.sai-max.yaml up
```

In Hermes, configure a custom OpenAI-compatible provider with the corresponding local endpoint and select the profile ID from the table. [Hermes provider setup](https://hermes-agent.nousresearch.com/docs/integrations/providers)

## License

The project is distributed under [GPL-3.0](LICENSE). The chat templates adapt the original Thinking Machines Lab template and are distributed under the [Apache 2.0 license](templates/LICENSE-APACHE). [Upstream Inkling 2 Mini chat template](https://huggingface.co/thinkingmachines/Inkling-2-Mini/blob/b85c3cfa615fc413cc9af3379f491b963f3b586a/chat_template.jinja)
