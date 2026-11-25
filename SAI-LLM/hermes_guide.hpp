#pragma once

#include <array>
#include <string_view>

namespace sai {

struct GuideStep {
    std::wstring_view label;
    std::wstring_view title;
    std::wstring_view instructions;
    std::wstring_view example;
    std::wstring_view note;
    std::wstring_view copy_label;
    std::wstring_view clipboard;
    std::wstring_view link_label;
    std::wstring_view url;
};

inline constexpr auto hermes_windows_install =
    L"iex (irm https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1)";

inline constexpr auto hermes_providers = LR"(providers:
  sai-router:
    name: SAI Flash
    api: http://127.0.0.1:8082/v1
    transport: chat_completions
    discover_models: false
    default_model: sai-flash
    models:
      sai-flash:
        context_length: 262144
  sai-bonsai:
    name: SAI Smart (Bonsai 2 27B)
    api: http://127.0.0.1:8080/v1
    transport: chat_completions
    discover_models: false
    default_model: sai-smart
    models:
      sai-smart:
        context_length: 200000
        supports_vision: true
  sai-native:
    name: SAI Pro
    api: http://127.0.0.1:8081/v1
    transport: chat_completions
    discover_models: false
    default_model: sai-pro
    models:
      sai-pro:
        context_length: 500000
        supports_vision: true
)";

inline constexpr std::array<GuideStep, 5> hermes_guide{{
    {
        L"Install Hermes", L"Install Hermes Agent on Windows",
        L"Open PowerShell and run the official Nous Research installer. If Hermes is already installed, "
        L"go straight to the version check in a new PowerShell window.",
        hermes_windows_install,
        L"After installation, reopen PowerShell and run hermes --version. The next steps connect Hermes "
        L"to your local models.",
        L"Copy installer", hermes_windows_install,
        L"Installation docs", L"https://hermes-agent.nousresearch.com/docs/user-guide/windows-native",
    },
    {
        L"Get model files", L"Get the SAI models you want to use",
        L"Open SAI Downloads for the exact files. Use the PrismML runtime for Bonsai, "
        L"the Vulkan runtime for Flash, and the Unsloth CUDA runtime for Pro.",
        LR"(%LOCALAPPDATA%\Inkling2Mini
  unsloth-vulkan\llama-server.exe
  unsloth-cuda\llama-server.exe
  models\LFM3-1.7B-Q4_K_M.gguf           sai-flash
  models\Inkling-2-Mini-UD-Q4_K_XL.gguf sai-pro
  models\mmproj-F16.gguf               sai-pro images
  Inkling-2-Mini-direct.jinja
  Inkling-2-Mini-reasoning.jinja

%LOCALAPPDATA%\Bonsai2
  bin\llama-server.exe
  models\Ternary-Bonsai-2-27B-PTQ1_0.gguf
  models\Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf)",
        L"Set SAI_BONSAI_HOME if Bonsai is installed in another folder. Check the Flash Vulkan "
        L"device names in Sai-models.ini using llama-server.exe --list-devices.",
        L"Copy install folder", LR"(%LOCALAPPDATA%\Inkling2Mini)",
        L"SAI downloads", L"https://github.com/saias-o/sai-llm#downloads",
    },
    {
        L"Start SAI", L"Start the local model server",
        L"Open PowerShell in the SAI project folder and run the command for your model.",
        LR"(.\Launch-Inkling.cmd smart    http://127.0.0.1:8080/v1
.\Launch-Inkling.cmd pro      http://127.0.0.1:8081/v1
.\Launch-Inkling.cmd          http://127.0.0.1:8082/v1)",
        L"Keep the server terminal open. To check a server, open its base URL with /models appended. "
        L"For example, http://127.0.0.1:8080/v1/models should return a JSON model list.",
        L"Copy Smart command", LR"(.\Launch-Inkling.cmd smart)",
        L"SAI launch guide", L"https://github.com/saias-o/sai-llm#run-the-models",
    },
    {
        L"Add providers", L"Add the SAI providers in Hermes",
        L"Run the command below to open Hermes config.yaml. Use Copy provider YAML, paste the block as a "
        L"top-level setting, and save. If providers already has entries, add or update "
        L"sai-router, sai-bonsai, and sai-native under the existing providers key.",
        L"hermes config edit",
        L"Smart uses port 8080, Pro uses 8081, and Flash uses 8082. The copied YAML includes "
        L"the model context limits and uses local, keyless connections.",
        L"Copy provider YAML", hermes_providers,
        L"Provider docs", L"https://hermes-agent.nousresearch.com/docs/integrations/providers#named-custom-providers",
    },
    {
        L"Choose a model", L"Select a SAI model and start chatting",
        L"Run hermes model, choose the SAI provider for your installed model, then run hermes chat "
        L"and send a short message. To switch in an active chat, use one of these commands.",
        LR"(/model custom:sai-router:sai-flash
/model custom:sai-bonsai:sai-smart
/model custom:sai-native:sai-pro)",
        L"Hermes Desktop uses the same configuration. Open or restart it and choose a SAI model from "
        L"the chat model menu. If a model cannot connect, check that its server is running and the "
        L"model weights for that profile are installed.",
        L"Copy model command", L"hermes model",
        L"Hermes Desktop docs", L"https://hermes-agent.nousresearch.com/docs/user-guide/desktop",
    },
}};

} // namespace sai
