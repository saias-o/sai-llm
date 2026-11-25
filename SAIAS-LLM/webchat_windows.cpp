#include "webchat_windows.hpp"
#include "chat_windows.hpp"
#include "saias_cli.hpp"

#include <objbase.h>
#include <shellapi.h>
#include <wrl.h>
#include <WebView2.h>

#include <exception>
#include <string>
#include <string_view>
#include <thread>
#include <utility>

namespace saias::webchat {
namespace {

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;

constexpr auto class_name = L"SaiasWebChat";
constexpr UINT hub_ready = WM_APP + 40;   // wparam: 1 when the hub answers, 0 when it did not start
constexpr COLORREF background = RGB(23, 23, 23);
constexpr COLORREF muted = RGB(175, 175, 175);

std::wstring chat_origin() {
    return L"http://127.0.0.1:" + std::to_wstring(cli::hub_port);
}

bool hub_running() {
    const auto response = cli::hub_request(L"GET", L"/saias/status", 1500);
    return response && response->status == 200;
}

// Links from answers open in the default browser, never inside the app.
void open_external(const wchar_t* uri) {
    if (!uri) {
        return;
    }
    const std::wstring_view text(uri);
    if (text.starts_with(L"https://") || text.starts_with(L"http://")) {
        ShellExecuteW(nullptr, L"open", uri, nullptr, nullptr, SW_SHOWNORMAL);
    }
}

// WebView2 keeps its profile (cache, local storage) next to the app's other data.
std::wstring profile_folder() {
    wchar_t local[MAX_PATH]{};
    const auto length = GetEnvironmentVariableW(L"LOCALAPPDATA", local, MAX_PATH);
    if (!length || length >= MAX_PATH) {
        return {};
    }
    return std::wstring(local, length) + L"\\SAIAS\\WebView2";
}

class View {
public:
    static LRESULT CALLBACK dispatch(HWND window, UINT message, WPARAM wparam, LPARAM lparam);
    View(HWND window, HINSTANCE instance) : window_(window), instance_(instance) {}

private:
    static View* from(HWND window);
    LRESULT handle(UINT message, WPARAM wparam, LPARAM lparam);
    void start_hub();
    void create_webview();
    void attach(ICoreWebView2Controller* controller);
    void use_fallback();
    void fit();
    void paint();
    void set_message(std::wstring text);
    void close();

    HWND window_;
    HINSTANCE instance_;
    HWND fallback_ = nullptr;
    ComPtr<ICoreWebView2Controller> controller_;
    ComPtr<ICoreWebView2> webview_;
    EventRegistrationToken new_window_{};
    EventRegistrationToken navigation_{};
    std::wstring message_ = L"Starting SAIAS…";
    std::jthread starter_;
    bool com_ = false;
};

View* View::from(HWND window) {
    return IsWindow(window) ? reinterpret_cast<View*>(GetWindowLongPtrW(window, GWLP_USERDATA)) : nullptr;
}

LRESULT CALLBACK View::dispatch(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    auto* view = from(window);
    if (message == WM_NCCREATE) {
        const auto* create = reinterpret_cast<const CREATESTRUCTW*>(lparam);
        try {
            view = new View(window, create->hInstance);
        } catch (const std::exception&) {
            return FALSE;
        }
        SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(view));
    }
    if (message == WM_NCDESTROY && view) {
        SetWindowLongPtrW(window, GWLP_USERDATA, 0);
        delete view;
        return DefWindowProcW(window, message, wparam, lparam);
    }
    if (!view) {
        return DefWindowProcW(window, message, wparam, lparam);
    }
    try {
        return view->handle(message, wparam, lparam);
    } catch (const std::exception&) {
        return message == WM_CREATE ? -1 : 0;
    }
}

LRESULT View::handle(UINT message, WPARAM wparam, LPARAM lparam) {
    switch (message) {
        case WM_CREATE: {
            const auto result = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
            com_ = SUCCEEDED(result);
            start_hub();
            return 0;
        }
        case WM_SIZE: fit(); return 0;
        case WM_ERASEBKGND: return 1;
        case WM_PAINT: paint(); return 0;
        case WM_SHOWWINDOW:
            if (controller_) {
                controller_->put_IsVisible(wparam ? TRUE : FALSE);
            }
            break;
        case WM_SETFOCUS:
            if (controller_) {
                controller_->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
            } else if (fallback_) {
                SetFocus(fallback_);
            }
            return 0;
        case hub_ready:
            if (wparam) {
                create_webview();
            } else {
                set_message(L"SAIAS did not start. Run Start-SAIAS.cmd to see why, then open Chat again.");
            }
            return 0;
        case WM_DESTROY: close(); return 0;
    }
    return DefWindowProcW(window_, message, wparam, lparam);
}

// Checks the hub on a worker thread and starts it (without a window) when it is not running.
void View::start_hub() {
    starter_ = std::jthread([window = window_](std::stop_token stop) {
        bool ready = hub_running();
        if (!ready) {
            if (const auto process = cli::launch(L"start", false)) {
                CloseHandle(process);
            }
            // Loading the hub's own servers takes a few seconds; allow two minutes.
            for (int attempt = 0; attempt < 240 && !ready && !stop.stop_requested(); ++attempt) {
                Sleep(500);
                ready = hub_running();
            }
        }
        if (!stop.stop_requested()) {
            PostMessageW(window, hub_ready, ready ? 1 : 0, 0);
        }
    });
}

void View::create_webview() {
    set_message(L"Opening the chat…");
    const auto folder = profile_folder();
    const auto started = CreateCoreWebView2EnvironmentWithOptions(nullptr, folder.empty() ? nullptr : folder.c_str(), nullptr,
        Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [window = window_](HRESULT result, ICoreWebView2Environment* environment) -> HRESULT {
                auto* view = from(window);
                if (!view) {
                    return S_OK;
                }
                if (FAILED(result) || !environment) {
                    view->use_fallback();
                    return S_OK;
                }
                const auto created = environment->CreateCoreWebView2Controller(window,
                    Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                        [window](HRESULT result, ICoreWebView2Controller* controller) -> HRESULT {
                            auto* view = from(window);
                            if (!view) {
                                if (controller) {
                                    controller->Close();
                                }
                                return S_OK;
                            }
                            if (FAILED(result) || !controller) {
                                view->use_fallback();
                            } else {
                                view->attach(controller);
                            }
                            return S_OK;
                        }).Get());
                if (FAILED(created)) {
                    view->use_fallback();
                }
                return S_OK;
            }).Get());
    if (FAILED(started)) {
        use_fallback();
    }
}

void View::attach(ICoreWebView2Controller* controller) {
    controller_ = controller;
    if (FAILED(controller_->get_CoreWebView2(&webview_)) || !webview_) {
        use_fallback();
        return;
    }
    // The app is dark: no white flash while the page loads, and the page's dark theme.
    ComPtr<ICoreWebView2Controller2> controller2;
    if (SUCCEEDED(controller_.As(&controller2))) {
        controller2->put_DefaultBackgroundColor(COREWEBVIEW2_COLOR{255, 23, 23, 23});
    }
    ComPtr<ICoreWebView2_13> webview13;
    if (SUCCEEDED(webview_.As(&webview13))) {
        ComPtr<ICoreWebView2Profile> profile;
        if (SUCCEEDED(webview13->get_Profile(&profile)) && profile) {
            profile->put_PreferredColorScheme(COREWEBVIEW2_PREFERRED_COLOR_SCHEME_DARK);
        }
    }
    ComPtr<ICoreWebView2Settings> settings;
    if (SUCCEEDED(webview_->get_Settings(&settings)) && settings) {
        settings->put_IsStatusBarEnabled(FALSE);
        settings->put_AreDevToolsEnabled(FALSE);
        settings->put_IsZoomControlEnabled(TRUE);
    }
    webview_->add_NewWindowRequested(Callback<ICoreWebView2NewWindowRequestedEventHandler>(
        [](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) -> HRESULT {
            LPWSTR uri = nullptr;
            if (SUCCEEDED(args->get_Uri(&uri))) {
                open_external(uri);
                CoTaskMemFree(uri);
            }
            args->put_Handled(TRUE);
            return S_OK;
        }).Get(), &new_window_);
    // The view stays on SAIAS Chat; any other address opens in the browser.
    webview_->add_NavigationStarting(Callback<ICoreWebView2NavigationStartingEventHandler>(
        [](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
            LPWSTR uri = nullptr;
            if (SUCCEEDED(args->get_Uri(&uri)) && uri) {
                const auto own = chat_origin() + L"/saias/chat";
                if (!std::wstring_view(uri).starts_with(own)) {
                    open_external(uri);
                    args->put_Cancel(TRUE);
                }
                CoTaskMemFree(uri);
            }
            return S_OK;
        }).Get(), &navigation_);
    fit();
    controller_->put_IsVisible(IsWindowVisible(window_) ? TRUE : FALSE);
    const auto url = chat_origin() + L"/saias/chat/";
    webview_->Navigate(url.c_str());
    message_.clear();
    InvalidateRect(window_, nullptr, FALSE);
    if (GetFocus() == window_) {
        controller_->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
    }
}

// Without the WebView2 runtime: the native chat panel.
void View::use_fallback() {
    if (fallback_) {
        return;
    }
    if (controller_) {
        controller_->Close();
    }
    controller_.Reset();
    webview_.Reset();
    fallback_ = chat::create_panel(instance_, window_);
    if (!fallback_) {
        set_message(L"The chat could not open. Install the Microsoft Edge WebView2 runtime, then open Chat again.");
        return;
    }
    message_.clear();
    fit();
    ShowWindow(fallback_, SW_SHOW);
}

void View::fit() {
    RECT area{};
    GetClientRect(window_, &area);
    if (controller_) {
        controller_->put_Bounds(area);
    }
    if (fallback_) {
        MoveWindow(fallback_, 0, 0, area.right, area.bottom, TRUE);
    }
}

void View::set_message(std::wstring text) {
    message_ = std::move(text);
    InvalidateRect(window_, nullptr, FALSE);
}

void View::paint() {
    PAINTSTRUCT paint{};
    const auto dc = BeginPaint(window_, &paint);
    RECT area{};
    GetClientRect(window_, &area);
    const auto brush = CreateSolidBrush(background);
    FillRect(dc, &area, brush);
    DeleteObject(brush);
    if (!message_.empty()) {
        const auto dpi = static_cast<int>(GetDpiForWindow(window_));
        const auto font = CreateFontW(-MulDiv(15, dpi, 96), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
        const auto previous = SelectObject(dc, font);
        SetBkMode(dc, TRANSPARENT);
        SetTextColor(dc, muted);
        RECT text = area;
        InflateRect(&text, -MulDiv(40, dpi, 96), 0);
        DrawTextW(dc, message_.c_str(), static_cast<int>(message_.size()), &text,
            DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX | DT_END_ELLIPSIS);
        SelectObject(dc, previous);
        DeleteObject(font);
    }
    EndPaint(window_, &paint);
}

void View::close() {
    if (starter_.joinable()) {
        starter_.request_stop();
        starter_.join();
    }
    if (webview_) {
        webview_->remove_NewWindowRequested(new_window_);
        webview_->remove_NavigationStarting(navigation_);
    }
    if (controller_) {
        controller_->Close();
    }
    webview_.Reset();
    controller_.Reset();
    if (com_) {
        CoUninitialize();
        com_ = false;
    }
}

} // namespace

HWND create_panel(HINSTANCE instance, HWND parent) {
    WNDCLASSEXW type{};
    type.cbSize = sizeof(type);
    type.hInstance = instance;
    type.lpfnWndProc = View::dispatch;
    type.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    type.lpszClassName = class_name;
    if (!RegisterClassExW(&type) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
        return nullptr;
    }
    return CreateWindowExW(WS_EX_CONTROLPARENT, class_name, L"Chat", WS_CHILD | WS_CLIPCHILDREN,
        0, 0, 0, 0, parent, nullptr, instance, nullptr);
}

} // namespace saias::webchat
