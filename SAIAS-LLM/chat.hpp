#pragma once

#include <array>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

namespace saias::chat {

enum class Reasoning { preset, off, on, low, medium, high, extra_high };

struct Model {
    std::wstring_view id;
    Reasoning default_reasoning;
};

inline constexpr std::array models{
    Model{L"saias-flash", Reasoning::off},
    Model{L"saias-smart", Reasoning::medium},
    Model{L"saias-pro", Reasoning::extra_high},
};

std::wstring_view reasoning_label(Reasoning effort);
bool supports_reasoning(const Model& model, Reasoning effort);
bool supports_images(const Model& model);
// Image support of a profile as the installed catalog reports it (saias recommend).
void set_image_support(std::wstring_view id, bool supported);
// Context window of a profile in tokens (saias recommend, then the server itself); 0 if unknown.
void set_context_size(std::wstring_view id, std::size_t tokens);
std::size_t context_size(const Model& model);

// Web tools the SAIAS hub runs (mcp/saias-web.js, listed by GET /tools on the hub).
struct Tool {
    std::wstring_view name;
    std::wstring_view label;
};

inline constexpr std::array web_tools{
    Tool{L"web_search", L"Web search"},
    Tool{L"web_fetch", L"Read web pages"},
    Tool{L"web_research", L"Web research (search and read)"},
};

struct Attachment {
    std::wstring name;
    std::wstring text;
    std::string image_url;

    bool is_image() const { return !image_url.empty(); }
};

struct Settings {
    std::wstring memory;
    std::wstring system_prompt;
    // Names of the enabled tools.
    std::vector<std::wstring> tools{L"web_search", L"web_fetch", L"web_research"};

    bool tool_enabled(std::wstring_view name) const;
};

struct ToolCall {
    std::wstring id;
    std::wstring name;
    std::wstring arguments;  // JSON text written by the model
    std::wstring result;     // what the tool returned, sent back to the model
    bool failed = false;
};

// One step of an answer that used tools: what the model wrote, then the tools it called.
struct ToolRound {
    std::wstring text;
    std::vector<ToolCall> calls;
};

struct Message {
    bool from_user;
    std::wstring text;
    std::vector<Attachment> attachments{};
    std::wstring reasoning{};          // the model's thinking, shown but never sent back
    std::vector<ToolRound> rounds{};   // tool use before the final text
};

struct Conversation {
    std::wstring id;
    std::size_t model = 0;
    Reasoning reasoning = Reasoning::preset;
    std::vector<Message> messages;
    std::wstring draft;
    std::vector<Attachment> draft_attachments;
    std::size_t context_tokens = 0;  // tokens the last reply used, as the server counted them

    std::wstring title() const;
};

// Rough token count for text not counted by the server yet (about four characters per token).
std::size_t estimate_tokens(const Conversation& conversation);

class Archive {
public:
    Archive();
    Conversation create() const;
    std::vector<Conversation> load() const;
    bool save(const Conversation& conversation) const;
    Settings load_settings() const;
    bool save_settings(const Settings& settings) const;

private:
    std::filesystem::path directory_;
};

enum class BackendStatus { confirm_start, loading, ready };

// What happened since the last Request::take(), in order, for the live view.
struct LiveEvent {
    enum class Kind { text, reasoning, tool_start, tool_done };
    Kind kind;
    std::wstring text;   // text or reasoning delta; tool name
    std::wstring detail; // tool arguments, or the tool result
    bool failed = false;
};

struct Usage {
    std::size_t prompt = 0;      // tokens read, the whole conversation so far
    std::size_t completion = 0;  // tokens written
    double speed = 0;            // tokens per second while writing
};

struct Update {
    std::vector<LiveEvent> events;
    std::optional<Usage> usage;
    std::size_t context_size = 0;   // the model's context window, once the server reported it
    std::optional<Message> reply;   // the complete answer, when finished
    std::wstring error;
    std::optional<BackendStatus> backend;
    bool finished = false;
    bool stopped = false;
};

class Request {
public:
    Request(Conversation conversation, const Settings& settings);
    ~Request();
    void start_backend() const;
    void stop() const;
    Update take();

private:
    struct State;
    std::shared_ptr<State> state_;
    std::jthread worker_;
};

} // namespace saias::chat
