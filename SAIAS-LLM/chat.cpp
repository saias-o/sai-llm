#include "chat.hpp"
#include "saias_cli.hpp"
#include "third_party/picojson.h"

#include <windows.h>
#include <objbase.h>
#include <winhttp.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <fstream>
#include <functional>
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
};

// Keys are OpenAI reasoning_effort values. The SAIAS hub translates them for the model behind each
// profile and falls back to the nearest level a model supports. "On" is kept only to read older
// conversations and is sent as "medium".
constexpr std::array levels{
    Level{L"Model default", "default"},
    Level{L"Off", "none"},
    Level{L"On", "medium"},
    Level{L"Low", "low"},
    Level{L"Medium", "medium"},
    Level{L"High", "high"},
    Level{L"Extra high", "xhigh"},
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

std::size_t token_count(const value& json) {
    return json.is<double>() && json.get<double>() > 0 ? static_cast<std::size_t>(json.get<double>()) : 0;
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
        if (!message.reasoning.empty()) {
            item.emplace("reasoning", value(utf8(message.reasoning)));
        }
        if (!message.rounds.empty()) {
            array rounds;
            for (const auto& round : message.rounds) {
                array calls;
                for (const auto& call : round.calls) {
                    calls.emplace_back(object{
                        {"id", value(utf8(call.id))},
                        {"name", value(utf8(call.name))},
                        {"arguments", value(utf8(call.arguments))},
                        {"result", value(utf8(call.result))},
                        {"failed", value(call.failed)},
                    });
                }
                rounds.emplace_back(object{{"text", value(utf8(round.text))}, {"calls", value(std::move(calls))}});
            }
            item.emplace("tool_rounds", value(std::move(rounds)));
        }
        result.emplace_back(std::move(item));
    }
    return result;
}

std::vector<ToolRound> decode_rounds(const value& data) {
    std::vector<ToolRound> result;
    if (!data.is<array>()) {
        return result;
    }
    for (const auto& entry : data.get<array>()) {
        ToolRound round{wide(string(field(entry, "text")))};
        const auto& calls = field(entry, "calls");
        if (calls.is<array>()) {
            for (const auto& call : calls.get<array>()) {
                ToolCall item{wide(string(field(call, "id"))), wide(string(field(call, "name"))),
                    wide(string(field(call, "arguments"))), wide(string(field(call, "result")))};
                const auto& failed = field(call, "failed");
                item.failed = failed.is<bool>() && failed.get<bool>();
                if (!item.name.empty()) {
                    round.calls.push_back(std::move(item));
                }
            }
        }
        if (!round.calls.empty()) {
            result.push_back(std::move(round));
        }
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

// The assistant turns of an answer that used tools: each round's tool calls and their results,
// then the final text.
void encode_assistant(array& messages, const Message& message) {
    for (const auto& round : message.rounds) {
        array calls;
        for (const auto& call : round.calls) {
            calls.emplace_back(object{
                {"id", value(utf8(call.id))},
                {"type", value("function")},
                {"function", value(object{{"name", value(utf8(call.name))}, {"arguments", value(utf8(call.arguments))}})},
            });
        }
        messages.emplace_back(object{
            {"role", value("assistant")},
            {"content", round.text.empty() ? value() : value(utf8(round.text))},
            {"tool_calls", value(std::move(calls))},
        });
        for (const auto& call : round.calls) {
            messages.emplace_back(object{
                {"role", value("tool")},
                {"tool_call_id", value(utf8(call.id))},
                {"content", value(utf8(call.result))},
            });
        }
    }
    if (!message.text.empty() || message.rounds.empty()) {
        messages.emplace_back(object{{"role", value("assistant")}, {"content", value(utf8(message.text))}});
    }
}

// tool_definitions: the enabled tools as the hub lists them (GET /tools), possibly empty.
std::string encode_request(const Conversation& conversation, const Settings& settings, const std::string& alias,
        const array& tool_definitions) {
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
        if (message.from_user) {
            messages.emplace_back(object{
                {"role", value("user")},
                {"content", message_content(message, supports_images(model))},
            });
        } else {
            encode_assistant(messages, message);
        }
    }
    object body{
        {"model", value(alias)},
        {"messages", value(std::move(messages))},
        {"stream", value(true)},
        {"stream_options", value(object{{"include_usage", value(true)}})},
    };
    if (!tool_definitions.empty()) {
        body.emplace("tools", value(tool_definitions));
    }
    if (conversation.reasoning != Reasoning::preset) {
        body.emplace("reasoning_effort", value(levels.at(static_cast<std::size_t>(conversation.reasoning)).key));
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
    const auto& context = field(data, "context_tokens");
    if (context.is<double>() && context.get<double>() > 0) {
        result.context_tokens = static_cast<std::size_t>(context.get<double>());
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
            if (!item.from_user) {
                item.reasoning = wide(string(field(message, "reasoning")));
                item.rounds = decode_rounds(field(message, "tool_rounds"));
            }
            if (!item.text.empty() || !item.attachments.empty() || !item.rounds.empty()) {
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
};

// The SAIAS hub serves every profile on one local endpoint (src/hub.js).
Backend find_backend() {
    return {cli::project_folder(), cli::hub_port};
}

using ProcessHandle = std::unique_ptr<void, decltype(&CloseHandle)>;

std::wstring launch_backend(const Backend& backend, ProcessHandle& process) {
    if (backend.project.empty()) {
        return L"Could not find saias.cmd. Open SAIAS.exe from the SAIAS folder or its build folder.";
    }
    std::array<wchar_t, MAX_PATH> system{};
    const auto length = GetSystemDirectoryW(system.data(), static_cast<UINT>(system.size()));
    if (!length || length >= system.size()) {
        return L"Could not locate the Windows command processor.";
    }
    const auto executable = std::filesystem::path(system.data()) / L"cmd.exe";
    std::wstring command = L"cmd.exe /d /c saias.cmd start";
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
        HANDLE stop, HANDLE confirmed, Publish publish, std::string& alias, std::size_t& context) {
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
            if (alias == utf8(model.id)) {
                context = token_count(field(field(probe.properties, "default_generation_settings"), "n_ctx"));
                return {};
            }
            return L"The SAIAS hub is not serving " + std::wstring(model.id) + L". Run Install-SAIAS.cmd to install it.";
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
                + L"). Run Start-SAIAS.cmd to see the startup error.";
        }
        WaitForSingleObject(stop, 500);
    }
    return L"The SAIAS backend took too long to start.";
}

// Where a worker reports progress. Called on the worker thread.
struct Sink {
    std::function<void(BackendStatus)> backend;
    std::function<void(LiveEvent)> event;
    std::function<void(const Usage&)> usage;
    std::function<void(std::size_t)> context;
};

struct StreamedCall {
    std::string id;
    std::string name;
    std::string arguments;
};

// One model reply: its text and reasoning, the tools it wants to call, and the server's counts.
struct RoundResult {
    std::wstring text;
    std::wstring reasoning;
    std::vector<StreamedCall> calls;
    std::optional<Usage> usage;
};

std::wstring stream_round(HINTERNET connection, unsigned short port, std::string& body, HANDLE stop,
        RoundResult& round, const Sink& sink) {
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
    bool done = false;
    bool finished_choice = false;
    std::size_t answer_size = 0;
    const auto consume = [&](std::string_view payload) {
        value json;
        if (!parse_json(json, std::string(payload))) {
            return;
        }
        error = server_message(json);
        if (!error.empty()) {
            return;
        }
        // With stream_options.include_usage, the last chunk has the counts and no choices.
        const auto& usage = field(json, "usage");
        if (usage.is<object>()) {
            Usage counts;
            counts.prompt = token_count(field(usage, "prompt_tokens"));
            counts.completion = token_count(field(usage, "completion_tokens"));
            const auto& speed = field(field(json, "timings"), "predicted_per_second");
            counts.speed = speed.is<double>() ? speed.get<double>() : 0;
            round.usage = counts;
        }
        const auto& choices = field(json, "choices");
        if (!choices.is<array>() || choices.get<array>().empty()) {
            return;
        }
        const auto& choice = choices.get<array>().front();
        const auto& delta = field(choice, sse ? "delta" : "message");
        auto thought = string(field(delta, "reasoning_content"));
        if (thought.empty()) {
            thought = string(field(delta, "reasoning"));
        }
        if (!thought.empty()) {
            auto text = wide(thought);
            round.reasoning += text;
            sink.event({LiveEvent::Kind::reasoning, std::move(text)});
        }
        const auto text = string(field(delta, "content"));
        if (!text.empty()) {
            answer_size += text.size();
            if (answer_size > archive_limit) {
                error = L"The local server sent a response that was too large.";
                return;
            }
            auto piece = wide(text);
            round.text += piece;
            sink.event({LiveEvent::Kind::text, std::move(piece)});
        }
        // Tool calls arrive in pieces: the first names the call, the next ones extend its arguments.
        const auto& calls = field(delta, "tool_calls");
        if (calls.is<array>()) {
            std::size_t position = 0;
            for (const auto& call : calls.get<array>()) {
                const auto& index = field(call, "index");
                const auto slot = index.is<double>() ? static_cast<std::size_t>(index.get<double>()) : position;
                ++position;
                if (slot >= 32) {
                    continue;
                }
                if (round.calls.size() <= slot) {
                    round.calls.resize(slot + 1);
                }
                auto& target = round.calls[slot];
                if (const auto id = string(field(call, "id")); !id.empty()) {
                    target.id = id;
                }
                const auto& function = field(call, "function");
                if (const auto name = string(field(function, "name")); !name.empty()) {
                    target.name = name;
                }
                target.arguments += string(field(function, "arguments"));
                if (target.arguments.size() > 1024 * 1024) {
                    error = L"The model wrote tool arguments that were too large.";
                    return;
                }
            }
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
    // Calls without a name cannot be run: drop them.
    std::erase_if(round.calls, [](const StreamedCall& call) { return call.name.empty(); });
    if (error.empty() && round.text.empty() && round.calls.empty()) {
        return L"The model returned no final answer.";
    }
    return error;
}

// Sends a JSON body and reads the JSON reply (the hub's tool endpoint).
struct Posted {
    DWORD error = ERROR_SUCCESS;
    DWORD status = 0;
    value json;
};

Posted post_json(HINTERNET connection, const wchar_t* path, std::string& body, HANDLE stop) {
    Transfer transfer(WinHttpOpenRequest(connection, L"POST", path, nullptr,
        WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0));
    Posted result;
    constexpr auto headers = L"Content-Type: application/json\r\n";
    if (!transfer.begin(headers, body.data(), static_cast<DWORD>(body.size()), stop)) {
        result.error = transfer.error;
        return result;
    }
    result.status = transfer.status_code();
    std::array<char, 8192> buffer{};
    std::string reply;
    while (reply.size() < 8 * 1024 * 1024) {
        if (!transfer.wait(WinHttpReadData(transfer.handle, buffer.data(), static_cast<DWORD>(buffer.size()), nullptr),
                WINHTTP_CALLBACK_STATUS_READ_COMPLETE, stop)) {
            result.error = transfer.error;
            return result;
        }
        if (!transfer.bytes) {
            parse_json(result.json, reply);
            return result;
        }
        reply.append(buffer.data(), transfer.bytes);
    }
    result.error = ERROR_INVALID_DATA;
    return result;
}

constexpr std::size_t tool_result_limit = 24000;

// Runs one tool through the hub and returns what the model gets back.
ToolCall run_tool(HINTERNET connection, unsigned short port, const StreamedCall& call, HANDLE stop) {
    ToolCall result{wide(call.id), wide(call.name), wide(call.arguments)};
    value arguments;
    if (call.arguments.empty()) {
        arguments = value(object{});
    } else if (!parse_json(arguments, call.arguments) || !arguments.is<object>()) {
        result.failed = true;
        result.result = L"The tool arguments were not valid JSON. Call the tool again with a JSON object.";
        return result;
    }
    auto body = value(object{{"tool", value(call.name)}, {"params", arguments}}).serialize();
    auto posted = post_json(connection, L"/tools", body, stop);
    if (posted.error) {
        result.failed = true;
        result.result = posted.error == ERROR_WINHTTP_OPERATION_CANCELLED ? L"Stopped." : error_message(posted.error, port);
        return result;
    }
    const auto text = string(field(posted.json, "plain_text_response"));
    if (posted.status != 200 || text.empty()) {
        result.failed = true;
        auto message = server_message(posted.json);
        result.result = L"The tool failed" + (message.empty() ? L" (HTTP " + std::to_wstring(posted.status) + L")." : L": " + message);
        return result;
    }
    result.result = wide(text);
    if (result.result.size() > tool_result_limit) {
        result.result.resize(tool_result_limit);
        result.result += L"\n[Truncated: the tool returned more text than fits here.]";
    }
    return result;
}

// The enabled tools' definitions, as the hub lists them. Empty when tools are off or unavailable.
array tool_definitions(HINTERNET connection, const Settings& settings, HANDLE stop) {
    array result;
    if (settings.tools.empty()) {
        return result;
    }
    const auto listed = probe_backend(connection, L"/tools", stop);
    if (listed.error || listed.status != 200 || !listed.properties.is<array>()) {
        return result;
    }
    for (const auto& item : listed.properties.get<array>()) {
        const auto& definition = field(item, "definition");
        if (definition.is<object>() && settings.tool_enabled(wide(string(field(item, "tool"))))) {
            result.push_back(definition);
        }
    }
    return result;
}

constexpr int max_tool_rounds = 8;

// reply receives the answer as it is built, also when the request stops early.
std::wstring run_request(const Conversation& conversation, const Settings& settings, HANDLE stop, HANDLE confirmed,
        const Sink& sink, Message& reply) {
    const auto& model = models.at(conversation.model);
    const auto backend = find_backend();
    // Both the readiness checks and the chat request use the same fixed loopback endpoint.
    InternetHandle session(WinHttpOpen(L"SAIAS/1.0", WINHTTP_ACCESS_TYPE_NO_PROXY,
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
    std::size_t context = 0;
    auto error = wait_for_backend(connection.handle, backend, model, stop, confirmed, sink.backend, alias, context);
    if (!error.empty() || WaitForSingleObject(stop, 0) != WAIT_TIMEOUT) {
        return error;
    }
    if (context) {
        sink.context(context);
    }
    const auto definitions = tool_definitions(connection.handle, settings, stop);
    sink.backend(BackendStatus::ready);

    for (int step = 0;; ++step) {
        auto request = conversation;
        if (!reply.rounds.empty()) {
            request.messages.push_back(reply);
        }
        // After the last allowed round the tools are left out, so the model has to answer.
        auto body = encode_request(request, settings, alias, step < max_tool_rounds ? definitions : array{});
        if (body.size() > archive_limit) {
            return L"This conversation is too large to send. Start a new conversation.";
        }
        RoundResult round;
        error = stream_round(connection.handle, backend.port, body, stop, round, sink);
        if (round.usage) {
            sink.usage(*round.usage);
        }
        if (!round.reasoning.empty()) {
            reply.reasoning += (reply.reasoning.empty() ? L"" : L"\n\n") + round.reasoning;
        }
        if (!error.empty() || round.calls.empty()) {
            reply.text += round.text;
            return error;
        }
        ToolRound done{round.text};
        for (std::size_t i = 0; i < round.calls.size(); ++i) {
            auto call = round.calls[i];
            if (call.id.empty()) {
                call.id = "call_" + std::to_string(step) + "_" + std::to_string(i);
            }
            sink.event({LiveEvent::Kind::tool_start, wide(call.name), wide(call.arguments)});
            auto result = run_tool(connection.handle, backend.port, call, stop);
            sink.event({LiveEvent::Kind::tool_done, result.name, result.result, result.failed});
            done.calls.push_back(std::move(result));
            if (WaitForSingleObject(stop, 0) != WAIT_TIMEOUT) {
                reply.rounds.push_back(std::move(done));
                return {};
            }
        }
        reply.rounds.push_back(std::move(done));
    }
}

} // namespace

std::wstring_view reasoning_label(Reasoning effort) {
    return levels.at(static_cast<std::size_t>(effort)).label;
}

bool supports_reasoning(const Model&, Reasoning effort) {
    // Every profile accepts every level: the hub maps it to the closest one the model supports.
    return effort != Reasoning::on;
}

namespace {

// -1 unknown, 0 no, 1 yes; filled from the catalog, read by the import thread too.
std::array<std::atomic<int>, models.size()> image_support{-1, -1, -1};

} // namespace

void set_image_support(std::wstring_view id, bool supported) {
    for (std::size_t i = 0; i < models.size(); ++i) {
        if (models[i].id == id) {
            image_support[i] = supported ? 1 : 0;
        }
    }
}

namespace {

std::array<std::atomic<std::size_t>, models.size()> context_sizes{};

} // namespace

void set_context_size(std::wstring_view id, std::size_t tokens) {
    for (std::size_t i = 0; i < models.size(); ++i) {
        if (models[i].id == id && tokens) {
            context_sizes[i] = tokens;
        }
    }
}

std::size_t context_size(const Model& model) {
    for (std::size_t i = 0; i < models.size(); ++i) {
        if (models[i].id == model.id) {
            return context_sizes[i];
        }
    }
    return 0;
}

bool Settings::tool_enabled(std::wstring_view name) const {
    return std::find(tools.begin(), tools.end(), name) != tools.end();
}

std::size_t estimate_tokens(const Conversation& conversation) {
    std::size_t characters = 0;
    for (const auto& message : conversation.messages) {
        characters += message.text.size();
        for (const auto& attachment : message.attachments) {
            characters += attachment.text.size();
        }
        for (const auto& round : message.rounds) {
            characters += round.text.size();
            for (const auto& call : round.calls) {
                characters += call.arguments.size() + call.result.size();
            }
        }
    }
    return characters / 4;
}

bool supports_images(const Model& model) {
    for (std::size_t i = 0; i < models.size(); ++i) {
        if (models[i].id == model.id && image_support[i] >= 0) {
            return image_support[i] == 1;
        }
    }
    // Before the catalog has been read: the profiles that have shipped with image support.
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
            directory_ = std::filesystem::path(local) / L"SAIAS" / L"Conversations";
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
        {"context_tokens", value(static_cast<double>(conversation.context_tokens))},
        {"messages", value(encode_archive_messages(conversation.messages))},
    }), archive_limit);
}

Settings Archive::load_settings() const {
    Settings result;
    if (directory_.empty()) {
        return result;
    }
    const auto data = read_json(directory_.parent_path() / L"settings.json", settings_limit);
    result.memory = wide(string(field(data, "memory")));
    result.system_prompt = wide(string(field(data, "system_prompt")));
    // Settings saved before tools existed keep the default: every tool on.
    const auto& enabled = field(data, "tools");
    if (enabled.is<array>()) {
        result.tools.clear();
        for (const auto& name : enabled.get<array>()) {
            if (!string(name).empty()) {
                result.tools.push_back(wide(string(name)));
            }
        }
    }
    return result;
}

bool Archive::save_settings(const Settings& settings) const {
    array enabled;
    for (const auto& name : settings.tools) {
        enabled.emplace_back(utf8(name));
    }
    return !directory_.empty() && write_json(directory_.parent_path() / L"settings.json", value(object{
        {"memory", value(utf8(settings.memory))},
        {"system_prompt", value(utf8(settings.system_prompt))},
        {"tools", value(std::move(enabled))},
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
        Message reply{false, L""};
        try {
            if (!state->cancel.handle || !state->confirmed.handle) {
                error = L"Could not initialize the local request.";
            } else {
                Sink sink;
                sink.backend = [&](BackendStatus status) {
                    std::lock_guard lock(state->mutex);
                    state->update.backend = status;
                };
                sink.event = [&](LiveEvent event) {
                    std::lock_guard lock(state->mutex);
                    // Consecutive deltas of the same kind are merged: the view takes them in batches.
                    auto& events = state->update.events;
                    const bool delta = event.kind == LiveEvent::Kind::text || event.kind == LiveEvent::Kind::reasoning;
                    if (delta && !events.empty() && events.back().kind == event.kind) {
                        events.back().text += event.text;
                    } else {
                        events.push_back(std::move(event));
                    }
                };
                sink.usage = [&](const Usage& usage) {
                    std::lock_guard lock(state->mutex);
                    state->update.usage = usage;
                };
                sink.context = [&](std::size_t tokens) {
                    std::lock_guard lock(state->mutex);
                    state->update.context_size = tokens;
                };
                error = run_request(conversation, settings, state->cancel.handle, state->confirmed.handle, sink, reply);
            }
        } catch (const std::exception&) {
            error = L"The local request could not be completed.";
        }
        std::lock_guard lock(state->mutex);
        state->update.stopped = state->cancel.handle && WaitForSingleObject(state->cancel.handle, 0) == WAIT_OBJECT_0;
        if (!state->update.stopped) {
            state->update.error = std::move(error);
        }
        // Whatever was written is kept, also when the reply stopped or failed half-way.
        if (!reply.text.empty() || !reply.rounds.empty()) {
            state->update.reply = std::move(reply);
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
