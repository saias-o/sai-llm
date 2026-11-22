#include "advisor.hpp"

#include <windows.h>
#include <d2d1.h>
#include <dwrite.h>
#include <dwmapi.h>
#include <wrl/client.h>

#include <algorithm>
#include <array>
#include <iterator>
#include <mutex>
#include <thread>
#include <utility>

namespace {

using Microsoft::WRL::ComPtr;
constexpr auto window_class = L"SaiLlmModelAdvisor";
constexpr UINT scan_complete = WM_APP + 1;
constexpr int rescan_button = 100;
constexpr float margin = 36;
constexpr float header_height = 78;
constexpr float card_top = 184;
constexpr float card_height = 224;
constexpr float hardware_top = 469;
constexpr float processor_height = 73;
constexpr float gpu_height = 54;

constexpr unsigned background = 0x0C111A;
constexpr unsigned header = 0x101722;
constexpr unsigned surface = 0x131C2A;
constexpr unsigned border = 0x28364B;
constexpr unsigned text = 0xF5F7FB;
constexpr unsigned muted = 0xA7B3C6;
constexpr unsigned lime = 0xC1F36B;
constexpr unsigned violet = 0xB9AAFF;
constexpr unsigned amber = 0xF2CB8A;

constexpr auto bounds(float x, float y, float width, float height) {
    return D2D1_RECT_F{x, y, x + width, y + height};
}

constexpr auto color_ref(unsigned rgb) {
    return RGB((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255);
}

enum class Type { eyebrow, body, wrapped, strong, section, model, title, count };
enum class Symbol { brand, layers, bolt, cpu, gpu, shield };

class Canvas {
public:
    bool initialize();
    bool begin(HWND window, UINT dpi);
    void end();
    void resize(HWND window, UINT dpi);
    void translate(float y);
    void clip(D2D1_RECT_F area);
    void unclip();
    void fill(D2D1_RECT_F area, unsigned rgb, float radius = 0);
    void outline(D2D1_RECT_F area, unsigned rgb, float radius);
    void rule(float x, float y, float width, unsigned rgb);
    void wash(float width);
    void label(std::wstring_view value, Type style, D2D1_RECT_F area, unsigned rgb = text,
               DWRITE_TEXT_ALIGNMENT align = DWRITE_TEXT_ALIGNMENT_LEADING);
    void icon(Symbol symbol, float x, float y, unsigned rgb, unsigned tile, float size = 40);

private:
    void ink(unsigned rgb);
    void segment(float x1, float y1, float x2, float y2, float weight = 1.65f);

    ComPtr<ID2D1Factory> d2d_;
    ComPtr<IDWriteFactory> write_;
    std::array<ComPtr<IDWriteTextFormat>, static_cast<std::size_t>(Type::count)> formats_;
    ComPtr<ID2D1HwndRenderTarget> target_;
    ComPtr<ID2D1SolidColorBrush> brush_;
    ComPtr<ID2D1LinearGradientBrush> wash_;
};

bool Canvas::initialize() {
    if (FAILED(D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, d2d_.GetAddressOf()))
        || FAILED(DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory),
            reinterpret_cast<IUnknown**>(write_.GetAddressOf())))) {
        return false;
    }

    struct Style { float size; DWRITE_FONT_WEIGHT weight; };
    constexpr Style styles[]{
        {11, DWRITE_FONT_WEIGHT_BOLD}, {13.5f, DWRITE_FONT_WEIGHT_NORMAL},
        {13.5f, DWRITE_FONT_WEIGHT_NORMAL}, {14, DWRITE_FONT_WEIGHT_SEMI_BOLD},
        {20, DWRITE_FONT_WEIGHT_SEMI_BOLD}, {35, DWRITE_FONT_WEIGHT_SEMI_BOLD},
        {38, DWRITE_FONT_WEIGHT_SEMI_BOLD},
    };
    static_assert(std::size(styles) == static_cast<std::size_t>(Type::count));
    for (std::size_t index = 0; index < formats_.size(); ++index) {
        auto& format = formats_[index];
        const auto style = styles[index];
        if (FAILED(write_->CreateTextFormat(L"Segoe UI", nullptr, style.weight,
                DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL, style.size, L"en-US",
                format.GetAddressOf()))) {
            return false;
        }
        format->SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_NEAR);
        if (index != static_cast<std::size_t>(Type::wrapped)) {
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
        const D2D1_GRADIENT_STOP stops[]{{0, D2D1::ColorF(0x152137)}, {1, D2D1::ColorF(background)}};
        ComPtr<ID2D1GradientStopCollection> collection;
        if (SUCCEEDED(target_->CreateGradientStopCollection(stops, 2, collection.GetAddressOf()))) {
            target_->CreateLinearGradientBrush(
                D2D1::LinearGradientBrushProperties(D2D1::Point2F(), D2D1::Point2F(0, 270)),
                collection.Get(), wash_.GetAddressOf());
        }
    }
    target_->BeginDraw();
    target_->SetTransform(D2D1::Matrix3x2F::Identity());
    target_->Clear(D2D1::ColorF(background));
    return true;
}

void Canvas::end() {
    if (target_->EndDraw() == D2DERR_RECREATE_TARGET) {
        wash_.Reset();
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

void Canvas::fill(D2D1_RECT_F area, unsigned rgb, float radius) {
    ink(rgb);
    if (radius) {
        target_->FillRoundedRectangle(D2D1::RoundedRect(area, radius, radius), brush_.Get());
    } else {
        target_->FillRectangle(area, brush_.Get());
    }
}

void Canvas::outline(D2D1_RECT_F area, unsigned rgb, float radius) {
    ink(rgb);
    target_->DrawRoundedRectangle(D2D1::RoundedRect(area, radius, radius), brush_.Get());
}

void Canvas::rule(float x, float y, float width, unsigned rgb) {
    ink(rgb);
    segment(x, y, x + width, y, 1);
}

void Canvas::wash(float width) {
    if (wash_) {
        target_->FillRectangle(bounds(0, header_height, width, 220), wash_.Get());
    }
}

void Canvas::label(std::wstring_view value, Type style, D2D1_RECT_F area, unsigned rgb,
                   DWRITE_TEXT_ALIGNMENT align) {
    auto& format = formats_[static_cast<std::size_t>(style)];
    format->SetTextAlignment(align);
    ink(rgb);
    target_->DrawText(value.data(), static_cast<UINT32>(value.size()), format.Get(), area,
                      brush_.Get(), D2D1_DRAW_TEXT_OPTIONS_CLIP);
}

void Canvas::segment(float x1, float y1, float x2, float y2, float weight) {
    target_->DrawLine(D2D1::Point2F(x1, y1), D2D1::Point2F(x2, y2), brush_.Get(), weight);
}

void Canvas::icon(Symbol symbol, float x, float y, unsigned rgb, unsigned tile, float size) {
    fill(bounds(x, y, size, size), tile, 10);
    const float center_x = x + size / 2;
    const float center_y = y + size / 2;
    const auto stroke = [&](float x1, float y1, float x2, float y2) {
        segment(center_x + x1, center_y + y1, center_x + x2, center_y + y2);
    };
    ink(rgb);
    switch (symbol) {
        case Symbol::brand:
            stroke(-8, 6, -8, 1); stroke(-8, 1, -3, 1); stroke(-3, 1, -3, -4);
            stroke(-3, -4, 2, -4); stroke(2, -4, 2, -8); stroke(2, -8, 8, -8);
            stroke(-4, 7, 1, 7); stroke(1, 7, 1, 3); stroke(1, 3, 7, 3);
            break;
        case Symbol::layers:
            stroke(-11, -4, 0, -10); stroke(0, -10, 11, -4);
            stroke(11, -4, 0, 2); stroke(0, 2, -11, -4);
            stroke(-11, 1, 0, 7); stroke(0, 7, 11, 1);
            stroke(-11, 6, 0, 12); stroke(0, 12, 11, 6);
            break;
        case Symbol::bolt:
            stroke(2, -12, -9, 2); stroke(-9, 2, -1, 2);
            stroke(-1, 2, -3, 12); stroke(-3, 12, 9, -3);
            stroke(9, -3, 1, -3); stroke(1, -3, 2, -12);
            break;
        case Symbol::cpu:
            target_->DrawRoundedRectangle(D2D1::RoundedRect(bounds(center_x - 7, center_y - 7, 14, 14), 2, 2),
                                          brush_.Get(), 1.4f);
            for (float pin : {-4, 0, 4}) {
                stroke(pin, -7, pin, -10); stroke(pin, 7, pin, 10);
                stroke(-7, pin, -10, pin); stroke(7, pin, 10, pin);
            }
            break;
        case Symbol::gpu:
            target_->DrawRoundedRectangle(D2D1::RoundedRect(bounds(center_x - 10, center_y - 6, 20, 12), 2, 2),
                                          brush_.Get(), 1.4f);
            target_->DrawEllipse(D2D1::Ellipse(D2D1::Point2F(center_x - 3, center_y), 3, 3), brush_.Get(), 1.3f);
            stroke(4, -2, 7, -2); stroke(4, 2, 7, 2); stroke(-6, 6, -6, 9); stroke(5, 6, 5, 9);
            break;
        case Symbol::shield:
            stroke(-6, -2, -6, -6); stroke(-6, -6, 0, -8); stroke(0, -8, 6, -6);
            stroke(6, -6, 6, 0); stroke(6, 0, 0, 7); stroke(0, 7, -6, 0); stroke(-6, 0, -6, -2);
            stroke(-3, -1, -1, 2); stroke(-1, 2, 3, -2);
            break;
    }
}

struct Scan {
    sai::Hardware hardware;
    std::optional<sai::Advice> advice;
    std::wstring error;
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
    void draw();
    void recommendation(float x, float width, const sai::Choice* choice, bool everyday);
    void hardware(float width);
    void paint_button(const DRAWITEMSTRUCT& item) const;
    int px(float dips) const { return static_cast<int>(dips * dpi_ / 96.0f + 0.5f); }
    float dips(int pixels) const { return pixels * 96.0f / dpi_; }

    HINSTANCE application_;
    HWND window_ = nullptr;
    HWND rescan_ = nullptr;
    UINT dpi_ = 96;
    Canvas canvas_;
    float scroll_ = 0;
    float max_scroll_ = 0;
    bool scanning_ = false;
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
    RECT requested{0, 0, px(1000), px(720)};
    AdjustWindowRectExForDpi(&requested, style, FALSE, 0, dpi_);
    const LONG available_width = monitor.rcWork.right - monitor.rcWork.left;
    const LONG available_height = monitor.rcWork.bottom - monitor.rcWork.top;
    const LONG width = std::min(requested.right - requested.left, available_width);
    const LONG height = std::min(requested.bottom - requested.top, available_height);
    window_ = CreateWindowExW(0, window_class, L"SAI-LLM | Model Advisor", style,
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
        if (message.message == WM_KEYDOWN && message.wParam == VK_F5) {
            scan();
            continue;
        }
        if (message.message == WM_KEYDOWN && (message.wParam == VK_NEXT || message.wParam == VK_PRIOR)) {
            RECT area{};
            GetClientRect(window_, &area);
            scroll_by((dips(area.bottom) - header_height - 24) * (message.wParam == VK_NEXT ? 1 : -1));
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
            rescan_ = CreateWindowExW(0, L"BUTTON", L"Rescan", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_OWNERDRAW,
                0, 0, 0, 0, window_, reinterpret_cast<HMENU>(static_cast<INT_PTR>(rescan_button)), application_, nullptr);
            if (!rescan_) {
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
                constexpr auto error = L"SAI-LLM could not initialize the graphics surface.";
                TextOutW(dc, 24, 96, error, lstrlenW(error));
            }
            EndPaint(window_, &paint);
            return 0;
        }
        case WM_COMMAND:
            if (LOWORD(wparam) == rescan_button && HIWORD(wparam) == BN_CLICKED) {
                scan();
            }
            return 0;
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
            result.hardware = sai::scan_hardware();
            result.advice = sai::recommend(result.hardware);
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

void Window::resize() {
    RECT area{};
    GetClientRect(window_, &area);
    if (rescan_) {
        MoveWindow(rescan_, area.right - px(margin + 108), px(23), px(108), px(34), TRUE);
    }
    const float cards = static_cast<float>(std::max<std::size_t>(current_.hardware.adapters.size(), 1));
    const float bottom = hardware_top + processor_height + cards * gpu_height + 58;
    max_scroll_ = std::max(0.0f, bottom - dips(area.bottom));
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
    const auto brush = CreateSolidBrush(color_ref(pressed ? 0x30445A : 0x182439));
    const auto pen = CreatePen(PS_SOLID, 1, color_ref(focused ? lime : 0x40516C));
    const auto old_brush = SelectObject(dc, brush);
    const auto old_pen = SelectObject(dc, pen);
    RoundRect(dc, area.left, area.top, area.right, area.bottom, px(9), px(9));
    SelectObject(dc, old_brush);
    SelectObject(dc, old_pen);
    DeleteObject(brush);
    DeleteObject(pen);

    HFONT font = CreateFontW(-px(13), 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
        OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
    const auto old_font = SelectObject(dc, font);
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, color_ref(disabled ? muted : text));
    RECT label_area = area;
    std::array<wchar_t, 24> label{};
    GetWindowTextW(item.hwndItem, label.data(), static_cast<int>(label.size()));
    DrawTextW(dc, label.data(), -1, &label_area, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
    SelectObject(dc, old_font);
    DeleteObject(font);
}

void Window::draw() {
    RECT area{};
    GetClientRect(window_, &area);
    const float width = dips(area.right);
    const float height = dips(area.bottom);
    const float content = width - 2 * margin;
    if (content < 100 || height < 80) {
        return;
    }

    canvas_.wash(width);
    canvas_.clip(bounds(0, header_height, width, height - header_height));
    canvas_.translate(-scroll_);
    canvas_.label(L"Model advisor", Type::title, bounds(margin, 103, content, 56));
    canvas_.label(L"Recommendations based on your CPU, memory, and graphics hardware.", Type::body,
                  bounds(margin + 1, 154, content, 25), muted);
    const float half = (content - 16) / 2;
    const auto& advice = current_.advice;
    recommendation(margin, half, advice && advice->most_capable ? &*advice->most_capable : nullptr, false);
    recommendation(margin + half + 16, half, advice ? &advice->everyday : nullptr, true);
    hardware(content);
    canvas_.translate(0);
    canvas_.unclip();

    canvas_.fill(bounds(0, 0, width, header_height), header);
    canvas_.rule(0, header_height - 1, width, border);
    canvas_.icon(Symbol::brand, margin, 22, lime, 0x223523, 34);
    canvas_.label(L"SAI-LLM", Type::strong, bounds(margin + 46, 28, 180, 24));

    if (max_scroll_ > 1) {
        const float track = height - header_height - 16;
        const float thumb = std::max(22.0f, track * track / (track + max_scroll_));
        const float top = header_height + 8 + (track - thumb) * scroll_ / max_scroll_;
        canvas_.fill(bounds(width - 8, top, 4, thumb), 0x3D506C, 2);
    }
}

void Window::recommendation(float x, float width, const sai::Choice* choice, bool everyday) {
    const float inner = x + 23;
    const float usable = width - 46;
    const auto tint = everyday ? lime : violet;
    const auto tile = everyday ? 0x213627 : 0x282640;
    const auto panel = everyday ? 0x12251F : 0x191E32;
    const auto edge = everyday ? 0x385941 : 0x3D3959;
    const auto y = card_top;
    const auto frame = bounds(x, y, width, card_height);
    canvas_.fill(frame, panel, 16);
    canvas_.outline(frame, edge, 16);
    canvas_.icon(everyday ? Symbol::bolt : Symbol::layers, x + width - 68, y + 20, tint, tile, 44);
    canvas_.label(everyday ? L"EVERYDAY PICK" : L"MOST CAPABLE", Type::eyebrow,
                  bounds(inner, y + 21, usable - 48, 23), tint);
    const std::wstring_view name = choice ? choice->profile->name :
        (scanning_ ? L"Scanning…" : (current_.error.empty() ? L"No full preset" : L"Unavailable"));
    canvas_.label(name, Type::model, bounds(inner, y + 46, usable - 40, 56));

    if (choice) {
        const float chip_width = 108;
        const float context_width = everyday ? usable - chip_width - 8 : usable;
        const auto context = std::wstring(choice->profile->context) + L" tokens";
        canvas_.label(context, Type::strong, bounds(inner, y + 112, context_width, 24));
        if (everyday) {
            const auto badge = choice->target_plausible ? L"20 tok/s target" : L"Speed uncertain";
            canvas_.fill(bounds(inner + usable - chip_width, y + 109, chip_width, 25),
                         choice->target_plausible ? 0x273C23 : 0x3D3223, 8);
            canvas_.label(badge, Type::eyebrow, bounds(inner + usable - chip_width, y + 114, chip_width, 17),
                          choice->target_plausible ? lime : amber, DWRITE_TEXT_ALIGNMENT_CENTER);
        }
        canvas_.label(choice->mode, Type::body, bounds(inner, y + 136, usable, 22), muted);
    }

    canvas_.rule(inner, y + 168, usable, edge);
    const auto reason = choice ? std::wstring_view(choice->reason)
        : (scanning_ ? L"Reading the hardware inventory."
                     : (current_.error.empty() ? L"The detected hardware is below the full-context presets." : L"Scan again to retry."));
    canvas_.label(reason, Type::wrapped, bounds(inner, y + 181, usable, 42), muted);
}

void Window::hardware(float width) {
    const auto x = margin;
    canvas_.label(L"Detected hardware", Type::section, bounds(x, hardware_top - 37, width, 30));
    const auto& pc = current_.hardware;
    const auto adapter_count = std::max<std::size_t>(pc.adapters.size(), 1);
    const float panel_height = processor_height + gpu_height * static_cast<float>(adapter_count);
    const auto panel = bounds(x, hardware_top, width, panel_height);
    canvas_.fill(panel, surface, 14);
    canvas_.outline(panel, border, 14);

    if (!current_.advice) {
        const auto status = scanning_ ? L"Scanning local hardware…" : current_.error.c_str();
        canvas_.label(status, Type::wrapped, bounds(x + 20, hardware_top + 24, width - 40, 52), muted);
    } else {
        const float value_width = std::min(width * 0.28f, 190.0f);
        const float value_x = x + width - value_width - 20;
        const auto cores = pc.physical_cores ? std::to_wstring(pc.physical_cores) + L" physical cores" : L"Core count unavailable";
        canvas_.icon(Symbol::cpu, x + 18, hardware_top + 17, 0xADD1FD, 0x22344C, 38);
        canvas_.label(pc.cpu, Type::strong, bounds(x + 69, hardware_top + 15, value_x - x - 79, 24));
        canvas_.label(cores, Type::body, bounds(x + 69, hardware_top + 38, value_x - x - 79, 22), muted);
        canvas_.label(sai::gib(pc.ram_gib), Type::section, bounds(value_x, hardware_top + 9, value_width, 30),
                      text, DWRITE_TEXT_ALIGNMENT_TRAILING);
        canvas_.label(L"Usable system RAM", Type::body, bounds(value_x, hardware_top + 39, value_width, 21),
                      muted, DWRITE_TEXT_ALIGNMENT_TRAILING);

        float row = hardware_top + processor_height;
        if (pc.adapters.empty()) {
            canvas_.rule(x + 18, row, width - 36, border);
            canvas_.label(L"No GPU identified", Type::body, bounds(x + 21, row + 16, width - 40, 26), muted);
        }
        for (const auto& card : pc.adapters) {
            canvas_.rule(x + 18, row, width - 36, border);
            canvas_.icon(Symbol::gpu, x + 20, row + 10, 0xADD1FD, 0x22344C, 34);
            canvas_.label(card.name, Type::strong, bounds(x + 69, row + 16, value_x - x - 79, 24));
            const auto dedicated = card.dedicated_gib > 0 ? sai::gib(card.dedicated_gib) + L" dedicated" : L"Dedicated VRAM unavailable";
            canvas_.label(dedicated, Type::strong, bounds(value_x, row + 8, value_width, 22),
                          text, DWRITE_TEXT_ALIGNMENT_TRAILING);
            if (card.shared_gib > 0) {
                canvas_.label(sai::gib(card.shared_gib) + L" shared", Type::body,
                              bounds(value_x, row + 28, value_width, 21), muted, DWRITE_TEXT_ALIGNMENT_TRAILING);
            }
            row += gpu_height;
        }
    }

    const float footer = hardware_top + panel_height + 13;
    canvas_.icon(Symbol::shield, x + 1, footer, 0x91BEA8, background, 24);
    canvas_.label(L"Read-only scan. Speed estimates are for a short prompt with the model already loaded.",
                  Type::body, bounds(x + 31, footer + 3, width - 31, 24), muted);
}

} // namespace

int WINAPI wWinMain(HINSTANCE application, HINSTANCE, PWSTR, int show) {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    Window window(application);
    if (!window.open(show)) {
        MessageBoxW(nullptr, L"The SAI-LLM window could not be opened.", L"SAI-LLM", MB_ICONERROR);
        return 1;
    }
    return window.run();
}
