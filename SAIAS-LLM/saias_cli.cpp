#include "saias_cli.hpp"

#include <winhttp.h>

#include <array>
#include <memory>

namespace saias::cli {
namespace {

using Handle = std::unique_ptr<void, decltype(&CloseHandle)>;
using InternetHandle = std::unique_ptr<void, decltype(&WinHttpCloseHandle)>;

std::filesystem::path command_processor() {
    std::array<wchar_t, MAX_PATH> system{};
    const auto length = GetSystemDirectoryW(system.data(), static_cast<UINT>(system.size()));
    return length && length < system.size() ? std::filesystem::path(system.data()) / L"cmd.exe" : std::filesystem::path(L"cmd.exe");
}

} // namespace

std::filesystem::path project_folder() {
    std::array<wchar_t, 32768> name{};
    const auto length = GetModuleFileNameW(nullptr, name.data(), static_cast<DWORD>(name.size()));
    if (!length || length >= name.size()) {
        return {};
    }
    auto folder = std::filesystem::path(std::wstring_view(name.data(), length)).parent_path();
    for (; folder.is_absolute() && folder.has_relative_path(); folder = folder.parent_path()) {
        std::error_code error;
        if (std::filesystem::is_regular_file(folder / L"saias.cmd", error)
            && std::filesystem::is_regular_file(folder / L"catalog" / L"catalog.json", error)) {
            return folder;
        }
    }
    return {};
}

Captured run_capture(std::wstring_view arguments, DWORD timeout_ms) {
    Captured result;
    const auto project = project_folder();
    if (project.empty()) {
        return result;
    }
    SECURITY_ATTRIBUTES inherit{sizeof(inherit), nullptr, TRUE};
    HANDLE read_raw = nullptr;
    HANDLE write_raw = nullptr;
    if (!CreatePipe(&read_raw, &write_raw, &inherit, 0)) {
        return result;
    }
    Handle read(read_raw, CloseHandle);
    Handle write(write_raw, CloseHandle);
    SetHandleInformation(read_raw, HANDLE_FLAG_INHERIT, 0);

    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdOutput = write_raw;
    startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    startup.hStdInput = nullptr;
    // The full path: cmd.exe does not look in the current folder when
    // NoDefaultCurrentDirectoryInExePath is set.
    std::wstring command = L"cmd.exe /d /s /c \"\"" + (project / L"saias.cmd").wstring() + L"\" "
        + std::wstring(arguments) + L"\"";
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(command_processor().c_str(), command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW,
            nullptr, project.c_str(), &startup, &process)) {
        return result;
    }
    result.started = true;
    Handle process_handle(process.hProcess, CloseHandle);
    CloseHandle(process.hThread);
    write.reset();

    std::array<char, 4096> buffer{};
    DWORD read_bytes = 0;
    const auto deadline = GetTickCount64() + timeout_ms;
    while (ReadFile(read_raw, buffer.data(), static_cast<DWORD>(buffer.size()), &read_bytes, nullptr) && read_bytes) {
        result.output.append(buffer.data(), read_bytes);
        if (GetTickCount64() > deadline || result.output.size() > 4 * 1024 * 1024) {
            TerminateProcess(process.hProcess, 1);
            break;
        }
    }
    const auto left = deadline > GetTickCount64() ? static_cast<DWORD>(deadline - GetTickCount64()) : 0;
    if (WaitForSingleObject(process.hProcess, left) != WAIT_OBJECT_0) {
        TerminateProcess(process.hProcess, 1);
    }
    GetExitCodeProcess(process.hProcess, &result.exit_code);
    return result;
}

HANDLE launch(std::wstring_view arguments, bool console) {
    const auto project = project_folder();
    if (project.empty()) {
        return nullptr;
    }
    std::wstring command = L"cmd.exe /d /s /c \"\"" + (project / L"saias.cmd").wstring() + L"\" " + std::wstring(arguments)
        + (console ? L" & echo. & pause\"" : L"\"");
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process{};
    const DWORD flags = console ? CREATE_NEW_CONSOLE : CREATE_NO_WINDOW;
    if (!CreateProcessW(command_processor().c_str(), command.data(), nullptr, nullptr, FALSE, flags,
            nullptr, project.c_str(), &startup, &process)) {
        return nullptr;
    }
    CloseHandle(process.hThread);
    return process.hProcess;
}

std::optional<HubResponse> hub_request(const wchar_t* verb, const wchar_t* path, DWORD timeout_ms, const wchar_t* headers) {
    InternetHandle session(WinHttpOpen(L"SAIAS/1.0", WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME,
        WINHTTP_NO_PROXY_BYPASS, 0), WinHttpCloseHandle);
    if (!session) {
        return std::nullopt;
    }
    const int timeout = static_cast<int>(timeout_ms);
    WinHttpSetTimeouts(session.get(), timeout, timeout, timeout, timeout);
    InternetHandle connection(WinHttpConnect(session.get(), L"127.0.0.1", hub_port, 0), WinHttpCloseHandle);
    if (!connection) {
        return std::nullopt;
    }
    InternetHandle request(WinHttpOpenRequest(connection.get(), verb, path, nullptr, WINHTTP_NO_REFERER,
        WINHTTP_DEFAULT_ACCEPT_TYPES, 0), WinHttpCloseHandle);
    if (!request || !WinHttpSendRequest(request.get(), headers ? headers : WINHTTP_NO_ADDITIONAL_HEADERS,
            headers ? static_cast<DWORD>(-1L) : 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0)
        || !WinHttpReceiveResponse(request.get(), nullptr)) {
        return std::nullopt;
    }
    HubResponse response;
    DWORD size = sizeof(response.status);
    WinHttpQueryHeaders(request.get(), WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX,
        &response.status, &size, WINHTTP_NO_HEADER_INDEX);
    std::array<char, 8192> buffer{};
    DWORD read = 0;
    while (WinHttpReadData(request.get(), buffer.data(), static_cast<DWORD>(buffer.size()), &read) && read) {
        response.body.append(buffer.data(), read);
        if (response.body.size() > 1024 * 1024) {
            break;
        }
    }
    return response;
}

} // namespace saias::cli
