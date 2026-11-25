#pragma once

#include <array>
#include <string_view>

namespace saias {

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

// Same provider and MCP server that Install-SAIAS.cmd writes to the Hermes config.yaml.
inline constexpr auto hermes_config = LR"(providers:
  saias:
    name: SAIAS (local)
    api: http://127.0.0.1:8090/v1
    transport: chat_completions
    discover_models: false
    default_model: saias-smart
    models:
      saias-flash:
        context_length: 262144
      saias-smart:
        context_length: 200000
        supports_vision: true
      saias-pro:
        context_length: 500000
        supports_vision: true
mcp_servers:
  saias-web:
    command: node
    args:
    - C:/path/to/saias-llm/mcp/saias-web.js
    timeout: 120
)";

inline constexpr std::array<GuideStep, 4> hermes_guide{{
    {
        L"Install", L"Install SAIAS and Hermes",
        L"Open PowerShell in the saias-llm folder and run the installer. It checks your hardware, downloads "
        L"the runtimes and models for the recommended profiles, installs Node.js and Hermes Agent if they are "
        L"missing, and adds the SAIAS provider and web search to Hermes.",
        LR"(.\Install-SAIAS.cmd
.\Install-SAIAS.cmd --profiles flash,smart --yes
.\Install-SAIAS.cmd --check)",
        L"Running it again is safe: installed files are kept and interrupted downloads resume. --check reports "
        L"what is installed without changing anything.",
        L"Copy command", LR"(.\Install-SAIAS.cmd)",
        L"Quick start", L"https://github.com/saias-o/saias-llm#quick-start-windows",
    },
    {
        L"Start SAIAS", L"Start the SAIAS hub",
        L"Run Start-SAIAS.cmd or double-click the SAIAS desktop shortcut. The hub serves Llama Chat and one "
        L"OpenAI-compatible endpoint for saias-flash, saias-smart and saias-pro, and loads a model when it is "
        L"first requested.",
        LR"(.\Start-SAIAS.cmd

Llama Chat   http://127.0.0.1:8090/
Hermes API   http://127.0.0.1:8090/v1)",
        L"Keep the hub window open while you use the models. Ctrl+C stops the hub and the model servers "
        L"it started.",
        L"Copy command", LR"(.\Start-SAIAS.cmd)",
        L"Open Llama Chat", L"http://127.0.0.1:8090/",
    },
    {
        L"Check Hermes", L"Check the SAIAS provider in Hermes",
        L"Install-SAIAS.cmd adds this configuration for you. To set it up by hand, run the command below, "
        L"paste the copied YAML as top-level settings, merge it with any existing providers and mcp_servers "
        L"entries, and replace the path with your saias-llm folder.",
        L"hermes config edit",
        L"All three profiles share port 8090, so Hermes needs a single saias provider. saias-web gives Hermes "
        L"the same keyless web search, page reading and research tools as Llama Chat.",
        L"Copy provider YAML", hermes_config,
        L"Provider docs", L"https://hermes-agent.nousresearch.com/docs/integrations/providers#named-custom-providers",
    },
    {
        L"Choose a model", L"Select a SAIAS model and start chatting",
        L"Run hermes chat and send a short message. To switch models in an active chat, use one of these "
        L"commands.",
        LR"(/model custom:saias:saias-flash
/model custom:saias:saias-smart
/model custom:saias:saias-pro)",
        L"Hermes Desktop uses the same configuration: restart it and choose a SAIAS model from the chat model "
        L"menu. If a model cannot connect, check that the hub is running and that its profile is installed "
        L"(saias.cmd status).",
        L"Copy model command", L"/model custom:saias:saias-smart",
        L"Hermes Desktop docs", L"https://hermes-agent.nousresearch.com/docs/user-guide/desktop",
    },
}};

} // namespace saias
