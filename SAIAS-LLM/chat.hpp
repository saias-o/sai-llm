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

struct Attachment {
    std::wstring name;
    std::wstring text;
    std::string image_url;

    bool is_image() const { return !image_url.empty(); }
};

struct Settings {
    std::wstring memory;
    std::wstring system_prompt;
};

struct Message {
    bool from_user;
    std::wstring text;
    std::vector<Attachment> attachments{};
};

struct Conversation {
    std::wstring id;
    std::size_t model = 0;
    Reasoning reasoning = Reasoning::preset;
    std::vector<Message> messages;
    std::wstring draft;
    std::vector<Attachment> draft_attachments;

    std::wstring title() const;
};

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

struct Update {
    std::wstring text;
    std::wstring error;
    std::optional<BackendStatus> backend;
    bool thinking = false;
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
