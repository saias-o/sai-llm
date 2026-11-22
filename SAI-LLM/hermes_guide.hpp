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
    name: SAI Router
    api: http://127.0.0.1:8080/v1
    transport: chat_completions
    discover_models: false
    default_model: sai-flash
    models:
      sai-flash:
        context_length: 262144
      sai-smart:
        context_length: 65536
      sai-big:
        context_length: 200000
  sai-native:
    name: SAI Max
    api: http://127.0.0.1:8081/v1
    transport: chat_completions
    discover_models: false
    default_model: sai-max
    models:
      sai-max:
        context_length: 1048576
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
        L"Open SAI Downloads for the exact files. For the Windows router, extract the Vulkan runtime "
        L"and put the model weights and chat templates in these locations.",
        LR"(%LOCALAPPDATA%\Inkling2Mini
  unsloth-vulkan\llama-server.exe
  models\LFM3-1.7B-Q4_K_M.gguf           sai-flash
  models\Inkling-2-Mini-UD-IQ1_S.gguf   sai-smart and sai-big
  Inkling-2-Mini-direct.jinja
  Inkling-2-Mini-reasoning.jinja)",
        L"Copy both templates from the project's templates folder. Check the Vulkan device names in "
        L"Sai-models.ini using llama-server.exe --list-devices. The download guide lists single-GPU "
        L"and CPU-only settings. SAI Max downloads its own checkpoint when Compose starts.",
        L"Copy install folder", LR"(%LOCALAPPDATA%\Inkling2Mini)",
        L"SAI downloads", L"https://github.com/saias-o/sai-llm#downloads",
    },
    {
        L"Start SAI", L"Start the local model server",
        L"Open PowerShell in the SAI project folder. Use the first command for Flash, Smart and Big. "
        L"For Max, use the second command on a compatible Docker GPU host. Run each server in its own terminal.",
        LR"(.\Launch-Inkling.cmd          http://127.0.0.1:8080/v1
.\Launch-Inkling.cmd max      http://127.0.0.1:8081/v1)",
        L"Keep the server terminal open. To check a server, open its base URL with /models appended. "
        L"For example, http://127.0.0.1:8080/v1/models should return a JSON model list.",
        L"Copy router command", LR"(.\Launch-Inkling.cmd)",
        L"SAI launch guide", L"https://github.com/saias-o/sai-llm#run-the-models",
    },
    {
        L"Add providers", L"Add the SAI providers in Hermes",
        L"Run the command below to open Hermes config.yaml. Use Copy provider YAML, paste the block as a "
        L"top-level setting, and save. If providers already has entries, add sai-router and sai-native "
        L"under it and keep one providers key. If it says providers: {}, replace that line with the block.",
        L"hermes config edit",
        L"SAI Router lists sai-flash, sai-smart and sai-big on port 8080. SAI Max lists sai-max on "
        L"port 8081. The copied YAML includes the context limits for all four models and uses local, "
        L"keyless connections.",
        L"Copy provider YAML", hermes_providers,
        L"Provider docs", L"https://hermes-agent.nousresearch.com/docs/integrations/providers#named-custom-providers",
    },
    {
        L"Choose a model", L"Select a SAI model and start chatting",
        L"Run hermes model, choose SAI Router or SAI Max, then select an installed model. Run hermes chat "
        L"and send a short message. To switch in an active chat, use one of these commands.",
        LR"(/model custom:sai-router:sai-flash
/model custom:sai-router:sai-smart
/model custom:sai-router:sai-big
/model custom:sai-native:sai-max)",
        L"Hermes Desktop uses the same configuration. Open or restart it and choose a SAI model from "
        L"the chat model menu. If a model cannot connect, check that its server is running and the "
        L"model weights for that profile are installed.",
        L"Copy model command", L"hermes model",
        L"Hermes Desktop docs", L"https://hermes-agent.nousresearch.com/docs/user-guide/desktop",
    },
}};

} // namespace sai
