#pragma once

// Talks to the SAIAS command line (saias.cmd) and to the local hub from the Windows app.

#include <windows.h>

#include <filesystem>
#include <optional>
#include <string>
#include <string_view>

namespace saias::cli {

inline constexpr unsigned short hub_port = 8090;

// The SAIAS folder (it holds saias.cmd and catalog\catalog.json), found from the executable's
// location upwards. Empty when the app runs outside a SAIAS folder.
std::filesystem::path project_folder();

struct Captured {
    bool started = false;
    DWORD exit_code = 1;
    std::string output;
};

// Runs "saias.cmd <arguments>" without a window and returns its standard output.
Captured run_capture(std::wstring_view arguments, DWORD timeout_ms);

// Starts "saias.cmd <arguments>". With a console, the window stays open until a key is pressed.
// Returns the process handle (close it with CloseHandle) or nullptr.
HANDLE launch(std::wstring_view arguments, bool console);

struct HubResponse {
    DWORD status = 0;
    std::string body;
};

// Sends a request to the hub on 127.0.0.1. Empty when the hub does not answer.
std::optional<HubResponse> hub_request(const wchar_t* verb, const wchar_t* path, DWORD timeout_ms,
    const wchar_t* headers = nullptr);

} // namespace saias::cli
