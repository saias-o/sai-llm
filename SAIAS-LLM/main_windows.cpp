#include "chat.hpp"
#include "chat_windows.hpp"
#include "hardware.hpp"
#include "hermes_guide.hpp"
#include "saias_cli.hpp"
#include "third_party/picojson.h"

#include <windows.h>
#include <d2d1.h>
#include <dwrite.h>
#include <dwmapi.h>
#include <shellapi.h>
#include <wrl/client.h>

#include <windowsx.h>

#include <algorithm>
#include <array>
#include <iterator>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace {

using Microsoft::WRL::ComPtr;
constexpr auto window_class = L"SaiasApp";
constexpr UINT scan_complete = WM_APP + 1;
constexpr UINT update_checked = WM_APP + 2;
constexpr UINT update_finished = WM_APP + 3;
constexpr UINT tray_message = WM_APP + 4;
constexpr UINT show_request = WM_APP + 5;
constexpr int rescan_button = 100;
constexpr int setup_button = 101;
constexpr int back_button = 102;
constexpr int next_button = 103;
constexpr int copy_button = 104;
constexpr int docs_button = 105;
constexpr int advisor_button = 106;
constexpr int chat_button = 107;
constexpr int update_button = 108;
constexpr UINT tray_open = 200;
constexpr UINT tray_web = 201;
constexpr UINT tray_start = 202;
constexpr UINT tray_stop = 203;
constexpr UINT tray_check = 204;
constexpr UINT tray_update = 205;
constexpr UINT tray_autostart = 206;
constexpr UINT tray_quit = 207;
constexpr UINT_PTR update_timer = 1;
constexpr UINT update_interval_ms = 6 * 60 * 60 * 1000;
constexpr auto run_key = L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
constexpr auto hub_url = L"http://127.0.0.1:8090/";
constexpr UINT first_step_button = 110;
constexpr auto step_count = saias::hermes_guide.size();
constexpr float margin = 28;
constexpr float header_height = 58;
constexpr float banner_height = 46;
constexpr float recommendation_top = 126;
constexpr float recommendation_height = 106;
constexpr float hardware_top = 396;
constexpr float hardware_row = 37;
constexpr float gpu_height = 50;
constexpr float setup_footer_height = 60;
constexpr float setup_body_top = 159;
constexpr float step_top = 171;
constexpr float step_padding = 18;
constexpr float step_gap = 14;

constexpr unsigned background = 0x080808;
constexpr unsigned header = 0x0D0D0D;
constexpr unsigned surface = 0x121212;
constexpr unsigned border = 0x2C2C2C;
constexpr unsigned text = 0xF3F3F3;
constexpr unsigned muted = 0xAFAFAF;
constexpr unsigned red = 0xFF7972;
constexpr unsigned green = 0x77D597;

constexpr auto bounds(float x, float y, float width, float height) {
    return D2D1_RECT_F{x, y, x + width, y + height};
}

constexpr auto color_ref(unsigned rgb) {
    return RGB((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255);
}

enum class Type { body, wrapped, strong, section, model, title, code, count };
enum class View { advisor, guide, chat };

class Canvas {
public:
    bool initialize();
    bool begin(HWND window, UINT dpi);
    void end();
    void resize(HWND window, UINT dpi);
    void translate(float y);
    void clip(D2D1_RECT_F area);
    void unclip();
    void fill(D2D1_RECT_F area, unsigned rgb);
    void outline(D2D1_RECT_F area, unsigned rgb);
    void rule(float x, float y, float width, unsigned rgb);
    void label(std::wstring_view value, Type style, D2D1_RECT_F area, unsigned rgb = text,
               DWRITE_TEXT_ALIGNMENT align = DWRITE_TEXT_ALIGNMENT_LEADING);
    float measure(std::wstring_view value, Type style, float width) const;

private:
    void ink(unsigned rgb);

    ComPtr<ID2D1Factory> d2d_;
    ComPtr<IDWriteFactory> write_;
    std::array<ComPtr<IDWriteTextFormat>, static_cast<std::size_t>(Type::count)> formats_;
    ComPtr<ID2D1HwndRenderTarget> target_;
    ComPtr<ID2D1SolidColorBrush> brush_;
};

bool Canvas::initialize() {
    if (FAILED(D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, d2d_.GetAddressOf()))
        || FAILED(DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory),
            reinterpret_cast<IUnknown**>(write_.GetAddressOf())))) {
        return false;
    }

    struct Style { float size; DWRITE_FONT_WEIGHT weight; };
    constexpr Style styles[]{
        {13.5f, DWRITE_FONT_WEIGHT_NORMAL}, {13.5f, DWRITE_FONT_WEIGHT_NORMAL},
        {14, DWRITE_FONT_WEIGHT_SEMI_BOLD}, {17, DWRITE_FONT_WEIGHT_SEMI_BOLD},
        {25, DWRITE_FONT_WEIGHT_SEMI_BOLD}, {28, DWRITE_FONT_WEIGHT_SEMI_BOLD},
        {13, DWRITE_FONT_WEIGHT_NORMAL},
    };
    static_assert(std::size(styles) == static_cast<std::size_t>(Type::count));
    for (std::size_t index = 0; index < formats_.size(); ++index) {
        auto& format = formats_[index];
        const auto style = styles[index];
        const auto type = static_cast<Type>(index);
        if (FAILED(write_->CreateTextFormat(type == Type::code ? L"Consolas" : L"Segoe UI", nullptr, style.weight,
                DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL, style.size, L"en-US",
                format.GetAddressOf()))) {
            return false;
        }
        format->SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_NEAR);
        if (type == Type::code) {
            format->SetWordWrapping(DWRITE_WORD_WRAPPING_CHARACTER);
        } else if (type != Type::wrapped) {
            format->SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
            ComPtr<IDWriteInlineObject> ellipsis;
            if (SUCCEEDED(write_->CreateEllipsisTrimmingSign(format.Get(), ellipsis.GetAddressOf()))) {
                constexpr DWRITE_TRIMMING trimming{DWRITE_TRIMMING_GRANULARITY_CHARACTER, 0, 0};
                format->SetTrimming(&trimming, ellipsis.Get());
            }
        }
    }
    return true;
}

bool Canvas::begin(HWND window, UINT dpi) {
    if (!target_) {
        RECT area{};
        GetClientRect(window, &area);
        const auto pixels = D2D1::SizeU(area.right, area.bottom);
        if (FAILED(d2d_->CreateHwndRenderTarget(D2D1::RenderTargetProperties(),
                D2D1::HwndRenderTargetProperties(window, pixels), target_.GetAddressOf()))) {
            return false;
        }
        target_->SetDpi(static_cast<float>(dpi), static_cast<float>(dpi));
        if (FAILED(target_->CreateSolidColorBrush(D2D1::ColorF(text), brush_.GetAddressOf()))) {
            target_.Reset();
            return false;
        }
    }
    target_->BeginDraw();
    target_->SetTransform(D2D1::Matrix3x2F::Identity());
    target_->Clear(D2D1::ColorF(background));
    return true;
}

void Canvas::end() {
    if (target_->EndDraw() == D2DERR_RECREATE_TARGET) {
        brush_.Reset();
        target_.Reset();
    }
}

void Canvas::resize(HWND window, UINT dpi) {
    if (target_) {
        RECT area{};
        GetClientRect(window, &area);
        target_->SetDpi(static_cast<float>(dpi), static_cast<float>(dpi));
        if (area.right && area.bottom) {
            target_->Resize(D2D1::SizeU(area.right, area.bottom));
        }
    }
}

void Canvas::translate(float y) {
    target_->SetTransform(D2D1::Matrix3x2F::Translation(0, y));
}

void Canvas::clip(D2D1_RECT_F area) {
    target_->PushAxisAlignedClip(area, D2D1_ANTIALIAS_MODE_ALIASED);
}

void Canvas::unclip() {
    target_->PopAxisAlignedClip();
}

void Canvas::ink(unsigned rgb) {
    brush_->SetColor(D2D1::ColorF(rgb));
}

void Canvas::fill(D2D1_RECT_F area, unsigned rgb) {
    ink(rgb);
    target_->FillRectangle(area, brush_.Get());
}

void Canvas::outline(D2D1_RECT_F area, unsigned rgb) {
    ink(rgb);
    target_->DrawRectangle(area, brush_.Get());
}

void Canvas::rule(float x, float y, float width, unsigned rgb) {
    fill(bounds(x, y, width, 1), rgb);
}

void Canvas::label(std::wstring_view value, Type style, D2D1_RECT_F area, unsigned rgb,
                   DWRITE_TEXT_ALIGNMENT align) {
    auto& format = formats_[static_cast<std::size_t>(style)];
    format->SetTextAlignment(align);
    ink(rgb);
    target_->DrawText(value.data(), static_cast<UINT32>(value.size()), format.Get(), area,
                      brush_.Get(), D2D1_DRAW_TEXT_OPTIONS_CLIP);
}

float Canvas::measure(std::wstring_view value, Type style, float width) const {
    ComPtr<IDWriteTextLayout> layout;
    DWRITE_TEXT_METRICS metrics{};
    if (SUCCEEDED(write_->CreateTextLayout(value.data(), static_cast<UINT32>(value.size()),
            formats_[static_cast<std::size_t>(style)].Get(), width, 2048, layout.GetAddressOf()))) {
        layout->GetMetrics(&metrics);
    }
    return std::max(metrics.height, 18.0f);
}

std::wstring wide(std::string_view text) {
    if (text.empty()) {
        return {};
    }
    const int size = MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0);
    std::wstring result(static_cast<std::size_t>(std::max(size, 0)), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), result.data(), size);
    return result;
}

std::wstring executable_path() {
    std::array<wchar_t, 32768> name{};
    const auto length = GetModuleFileNameW(nullptr, name.data(), static_cast<DWORD>(name.size()));
    return std::wstring(name.data(), length < name.size() ? length : 0);
}

bool autostart_enabled() {
    DWORD size = 0;
    return RegGetValueW(HKEY_CURRENT_USER, run_key, L"SAIAS", RRF_RT_REG_SZ, nullptr, nullptr, &size) == ERROR_SUCCESS;
}

void set_autostart(bool enabled) {
    if (!enabled) {
        RegDeleteKeyValueW(HKEY_CURRENT_USER, run_key, L"SAIAS");
        return;
    }
    const auto command = L"\"" + executable_path() + L"\" --tray";
    RegSetKeyValueW(HKEY_CURRENT_USER, run_key, L"SAIAS", REG_SZ, command.c_str(),
        static_cast<DWORD>((command.size() + 1) * sizeof(wchar_t)));
}

struct ProfileStatus {
    std::wstring id;
    std::wstring status;
};

// Profiles and their state, or nothing when the hub is not running.
std::optional<std::vector<ProfileStatus>> hub_status() {
    const auto response = saias::cli::hub_request(L"GET", L"/saias/status", 800);
    if (!response || response->status != 200) {
        return std::nullopt;
    }
    picojson::value json;
    if (!picojson::parse(json, response->body).empty() || !json.is<picojson::object>()) {
        return std::nullopt;
    }
    std::vector<ProfileStatus> result;
    const auto& profiles = json.get("profiles");
    if (profiles.is<picojson::array>()) {
        for (const auto& item : profiles.get<picojson::array>()) {
            result.push_back({wide(item.get("id").to_str()), wide(item.get("status").to_str())});
        }
    }
    return result;
}

void stop_hub() {
    saias::cli::hub_request(L"POST", L"/saias/stop", 3000, L"X-SAIAS: 1\r\n");
}

void start_hub() {
    if (const auto process = saias::cli::launch(L"start", false)) {
        CloseHandle(process);
    }
}

struct UpdateInfo {
    bool available = false;
    std::wstring summary;
};

// Reads "saias update --check --json": installed and latest catalog, profile changes, download size.
UpdateInfo parse_update(const std::string& output) {
    UpdateInfo info;
    const auto start = output.find('{');
    picojson::value json;
    if (start == std::string::npos || !picojson::parse(json, output.substr(start)).empty() || !json.is<picojson::object>()) {
        return info;
    }
    info.available = json.get("available").is<bool>() && json.get("available").get<bool>();
    if (!info.available) {
        return info;
    }
    info.summary = L"SAIAS update available: catalog " + wide(json.get("latest").to_str());
    const auto& changes = json.get("changes");
    if (changes.is<picojson::array>()) {
        for (const auto& change : changes.get<picojson::array>()) {
            info.summary += L". " + wide(change.get("profile").to_str()) + L" \u2192 " + wide(change.get("to").to_str());
        }
    }
    const double bytes = json.get("downloadBytes").is<double>() ? json.get("downloadBytes").get<double>() : 0;
    if (bytes > 0) {
        wchar_t size[32]{};
        swprintf(size, std::size(size), bytes >= 1e9 ? L"%.1f GB" : L"%.0f MB", bytes >= 1e9 ? bytes / 1e9 : bytes / 1e6);
        info.summary += L" (" + std::wstring(size) + L" to download)";
    }
    return info;
}

// One recommended profile, as "saias recommend --json" reports it.
struct Pick {
    std::wstring id;
    std::wstring model;
    std::wstring context;
    std::wstring reason;
    std::wstring speed;
    bool installed = false;
    bool measured = false;
};

struct Recommendation {
    std::optional<Pick> most_capable;
    std::optional<Pick> everyday;
    std::wstring problem;
};

std::wstring thousands(double value) {
    auto digits = std::to_wstring(static_cast<long long>(value));
    for (auto i = static_cast<int>(digits.size()) - 3; i > 0; i -= 3) {
        digits.insert(static_cast<std::size_t>(i), L",");
    }
    return digits;
}

// Asks the SAIAS command line which profiles suit this PC; the catalog holds every rule.
Recommendation recommend() {
    Recommendation result;
    const auto output = saias::cli::run_capture(L"recommend --json", 60000);
    const auto start = output.output.find('{');
    picojson::value json;
    if (!output.started || output.exit_code != 0 || start == std::string::npos
        || !picojson::parse(json, output.output.substr(start)).empty() || !json.is<picojson::object>()) {
        result.problem = saias::cli::project_folder().empty()
            ? L"Open SAIAS.exe from the SAIAS folder to see recommendations."
            : L"SAIAS could not read its catalog. Run Install-SAIAS.cmd, then scan again.";
        return result;
    }
    const auto& profiles = json.get("profiles");
    const auto find = [&](const picojson::value& choice, bool everyday) -> std::optional<Pick> {
        if (!choice.is<picojson::object>() || !profiles.is<picojson::array>()) {
            return std::nullopt;
        }
        const auto id = choice.get("id").to_str();
        for (const auto& item : profiles.get<picojson::array>()) {
            if (item.get("id").to_str() != id) {
                continue;
            }
            Pick pick;
            pick.id = wide(id);
            pick.model = wide(item.get("model").to_str());
            pick.context = item.get("context").is<double>() ? thousands(item.get("context").get<double>()) + L" tokens" : L"";
            pick.reason = wide(choice.get("reason").to_str());
            pick.installed = item.get("installed").is<bool>() && item.get("installed").get<bool>();
            if (everyday) {
                pick.measured = choice.get("measured").is<bool>() && choice.get("measured").get<bool>();
                if (pick.measured && choice.get("genTps").is<double>()) {
                    wchar_t speed[32]{};
                    swprintf(speed, std::size(speed), L"%.1f tok/s measured", choice.get("genTps").get<double>());
                    pick.speed = speed;
                } else {
                    pick.speed = L"Not measured yet";
                }
            }
            return pick;
        }
        return std::nullopt;
    };
    result.most_capable = find(json.get("mostCapable"), false);
    result.everyday = find(json.get("everyday"), true);
    if (profiles.is<picojson::array>()) {
        for (const auto& item : profiles.get<picojson::array>()) {
            if (item.get("vision").is<bool>()) {
                saias::chat::set_image_support(wide(item.get("id").to_str()), item.get("vision").get<bool>());
            }
            if (item.get("context").is<double>() && item.get("context").get<double>() > 0) {
                saias::chat::set_context_size(wide(item.get("id").to_str()),
                    static_cast<std::size_t>(item.get("context").get<double>()));
            }
        }
    }
    if (!result.most_capable && !result.everyday) {
        result.problem = L"No SAIAS profile can run on this PC.";
    }
    return result;
}

struct Scan {
    saias::Hardware hardware;
    Recommendation recommendation;
    bool hardware_ready = false;
    std::wstring error;
};

struct StepLayout {
    float instructions_height = 0;
    float example_height = 0;
    float note_height = 0;

    float instructions_top() const { return step_top + 52; }
    float example_top() const { return instructions_top() + instructions_height + step_gap; }
    float note_top() const { return example_top() + example_height + step_gap; }
    float bottom() const { return note_top() + note_height + step_padding; }
};

class Window {
public:
    explicit Window(HINSTANCE application) : application_(application) {}
    bool open(int show, bool tray_only);
    int run();

private:
    static LRESULT CALLBACK dispatch(HWND window, UINT message, WPARAM wparam, LPARAM lparam);
    LRESULT handle(UINT message, WPARAM wparam, LPARAM lparam);
    void scan();
    void accept_scan();
    void resize();
    void scroll_by(float distance);
    HWND add_button(int id, LPCWSTR label, bool visible);
    void show_view(View view);
    void select_step(std::size_t step);
    void copy_step() const;
    void open_step_docs() const;
    void draw();
    void draw_setup_step(float width);
    void recommendation(float y, float width, const Pick* pick, bool everyday);
    void hardware(float width);
    void paint_button(const DRAWITEMSTRUCT& item) const;
    void check_updates();
    void accept_update(UpdateInfo info);
    void run_update();
    void add_tray();
    void tray_menu(POINT at);
    void notify(const wchar_t* title, const std::wstring& message);
    void show_window();
    void quit();
    float banner() const { return update_info_.available ? banner_height : 0; }
    int px(float dips) const { return static_cast<int>(dips * dpi_ / 96.0f + 0.5f); }
    float dips(int pixels) const { return pixels * 96.0f / dpi_; }

    HINSTANCE application_;
    HWND window_ = nullptr;
    HWND rescan_ = nullptr;
    HWND advisor_ = nullptr;
    HWND setup_ = nullptr;
    HWND chat_ = nullptr;
    HWND chat_panel_ = nullptr;
    std::array<HWND, step_count> step_buttons_{};
    HWND back_ = nullptr;
    HWND next_ = nullptr;
    HWND copy_ = nullptr;
    HWND docs_ = nullptr;
    HWND update_ = nullptr;
    UINT dpi_ = 96;
    UINT taskbar_created_ = RegisterWindowMessageW(L"TaskbarCreated");
    NOTIFYICONDATAW tray_{};
    bool tray_added_ = false;
    bool tray_hint_shown_ = false;
    bool quitting_ = false;
    bool checking_update_ = false;
    bool updating_ = false;
    UpdateInfo update_info_;
    Canvas canvas_;
    float scroll_ = 0;
    float max_scroll_ = 0;
    bool scanning_ = false;
    View view_ = View::advisor;
    std::size_t step_ = 0;
    StepLayout step_layout_;
    Scan current_;
    Scan pending_;
    std::mutex pending_mutex_;
    std::jthread worker_;
};

bool Window::open(int show, bool tray_only) {
    if (!canvas_.initialize()) {
        return false;
    }
    WNDCLASSEXW type{};
    type.cbSize = sizeof(type);
    type.lpfnWndProc = dispatch;
    type.hInstance = application_;
    type.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    type.hIcon = LoadIconW(application_, MAKEINTRESOURCEW(101));
    type.hIconSm = type.hIcon;
    type.lpszClassName = window_class;
    if (!RegisterClassExW(&type)) {
        return false;
    }

    dpi_ = GetDpiForSystem();
    constexpr DWORD style = WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN;
    MONITORINFO monitor{};
    monitor.cbSize = sizeof(monitor);
    GetMonitorInfoW(MonitorFromPoint(POINT{0, 0}, MONITOR_DEFAULTTOPRIMARY), &monitor);
    RECT requested{0, 0, px(900), px(650)};
    AdjustWindowRectExForDpi(&requested, style, FALSE, 0, dpi_);
    const LONG available_width = monitor.rcWork.right - monitor.rcWork.left;
    const LONG available_height = monitor.rcWork.bottom - monitor.rcWork.top;
    const LONG width = std::min(requested.right - requested.left, available_width);
    const LONG height = std::min(requested.bottom - requested.top, available_height);
    window_ = CreateWindowExW(0, window_class, L"SAIAS", style,
        monitor.rcWork.left + (available_width - width) / 2,
        monitor.rcWork.top + (available_height - height) / 2, width, height,
        nullptr, nullptr, application_, this);
    if (!window_) {
        return false;
    }
    const BOOL dark = TRUE;
    const COLORREF caption = color_ref(header), caption_text = color_ref(text), edge = color_ref(border);
    DwmSetWindowAttribute(window_, 20, &dark, sizeof(dark));
    DwmSetWindowAttribute(window_, 34, &edge, sizeof(edge));
    DwmSetWindowAttribute(window_, 35, &caption, sizeof(caption));
    DwmSetWindowAttribute(window_, 36, &caption_text, sizeof(caption_text));
    scan();
    add_tray();
    SetTimer(window_, update_timer, update_interval_ms, nullptr);
    check_updates();
    if (tray_only) {
        // Started with Windows: stay in the notification area and get the models ready.
        std::thread([] { if (!hub_status()) start_hub(); }).detach();
    } else {
        ShowWindow(window_, show);
        UpdateWindow(window_);
    }
    return true;
}

int Window::run() {
    MSG message{};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
        if (message.message == WM_KEYDOWN && message.wParam == VK_ESCAPE && view_ == View::guide) {
            show_view(View::advisor);
            continue;
        }
        if (message.message == WM_KEYDOWN && message.wParam == VK_F5 && view_ == View::advisor) {
            scan();
            continue;
        }
        if (message.message == WM_KEYDOWN && view_ != View::chat && (message.wParam == VK_NEXT || message.wParam == VK_PRIOR)) {
            RECT area{};
            GetClientRect(window_, &area);
            const float fixed_height = (view_ == View::guide ? setup_body_top + setup_footer_height : header_height) + banner();
            const float viewport = dips(area.bottom) - fixed_height;
            scroll_by((viewport - 24) * (message.wParam == VK_NEXT ? 1 : -1));
            continue;
        }
        if (!IsDialogMessageW(window_, &message)) {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    return static_cast<int>(message.wParam);
}

LRESULT CALLBACK Window::dispatch(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    auto* self = reinterpret_cast<Window*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == WM_NCCREATE) {
        self = static_cast<Window*>(reinterpret_cast<CREATESTRUCTW*>(lparam)->lpCreateParams);
        self->window_ = window;
        SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
    }
    return self ? self->handle(message, wparam, lparam) : DefWindowProcW(window, message, wparam, lparam);
}

LRESULT Window::handle(UINT message, WPARAM wparam, LPARAM lparam) {
    switch (message) {
        case WM_CREATE:
            dpi_ = GetDpiForWindow(window_);
            rescan_ = add_button(rescan_button, L"Rescan", true);
            advisor_ = add_button(advisor_button, L"Advisor", true);
            setup_ = add_button(setup_button, L"Hermes Setup", true);
            chat_ = add_button(chat_button, L"Chat", true);
            for (std::size_t step = 0; step < step_count; ++step) {
                step_buttons_[step] = add_button(first_step_button + static_cast<int>(step),
                    saias::hermes_guide[step].label.data(), false);
                if (!step_buttons_[step]) {
                    return -1;
                }
            }
            back_ = add_button(back_button, L"Back", false);
            copy_ = add_button(copy_button, L"Copy", false);
            docs_ = add_button(docs_button, L"Docs", false);
            next_ = add_button(next_button, L"Next", false);
            update_ = add_button(update_button, L"Update", false);
            if (!rescan_ || !advisor_ || !setup_ || !chat_ || !back_ || !copy_ || !docs_ || !next_ || !update_) {
                return -1;
            }
            resize();
            return 0;
        case WM_SIZE:
            resize();
            return 0;
        case WM_DPICHANGED: {
            dpi_ = HIWORD(wparam);
            const auto& area = *reinterpret_cast<RECT*>(lparam);
            SetWindowPos(window_, nullptr, area.left, area.top, area.right - area.left,
                         area.bottom - area.top, SWP_NOZORDER | SWP_NOACTIVATE);
            resize();
            return 0;
        }
        case WM_GETMINMAXINFO: {
            auto& metrics = *reinterpret_cast<MINMAXINFO*>(lparam);
            metrics.ptMinTrackSize = {px(690), px(480)};
            return 0;
        }
        case WM_ERASEBKGND:
            return 1;
        case WM_PAINT: {
            PAINTSTRUCT paint{};
            const auto dc = BeginPaint(window_, &paint);
            if (canvas_.begin(window_, dpi_)) {
                draw();
                canvas_.end();
            } else {
                SetBkMode(dc, TRANSPARENT);
                FillRect(dc, &paint.rcPaint, reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1));
                constexpr auto error = L"SAIAS could not initialize the graphics surface.";
                TextOutW(dc, 24, 96, error, lstrlenW(error));
            }
            EndPaint(window_, &paint);
            return 0;
        }
        case WM_COMMAND: {
            if (HIWORD(wparam) == BN_CLICKED) {
                const UINT id = LOWORD(wparam);
                switch (id) {
                    case rescan_button: scan(); break;
                    case advisor_button: show_view(View::advisor); break;
                    case setup_button: show_view(View::guide); break;
                    case chat_button: show_view(View::chat); break;
                    case back_button:
                        if (step_ > 0) {
                            select_step(step_ - 1);
                        }
                        break;
                    case next_button:
                        if (step_ + 1 == step_count) {
                            show_view(View::advisor);
                        } else {
                            select_step(step_ + 1);
                        }
                        break;
                    case copy_button: copy_step(); break;
                    case update_button: run_update(); break;
                    case docs_button: open_step_docs(); break;
                    default:
                        if (view_ == View::guide && id >= first_step_button && id < first_step_button + step_count) {
                            select_step(id - first_step_button);
                        }
                        break;
                }
            }
            return 0;
        }
        case WM_DRAWITEM:
            paint_button(*reinterpret_cast<DRAWITEMSTRUCT*>(lparam));
            return TRUE;
        case WM_MOUSEWHEEL:
            scroll_by(-GET_WHEEL_DELTA_WPARAM(wparam) * 55.0f / WHEEL_DELTA);
            return 0;
        case scan_complete:
            accept_scan();
            return 0;
        case update_checked: {
            std::unique_ptr<UpdateInfo> info(reinterpret_cast<UpdateInfo*>(lparam));
            checking_update_ = false;
            if (info) {
                accept_update(std::move(*info));
            }
            return 0;
        }
        case update_finished:
            updating_ = false;
            SetWindowTextW(update_, L"Update");
            EnableWindow(update_, TRUE);
            check_updates();
            return 0;
        case WM_TIMER:
            if (wparam == update_timer) {
                check_updates();
            }
            return 0;
        case tray_message:
            switch (LOWORD(lparam)) {
                case WM_CONTEXTMENU:
                    tray_menu(POINT{GET_X_LPARAM(wparam), GET_Y_LPARAM(wparam)});
                    break;
                case NIN_SELECT:
                case NIN_KEYSELECT:
                    show_window();
                    break;
            }
            return 0;
        case show_request:
            show_window();
            return 0;
        case WM_CLOSE:
            if (!quitting_ && tray_added_) {
                // Closing the window keeps SAIAS in the notification area; "Quit SAIAS" exits.
                ShowWindow(window_, SW_HIDE);
                if (!tray_hint_shown_) {
                    tray_hint_shown_ = true;
                    notify(L"SAIAS is still running", L"Right-click the SAIAS icon to open Llama Chat, update models or quit.");
                }
                return 0;
            }
            DestroyWindow(window_);
            return 0;
        case WM_DESTROY:
            KillTimer(window_, update_timer);
            if (tray_added_) {
                Shell_NotifyIconW(NIM_DELETE, &tray_);
            }
            PostQuitMessage(0);
            return 0;
    }
    if (message == taskbar_created_ && taskbar_created_) {
        // Explorer restarted: put the icon back.
        tray_added_ = false;
        add_tray();
        return 0;
    }
    return DefWindowProcW(window_, message, wparam, lparam);
}

void Window::scan() {
    if (scanning_) {
        return;
    }
    scanning_ = true;
    EnableWindow(rescan_, FALSE);
    SetWindowTextW(rescan_, L"Scanning…");
    InvalidateRect(window_, nullptr, FALSE);
    worker_ = std::jthread([this, window = window_] {
        Scan result;
        try {
            result.hardware = saias::scan_hardware();
            result.hardware_ready = true;
        } catch (...) {
            result.error = L"Windows could not report the hardware inventory. Try scanning again.";
        }
        result.recommendation = recommend();
        {
            std::lock_guard lock(pending_mutex_);
            pending_ = std::move(result);
        }
        PostMessageW(window, scan_complete, 0, 0);
    });
}

void Window::accept_scan() {
    {
        std::lock_guard lock(pending_mutex_);
        current_ = std::move(pending_);
    }
    scanning_ = false;
    SetWindowTextW(rescan_, L"Rescan");
    EnableWindow(rescan_, TRUE);
    resize();
}

HWND Window::add_button(int id, LPCWSTR label, bool visible) {
    const DWORD style = WS_CHILD | WS_TABSTOP | BS_OWNERDRAW | (visible ? WS_VISIBLE : 0);
    return CreateWindowExW(0, L"BUTTON", label, style, 0, 0, 0, 0, window_,
        reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)), application_, nullptr);
}

void Window::show_view(View view) {
    if (view == view_) {
        return;
    }
    if (view == View::chat && !chat_panel_) {
        chat_panel_ = saias::chat::create_panel(application_, window_);
        if (!chat_panel_) {
            MessageBoxW(window_, L"The chat panel could not be opened.", L"SAIAS", MB_OK | MB_ICONERROR);
            return;
        }
    }
    view_ = view;
    scroll_ = 0;
    const bool guide = view == View::guide;
    ShowWindow(rescan_, view == View::advisor ? SW_SHOW : SW_HIDE);
    for (const auto button : step_buttons_) {
        ShowWindow(button, guide ? SW_SHOW : SW_HIDE);
    }
    for (const auto button : {back_, copy_, docs_, next_}) {
        ShowWindow(button, guide ? SW_SHOW : SW_HIDE);
    }
    if (chat_panel_) {
        ShowWindow(chat_panel_, view == View::chat ? SW_SHOW : SW_HIDE);
    }
    if (guide) {
        select_step(step_);
    } else {
        resize();
    }
    for (const auto button : {advisor_, setup_, chat_}) {
        InvalidateRect(button, nullptr, FALSE);
    }
    SetFocus(view == View::advisor ? advisor_ : (guide ? setup_ : chat_));
}

void Window::select_step(std::size_t step) {
    step_ = step;
    scroll_ = 0;
    const auto& content = saias::hermes_guide[step_];
    if (step_ == 0 && GetFocus() == back_) {
        SetFocus(next_);
    }
    EnableWindow(back_, step_ > 0);
    SetWindowTextW(copy_, content.copy_label.data());
    SetWindowTextW(docs_, content.link_label.data());
    SetWindowTextW(next_, step_ + 1 == step_count ? L"Done" : L"Next");
    for (const auto button : step_buttons_) {
        InvalidateRect(button, nullptr, FALSE);
    }
    resize();
}

void Window::copy_step() const {
    const auto value = saias::hermes_guide[step_].clipboard;
    std::wstring clipboard_text;
    clipboard_text.reserve(value.size() + 16);
    for (const auto character : value) {
        if (character == L'\n') {
            clipboard_text.push_back(L'\r');
        }
        clipboard_text.push_back(character);
    }

    const auto memory = GlobalAlloc(GMEM_MOVEABLE, (clipboard_text.size() + 1) * sizeof(wchar_t));
    auto* buffer = memory ? static_cast<wchar_t*>(GlobalLock(memory)) : nullptr;
    bool copied = false;
    if (buffer) {
        std::copy_n(clipboard_text.c_str(), clipboard_text.size() + 1, buffer);
        GlobalUnlock(memory);
        if (OpenClipboard(window_)) {
            copied = EmptyClipboard() && SetClipboardData(CF_UNICODETEXT, memory);
            CloseClipboard();
        }
    }
    if (!copied && memory) {
        GlobalFree(memory);
    }
    SetWindowTextW(copy_, copied ? L"Copied" : L"Copy failed");
}

void Window::open_step_docs() const {
    const auto url = saias::hermes_guide[step_].url;
    const auto result = ShellExecuteW(window_, L"open", url.data(), nullptr, nullptr, SW_SHOWNORMAL);
    if (reinterpret_cast<INT_PTR>(result) <= 32) {
        MessageBoxW(window_, L"Windows could not open the link.", L"Hermes Setup", MB_OK | MB_ICONERROR);
    }
}

void Window::resize() {
    RECT area{};
    GetClientRect(window_, &area);
    if (rescan_) {
        MoveWindow(rescan_, area.right - px(margin + 94), px(13), px(94), px(32), TRUE);
        const auto nav_right = area.right - px(margin + (view_ == View::advisor ? 104 : 0));
        MoveWindow(chat_, nav_right - px(74), px(13), px(74), px(32), TRUE);
        MoveWindow(setup_, nav_right - px(209), px(13), px(126), px(32), TRUE);
        MoveWindow(advisor_, nav_right - px(301), px(13), px(83), px(32), TRUE);
        MoveWindow(update_, area.right - px(margin + 120), px(header_height + 7), px(120), px(32), TRUE);
        ShowWindow(update_, update_info_.available ? SW_SHOW : SW_HIDE);
    }
    float viewport_bottom = dips(area.bottom);
    float content_bottom = viewport_bottom;
    if (view_ == View::guide) {
        viewport_bottom -= setup_footer_height;
        constexpr float gap = 8;
        const float content_width = dips(area.right) - 2 * margin;
        const float tab_width = (content_width - (step_count - 1) * gap) / step_count;
        float tab_left = margin;
        for (const auto button : step_buttons_) {
            MoveWindow(button, px(tab_left), px(113 + banner()), px(tab_left + tab_width) - px(tab_left), px(34), TRUE);
            tab_left += tab_width + gap;
        }
        const auto button_top = px(viewport_bottom + 13);
        const auto middle = area.right / 2;
        MoveWindow(back_, px(margin), button_top, px(82), px(34), TRUE);
        MoveWindow(copy_, middle - px(168), button_top, px(162), px(34), TRUE);
        MoveWindow(docs_, middle + px(6), button_top, px(162), px(34), TRUE);
        MoveWindow(next_, area.right - px(margin + 82), button_top, px(82), px(34), TRUE);

        const auto& step = saias::hermes_guide[step_];
        const float inner = std::max(1.0f, dips(area.right) - 2 * (margin + step_padding));
        step_layout_.instructions_height = canvas_.measure(step.instructions, Type::wrapped, inner);
        step_layout_.example_height = canvas_.measure(step.example, Type::code, std::max(1.0f, inner - 28)) + 24;
        step_layout_.note_height = canvas_.measure(step.note, Type::wrapped, inner);
        content_bottom = step_layout_.bottom() + margin + banner();
    } else if (view_ == View::advisor) {
        const float rows = static_cast<float>(std::max<std::size_t>(current_.hardware.adapters.size(), 1));
        content_bottom = hardware_top + 2 * hardware_row + rows * gpu_height + 61 + banner();
    } else {
        const int top = px(header_height + banner());
        MoveWindow(chat_panel_, 0, top, area.right, std::max(0L, area.bottom - top), TRUE);
    }
    max_scroll_ = std::max(0.0f, content_bottom - viewport_bottom);
    scroll_ = std::clamp(scroll_, 0.0f, max_scroll_);
    canvas_.resize(window_, dpi_);
    InvalidateRect(window_, nullptr, FALSE);
}

void Window::scroll_by(float distance) {
    scroll_ = std::clamp(scroll_ + distance, 0.0f, max_scroll_);
    InvalidateRect(window_, nullptr, FALSE);
}

void Window::paint_button(const DRAWITEMSTRUCT& item) const {
    const auto dc = item.hDC;
    const auto& area = item.rcItem;
    const bool disabled = item.itemState & ODS_DISABLED;
    const bool pressed = item.itemState & ODS_SELECTED;
    const bool focused = item.itemState & ODS_FOCUS;
    const bool step_button = item.CtlID >= first_step_button && item.CtlID < first_step_button + step_count;
    const bool selected_step = step_button && item.CtlID - first_step_button == step_;
    const bool active_view = (item.CtlID == advisor_button && view_ == View::advisor)
        || (item.CtlID == setup_button && view_ == View::guide)
        || (item.CtlID == chat_button && view_ == View::chat);
    const bool accent = selected_step || active_view || item.CtlID == next_button || item.CtlID == update_button;
    const auto fill_color = accent ? (pressed ? 0x253A2C : 0x142219) : (pressed ? 0x292929 : surface);
    const auto edge_color = focused ? red : (accent ? 0x41634C : 0x3B3B3B);
    const auto brush = static_cast<HBRUSH>(GetStockObject(DC_BRUSH));
    const auto old_color = SetDCBrushColor(dc, color_ref(fill_color));
    FillRect(dc, &area, brush);
    SetDCBrushColor(dc, color_ref(edge_color));
    FrameRect(dc, &area, brush);
    if (selected_step) {
        const RECT underline{area.left, area.bottom - px(2), area.right, area.bottom};
        SetDCBrushColor(dc, color_ref(green));
        FillRect(dc, &underline, brush);
    }
    SetDCBrushColor(dc, old_color);

    HFONT font = CreateFontW(-px(13), 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
        OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
    const auto old_font = SelectObject(dc, font);
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, color_ref(accent ? green : (disabled ? muted : text)));
    RECT label_area = area;
    if (step_button) {
        label_area.left += px(10);
        label_area.right -= px(10);
    }
    std::array<wchar_t, 24> label{};
    GetWindowTextW(item.hwndItem, label.data(), static_cast<int>(label.size()));
    const UINT alignment = step_button ? DT_LEFT : DT_CENTER;
    DrawTextW(dc, label.data(), -1, &label_area, alignment | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS);
    SelectObject(dc, old_font);
    DeleteObject(font);
}

void Window::draw() {
    RECT area{};
    GetClientRect(window_, &area);
    const float width = dips(area.right);
    const float height = dips(area.bottom);
    const float content = width - 2 * margin;
    const float viewport_top = (view_ == View::guide ? setup_body_top : header_height) + banner();
    const float viewport_bottom = height - (view_ == View::guide ? setup_footer_height : 0);
    if (content < 100 || viewport_bottom < viewport_top) {
        return;
    }

    canvas_.clip(bounds(0, viewport_top, width, viewport_bottom - viewport_top));
    canvas_.translate(banner() - scroll_);
    if (view_ == View::guide) {
        draw_setup_step(content);
    } else if (view_ == View::advisor) {
        canvas_.label(L"Models for this PC", Type::title, bounds(margin, 78, content, 38));
        const auto panel = bounds(margin, recommendation_top, content, 2 * recommendation_height);
        canvas_.fill(panel, surface);
        canvas_.outline(panel, border);
        canvas_.rule(margin, recommendation_top + recommendation_height, content, border);
        const auto& picks = current_.recommendation;
        recommendation(recommendation_top, content, picks.most_capable ? &*picks.most_capable : nullptr, false);
        recommendation(recommendation_top + recommendation_height, content, picks.everyday ? &*picks.everyday : nullptr, true);
        hardware(content);
    }
    canvas_.translate(0);
    canvas_.unclip();

    canvas_.fill(bounds(0, 0, width, header_height), header);
    canvas_.rule(0, header_height - 1, width, border);
    canvas_.label(L"SAIAS", Type::section, bounds(margin, 17, 180, 24));
    if (update_info_.available) {
        canvas_.fill(bounds(0, header_height, width, banner_height), 0x142219);
        canvas_.rule(0, header_height + banner_height - 1, width, 0x41634C);
        canvas_.label(update_info_.summary, Type::body, bounds(margin, header_height + 13, content - 136, 22), green);
    }

    if (view_ == View::guide) {
        canvas_.label(L"Hermes Setup", Type::title, bounds(margin, 73 + banner(), content, 38));
        canvas_.fill(bounds(0, viewport_bottom, width, setup_footer_height), header);
        canvas_.rule(0, viewport_bottom, width, border);
    }
    if (max_scroll_ > 1) {
        const float track = viewport_bottom - viewport_top - 16;
        const float thumb = std::max(22.0f, track * track / (track + max_scroll_));
        const float top = viewport_top + 8 + (track - thumb) * scroll_ / max_scroll_;
        canvas_.fill(bounds(width - 8, top, 3, thumb), 0x4C4C4C);
    }
}

void Window::draw_setup_step(float width) {
    const auto card = bounds(margin, step_top, width, step_layout_.bottom() - step_top);
    canvas_.fill(card, surface);
    canvas_.outline(card, border);
    const float x = margin + step_padding;
    const float inner = width - 2 * step_padding;
    const auto& step = saias::hermes_guide[step_];
    canvas_.label(step.title, Type::section, bounds(x, step_top + 17, inner, 27));
    canvas_.label(step.instructions, Type::wrapped,
                  bounds(x, step_layout_.instructions_top(), inner, step_layout_.instructions_height));
    canvas_.fill(bounds(x, step_layout_.example_top(), inner, step_layout_.example_height), background);
    canvas_.label(step.example, Type::code,
                  bounds(x + 14, step_layout_.example_top() + 12, inner - 28, step_layout_.example_height - 24), green);
    canvas_.label(step.note, Type::wrapped,
                  bounds(x, step_layout_.note_top(), inner, step_layout_.note_height), muted);
}

void Window::recommendation(float y, float width, const Pick* pick, bool everyday) {
    const auto accent = everyday ? green : red;
    const float left = margin + 16;
    const float model_x = left + 127;
    const float right = margin + width - 16;
    constexpr float details_width = 156;
    const float details_x = right - details_width;
    canvas_.fill(bounds(margin + 1, y + 1, 3, recommendation_height - 1), accent);
    canvas_.label(everyday ? L"Everyday pick" : L"Most capable", Type::strong,
                  bounds(left, y + 19, 112, 22), accent);
    const std::wstring_view name = pick ? std::wstring_view(pick->id) : (scanning_ ? L"Scanning<BS>u2026" : L"Unavailable");
    canvas_.label(name, Type::model, bounds(model_x, y + 10, details_x - model_x - 12, 35));

    if (pick) {
        canvas_.label(pick->context, Type::strong, bounds(details_x, y + 19, details_width, 22),
                      text, DWRITE_TEXT_ALIGNMENT_TRAILING);
        if (everyday) {
            canvas_.label(pick->speed, Type::body, bounds(details_x, y + 42, details_width, 20),
                          pick->measured ? green : muted, DWRITE_TEXT_ALIGNMENT_TRAILING);
        }
        const auto model = pick->model + (pick->installed ? L"" : L" (not installed)");
        canvas_.label(model, Type::body, bounds(model_x, y + 42, details_x - model_x - 12, 20), muted);
    }

    const auto reason = pick ? std::wstring_view(pick->reason)
        : (scanning_ ? std::wstring_view(L"Reading the hardware and the SAIAS catalog.") : std::wstring_view(current_.recommendation.problem));
    canvas_.label(reason, Type::wrapped, bounds(model_x, y + 65, right - model_x, 38), muted);
}

void Window::hardware(float width) {
    const auto x = margin;
    canvas_.label(L"Hardware", Type::section, bounds(x, hardware_top - 32, width, 24));
    const auto& pc = current_.hardware;
    const auto adapter_count = std::max<std::size_t>(pc.adapters.size(), 1);
    const float panel_height = 2 * hardware_row + gpu_height * static_cast<float>(adapter_count);
    const auto panel = bounds(x, hardware_top, width, panel_height);
    canvas_.fill(panel, surface);
    canvas_.outline(panel, border);

    if (!current_.hardware_ready) {
        const auto status = scanning_ ? L"Scanning local hardware\u2026" : current_.error.c_str();
        canvas_.label(status, Type::wrapped, bounds(x + 16, hardware_top + 16, width - 32, 52), muted);
    } else {
        const float label_x = x + 16;
        const float value_x = x + 76;
        constexpr float detail_width = 185;
        const float detail_x = x + width - 16 - detail_width;
        const float value_width = detail_x - value_x - 12;

        const auto cores = pc.physical_cores ? std::to_wstring(pc.physical_cores) + L" physical cores" : L"Core count unavailable";
        canvas_.label(L"CPU", Type::body, bounds(label_x, hardware_top + 9, 48, 20), muted);
        canvas_.label(pc.cpu, Type::strong, bounds(value_x, hardware_top + 9, value_width, 22));
        canvas_.label(cores, Type::body, bounds(detail_x, hardware_top + 9, detail_width, 20),
                      muted, DWRITE_TEXT_ALIGNMENT_TRAILING);

        const float ram_top = hardware_top + hardware_row;
        canvas_.rule(x, ram_top, width, border);
        canvas_.label(L"RAM", Type::body, bounds(label_x, ram_top + 9, 48, 20), muted);
        canvas_.label(saias::gib(pc.ram_gib), Type::strong, bounds(value_x, ram_top + 9, value_width, 22));

        float row = ram_top + hardware_row;
        if (pc.adapters.empty()) {
            canvas_.rule(x, row, width, border);
            canvas_.label(L"GPU", Type::body, bounds(label_x, row + 15, 48, 20), muted);
            canvas_.label(L"No GPU identified", Type::body, bounds(value_x, row + 15, value_width, 22), muted);
        }
        for (const auto& card : pc.adapters) {
            canvas_.rule(x, row, width, border);
            canvas_.label(L"GPU", Type::body, bounds(label_x, row + 15, 48, 20), muted);
            canvas_.label(card.name, Type::strong, bounds(value_x, row + 15, value_width, 22));
            const auto dedicated = card.dedicated_gib > 0 ? saias::gib(card.dedicated_gib) + L" dedicated" : L"Dedicated VRAM unavailable";
            const float memory_top = row + (card.shared_gib > 0 ? 6 : 15);
            canvas_.label(dedicated, Type::strong, bounds(detail_x, memory_top, detail_width, 22),
                          text, DWRITE_TEXT_ALIGNMENT_TRAILING);
            if (card.shared_gib > 0) {
                canvas_.label(saias::gib(card.shared_gib) + L" shared", Type::body,
                              bounds(detail_x, row + 26, detail_width, 20), muted, DWRITE_TEXT_ALIGNMENT_TRAILING);
            }
            row += gpu_height;
        }
    }

    const float footer = hardware_top + panel_height + 14;
    canvas_.label(L"Recommendations come from the SAIAS catalog. Run saias bench to measure real speeds.",
                  Type::body, bounds(x, footer, width, 22), muted);
}

void Window::check_updates() {
    if (checking_update_ || updating_ || saias::cli::project_folder().empty()) {
        return;
    }
    checking_update_ = true;
    std::thread([window = window_] {
        const auto result = saias::cli::run_capture(L"update --check --json", 120000);
        auto* info = new UpdateInfo(result.started && result.exit_code == 0 ? parse_update(result.output) : UpdateInfo{});
        if (!PostMessageW(window, update_checked, 0, reinterpret_cast<LPARAM>(info))) {
            delete info;
        }
    }).detach();
}

void Window::accept_update(UpdateInfo info) {
    const bool newly_available = info.available && !update_info_.available;
    update_info_ = std::move(info);
    if (tray_added_) {
        wcsncpy_s(tray_.szTip, update_info_.available ? L"SAIAS - update available" : L"SAIAS", _TRUNCATE);
        tray_.uFlags = NIF_TIP | NIF_SHOWTIP;
        Shell_NotifyIconW(NIM_MODIFY, &tray_);
    }
    if (newly_available && !IsWindowVisible(window_)) {
        notify(L"SAIAS update available", update_info_.summary);
    }
    resize();
}

// Runs "saias update --yes" in a console so the download progress stays visible, then restarts
// the hub if it was running so the new models are used.
void Window::run_update() {
    if (updating_) {
        return;
    }
    const bool was_running = hub_status().has_value();
    const HANDLE process = saias::cli::launch(L"update --yes", true);
    if (!process) {
        MessageBoxW(window_, L"Could not start the SAIAS update. Run saias.cmd update in the SAIAS folder.", L"SAIAS",
            MB_OK | MB_ICONERROR);
        return;
    }
    updating_ = true;
    SetWindowTextW(update_, L"Updating…");
    EnableWindow(update_, FALSE);
    std::thread([window = window_, process, was_running] {
        WaitForSingleObject(process, INFINITE);
        CloseHandle(process);
        if (was_running) {
            stop_hub();
            Sleep(1500);
            start_hub();
        }
        PostMessageW(window, update_finished, 0, 0);
    }).detach();
}

void Window::add_tray() {
    if (tray_added_) {
        return;
    }
    tray_ = {};
    tray_.cbSize = sizeof(tray_);
    tray_.hWnd = window_;
    tray_.uID = 1;
    tray_.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP | NIF_SHOWTIP;
    tray_.uCallbackMessage = tray_message;
    tray_.hIcon = static_cast<HICON>(LoadImageW(application_, MAKEINTRESOURCEW(101), IMAGE_ICON,
        GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), LR_DEFAULTCOLOR));
    wcsncpy_s(tray_.szTip, L"SAIAS", _TRUNCATE);
    tray_added_ = Shell_NotifyIconW(NIM_ADD, &tray_);
    if (tray_added_) {
        tray_.uVersion = NOTIFYICON_VERSION_4;
        Shell_NotifyIconW(NIM_SETVERSION, &tray_);
    }
}

void Window::notify(const wchar_t* title, const std::wstring& message) {
    if (!tray_added_) {
        return;
    }
    tray_.uFlags = NIF_INFO;
    tray_.dwInfoFlags = NIIF_USER | NIIF_LARGE_ICON;
    wcsncpy_s(tray_.szInfoTitle, title, _TRUNCATE);
    wcsncpy_s(tray_.szInfo, message.c_str(), _TRUNCATE);
    Shell_NotifyIconW(NIM_MODIFY, &tray_);
}

void Window::tray_menu(POINT at) {
    const auto profiles = hub_status();
    HMENU menu = CreatePopupMenu();
    AppendMenuW(menu, MF_STRING, tray_open, L"Open SAIAS");
    AppendMenuW(menu, MF_STRING | (profiles ? 0 : MF_GRAYED), tray_web, L"Open Llama Chat");
    AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(menu, MF_STRING | MF_GRAYED, 0, profiles ? L"SAIAS is running" : L"SAIAS is stopped");
    if (profiles) {
        for (const auto& p : *profiles) {
            const auto line = L"    " + p.id + L": " + p.status;
            AppendMenuW(menu, MF_STRING | MF_GRAYED, 0, line.c_str());
        }
    }
    AppendMenuW(menu, MF_STRING, profiles ? tray_stop : tray_start, profiles ? L"Stop SAIAS" : L"Start SAIAS");
    AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
    if (update_info_.available) {
        AppendMenuW(menu, MF_STRING | (updating_ ? MF_GRAYED : 0), tray_update, L"Update models…");
    } else {
        AppendMenuW(menu, MF_STRING | (checking_update_ ? MF_GRAYED : 0), tray_check, L"Check for updates");
    }
    AppendMenuW(menu, MF_STRING | (autostart_enabled() ? MF_CHECKED : 0), tray_autostart, L"Start with Windows");
    AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(menu, MF_STRING, tray_quit, L"Quit SAIAS");
    SetMenuDefaultItem(menu, tray_open, FALSE);

    SetForegroundWindow(window_);
    const UINT command = TrackPopupMenuEx(menu, TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON, at.x, at.y, window_, nullptr);
    DestroyMenu(menu);
    switch (command) {
        case tray_open: show_window(); break;
        case tray_web: ShellExecuteW(window_, L"open", hub_url, nullptr, nullptr, SW_SHOWNORMAL); break;
        case tray_start: start_hub(); break;
        case tray_stop: stop_hub(); break;
        case tray_check: check_updates(); break;
        case tray_update: run_update(); break;
        case tray_autostart: set_autostart(!autostart_enabled()); break;
        case tray_quit: quit(); break;
    }
}

void Window::show_window() {
    ShowWindow(window_, IsIconic(window_) ? SW_RESTORE : SW_SHOW);
    SetForegroundWindow(window_);
}

// Quitting the app also stops the local models it manages.
void Window::quit() {
    quitting_ = true;
    if (hub_status()) {
        stop_hub();
    }
    DestroyWindow(window_);
}

} // namespace

int WINAPI wWinMain(HINSTANCE application, HINSTANCE, PWSTR command_line, int show) {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    const bool tray_only = command_line && wcsstr(command_line, L"--tray");
    // One SAIAS app per user session: a second launch brings the first one forward.
    const HANDLE instance = CreateMutexW(nullptr, TRUE, L"Local\\SAIAS.App");
    if (instance && GetLastError() == ERROR_ALREADY_EXISTS) {
        if (const HWND existing = FindWindowW(window_class, nullptr); existing && !tray_only) {
            PostMessageW(existing, show_request, 0, 0);
        }
        return 0;
    }
    Window window(application);
    if (!window.open(show, tray_only)) {
        MessageBoxW(nullptr, L"The SAIAS window could not be opened.", L"SAIAS", MB_ICONERROR);
        return 1;
    }
    return window.run();
}
