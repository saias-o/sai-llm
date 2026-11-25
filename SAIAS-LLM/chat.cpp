#include "chat.hpp"
#include "third_party/picojson.h"

#include <windows.h>
#include <objbase.h>
#include <winhttp.h>

#include <algorithm>
#include <array>
#include <fstream>
#include <iterator>
#include <mutex>
#include <stdexcept>
#include <system_error>
#include <utility>

namespace saias::chat {
namespace {

using picojson::array;
using picojson::object;
using picojson::value;

struct Level {
    std::wstring_view label;
    const char* key;
    double inkling_value;
};

constexpr std::array levels{
    Level{L"Model default", "default", 0},
    Level{L"Off", "none", 0},
    Level{L"On", "on", 0},
    Level{L"Low", "low", 0.2},
    Level{L"Medium", "medium", 0.7},
    Level{L"High", "high", 0.9},
    Level{L"Extra high", "xhigh", 0.99},
};

constexpr std::size_t archive_limit = 32 * 1024 * 1024;
constexpr std::size_t settings_limit = 1024 * 1024;
constexpr auto completions_path = L"/v1/chat/completions";

std::string utf8(std::wstring_view source) {
    const auto length = static_cast<int>(source.size());
    const int size = WideCharToMultiByte(CP_UTF8, 0, source.data(), length, nullptr, 0, nullptr, nullptr);
    std::string result(size, '\0');
    if (size) {
        WideCharToMultiByte(CP_UTF8, 0, source.data(), length, result.data(), size, nullptr, nullptr);
    }
    return result;
}

std::wstring wide(std::string_view source) {
    const auto length = static_cast<int>(source.size());
    const int size = MultiByteToWideChar(CP_UTF8, 0, source.data(), length, nullptr, 0);
    std::wstring result(size, L'\0');
    if (size) {
        MultiByteToWideChar(CP_UTF8, 0, source.data(), length, result.data(), size);
    }
    return result;
}

const value& field(const value& json, const char* key) {
    static const value missing;
    return json.is<object>() ? json.get(key) : missing;
}

std::string_view string(const value& json) {
    return json.is<std::string>() ? std::string_view(json.get<std::string>()) : std::string_view{};
}

bool parse_json(value& result, const std::string& encoded) {
    // PicoJSON uses recursion when parsing arrays and objects.
    int depth = 0;
    bool quoted = false;
    bool escaped = false;
    for (const char character : encoded) {
        if (quoted) {
            if (escaped) {
                escaped = false;
            } else if (character == '\\') {
                escaped = true;
            } else if (character == '"') {
                quoted = false;
            }
        } else if (character == '"') {
            quoted = true;
        } else if (character == '{' || character == '[') {
            if (++depth > 64) {
                return false;
            }
        } else if (character == '}' || character == ']') {
            if (--depth < 0) {
                return false;
            }
        }
    }
    return depth == 0 && picojson::parse(result, encoded).empty();
}

bool image_data_url(std::string_view url) {
    return url.starts_with("data:image/jpeg;base64,") || url.starts_with("data:image/png;base64,");
}

array encode_archive_messages(const std::vector<Message>& messages) {
    array result;
    result.reserve(messages.size());
    for (const auto& message : messages) {
        object item{
            {"role", value(message.from_user ? "user" : "assistant")},
            {"content", value(utf8(message.text))},
        };
        if (!message.attachments.empty()) {
            array attachments;
            attachments.reserve(message.attachments.size());
            for (const auto& attachment : message.attachments) {
                object entry{{"name", value(utf8(attachment.name))}};
                if (attachment.is_image()) {
                    entry.emplace("image_url", value(attachment.image_url));
                } else {
                    entry.emplace("text", value(utf8(attachment.text)));
                }
                attachments.emplace_back(std::move(entry));
            }
            item.emplace("attachments", value(std::move(attachments)));
        }
        result.emplace_back(std::move(item));
    }
    return result;
}

value message_content(const Message& message, bool vision) {
    auto content = message.text;
    array images;
    for (const auto& attachment : message.attachments) {
        if (attachment.is_image() && vision) {
            images.emplace_back(object{
                {"type", value("image_url")},
                {"image_url", value(object{{"url", value(attachment.image_url)}})},
            });
        } else {
            if (!content.empty()) {
                content += L"\n\n";
            }
            if (attachment.is_image()) {
                content += L"[Earlier image attachment: " + attachment.name + L"]";
            } else {
                content += L"[PDF attachment: " + attachment.name + L"]\n"
                    + attachment.text + L"\n[End PDF attachment]";
            }
        }
    }
    if (images.empty()) {
        return value(utf8(content));
    }
    if (!content.empty()) {
        images.insert(images.begin(), value(object{{"type", value("text")}, {"text", value(utf8(content))}}));
    }
    return value(std::move(images));
}

std::string encode_request(const Conversation& conversation, const Settings& settings, const std::string& alias) {
    const auto& model = models.at(conversation.model);
    auto system = settings.system_prompt;
    if (!settings.memory.empty()) {
        if (!system.empty()) {
            system += L"\n\n";
        }
        system += L"User-provided memory:\n" + settings.memory;
    }
    array messages;
    messages.reserve(conversation.messages.size() + 1);
    if (!system.empty()) {
        messages.emplace_back(object{{"role", value("system")}, {"content", value(utf8(system))}});
    }
    for (const auto& message : conversation.messages) {
        messages.emplace_back(object{
            {"role", value(message.from_user ? "user" : "assistant")},
            {"content", message_content(message, supports_images(model))},
        });
    }
    object body{
        {"model", value(alias)},
        {"messages", value(std::move(messages))},
        {"stream", value(true)},
    };
    const auto effort = conversation.reasoning;
    const auto& level = levels.at(static_cast<std::size_t>(effort));
    if (model.id == L"saias-flash") {
        const bool thinking = effort == Reasoning::on;
        body.emplace("chat_template_kwargs", value(object{{"enable_thinking", value(thinking)}}));
        body.emplace("reasoning_format", value("deepseek"));
    } else if (effort != Reasoning::preset) {
        if (model.id == L"saias-pro") {
            body.emplace("chat_template_kwargs", value(object{{"reasoning_effort", value(level.inkling_value)}}));
        } else if (effort == Reasoning::off) {
            body.emplace("chat_template_kwargs", value(object{{"enable_thinking", value(false)}}));
        } else {
            body.emplace("chat_template_kwargs", value(object{{"reasoning_effort", value(level.key)}}));
        }
    }
    return value(std::move(body)).serialize();
}

value read_json(const std::filesystem::path& path, std::size_t limit) {
    std::error_code error;
    if (std::filesystem::file_size(path, error) > limit || error) {
        return {};
    }
    std::ifstream contents(path, std::ios::binary);
    if (!contents) {
        return {};
    }
    const std::string encoded((std::istreambuf_iterator<char>(contents)), {});
    value data;
    return encoded.size() <= limit && parse_json(data, encoded) ? data : value{};
}

bool write_json(const std::filesystem::path& path, const value& data, std::size_t limit) {
    std::error_code error;
    std::filesystem::create_directories(path.parent_path(), error);
    if (error) {
        return false;
    }
    const auto encoded = data.serialize();
    if (encoded.size() > limit) {
        return false;
    }
    auto temp = path;
    temp += L"." + std::to_wstring(GetCurrentProcessId()) + L".tmp";
    std::ofstream output(temp, std::ios::binary | std::ios::trunc);
    output.write(encoded.data(), static_cast<std::streamsize>(encoded.size()));
    output.close();
    if (!output || !MoveFileExW(temp.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        std::filesystem::remove(temp, error);
        return false;
    }
    return true;
}

Conversation decode_conversation(const std::filesystem::path& path) {
    Conversation result;
    result.id = path.stem().wstring();
    const auto data = read_json(path, archive_limit);
    auto id = wide(string(field(data, "model")));
    if (id.starts_with(L"sai-")) {
        id = L"saias-" + id.substr(4); // Conversations saved before the SAIAS rename.
    }
    if (id == L"saias-big") {
        id = L"saias-smart";
    } else if (id == L"saias-max") {
        id = L"saias-pro";
    }
    const auto model = std::find_if(models.begin(), models.end(), [&](const Model& item) { return item.id == id; });
    if (model != models.end()) {
        result.model = static_cast<std::size_t>(model - models.begin());
    }
    const auto key = string(field(data, "reasoning"));
    const auto level = std::find_if(levels.begin(), levels.end(), [&](const Level& item) { return item.key == key; });
    if (level != levels.end()) {
        const auto effort = static_cast<Reasoning>(level - levels.begin());
        if (supports_reasoning(models[result.model], effort)) {
            result.reasoning = effort;
        }
    }
    const auto& messages = field(data, "messages");
    if (messages.is<array>()) {
        for (const auto& message : messages.get<array>()) {
            const auto role = string(field(message, "role"));
            if (role != "user" && role != "assistant") {
                continue;
            }
            Message item{role == "user", wide(string(field(message, "content")))};
            const auto& attachments = field(message, "attachments");
            if (item.from_user && attachments.is<array>()) {
                for (const auto& entry : attachments.get<array>()) {
                    Attachment attachment;
                    attachment.name = wide(string(field(entry, "name")));
                    const auto url = string(field(entry, "image_url"));
                    if (image_data_url(url)) {
                        attachment.image_url = url;
                    } else {
                        attachment.text = wide(string(field(entry, "text")));
                    }
                    if (!attachment.name.empty() && (attachment.is_image() || !attachment.text.empty())) {
                        item.attachments.push_back(std::move(attachment));
                    }
                }
            }
            if (!item.text.empty() || !item.attachments.empty()) {
                result.messages.push_back(std::move(item));
            }
        }
    }
    return result;
}

struct Event {
    explicit Event(bool manual = false) : handle(CreateEventW(nullptr, manual, FALSE, nullptr)) {}
    ~Event() { if (handle) CloseHandle(handle); }
    Event(const Event&) = delete;
    Event& operator=(const Event&) = delete;
    const HANDLE handle;
};

struct InternetHandle {
    explicit InternetHandle(HINTERNET handle) : handle(handle) {}
    ~InternetHandle() { if (handle) WinHttpCloseHandle(handle); }
    InternetHandle(const InternetHandle&) = delete;
    InternetHandle& operator=(const InternetHandle&) = delete;
    const HINTERNET handle;
};

class Transfer {
public:
    explicit Transfer(HINTERNET handle) : handle(handle) {}
    ~Transfer();
    bool begin(const wchar_t* headers, void* data, DWORD size, HANDLE stop);
    bool wait(BOOL queued, DWORD expected, HANDLE stop);
    DWORD status_code() const;

    const HINTERNET handle;
    DWORD bytes = 0;
    DWORD error = ERROR_SUCCESS;

private:
    bool attach();
    static void CALLBACK notify(HINTERNET, DWORD_PTR context, DWORD status, void* data, DWORD size);
    Event ready_;
    Event closed_{true};
    std::mutex mutex_;
    DWORD status_ = 0;
    DWORD reported_bytes_ = 0;
    DWORD reported_error_ = ERROR_SUCCESS;
    bool attached_ = false;
};

bool Transfer::attach() {
    if (!handle || !ready_.handle || !closed_.handle) {
        return false;
    }
    auto context = reinterpret_cast<DWORD_PTR>(this);
    if (!WinHttpSetOption(handle, WINHTTP_OPTION_CONTEXT_VALUE, &context, sizeof(context))) {
        return false;
    }
    attached_ = WinHttpSetStatusCallback(handle, notify,
        WINHTTP_CALLBACK_FLAG_ALL_COMPLETIONS | WINHTTP_CALLBACK_FLAG_HANDLES,
        0) != WINHTTP_INVALID_STATUS_CALLBACK;
    return attached_;
}

bool Transfer::begin(const wchar_t* headers, void* data, DWORD size, HANDLE stop) {
    DWORD redirect = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
    if (!attach() || !WinHttpSetOption(handle, WINHTTP_OPTION_REDIRECT_POLICY, &redirect, sizeof(redirect))) {
        error = GetLastError();
        return false;
    }
    return wait(WinHttpSendRequest(handle, headers, headers ? static_cast<DWORD>(-1) : 0,
            data, size, size, reinterpret_cast<DWORD_PTR>(this)), WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE, stop)
        && wait(WinHttpReceiveResponse(handle, nullptr), WINHTTP_CALLBACK_STATUS_HEADERS_AVAILABLE, stop);
}

DWORD Transfer::status_code() const {
    DWORD status = 0;
    DWORD size = sizeof(status);
    WinHttpQueryHeaders(handle, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX, &status, &size, WINHTTP_NO_HEADER_INDEX);
    return status;
}

Transfer::~Transfer() {
    // The final callback can arrive after WinHttpCloseHandle returns.
    if (handle && WinHttpCloseHandle(handle) && attached_) {
        WaitForSingleObject(closed_.handle, INFINITE);
    }
}

void CALLBACK Transfer::notify(HINTERNET, DWORD_PTR context, DWORD status, void* data, DWORD size) {
    if (!context) {
        return;
    }
    auto& transfer = *reinterpret_cast<Transfer*>(context);
    if (status == WINHTTP_CALLBACK_STATUS_HANDLE_CLOSING) {
        SetEvent(transfer.closed_.handle);
        return;
    }
    if (status != WINHTTP_CALLBACK_STATUS_REQUEST_ERROR && status != WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE
        && status != WINHTTP_CALLBACK_STATUS_HEADERS_AVAILABLE && status != WINHTTP_CALLBACK_STATUS_READ_COMPLETE) {
        return;
    }
    std::lock_guard lock(transfer.mutex_);
    transfer.status_ = status;
    transfer.reported_bytes_ = size;
    transfer.reported_error_ = status == WINHTTP_CALLBACK_STATUS_REQUEST_ERROR
        ? static_cast<WINHTTP_ASYNC_RESULT*>(data)->dwError : ERROR_SUCCESS;
    SetEvent(transfer.ready_.handle);
}

bool Transfer::wait(BOOL queued, DWORD expected, HANDLE stop) {
    if (!queued) {
        error = GetLastError();
        if (error != ERROR_IO_PENDING) {
            return false;
        }
    }
    const HANDLE events[]{stop, ready_.handle};
    const auto result = WaitForMultipleObjects(2, events, FALSE, INFINITE);
    if (result != WAIT_OBJECT_0 + 1) {
        error = result == WAIT_OBJECT_0 ? ERROR_WINHTTP_OPERATION_CANCELLED : GetLastError();
        return false;
    }
    std::lock_guard lock(mutex_);
    bytes = reported_bytes_;
    error = reported_error_;
    return status_ == expected;
}

std::wstring error_message(DWORD error, unsigned short port) {
    if (error == ERROR_WINHTTP_CANNOT_CONNECT) {
        return L"The SAIAS backend stopped responding on port " + std::to_wstring(port) + L".";
    }
    if (error == ERROR_WINHTTP_TIMEOUT) {
        return L"The local model server timed out.";
    }
    return L"The local connection failed (Windows error " + std::to_wstring(error) + L").";
}

std::wstring server_message(const value& json) {
    const auto& error = field(json, "error");
    auto message = string(field(error, "message"));
    if (message.empty()) {
        message = string(error);
    }
    if (message.empty()) {
        message = string(field(json, "message"));
    }
    return wide(message.substr(0, 1000));
}

struct Backend {
    std::filesystem::path project;
    unsigned short port;
    std::wstring_view launch_arguments;
};

Backend backend_for(const Model& model) {
    std::array<wchar_t, 32768> name{};
    const auto length = GetModuleFileNameW(nullptr, name.data(), static_cast<DWORD>(name.size()));
    std::filesystem::path project;
    if (length && length < name.size()) {
        auto folder = std::filesystem::path(std::wstring_view(name.data(), length)).parent_path();
        for (; folder.is_absolute() && folder.has_relative_path(); folder = folder.parent_path()) {
            std::error_code error;
            if (std::filesystem::is_regular_file(folder / L"Launch-Inkling.cmd", error)
                && std::filesystem::is_regular_file(folder / L"Saias-models.ini", error)) {
                project = std::move(folder);
                break;
            }
        }
    }
    if (model.id == L"saias-pro") {
        return {std::move(project), model.port, L" pro"};
    }
    if (model.id == L"saias-smart") {
        return {std::move(project), model.port, L" smart"};
    }
    return {std::move(project), model.port, {}};
}

using ProcessHandle = std::unique_ptr<void, decltype(&CloseHandle)>;

std::wstring launch_backend(const Backend& backend, ProcessHandle& process) {
    if (backend.project.empty()) {
        return L"Could not find Launch-Inkling.cmd. Open SAIAS-LLM.exe from the SAIAS project or its build folder.";
    }
    std::array<wchar_t, MAX_PATH> system{};
    const auto length = GetSystemDirectoryW(system.data(), static_cast<UINT>(system.size()));
    if (!length || length >= system.size()) {
        return L"Could not locate the Windows command processor.";
    }
    const auto executable = std::filesystem::path(system.data()) / L"cmd.exe";
    std::wstring command = L"cmd.exe /d /c .\\Launch-Inkling.cmd";
    command += backend.launch_arguments;
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION information{};
    if (!CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
            nullptr, backend.project.c_str(), &startup, &information)) {
        return L"Could not start the SAIAS backend (Windows error " + std::to_wstring(GetLastError()) + L").";
    }
    CloseHandle(information.hThread);
    process.reset(information.hProcess);
    return {};
}

struct BackendProbe {
    DWORD error = ERROR_SUCCESS;
    DWORD status = 0;
    value properties;
};

BackendProbe probe_backend(HINTERNET connection, const std::wstring& path, HANDLE stop) {
    Transfer transfer(WinHttpOpenRequest(connection, L"GET", path.c_str(), nullptr,
        WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0));
    BackendProbe result;
    if (!transfer.begin(nullptr, nullptr, 0, stop)) {
        result.error = transfer.error;
        return result;
    }
    result.status = transfer.status_code();
    if (!result.status) {
        result.error = GetLastError();
        return result;
    }
    std::array<char, 8192> buffer{};
    std::string body;
    while (body.size() < 1024 * 1024) {
        if (!transfer.wait(WinHttpReadData(transfer.handle, buffer.data(), static_cast<DWORD>(buffer.size()), nullptr),
                WINHTTP_CALLBACK_STATUS_READ_COMPLETE, stop)) {
            result.error = transfer.error;
            return result;
        }
        if (!transfer.bytes) {
            parse_json(result.properties, body);
            return result;
        }
        body.append(buffer.data(), transfer.bytes);
    }
    result.error = ERROR_INVALID_DATA;
    return result;
}

template <typename Publish>
std::wstring wait_for_backend(HINTERNET connection, const Backend& backend, const Model& model,
        HANDLE stop, HANDLE confirmed, Publish publish, std::string& alias) {
    // The router loads the selected model for this endpoint without sending a chat message.
    const auto properties_path = L"/props?model=" + std::wstring(model.id);
    ProcessHandle process(nullptr, CloseHandle);
    bool approved = false;
    constexpr ULONGLONG startup_timeout = 5 * 60 * 1000;
    auto deadline = GetTickCount64() + startup_timeout;
    while (WaitForSingleObject(stop, 0) == WAIT_TIMEOUT && GetTickCount64() < deadline) {
        const auto probe = probe_backend(connection, properties_path, stop);
        if (probe.error == ERROR_WINHTTP_CANNOT_CONNECT) {
            if (!approved) {
                publish(BackendStatus::confirm_start);
                const HANDLE events[]{stop, confirmed};
                const auto decision = WaitForMultipleObjects(2, events, FALSE, INFINITE);
                if (decision == WAIT_OBJECT_0) {
                    return {};
                }
                if (decision != WAIT_OBJECT_0 + 1) {
                    return L"Could not wait for startup confirmation.";
                }
                approved = true;
                deadline = GetTickCount64() + startup_timeout;
                publish(BackendStatus::loading);
                continue;
            }
            if (!process) {
                if (auto error = launch_backend(backend, process); !error.empty()) {
                    return error;
                }
            }
        } else if (probe.error) {
            return error_message(probe.error, backend.port);
        } else if (probe.status == 200) {
            alias = string(field(probe.properties, "model_alias"));
            if (alias == utf8(model.id) || (model.id == L"saias-smart" && alias == "bonsai-2-27b")) {
                return {};
            }
            return L"The server on port " + std::to_wstring(backend.port) + L" is not serving " + std::wstring(model.id) + L".";
        } else {
            const auto message = server_message(probe.properties);
            if (probe.status != 503 || message != L"Loading model") {
                return L"SAIAS backend error " + std::to_wstring(probe.status)
                    + (message.empty() ? L"." : L". " + message);
            }
        }
        if (process && WaitForSingleObject(process.get(), 0) == WAIT_OBJECT_0) {
            DWORD code = 0;
            GetExitCodeProcess(process.get(), &code);
            return L"The SAIAS backend exited during startup (code " + std::to_wstring(code)
                + L"). Run Launch-Inkling.cmd" + std::wstring(backend.launch_arguments)
                + L" from the SAIAS project folder to see the startup error.";
        }
        WaitForSingleObject(stop, 500);
    }
    return L"The SAIAS backend took too long to start.";
}

template <typename Publish>
std::wstring complete(HINTERNET connection, unsigned short port, std::string& body, HANDLE stop, Publish publish) {
    std::array<char, 8192> buffer{};
    Transfer transfer(WinHttpOpenRequest(connection, L"POST", completions_path, nullptr,
        WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0));
    constexpr auto headers = L"Content-Type: application/json\r\nAccept: text/event-stream\r\n";
    const auto length = static_cast<DWORD>(body.size());
    if (!transfer.begin(headers, body.data(), length, stop)) {
        return error_message(transfer.error, port);
    }

    const auto http_status = transfer.status_code();
    if (!http_status) {
        return error_message(GetLastError(), port);
    }
    wchar_t response_type[128]{};
    DWORD type_size = sizeof(response_type);
    const bool success = http_status >= 200 && http_status < 300;
    const bool sse = success && WinHttpQueryHeaders(transfer.handle, WINHTTP_QUERY_CONTENT_TYPE,
        WINHTTP_HEADER_NAME_BY_INDEX, response_type, &type_size, WINHTTP_NO_HEADER_INDEX)
        && std::wstring_view(response_type).find(L"text/event-stream") != std::wstring_view::npos;

    std::wstring error;
    bool have_answer = false;
    bool done = false;
    bool finished_choice = false;
    std::size_t answer_size = 0;
    const auto consume = [&](std::string_view payload) {
        value json;
        if (!parse_json(json, std::string(payload))) {
            return;
        }
        error = server_message(json);
        const auto& choices = field(json, "choices");
        if (!error.empty() || !choices.is<array>() || choices.get<array>().empty()) {
            return;
        }
        const auto& choice = choices.get<array>().front();
        const auto& delta = field(choice, sse ? "delta" : "message");
        const auto text = string(field(delta, "content"));
        const bool thinking = !string(field(delta, "reasoning_content")).empty()
            || !string(field(delta, "reasoning")).empty();
        if (!text.empty()) {
            answer_size += text.size();
            if (answer_size > archive_limit) {
                error = L"The local server sent a response that was too large.";
                return;
            }
            have_answer = true;
            publish(wide(text), false);
        } else if (thinking && !have_answer) {
            publish({}, true);
        }
        if (!string(field(choice, "finish_reason")).empty()) {
            finished_choice = true;
        }
    };

    std::string pending;
    while (!done && error.empty()) {
        if (!transfer.wait(WinHttpReadData(transfer.handle, buffer.data(), static_cast<DWORD>(buffer.size()), nullptr),
                WINHTTP_CALLBACK_STATUS_READ_COMPLETE, stop)) {
            return error_message(transfer.error, port);
        }
        if (!transfer.bytes) {
            break;
        }
        pending.append(buffer.data(), transfer.bytes);
        if (!sse) {
            if (pending.size() > (success ? archive_limit : 64 * 1024)) {
                break;
            }
            continue;
        }

        std::size_t start = 0;
        for (auto end = pending.find('\n'); end != std::string::npos && !done && error.empty();
                end = pending.find('\n', start)) {
            auto line = std::string_view(pending).substr(start, end - start);
            start = end + 1;
            if (line.ends_with('\r')) {
                line.remove_suffix(1);
            }
            if (line.starts_with("data:")) {
                line.remove_prefix(5);
                if (line.starts_with(' ')) {
                    line.remove_prefix(1);
                }
                done = line == "[DONE]";
                if (!done) {
                    consume(line);
                }
            }
        }
        pending.erase(0, start);
        if (pending.size() > archive_limit) {
            return L"The local server sent an invalid event stream.";
        }
    }
    if (!sse) {
        if (!success) {
            value json;
            parse_json(json, pending);
            const auto message = server_message(json);
            return L"Server error " + std::to_wstring(http_status) + (message.empty() ? L"." : L": " + message);
        }
        consume(pending);
    } else if (!done && !finished_choice && error.empty()) {
        return L"The local server closed the reply before it finished.";
    }
    if (error.empty() && !have_answer) {
        return L"The model returned no final answer.";
    }
    return error;
}

template <typename SetBackendStatus, typename Publish>
std::wstring run_request(const Conversation& conversation, const Settings& settings, HANDLE stop, HANDLE confirmed,
        SetBackendStatus set_backend_status, Publish publish) {
    const auto& model = models.at(conversation.model);
    const auto backend = backend_for(model);
    // Both the readiness checks and the chat request use the same fixed loopback endpoint.
    InternetHandle session(WinHttpOpen(L"SAIAS-LLM/1.0", WINHTTP_ACCESS_TYPE_NO_PROXY,
        WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, WINHTTP_FLAG_ASYNC));
    if (!session.handle) {
        return error_message(GetLastError(), backend.port);
    }
    WinHttpSetTimeouts(session.handle, 4000, 4000, 10000, 300000);
    InternetHandle connection(WinHttpConnect(session.handle, L"127.0.0.1", backend.port, 0));
    if (!connection.handle) {
        return error_message(GetLastError(), backend.port);
    }
    std::string alias;
    auto error = wait_for_backend(connection.handle, backend, model, stop, confirmed, set_backend_status, alias);
    if (!error.empty() || WaitForSingleObject(stop, 0) != WAIT_TIMEOUT) {
        return error;
    }
    auto body = encode_request(conversation, settings, alias);
    if (body.size() > archive_limit) {
        return L"This conversation is too large to send. Start a new conversation.";
    }
    set_backend_status(BackendStatus::ready);
    return complete(connection.handle, backend.port, body, stop, publish);
}

} // namespace

std::wstring_view reasoning_label(Reasoning effort) {
    return levels.at(static_cast<std::size_t>(effort)).label;
}

bool supports_reasoning(const Model& model, Reasoning effort) {
    if (effort == Reasoning::preset || effort == Reasoning::off) {
        return true;
    }
    if (model.id == L"saias-flash") {
        return effort == Reasoning::on;
    }
    if (model.id == L"saias-smart") {
        return effort == Reasoning::medium || effort == Reasoning::extra_high;
    }
    return effort != Reasoning::on;
}

bool supports_images(const Model& model) {
    return model.id == L"saias-smart" || model.id == L"saias-pro";
}

std::wstring Conversation::title() const {
    for (const auto& message : messages) {
        if (message.from_user) {
            const auto& source = message.text.empty() && !message.attachments.empty()
                ? message.attachments.front().name : message.text;
            const auto end = source.find_first_of(L"\r\n");
            auto title = source.substr(0, std::min<std::size_t>(end, 42));
            if (title.size() < source.size()) {
                title += L"\u2026";
            }
            return title;
        }
    }
    return L"New conversation";
}

Archive::Archive() {
    const DWORD size = GetEnvironmentVariableW(L"LOCALAPPDATA", nullptr, 0);
    if (size) {
        std::wstring local(size, L'\0');
        const DWORD length = GetEnvironmentVariableW(L"LOCALAPPDATA", local.data(), size);
        if (length && length < size) {
            local.resize(length);
            directory_ = std::filesystem::path(local) / L"SAIAS-LLM" / L"Conversations";
        }
    }
}

Conversation Archive::create() const {
    GUID id{};
    wchar_t text[40]{};
    if (FAILED(CoCreateGuid(&id)) || !StringFromGUID2(id, text, static_cast<int>(std::size(text)))) {
        throw std::runtime_error("Could not create a conversation ID.");
    }
    Conversation result;
    result.id = text;
    return result;
}

std::vector<Conversation> Archive::load() const {
    std::vector<Conversation> result;
    if (directory_.empty()) {
        return result;
    }
    namespace fs = std::filesystem;
    std::vector<std::pair<fs::file_time_type, fs::path>> files;
    std::error_code error;
    for (auto item = fs::directory_iterator(directory_, error); !error && item != fs::directory_iterator(); item.increment(error)) {
        std::error_code item_error;
        if (item->path().extension() == L".json" && item->is_regular_file(item_error)
                && item->file_size(item_error) <= archive_limit && !item_error) {
            const auto modified = item->last_write_time(item_error);
            if (!item_error) {
                files.emplace_back(modified, item->path());
            }
        }
    }
    std::sort(files.rbegin(), files.rend());
    for (const auto& [date, path] : files) {
        auto conversation = decode_conversation(path);
        if (!conversation.messages.empty()) {
            result.push_back(std::move(conversation));
        }
    }
    return result;
}

bool Archive::save(const Conversation& conversation) const {
    if (directory_.empty() || conversation.messages.empty()) {
        return false;
    }
    return write_json(directory_ / (conversation.id + L".json"), value(object{
        {"model", value(utf8(models.at(conversation.model).id))},
        {"reasoning", value(levels.at(static_cast<std::size_t>(conversation.reasoning)).key)},
        {"messages", value(encode_archive_messages(conversation.messages))},
    }), archive_limit);
}

Settings Archive::load_settings() const {
    if (directory_.empty()) {
        return {};
    }
    const auto data = read_json(directory_.parent_path() / L"settings.json", settings_limit);
    return {wide(string(field(data, "memory"))), wide(string(field(data, "system_prompt")))};
}

bool Archive::save_settings(const Settings& settings) const {
    return !directory_.empty() && write_json(directory_.parent_path() / L"settings.json", value(object{
        {"memory", value(utf8(settings.memory))},
        {"system_prompt", value(utf8(settings.system_prompt))},
    }), settings_limit);
}

struct Request::State {
    Event cancel{true};
    Event confirmed;
    std::mutex mutex;
    Update update;
};

Request::Request(Conversation conversation, const Settings& settings) : state_(std::make_shared<State>()),
    worker_([state = state_, conversation = std::move(conversation), settings] {
        std::wstring error;
        try {
            if (!state->cancel.handle || !state->confirmed.handle) {
                error = L"Could not initialize the local request.";
            } else {
                error = run_request(conversation, settings, state->cancel.handle, state->confirmed.handle,
                    [&](BackendStatus status) {
                        std::lock_guard lock(state->mutex);
                        state->update.backend = status;
                    }, [&](std::wstring text, bool thinking) {
                        std::lock_guard lock(state->mutex);
                        state->update.text += text;
                        state->update.thinking = thinking;
                    });
            }
        } catch (const std::exception&) {
            error = L"The local request could not be completed.";
        }
        std::lock_guard lock(state->mutex);
        state->update.stopped = state->cancel.handle && WaitForSingleObject(state->cancel.handle, 0) == WAIT_OBJECT_0;
        if (!state->update.stopped) {
            state->update.error = std::move(error);
        }
        state->update.finished = true;
    }) {}

Request::~Request() {
    stop();
}

void Request::start_backend() const {
    SetEvent(state_->confirmed.handle);
}

void Request::stop() const {
    if (state_->cancel.handle) {
        SetEvent(state_->cancel.handle);
    }
}

Update Request::take() {
    std::lock_guard lock(state_->mutex);
    return std::exchange(state_->update, {});
}

} // namespace saias::chat
