#include "advisor.hpp"
#include "chat_windows.hpp"
#include "hermes_guide.hpp"

#include <windows.h>
#include <d2d1.h>
#include <dwrite.h>
#include <dwmapi.h>
#include <shellapi.h>
#include <wrl/client.h>

#include <algorithm>
#include <array>
#include <iterator>
#include <mutex>
#include <thread>
#include <utility>

namespace {

using Microsoft::WRL::ComPtr;
constexpr auto window_class = L"SaiasLlmModelAdvisor";
constexpr UINT scan_complete = WM_APP + 1;
constexpr int rescan_button = 100;
constexpr int setup_button = 101;
constexpr int back_button = 102;
constexpr int next_button = 103;
constexpr int copy_button = 104;
constexpr int docs_button = 105;
constexpr int advisor_button = 106;
constexpr int chat_button = 107;
constexpr UINT first_step_button = 110;
constexpr auto step_count = saias::hermes_guide.size();
constexpr float margin = 28;
constexpr float header_height = 58;
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

struct Scan {
    saias::Hardware hardware;
    std::optional<saias::Advice> advice;
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
    bool open(int show);
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
    void recommendation(float y, float width, const saias::Choice* choice, bool everyday);
    void hardware(float width);
    void paint_button(const DRAWITEMSTRUCT& item) const;
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
    UINT dpi_ = 96;
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

bool Window::open(int show) {
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
    window_ = CreateWindowExW(0, window_class, L"SAIAS-LLM | Model Advisor", style,
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
    ShowWindow(window_, show);
    UpdateWindow(window_);
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
            const float fixed_height = view_ == View::guide ? setup_body_top + setup_footer_height : header_height;
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
            if (!rescan_ || !advisor_ || !setup_ || !chat_ || !back_ || !copy_ || !docs_ || !next_) {
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
                constexpr auto error = L"SAIAS-LLM could not initialize the graphics surface.";
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
        case WM_DESTROY:
            PostQuitMessage(0);
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
            result.advice = saias::recommend(result.hardware);
        } catch (...) {
            result.error = L"Windows could not report the hardware inventory. Try scanning again.";
        }
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
            MessageBoxW(window_, L"The chat panel could not be opened.", L"SAIAS-LLM", MB_OK | MB_ICONERROR);
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
            MoveWindow(button, px(tab_left), px(113), px(tab_left + tab_width) - px(tab_left), px(34), TRUE);
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
        content_bottom = step_layout_.bottom() + margin;
    } else if (view_ == View::advisor) {
        const float rows = static_cast<float>(std::max<std::size_t>(current_.hardware.adapters.size(), 1));
        content_bottom = hardware_top + 2 * hardware_row + rows * gpu_height + 61;
    } else {
        MoveWindow(chat_panel_, 0, px(header_height), area.right, std::max(0L, area.bottom - px(header_height)), TRUE);
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
    const bool accent = selected_step || active_view || item.CtlID == next_button;
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
    const float viewport_top = view_ == View::guide ? setup_body_top : header_height;
    const float viewport_bottom = height - (view_ == View::guide ? setup_footer_height : 0);
    if (content < 100 || viewport_bottom < viewport_top) {
        return;
    }

    canvas_.clip(bounds(0, viewport_top, width, viewport_bottom - viewport_top));
    canvas_.translate(-scroll_);
    if (view_ == View::guide) {
        draw_setup_step(content);
    } else if (view_ == View::advisor) {
        canvas_.label(L"Model advisor", Type::title, bounds(margin, 78, content, 38));
        const auto panel = bounds(margin, recommendation_top, content, 2 * recommendation_height);
        canvas_.fill(panel, surface);
        canvas_.outline(panel, border);
        canvas_.rule(margin, recommendation_top + recommendation_height, content, border);
        const auto& advice = current_.advice;
        recommendation(recommendation_top, content, advice && advice->most_capable ? &*advice->most_capable : nullptr, false);
        recommendation(recommendation_top + recommendation_height, content, advice ? &advice->everyday : nullptr, true);
        hardware(content);
    }
    canvas_.translate(0);
    canvas_.unclip();

    canvas_.fill(bounds(0, 0, width, header_height), header);
    canvas_.rule(0, header_height - 1, width, border);
    canvas_.label(L"SAIAS-LLM", Type::section, bounds(margin, 17, 180, 24));

    if (view_ == View::guide) {
        canvas_.label(L"Hermes Setup", Type::title, bounds(margin, 73, content, 38));
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

void Window::recommendation(float y, float width, const saias::Choice* choice, bool everyday) {
    const auto accent = everyday ? green : red;
    const float left = margin + 16;
    const float model_x = left + 127;
    const float right = margin + width - 16;
    constexpr float details_width = 156;
    const float details_x = right - details_width;
    canvas_.fill(bounds(margin + 1, y + 1, 3, recommendation_height - 1), accent);
    canvas_.label(everyday ? L"Everyday pick" : L"Most capable", Type::strong,
                  bounds(left, y + 19, 112, 22), accent);
    const std::wstring_view name = choice ? choice->profile->name :
        (scanning_ ? L"Scanning\u2026" : (current_.error.empty() ? L"No full preset" : L"Unavailable"));
    canvas_.label(name, Type::model, bounds(model_x, y + 10, details_x - model_x - 12, 35));

    if (choice) {
        const auto context = std::wstring(choice->profile->context) + L" tokens";
        canvas_.label(context, Type::strong, bounds(details_x, y + 19, details_width, 22),
                      text, DWRITE_TEXT_ALIGNMENT_TRAILING);
        if (everyday) {
            const auto speed = choice->target_plausible ? L"20 tok/s target" : L"Speed uncertain";
            canvas_.label(speed, Type::body, bounds(details_x, y + 42, details_width, 20),
                          choice->target_plausible ? green : muted, DWRITE_TEXT_ALIGNMENT_TRAILING);
        }
        canvas_.label(choice->mode, Type::body, bounds(model_x, y + 42, details_x - model_x - 12, 20), muted);
    }

    const auto reason = choice ? std::wstring_view(choice->reason)
        : (scanning_ ? L"Reading the hardware inventory."
                     : (current_.error.empty() ? L"The detected hardware is below the full-context presets." : L"Scan again to retry."));
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

    if (!current_.advice) {
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
    canvas_.label(L"Speed estimates assume a short prompt and a loaded model.",
                  Type::body, bounds(x, footer, width, 22), muted);
}

} // namespace

int WINAPI wWinMain(HINSTANCE application, HINSTANCE, PWSTR, int show) {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    Window window(application);
    if (!window.open(show)) {
        MessageBoxW(nullptr, L"The SAIAS-LLM window could not be opened.", L"SAIAS-LLM", MB_ICONERROR);
        return 1;
    }
    return window.run();
}
