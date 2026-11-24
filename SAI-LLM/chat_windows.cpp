#include "chat_windows.hpp"
#include "attachments.hpp"
#include "chat.hpp"

#include <commctrl.h>
#include <commdlg.h>
#include <richedit.h>
#include <windowsx.h>

#include <algorithm>
#include <array>
#include <cwchar>
#include <exception>
#include <mutex>
#include <optional>
#include <utility>

namespace sai::chat {
namespace {

constexpr auto class_name = L"SaiLlmChatPanel";
constexpr UINT_PTR refresh_timer = 1;
constexpr int history_id = 200;
constexpr int new_id = 201;
constexpr int model_id = 202;
constexpr int effort_id = 203;
constexpr int send_id = 204;
constexpr int attach_id = 205;
constexpr int remove_attachment_id = 206;
constexpr int options_id = 207;
constexpr int memory_id = 208;
constexpr int prompt_id = 209;
constexpr int save_options_id = 210;
constexpr int cancel_options_id = 211;
constexpr UINT files_ready = WM_APP + 2;
constexpr auto no_selection = static_cast<std::size_t>(-1);
constexpr auto attachment_glyph = L"\uE723";

constexpr COLORREF black = RGB(8, 8, 8);
constexpr COLORREF panel = RGB(13, 13, 13);
constexpr COLORREF field = RGB(18, 18, 18);
constexpr COLORREF edge = RGB(52, 52, 52);
constexpr COLORREF text = RGB(243, 243, 243);
constexpr COLORREF muted = RGB(175, 175, 175);
constexpr COLORREF green = RGB(119, 213, 151);
constexpr COLORREF red = RGB(255, 121, 114);

std::wstring window_text(HWND window) {
    std::wstring result(static_cast<std::size_t>(GetWindowTextLengthW(window)) + 1, L'\0');
    const int size = GetWindowTextW(window, result.data(), static_cast<int>(result.size()));
    result.resize(size);
    return result;
}

std::vector<std::filesystem::path> pick_files(HWND owner) {
    std::vector<wchar_t> names(32768, L'\0');
    OPENFILENAMEW dialog{};
    dialog.lStructSize = sizeof(dialog);
    dialog.hwndOwner = owner;
    dialog.lpstrFilter = L"PDF and image files\0*.pdf;*.png;*.jpg;*.jpeg\0PDF files\0*.pdf\0"
        L"PNG and JPEG images\0*.png;*.jpg;*.jpeg\0";
    dialog.lpstrFile = names.data();
    dialog.nMaxFile = static_cast<DWORD>(names.size());
    dialog.lpstrTitle = L"Attach files";
    dialog.Flags = OFN_EXPLORER | OFN_ALLOWMULTISELECT | OFN_FILEMUSTEXIST | OFN_NOCHANGEDIR | OFN_DONTADDTORECENT;
    if (!GetOpenFileNameW(&dialog)) {
        return {};
    }

    const wchar_t* item = names.data() + std::wcslen(names.data()) + 1;
    if (*item == L'\0') {
        return {std::filesystem::path(names.data())};
    }
    const std::filesystem::path directory(names.data());
    std::vector<std::filesystem::path> files;
    while (*item) {
        files.push_back(directory / item);
        item += std::wcslen(item) + 1;
    }
    return files;
}

void rectangle(HDC dc, const RECT& rect, COLORREF color, bool outline = false) {
    const auto brush = static_cast<HBRUSH>(GetStockObject(DC_BRUSH));
    const auto previous = SetDCBrushColor(dc, color);
    if (outline) {
        FrameRect(dc, &rect, brush);
    } else {
        FillRect(dc, &rect, brush);
    }
    SetDCBrushColor(dc, previous);
}

class Panel {
public:
    static LRESULT CALLBACK dispatch(HWND window, UINT message, WPARAM wparam, LPARAM lparam);
    explicit Panel(HWND window) : window_(window) {}
    ~Panel();

private:
    LRESULT handle(UINT message, WPARAM wparam, LPARAM lparam);
    static LRESULT CALLBACK entry_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam, UINT_PTR id, DWORD_PTR data);
    bool initialize();
    HWND control(LPCWSTR kind, LPCWSTR caption, DWORD style, int id = 0);
    void layout();
    void update_font();
    void paint_item(const DRAWITEMSTRUCT& item) const;
    HBRUSH paint_control(HDC dc, HWND control) const;
    int px(int dips) const { return MulDiv(dips, dpi_, 96); }

    void new_conversation();
    void show_conversation(std::size_t index);
    void refresh_history();
    void fill_reasoning();
    void choose_model();
    void choose_reasoning();
    void persist(const Conversation& conversation);
    void set_status(std::wstring_view value, bool failed = false);
    void update_controls();

    void choose_attachments();
    void accept_attachments();
    void refresh_attachments();
    void remove_attachment();
    bool has_pending_image() const;
    void show_options(bool open);
    void select_option(bool memory);
    void capture_option();
    void save_options();

    void send();
    void commit_pending_message();
    void update_reply();
    void render_history();
    void append(std::wstring_view value, COLORREF color, bool bold = false);
    void append_message(const Message& message);

    HWND window_;
    HWND list_ = nullptr;
    HWND title_ = nullptr;
    HWND new_ = nullptr;
    HWND model_label_ = nullptr;
    HWND model_ = nullptr;
    HWND reasoning_label_ = nullptr;
    HWND reasoning_ = nullptr;
    HWND transcript_ = nullptr;
    HWND entry_ = nullptr;
    HWND send_ = nullptr;
    HWND status_ = nullptr;
    HWND attach_ = nullptr;
    HWND attachments_ = nullptr;
    HWND remove_attachment_ = nullptr;
    HWND options_ = nullptr;
    HWND options_title_ = nullptr;
    HWND memory_tab_ = nullptr;
    HWND prompt_tab_ = nullptr;
    HWND options_hint_ = nullptr;
    HWND options_entry_ = nullptr;
    HWND save_options_ = nullptr;
    HWND cancel_options_ = nullptr;
    HMODULE rich_edit_ = nullptr;
    HFONT font_ = nullptr;
    HFONT heading_ = nullptr;
    HFONT attachment_font_ = nullptr;
    HBRUSH background_brush_ = nullptr;
    HBRUSH panel_brush_ = nullptr;
    HBRUSH field_brush_ = nullptr;
    UINT dpi_ = 96;

    Archive archive_;
    std::vector<Conversation> conversations_;
    std::size_t selected_ = no_selection;
    std::size_t active_ = no_selection;
    std::unique_ptr<Request> request_;
    std::optional<std::wstring> pending_prompt_;
    std::wstring partial_;
    bool failed_ = false;
    bool history_saved_ = true;
    Settings settings_;
    Settings working_settings_;
    bool options_open_ = false;
    bool memory_open_ = true;
    bool importing_ = false;
    bool skipped_files_ = false;
    std::size_t attachment_target_ = no_selection;
    std::vector<AttachmentImport> imported_;
    std::mutex import_mutex_;
    std::jthread importer_;
};

Panel::~Panel() {
    if (importer_.joinable()) {
        importer_.request_stop();
        importer_.join();
    }
    request_.reset();
    DeleteObject(font_);
    DeleteObject(heading_);
    DeleteObject(attachment_font_);
    DeleteObject(background_brush_);
    DeleteObject(panel_brush_);
    DeleteObject(field_brush_);
    if (rich_edit_) {
        FreeLibrary(rich_edit_);
    }
}

LRESULT CALLBACK Panel::dispatch(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    auto* panel = reinterpret_cast<Panel*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == WM_NCCREATE) {
        try {
            panel = new Panel(window);
        } catch (const std::exception&) {
            return FALSE;
        }
        SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(panel));
    }
    if (message == WM_NCDESTROY && panel) {
        SetWindowLongPtrW(window, GWLP_USERDATA, 0);
        delete panel;
        return DefWindowProcW(window, message, wparam, lparam);
    }
    if (!panel) {
        return DefWindowProcW(window, message, wparam, lparam);
    }
    try {
        return panel->handle(message, wparam, lparam);
    } catch (const std::exception&) {
        if (message == WM_CREATE) {
            return -1;
        }
        panel->set_status(L"The chat operation could not be completed.", true);
        return 0;
    }
}

HWND Panel::control(LPCWSTR kind, LPCWSTR caption, DWORD style, int id) {
    return CreateWindowExW(0, kind, caption, WS_CHILD | WS_VISIBLE | style, 0, 0, 0, 0,
        window_, reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)),
        reinterpret_cast<HINSTANCE>(GetWindowLongPtrW(window_, GWLP_HINSTANCE)), nullptr);
}

bool Panel::initialize() {
    dpi_ = GetDpiForWindow(window_);
    rich_edit_ = LoadLibraryExW(L"Msftedit.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
    background_brush_ = CreateSolidBrush(black);
    panel_brush_ = CreateSolidBrush(panel);
    field_brush_ = CreateSolidBrush(field);
    if (!rich_edit_ || !background_brush_ || !panel_brush_ || !field_brush_) {
        return false;
    }
    constexpr DWORD button_style = WS_TABSTOP | BS_OWNERDRAW;
    constexpr DWORD combo_style = WS_TABSTOP | WS_VSCROLL | CBS_DROPDOWNLIST | CBS_HASSTRINGS | CBS_OWNERDRAWFIXED;
    title_ = control(L"STATIC", L"Conversations", SS_NOPREFIX);
    new_ = control(L"BUTTON", L"New conversation", button_style, new_id);
    list_ = control(L"LISTBOX", L"", WS_TABSTOP | WS_VSCROLL | LBS_NOTIFY | LBS_NOINTEGRALHEIGHT
        | LBS_HASSTRINGS | LBS_OWNERDRAWFIXED, history_id);
    model_label_ = control(L"STATIC", L"Model", SS_NOPREFIX);
    model_ = control(L"COMBOBOX", L"", combo_style, model_id);
    reasoning_label_ = control(L"STATIC", L"Reasoning", SS_NOPREFIX);
    reasoning_ = control(L"COMBOBOX", L"", combo_style, effort_id);
    transcript_ = control(MSFTEDIT_CLASS, L"", WS_TABSTOP | WS_VSCROLL | ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL);
    entry_ = control(L"EDIT", L"", WS_TABSTOP | WS_VSCROLL | ES_MULTILINE | ES_AUTOVSCROLL | ES_WANTRETURN);
    send_ = control(L"BUTTON", L"Send", button_style, send_id);
    status_ = control(L"STATIC", L"", SS_NOPREFIX);
    attach_ = control(L"BUTTON", L"Attach files", button_style, attach_id);
    attachments_ = control(L"COMBOBOX", L"", combo_style);
    remove_attachment_ = control(L"BUTTON", L"Remove", button_style, remove_attachment_id);
    options_ = control(L"BUTTON", L"Options", button_style, options_id);
    options_title_ = control(L"STATIC", L"Chat options", SS_NOPREFIX);
    memory_tab_ = control(L"BUTTON", L"Memory", button_style, memory_id);
    prompt_tab_ = control(L"BUTTON", L"System Prompt", button_style, prompt_id);
    options_hint_ = control(L"STATIC", L"", SS_NOPREFIX);
    options_entry_ = control(L"EDIT", L"", WS_TABSTOP | WS_VSCROLL | ES_MULTILINE | ES_AUTOVSCROLL | ES_WANTRETURN);
    save_options_ = control(L"BUTTON", L"Save", button_style, save_options_id);
    cancel_options_ = control(L"BUTTON", L"Cancel", button_style, cancel_options_id);
    if (!title_ || !new_ || !list_ || !model_label_ || !model_ || !reasoning_label_ || !reasoning_
        || !transcript_ || !entry_ || !send_ || !status_ || !attach_ || !attachments_ || !remove_attachment_
        || !options_ || !options_title_ || !memory_tab_ || !prompt_tab_ || !options_hint_ || !options_entry_
        || !save_options_ || !cancel_options_) {
        return false;
    }
    if (!SetWindowSubclass(entry_, entry_proc, 1, reinterpret_cast<DWORD_PTR>(this))) {
        return false;
    }
    update_font();
    SendMessageW(transcript_, EM_SETBKGNDCOLOR, FALSE, field);
    SendMessageW(transcript_, EM_EXLIMITTEXT, 0, 32 * 1024 * 1024);
    SendMessageW(entry_, EM_LIMITTEXT, 4 * 1024 * 1024, 0);
    SendMessageW(options_entry_, EM_LIMITTEXT, 65536, 0);
    SendMessageW(entry_, EM_SETMARGINS, EC_LEFTMARGIN | EC_RIGHTMARGIN, MAKELPARAM(px(8), px(8)));
    for (const auto& model : models) {
        const auto label = model.id == L"sai-smart" ? L"sai-smart (Bonsai 2 27B)" : model.id.data();
        SendMessageW(model_, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(label));
    }
    settings_ = archive_.load_settings();
    conversations_ = archive_.load();
    if (conversations_.empty()) {
        conversations_.push_back(archive_.create());
    }
    refresh_history();
    show_conversation(0);
    show_options(false);
    return true;
}

void Panel::update_font() {
    const auto create = [&](int size, int weight, const wchar_t* family = L"Segoe UI") {
        return CreateFontW(-px(size), 0, 0, 0, weight, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, family);
    };
    const auto body = create(14, FW_NORMAL);
    const auto heading = create(16, FW_SEMIBOLD);
    if (body && heading) {
        for (const auto input : {new_, list_, model_label_, model_, reasoning_label_, reasoning_, transcript_, entry_, send_,
                status_, attach_, attachments_, remove_attachment_, options_, memory_tab_, prompt_tab_, options_hint_,
                options_entry_, save_options_, cancel_options_}) {
            SendMessageW(input, WM_SETFONT, reinterpret_cast<WPARAM>(body), TRUE);
        }
        SendMessageW(title_, WM_SETFONT, reinterpret_cast<WPARAM>(heading), TRUE);
        SendMessageW(options_title_, WM_SETFONT, reinterpret_cast<WPARAM>(heading), TRUE);
        DeleteObject(std::exchange(font_, body));
        DeleteObject(std::exchange(heading_, heading));
    } else {
        DeleteObject(body);
        DeleteObject(heading);
    }
    if (const auto icons = create(17, FW_NORMAL, L"Segoe MDL2 Assets")) {
        DeleteObject(std::exchange(attachment_font_, icons));
    }
    SendMessageW(list_, LB_SETITEMHEIGHT, 0, px(34));
    for (const auto menu : {model_, reasoning_, attachments_}) {
        SendMessageW(menu, CB_SETITEMHEIGHT, static_cast<WPARAM>(-1), px(28));
        SendMessageW(menu, CB_SETITEMHEIGHT, 0, px(29));
    }
    SendMessageW(entry_, EM_SETMARGINS, EC_LEFTMARGIN | EC_RIGHTMARGIN, MAKELPARAM(px(8), px(8)));
    SendMessageW(options_entry_, EM_SETMARGINS, EC_LEFTMARGIN | EC_RIGHTMARGIN, MAKELPARAM(px(8), px(8)));
}

void Panel::layout() {
    RECT rect{};
    GetClientRect(window_, &rect);
    if (!rect.right || !rect.bottom) {
        return;
    }
    if (options_open_) {
        const int right = rect.right - px(22);
        const int footer = rect.bottom - px(54);
        MoveWindow(options_title_, px(22), px(18), right - px(22), px(24), TRUE);
        MoveWindow(memory_tab_, px(22), px(51), px(94), px(32), TRUE);
        MoveWindow(prompt_tab_, px(124), px(51), px(134), px(32), TRUE);
        MoveWindow(options_hint_, px(22), px(95), right - px(22), px(42), TRUE);
        MoveWindow(options_entry_, px(22), px(143), right - px(22), std::max(px(56), footer - px(157)), TRUE);
        MoveWindow(cancel_options_, right - px(170), footer, px(80), px(33), TRUE);
        MoveWindow(save_options_, right - px(80), footer, px(80), px(33), TRUE);
        MoveWindow(status_, px(22), footer + px(5), right - px(204), px(33), TRUE);
        InvalidateRect(window_, nullptr, FALSE);
        return;
    }
    const int left = px(206);
    const int width = std::max(px(100), static_cast<int>(rect.right) - left - px(18));
    const int composer = std::max(px(202), static_cast<int>(rect.bottom) - px(107));
    const bool pending = selected_ != no_selection && !conversations_[selected_].draft_attachments.empty();
    const int attachment_top = composer - (pending ? px(42) : 0);
    const int attachment_button_width = px(pending ? 50 : 36);
    const int status_offset = attachment_button_width + px(10);
    MoveWindow(title_, px(17), px(18), px(155), px(23), TRUE);
    MoveWindow(new_, px(17), px(49), px(155), px(32), TRUE);
    MoveWindow(list_, px(12), px(92), px(165), std::max(px(34), static_cast<int>(rect.bottom) - px(104)), TRUE);
    MoveWindow(model_label_, left, px(15), px(125), px(21), TRUE);
    MoveWindow(model_, left, px(38), px(133), px(240), TRUE);
    MoveWindow(reasoning_label_, left + px(149), px(15), px(172), px(21), TRUE);
    MoveWindow(reasoning_, left + px(149), px(38), px(172), px(260), TRUE);
    MoveWindow(options_, left + width - px(86), px(38), px(86), px(32), TRUE);
    MoveWindow(transcript_, left, px(85), width, attachment_top - px(98), TRUE);
    MoveWindow(attachments_, left, attachment_top, width - px(82), px(230), TRUE);
    MoveWindow(remove_attachment_, left + width - px(72), attachment_top, px(72), px(31), TRUE);
    MoveWindow(entry_, left, composer, width - px(82), px(60), TRUE);
    MoveWindow(send_, left + width - px(72), composer, px(72), px(60), TRUE);
    MoveWindow(attach_, left, composer + px(66), attachment_button_width, px(31), TRUE);
    MoveWindow(status_, left + status_offset, composer + px(68), width - status_offset, px(37), TRUE);
    InvalidateRect(window_, nullptr, FALSE);
}

HBRUSH Panel::paint_control(HDC dc, HWND control) const {
    const bool sidebar = control == title_ || control == list_;
    const bool input = control == entry_ || control == transcript_ || control == options_entry_;
    SetTextColor(dc, control == status_ ? (failed_ ? red : muted) : text);
    SetBkColor(dc, input ? field : (sidebar ? panel : black));
    return input ? field_brush_ : (sidebar ? panel_brush_ : background_brush_);
}

void Panel::paint_item(const DRAWITEMSTRUCT& item) const {
    const bool button = item.CtlType == ODT_BUTTON;
    const bool selected = (item.itemState & ODS_SELECTED) != 0;
    const bool focused = (item.itemState & ODS_FOCUS) != 0;
    const bool disabled = (item.itemState & ODS_DISABLED) != 0;
    const bool primary = button && (item.CtlID == send_id || item.CtlID == save_options_id
        || (item.CtlID == memory_id && memory_open_) || (item.CtlID == prompt_id && !memory_open_));
    const bool active = !button && selected;
    const auto background = primary || active ? (selected ? RGB(33, 56, 42) : RGB(21, 37, 26)) : field;
    rectangle(item.hDC, item.rcItem, background);
    if (button || focused) {
        rectangle(item.hDC, item.rcItem, focused ? red : edge, true);
    }
    const bool attachment_button = button && item.CtlID == attach_id;
    const auto attached = attachment_button && selected_ != no_selection ? conversations_[selected_].draft_attachments.size() : 0;
    std::wstring label;
    if (attachment_button) {
        label = attachment_glyph;
    } else if (button) {
        label = window_text(item.hwndItem);
    } else if (item.itemID != static_cast<UINT>(-1)) {
        const bool list = item.CtlType == ODT_LISTBOX;
        const auto count = SendMessageW(item.hwndItem, list ? LB_GETTEXTLEN : CB_GETLBTEXTLEN, item.itemID, 0);
        if (count != LB_ERR) {
            label.resize(static_cast<std::size_t>(count) + 1);
            SendMessageW(item.hwndItem, list ? LB_GETTEXT : CB_GETLBTEXT, item.itemID, reinterpret_cast<LPARAM>(label.data()));
            label.resize(count);
        }
    }
    auto bounds = item.rcItem;
    if (!button) {
        bounds.left += px(8);
        bounds.right -= px(8);
    }
    if (attached) {
        bounds.right -= px(16);
    }
    SetBkMode(item.hDC, TRANSPARENT);
    SetTextColor(item.hDC, disabled ? muted : (primary || active ? green : text));
    const auto previous = SelectObject(item.hDC, attachment_button ? attachment_font_ : font_);
    DrawTextW(item.hDC, label.c_str(), static_cast<int>(label.size()), &bounds,
        (button ? DT_CENTER : DT_LEFT) | DT_NOPREFIX | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);
    if (attached) {
        SelectObject(item.hDC, font_);
        const auto count = std::to_wstring(attached);
        RECT count_bounds{bounds.right - px(2), bounds.top, item.rcItem.right - px(4), bounds.bottom};
        DrawTextW(item.hDC, count.c_str(), static_cast<int>(count.size()), &count_bounds,
            DT_CENTER | DT_SINGLELINE | DT_VCENTER);
    }
    SelectObject(item.hDC, previous);
}

LRESULT Panel::handle(UINT message, WPARAM wparam, LPARAM lparam) {
    switch (message) {
        case WM_CREATE: return initialize() ? 0 : -1;
        case WM_SIZE: layout(); return 0;
        case WM_DPICHANGED_AFTERPARENT:
            dpi_ = GetDpiForWindow(window_);
            update_font();
            layout();
            return 0;
        case WM_ERASEBKGND: return 1;
        case WM_PAINT: {
            PAINTSTRUCT paint{};
            const auto dc = BeginPaint(window_, &paint);
            RECT area{};
            GetClientRect(window_, &area);
            rectangle(dc, area, black);
            if (!options_open_) {
                const RECT sidebar{0, 0, px(189), area.bottom};
                rectangle(dc, sidebar, panel);
                const RECT divider{px(189), 0, px(190), area.bottom};
                rectangle(dc, divider, edge);
            }
            EndPaint(window_, &paint);
            return 0;
        }
        case WM_CTLCOLORSTATIC:
        case WM_CTLCOLOREDIT:
        case WM_CTLCOLORLISTBOX:
            return reinterpret_cast<LRESULT>(paint_control(reinterpret_cast<HDC>(wparam), reinterpret_cast<HWND>(lparam)));
        case WM_DRAWITEM:
            paint_item(*reinterpret_cast<const DRAWITEMSTRUCT*>(lparam));
            return TRUE;
        case WM_MEASUREITEM:
            reinterpret_cast<MEASUREITEMSTRUCT*>(lparam)->itemHeight = px(30);
            return TRUE;
        case WM_COMMAND: {
            const auto action = HIWORD(wparam);
            switch (LOWORD(wparam)) {
                case history_id:
                    if (action == LBN_SELCHANGE) {
                        const auto index = SendMessageW(list_, LB_GETCURSEL, 0, 0);
                        if (index != LB_ERR) {
                            show_conversation(static_cast<std::size_t>(index));
                        }
                    }
                    break;
                case new_id: if (action == BN_CLICKED) new_conversation(); break;
                case model_id: if (action == CBN_SELCHANGE) choose_model(); break;
                case effort_id: if (action == CBN_SELCHANGE) choose_reasoning(); break;
                case attach_id: if (action == BN_CLICKED) choose_attachments(); break;
                case remove_attachment_id: if (action == BN_CLICKED) remove_attachment(); break;
                case options_id: if (action == BN_CLICKED) show_options(true); break;
                case memory_id: if (action == BN_CLICKED) select_option(true); break;
                case prompt_id: if (action == BN_CLICKED) select_option(false); break;
                case save_options_id: if (action == BN_CLICKED) save_options(); break;
                case cancel_options_id: if (action == BN_CLICKED) show_options(false); break;
                case send_id:
                    if (action == BN_CLICKED) {
                        if (request_) {
                            request_->stop();
                            SetWindowTextW(send_, L"Stopping");
                            EnableWindow(send_, FALSE);
                        } else {
                            send();
                        }
                    }
                    break;
            }
            return 0;
        }
        case WM_TIMER:
            if (wparam == refresh_timer && request_) {
                update_reply();
            }
            return 0;
        case files_ready:
            accept_attachments();
            return 0;
        case WM_DESTROY: KillTimer(window_, refresh_timer); return 0;
    }
    return DefWindowProcW(window_, message, wparam, lparam);
}

LRESULT CALLBACK Panel::entry_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam, UINT_PTR id, DWORD_PTR data) {
    if (message == WM_GETDLGCODE && wparam == VK_RETURN) {
        return DefSubclassProc(window, message, wparam, lparam) | DLGC_WANTMESSAGE;
    }
    if (message == WM_CHAR && wparam == L'\r' && !(GetKeyState(VK_SHIFT) & 0x8000)) {
        try {
            reinterpret_cast<Panel*>(data)->send();
        } catch (const std::exception&) {
            reinterpret_cast<Panel*>(data)->set_status(L"The message could not be sent.", true);
        }
        return 0;
    }
    if (message == WM_NCDESTROY) {
        RemoveWindowSubclass(window, entry_proc, id);
    }
    return DefSubclassProc(window, message, wparam, lparam);
}

void Panel::refresh_history() {
    SendMessageW(list_, LB_RESETCONTENT, 0, 0);
    for (const auto& chat : conversations_) {
        const auto title = chat.title();
        SendMessageW(list_, LB_ADDSTRING, 0, reinterpret_cast<LPARAM>(title.c_str()));
    }
    if (selected_ != no_selection) {
        SendMessageW(list_, LB_SETCURSEL, selected_, 0);
    }
}

void Panel::new_conversation() {
    if (request_ || importing_ || options_open_) {
        return;
    }
    const auto blank = std::find_if(conversations_.begin(), conversations_.end(),
        [](const Conversation& chat) { return chat.messages.empty(); });
    if (blank != conversations_.end()) {
        show_conversation(static_cast<std::size_t>(blank - conversations_.begin()));
    } else {
        auto next = archive_.create();
        conversations_[selected_].draft = window_text(entry_);
        next.model = conversations_[selected_].model;
        next.reasoning = conversations_[selected_].reasoning;
        conversations_.insert(conversations_.begin(), std::move(next));
        selected_ = no_selection;
        refresh_history();
        show_conversation(0);
    }
    SetFocus(entry_);
}

void Panel::show_conversation(std::size_t index) {
    if (selected_ == index || index >= conversations_.size()) {
        return;
    }
    if (selected_ != no_selection) {
        conversations_[selected_].draft = window_text(entry_);
    }
    selected_ = index;
    const auto& conversation = conversations_[selected_];
    SendMessageW(list_, LB_SETCURSEL, selected_, 0);
    SendMessageW(model_, CB_SETCURSEL, conversation.model, 0);
    fill_reasoning();
    SetWindowTextW(entry_, conversation.draft.c_str());
    refresh_attachments();
    render_history();
    update_controls();
    if (request_) {
        set_status(index != active_ ? L"Reply running in another conversation."
            : pending_prompt_ ? L"Loading the local model\u2026" : L"Waiting for the reply\u2026");
    } else if (importing_) {
        set_status(index == attachment_target_ ? L"Preparing attachments\u2026" : L"Preparing attachments in another conversation.");
    } else {
        set_status(L"Enter to send   |   Shift+Enter for a new line");
    }
}

void Panel::fill_reasoning() {
    const auto& conversation = conversations_[selected_];
    const auto& model = models[conversation.model];
    SendMessageW(reasoning_, CB_RESETCONTENT, 0, 0);
    constexpr std::array efforts{Reasoning::preset, Reasoning::off, Reasoning::on, Reasoning::low,
        Reasoning::medium, Reasoning::high, Reasoning::extra_high};
    for (const auto effort : efforts) {
        if (!supports_reasoning(model, effort)) {
            continue;
        }
        auto label = std::wstring(reasoning_label(effort));
        if (effort == Reasoning::preset) {
            label += L" (" + std::wstring(reasoning_label(model.default_reasoning)) + L")";
        }
        const auto index = SendMessageW(reasoning_, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(label.c_str()));
        if (index >= 0) {
            SendMessageW(reasoning_, CB_SETITEMDATA, index, static_cast<LPARAM>(effort));
            if (effort == conversation.reasoning) {
                SendMessageW(reasoning_, CB_SETCURSEL, index, 0);
            }
        }
    }
}

void Panel::choose_model() {
    const auto index = SendMessageW(model_, CB_GETCURSEL, 0, 0);
    if (index >= 0 && static_cast<std::size_t>(index) < models.size()) {
        auto& conversation = conversations_[selected_];
        conversation.model = static_cast<std::size_t>(index);
        if (!supports_reasoning(models[conversation.model], conversation.reasoning)) {
            conversation.reasoning = Reasoning::preset;
        }
        fill_reasoning();
        persist(conversation);
        if (has_pending_image() && !supports_images(models[conversation.model])) {
            set_status(L"Remove the pending image or select sai-smart or sai-max.", true);
        }
    }
}

void Panel::choose_reasoning() {
    const auto index = SendMessageW(reasoning_, CB_GETCURSEL, 0, 0);
    if (index >= 0) {
        const auto data = SendMessageW(reasoning_, CB_GETITEMDATA, index, 0);
        if (data >= 0) {
            auto& conversation = conversations_[selected_];
            conversation.reasoning = static_cast<Reasoning>(data);
            persist(conversation);
        }
    }
}

void Panel::persist(const Conversation& conversation) {
    if (!conversation.messages.empty()) {
        history_saved_ = archive_.save(conversation);
        if (!history_saved_) {
            set_status(L"Conversation history could not be saved to disk.", true);
        }
    }
}

void Panel::set_status(std::wstring_view value, bool failed) {
    failed_ = failed;
    SetWindowTextW(status_, std::wstring(value).c_str());
    InvalidateRect(status_, nullptr, TRUE);
}

void Panel::update_controls() {
    const bool ready = !request_ && !importing_;
    EnableWindow(new_, ready);
    EnableWindow(model_, ready);
    EnableWindow(reasoning_, ready);
    EnableWindow(attach_, ready);
    EnableWindow(remove_attachment_, ready);
    EnableWindow(options_, ready);
    EnableWindow(send_, !importing_);
    SendMessageW(entry_, EM_SETREADONLY, pending_prompt_.has_value() && selected_ == active_, 0);
    SetWindowTextW(send_, request_ ? L"Stop" : L"Send");
}

void Panel::choose_attachments() {
    if (request_ || importing_ || options_open_ || selected_ == no_selection) {
        return;
    }
    const auto& conversation = conversations_[selected_];
    const auto remaining = draft_attachment_limit - conversation.draft_attachments.size();
    if (!remaining) {
        set_status(L"Up to six attachments can be added to a message.", true);
        return;
    }
    auto paths = pick_files(window_);
    if (paths.empty()) {
        if (CommDlgExtendedError()) {
            set_status(L"Could not open the file picker.", true);
        }
        return;
    }
    skipped_files_ = paths.size() > remaining;
    paths.resize(std::min(paths.size(), remaining));
    attachment_target_ = selected_;
    importing_ = true;
    update_controls();
    set_status(L"Preparing attachments\u2026");
    try {
        importer_ = std::jthread([this, paths = std::move(paths), model = models[conversation.model]](std::stop_token stop) {
            std::vector<AttachmentImport> results;
            try {
                for (const auto& path : paths) {
                    if (stop.stop_requested()) {
                        return;
                    }
                    results.push_back(import_attachment(path, model, stop));
                }
            } catch (const std::exception&) {
                AttachmentImport failure;
                failure.error = L"Could not prepare an attachment.";
                results.push_back(std::move(failure));
            }
            if (!stop.stop_requested()) {
                {
                    std::lock_guard lock(import_mutex_);
                    imported_ = std::move(results);
                }
                PostMessageW(window_, files_ready, 0, 0);
            }
        });
    } catch (const std::exception&) {
        importing_ = false;
        attachment_target_ = no_selection;
        update_controls();
        set_status(L"Could not prepare the attachments.", true);
    }
}

void Panel::accept_attachments() {
    if (!importing_) {
        return;
    }
    std::vector<AttachmentImport> results;
    {
        std::lock_guard lock(import_mutex_);
        results.swap(imported_);
    }
    constexpr std::size_t draft_budget = 12 * 1024 * 1024;
    const auto size = [](const Attachment& item) { return item.image_url.size() + item.text.size() * 3; };
    auto& attachments = conversations_[attachment_target_].draft_attachments;
    std::size_t used = 0;
    for (const auto& item : attachments) {
        used += size(item);
    }
    std::wstring error;
    std::size_t accepted = 0;
    for (auto& result : results) {
        if (result.error.empty() && size(result.attachment) > draft_budget - used) {
            result.error = L"Attachments are too large for one message.";
        }
        if (!result.error.empty()) {
            if (error.empty()) {
                error = std::move(result.error);
            }
        } else {
            used += size(result.attachment);
            attachments.push_back(std::move(result.attachment));
            ++accepted;
        }
    }
    if (skipped_files_ && error.empty()) {
        error = L"Up to six files can be attached per message.";
    }
    const bool current = selected_ == attachment_target_;
    importing_ = false;
    attachment_target_ = no_selection;
    refresh_attachments();
    update_controls();
    if (!error.empty()) {
        set_status(error, true);
    } else if (current) {
        set_status(accepted == 1 ? L"Attachment ready." : L"Attachments ready.");
        SetFocus(entry_);
    } else {
        set_status(L"Attachments ready in another conversation.");
    }
}

void Panel::refresh_attachments() {
    const auto& pending = conversations_[selected_].draft_attachments;
    SendMessageW(attachments_, CB_RESETCONTENT, 0, 0);
    for (const auto& item : pending) {
        SendMessageW(attachments_, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(item.name.c_str()));
    }
    if (!pending.empty()) {
        SendMessageW(attachments_, CB_SETCURSEL, pending.size() - 1, 0);
    }
    SetWindowTextW(attach_, pending.empty() ? L"Attach files" : (L"Attach files (" + std::to_wstring(pending.size()) + L" attached)").c_str());
    const int show = !options_open_ && !pending.empty() ? SW_SHOW : SW_HIDE;
    ShowWindow(attachments_, show);
    ShowWindow(remove_attachment_, show);
    layout();
}

void Panel::remove_attachment() {
    if (request_ || importing_) {
        return;
    }
    const auto selected = SendMessageW(attachments_, CB_GETCURSEL, 0, 0);
    auto& pending = conversations_[selected_].draft_attachments;
    if (selected >= 0 && static_cast<std::size_t>(selected) < pending.size()) {
        pending.erase(pending.begin() + selected);
        refresh_attachments();
        set_status(L"Attachment removed.");
        if (pending.empty()) {
            SetFocus(attach_);
        }
    }
}

bool Panel::has_pending_image() const {
    const auto& attachments = conversations_[selected_].draft_attachments;
    return std::any_of(attachments.begin(), attachments.end(), [](const Attachment& item) { return item.is_image(); });
}

void Panel::show_options(bool open) {
    if (open && (request_ || importing_)) {
        return;
    }
    const bool changed = options_open_ != open;
    options_open_ = open;
    for (const auto item : {title_, new_, list_, model_label_, model_, reasoning_label_, reasoning_,
            transcript_, entry_, send_, attach_, options_}) {
        ShowWindow(item, open ? SW_HIDE : SW_SHOW);
    }
    for (const auto item : {options_title_, memory_tab_, prompt_tab_, options_hint_, options_entry_, save_options_, cancel_options_}) {
        ShowWindow(item, open ? SW_SHOW : SW_HIDE);
    }
    refresh_attachments();
    if (open) {
        working_settings_ = settings_;
        memory_open_ = true;
        SetWindowTextW(options_entry_, working_settings_.memory.c_str());
        select_option(true);
        SetFocus(options_entry_);
    } else if (changed) {
        set_status(L"Enter to send   |   Shift+Enter for a new line");
        SetFocus(options_);
    }
}

void Panel::capture_option() {
    auto& editing = memory_open_ ? working_settings_.memory : working_settings_.system_prompt;
    editing = window_text(options_entry_);
}

void Panel::select_option(bool memory) {
    if (!options_open_) {
        return;
    }
    capture_option();
    memory_open_ = memory;
    const auto& selected = memory ? working_settings_.memory : working_settings_.system_prompt;
    SetWindowTextW(options_entry_, selected.c_str());
    SetWindowTextW(options_hint_, memory
        ? L"Add facts and preferences to include in every chat. They are saved on this PC and take effect on your next message."
        : L"Set the instructions sent to the model before the conversation. Leave this empty to use the model's default.");
    set_status(L"");
    InvalidateRect(memory_tab_, nullptr, FALSE);
    InvalidateRect(prompt_tab_, nullptr, FALSE);
}

void Panel::save_options() {
    if (!options_open_) {
        return;
    }
    capture_option();
    if (!archive_.save_settings(working_settings_)) {
        set_status(L"Chat options could not be saved to disk.", true);
        return;
    }
    settings_ = std::move(working_settings_);
    show_options(false);
    set_status(L"Chat options saved.");
}

void Panel::send() {
    if (request_ || importing_ || options_open_ || selected_ == no_selection) {
        return;
    }
    const auto& conversation = conversations_[selected_];
    auto prompt = window_text(entry_);
    const auto first = prompt.find_first_not_of(L" \t\r\n");
    if (first == std::wstring::npos && conversation.draft_attachments.empty()) {
        SetFocus(entry_);
        return;
    }
    if (has_pending_image() && !supports_images(models[conversation.model])) {
        set_status(L"Remove the pending image or select sai-smart or sai-max.", true);
        return;
    }
    prompt = first == std::wstring::npos ? std::wstring{} : prompt.substr(first, prompt.find_last_not_of(L" \t\r\n") - first + 1);
    auto outgoing = conversation;
    outgoing.messages.push_back({true, prompt, std::move(outgoing.draft_attachments)});
    outgoing.draft.clear();
    if (!SetTimer(window_, refresh_timer, 50, nullptr)) {
        set_status(L"Could not start the reply view.", true);
        return;
    }
    try {
        request_ = std::make_unique<Request>(std::move(outgoing), settings_);
    } catch (const std::exception&) {
        KillTimer(window_, refresh_timer);
        throw;
    }
    pending_prompt_ = std::move(prompt);
    active_ = selected_;
    update_controls();
    set_status(L"Loading the local model\u2026");
    SetFocus(entry_);
}

void Panel::commit_pending_message() {
    auto& conversation = conversations_[active_];
    conversation.messages.push_back({true, std::move(*pending_prompt_), std::exchange(conversation.draft_attachments, {})});
    pending_prompt_.reset();
    conversation.draft.clear();
    update_controls();
    if (conversation.messages.size() == 1) {
        refresh_history();
    }
    if (selected_ == active_) {
        SetWindowTextW(entry_, L"");
        refresh_attachments();
        append_message(conversation.messages.back());
        SendMessageW(transcript_, EM_SCROLLCARET, 0, 0);
    }
    persist(conversation);
}

void Panel::update_reply() {
    auto update = request_->take();
    const bool visible_conversation = selected_ == active_;
    if (update.backend == BackendStatus::confirm_start && !update.finished && IsWindowEnabled(send_)) {
        const auto model = models[conversations_[active_].model].id;
        const auto question = L"Start the SAI backend for " + std::wstring(model)
            + L"? Your message will be sent as soon as the model is ready.";
        if (MessageBoxW(GetAncestor(window_, GA_ROOT), question.c_str(), L"Start SAI backend",
                MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2) == IDYES) {
            request_->start_backend();
        } else {
            request_->stop();
        }
    } else if (update.backend == BackendStatus::loading && visible_conversation) {
        set_status(L"Starting the SAI backend and loading the model\u2026");
    } else if (update.backend == BackendStatus::ready && pending_prompt_) {
        commit_pending_message();
        if (visible_conversation) {
            set_status(L"Backend ready. Waiting for the reply\u2026");
        }
    }
    if (!update.text.empty()) {
        if (visible_conversation) {
            SCROLLINFO scroll{};
            scroll.cbSize = sizeof(scroll);
            scroll.fMask = SIF_RANGE | SIF_PAGE | SIF_POS;
            GetScrollInfo(transcript_, SB_VERT, &scroll);
            const bool follow = scroll.nPos + static_cast<int>(scroll.nPage) >= scroll.nMax - 3;
            POINT offset{};
            SendMessageW(transcript_, EM_GETSCROLLPOS, 0, reinterpret_cast<LPARAM>(&offset));
            CHARRANGE selection{};
            SendMessageW(transcript_, EM_EXGETSEL, 0, reinterpret_cast<LPARAM>(&selection));
            if (partial_.empty()) {
                append(L"SAI\r\n", green, true);
            }
            append(update.text, text);
            if (follow && selection.cpMin == selection.cpMax) {
                SendMessageW(transcript_, EM_SCROLLCARET, 0, 0);
            } else {
                SendMessageW(transcript_, EM_EXSETSEL, 0, reinterpret_cast<LPARAM>(&selection));
                SendMessageW(transcript_, EM_SETSCROLLPOS, 0, reinterpret_cast<LPARAM>(&offset));
            }
            set_status(L"Receiving reply\u2026");
        }
        partial_ += update.text;
    } else if (update.thinking && visible_conversation) {
        set_status(L"The model is thinking\u2026");
    }
    if (!update.finished) {
        return;
    }
    auto& conversation = conversations_[active_];
    if (!partial_.empty()) {
        conversation.messages.push_back({false, std::exchange(partial_, {})});
        if (visible_conversation) {
            append(L"\r\n\r\n", text);
        }
        persist(conversation);
    }
    const bool draft_kept = pending_prompt_.has_value();
    pending_prompt_.reset();
    active_ = no_selection;
    KillTimer(window_, refresh_timer);
    request_.reset();
    update_controls();
    if (!update.error.empty()) {
        set_status(update.error, true);
    } else if (update.stopped && draft_kept) {
        set_status(L"Canceled. Your message is still in the draft.");
    } else if (!history_saved_) {
        set_status(L"Conversation history could not be saved to disk.", true);
    } else if (update.stopped) {
        set_status(L"Reply stopped.");
    } else {
        set_status(L"Enter to send   |   Shift+Enter for a new line");
    }
}

void Panel::append(std::wstring_view value, COLORREF color, bool bold) {
    GETTEXTLENGTHEX query{GTL_NUMCHARS | GTL_CLOSE, 1200};
    const LONG length = static_cast<LONG>(SendMessageW(transcript_, EM_GETTEXTLENGTHEX, reinterpret_cast<WPARAM>(&query), 0));
    const CHARRANGE end{length, length};
    SendMessageW(transcript_, EM_SETREADONLY, FALSE, 0);
    SendMessageW(transcript_, EM_EXSETSEL, 0, reinterpret_cast<LPARAM>(&end));
    CHARFORMAT2W format{};
    format.cbSize = sizeof(format);
    format.dwMask = CFM_COLOR | CFM_BOLD;
    format.dwEffects = bold ? CFE_BOLD : 0;
    format.crTextColor = color;
    SendMessageW(transcript_, EM_SETCHARFORMAT, SCF_SELECTION, reinterpret_cast<LPARAM>(&format));
    SendMessageW(transcript_, EM_REPLACESEL, FALSE, reinterpret_cast<LPARAM>(std::wstring(value).c_str()));
    SendMessageW(transcript_, EM_SETREADONLY, TRUE, 0);
}

void Panel::append_message(const Message& message) {
    append(message.from_user ? L"You\r\n" : L"SAI\r\n", message.from_user ? muted : green, true);
    for (const auto& item : message.attachments) {
        append((item.is_image() ? L"Image: " : L"PDF: ") + item.name + L"\r\n", muted);
    }
    append(message.text + L"\r\n\r\n", text);
}

void Panel::render_history() {
    SendMessageW(transcript_, WM_SETREDRAW, FALSE, 0);
    SetWindowTextW(transcript_, L"");
    for (const auto& message : conversations_[selected_].messages) {
        append_message(message);
    }
    if (selected_ == active_ && !partial_.empty()) {
        append(L"SAI\r\n", green, true);
        append(partial_, text);
    }
    SendMessageW(transcript_, WM_SETREDRAW, TRUE, 0);
    SendMessageW(transcript_, EM_SCROLLCARET, 0, 0);
    InvalidateRect(transcript_, nullptr, TRUE);
}

} // namespace

HWND create_panel(HINSTANCE instance, HWND parent) {
    WNDCLASSEXW type{};
    type.cbSize = sizeof(type);
    type.hInstance = instance;
    type.lpfnWndProc = Panel::dispatch;
    type.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    type.lpszClassName = class_name;
    if (!RegisterClassExW(&type) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
        return nullptr;
    }
    return CreateWindowExW(WS_EX_CONTROLPARENT, class_name, L"Chat", WS_CHILD | WS_CLIPCHILDREN,
        0, 0, 0, 0, parent, nullptr, instance, nullptr);
}

} // namespace sai::chat
