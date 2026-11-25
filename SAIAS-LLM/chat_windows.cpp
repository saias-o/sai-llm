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
#include <cwctype>
#include <exception>
#include <mutex>
#include <optional>
#include <string>
#include <utility>

namespace saias::chat {
namespace {

constexpr auto class_name = L"SaiasLlmChatPanel";
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
constexpr int tools_id = 212;
constexpr UINT tool_menu_base = 300;
constexpr UINT tool_menu_all = 350;
constexpr UINT tool_menu_none = 351;
constexpr UINT files_ready = WM_APP + 2;
constexpr auto no_selection = static_cast<std::size_t>(-1);
constexpr auto attachment_glyph = L"";
constexpr auto ready_hint = L"Enter to send   |   Shift+Enter for a new line";

constexpr COLORREF black = RGB(8, 8, 8);
constexpr COLORREF panel = RGB(13, 13, 13);
constexpr COLORREF field = RGB(18, 18, 18);
constexpr COLORREF edge = RGB(52, 52, 52);
constexpr COLORREF text = RGB(243, 243, 243);
constexpr COLORREF muted = RGB(175, 175, 175);
constexpr COLORREF dim = RGB(128, 128, 128);
constexpr COLORREF green = RGB(119, 213, 151);
constexpr COLORREF amber = RGB(229, 192, 123);
constexpr COLORREF red = RGB(255, 121, 114);
constexpr COLORREF link_color = RGB(130, 177, 255);
constexpr COLORREF code_back = RGB(30, 30, 30);
constexpr COLORREF code_text = RGB(222, 222, 222);

// Rich edit sizes are in twips (1/20 point) and scale with the screen on their own.
constexpr LONG body_twips = 210;
constexpr LONG small_twips = 180;

// How a run of transcript text looks.
struct Style {
    COLORREF color = text;
    bool bold = false;
    bool italic = false;
    bool underline = false;
    bool mono = false;
    LONG twips = body_twips;
    bool shaded = false;  // code background
};

constexpr Style body_style{};
constexpr Style user_header{muted, true};
constexpr Style model_header{green, true};
constexpr Style thinking_label{dim, true, false, false, false, small_twips};
constexpr Style thinking_style{dim, false, true, false, false, small_twips};
constexpr Style tool_header{amber, true};
constexpr Style tool_detail{muted, false, false, false, true, small_twips};
constexpr Style tool_failed{red, false, false, false, false, small_twips};
constexpr Style note_style{dim, false, false, false, false, small_twips};
constexpr Style code_style{code_text, false, false, false, true, body_twips, true};

std::wstring window_text(HWND window) {
    std::wstring result(static_cast<std::size_t>(GetWindowTextLengthW(window)) + 1, L'\0');
    const int size = GetWindowTextW(window, result.data(), static_cast<int>(result.size()));
    result.resize(size);
    return result;
}

std::wstring thousands(std::size_t value) {
    auto digits = std::to_wstring(value);
    for (auto position = static_cast<std::ptrdiff_t>(digits.size()) - 3; position > 0; position -= 3) {
        digits.insert(static_cast<std::size_t>(position), 1, L',');
    }
    return digits;
}

// One line, at most limit characters: for tool arguments and result previews.
std::wstring one_line(std::wstring_view source, std::size_t limit) {
    std::wstring result;
    bool space = false;
    for (const auto character : source) {
        if (character == L'\r' || character == L'\n' || character == L'\t' || character == L' ') {
            space = !result.empty();
            continue;
        }
        if (space) {
            result += L' ';
            space = false;
        }
        result += character;
        if (result.size() >= limit) {
            result += L"…";
            break;
        }
    }
    return result;
}

std::wstring_view tool_label(std::wstring_view name) {
    for (const auto& tool : web_tools) {
        if (tool.name == name) {
            return tool.label;
        }
    }
    return name;
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
    enum class LiveMode { none, reasoning, text, tool };

    LRESULT handle(UINT message, WPARAM wparam, LPARAM lparam);
    static LRESULT CALLBACK entry_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam, UINT_PTR id, DWORD_PTR data);
    bool initialize();
    HWND control(LPCWSTR kind, LPCWSTR caption, DWORD style, int id = 0);
    void layout();
    void update_font();
    void paint_item(const DRAWITEMSTRUCT& item) const;
    HBRUSH paint_control(HDC dc, HWND control) const;
    void paint_gauge(HDC dc) const;
    int px(int dips) const { return MulDiv(dips, dpi_, 96); }

    void new_conversation();
    void show_conversation(std::size_t index);
    void refresh_history();
    void fill_reasoning();
    void choose_model();
    void choose_reasoning();
    void choose_tools();
    void refresh_tools_label();
    void persist(const Conversation& conversation);
    void set_status(std::wstring_view value, bool failed = false);
    void update_controls();
    void refresh_gauge();

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

    // Transcript
    LONG text_length() const;
    void append(std::wstring_view value, const Style& style);
    void paragraph(LONG indent = 0, LONG offset = 0);
    void remove_from(LONG position);
    void append_inline(std::wstring_view line, const Style& base);
    void append_markdown(std::wstring_view source);
    void append_reasoning(std::wstring_view reasoning, bool live);
    void append_tool_call(const ToolCall& call);
    void append_tool_result(const ToolCall& call);
    void append_message(const Message& message);
    void begin_live();
    void show_live_event(const LiveEvent& event);

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
    HWND tools_ = nullptr;
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
    HFONT small_font_ = nullptr;
    HFONT attachment_font_ = nullptr;
    HBRUSH background_brush_ = nullptr;
    HBRUSH panel_brush_ = nullptr;
    HBRUSH field_brush_ = nullptr;
    UINT dpi_ = 96;
    RECT gauge_{};
    bool gauge_visible_ = false;

    Archive archive_;
    std::vector<Conversation> conversations_;
    std::size_t selected_ = no_selection;
    std::size_t active_ = no_selection;
    std::unique_ptr<Request> request_;
    std::optional<std::wstring> pending_prompt_;
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

    // The reply being written: what the transcript shows of it, where it starts there, and the
    // token count so far (the last server count plus an estimate for the text since).
    Message live_{false, L""};
    bool live_started_ = false;
    LONG live_start_ = -1;
    LiveMode live_mode_ = LiveMode::none;
    std::size_t live_tokens_ = 0;
    std::size_t live_characters_ = 0;
    double speed_ = 0;
    std::size_t speed_conversation_ = no_selection;
};

Panel::~Panel() {
    if (importer_.joinable()) {
        importer_.request_stop();
        importer_.join();
    }
    request_.reset();
    DeleteObject(font_);
    DeleteObject(heading_);
    DeleteObject(small_font_);
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
    tools_ = control(L"BUTTON", L"Tools", button_style, tools_id);
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
        || !tools_ || !options_ || !options_title_ || !memory_tab_ || !prompt_tab_ || !options_hint_ || !options_entry_
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
        // Profile names only: the model behind a profile changes with catalog updates.
        SendMessageW(model_, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(model.id.data()));
    }
    settings_ = archive_.load_settings();
    refresh_tools_label();
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
                status_, attach_, attachments_, remove_attachment_, tools_, options_, memory_tab_, prompt_tab_, options_hint_,
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
    if (const auto compact = create(12, FW_NORMAL)) {
        DeleteObject(std::exchange(small_font_, compact));
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
        gauge_visible_ = false;
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
    const int options_left = left + width - px(86);
    const int tools_left = options_left - px(104);
    MoveWindow(title_, px(17), px(18), px(155), px(23), TRUE);
    MoveWindow(new_, px(17), px(49), px(155), px(32), TRUE);
    MoveWindow(list_, px(12), px(92), px(165), std::max(px(34), static_cast<int>(rect.bottom) - px(104)), TRUE);
    MoveWindow(model_label_, left, px(15), px(125), px(21), TRUE);
    MoveWindow(model_, left, px(38), px(133), px(240), TRUE);
    MoveWindow(reasoning_label_, left + px(149), px(15), px(172), px(21), TRUE);
    MoveWindow(reasoning_, left + px(149), px(38), px(172), px(260), TRUE);
    MoveWindow(tools_, tools_left, px(38), px(94), px(32), TRUE);
    MoveWindow(options_, options_left, px(38), px(86), px(32), TRUE);
    MoveWindow(transcript_, left, px(85), width, attachment_top - px(98), TRUE);
    MoveWindow(attachments_, left, attachment_top, width - px(82), px(230), TRUE);
    MoveWindow(remove_attachment_, left + width - px(72), attachment_top, px(72), px(31), TRUE);
    MoveWindow(entry_, left, composer, width - px(82), px(60), TRUE);
    MoveWindow(send_, left + width - px(72), composer, px(72), px(60), TRUE);
    MoveWindow(attach_, left, composer + px(66), attachment_button_width, px(31), TRUE);
    // The context gauge sits at the right end of the status line, under the Send button.
    gauge_visible_ = width >= px(420);
    const int gauge_width = gauge_visible_ ? std::clamp(width * 45 / 100, px(230), px(380)) : 0;
    gauge_ = RECT{left + width - gauge_width, composer + px(66), left + width, composer + px(97)};
    MoveWindow(status_, left + status_offset, composer + px(68),
        std::max(px(40), width - status_offset - gauge_width - (gauge_visible_ ? px(12) : 0)), px(37), TRUE);
    // Room around the transcript text, like a page margin (reset by the control on every resize).
    const RECT inset{px(14), px(10), std::max(px(20), width - px(14)), std::max(px(20), attachment_top - px(98) - px(10))};
    SendMessageW(transcript_, EM_SETRECT, 0, reinterpret_cast<LPARAM>(&inset));
    InvalidateRect(window_, nullptr, FALSE);
}

HBRUSH Panel::paint_control(HDC dc, HWND control) const {
    const bool sidebar = control == title_ || control == list_;
    const bool input = control == entry_ || control == transcript_ || control == options_entry_;
    SetTextColor(dc, control == status_ ? (failed_ ? red : muted) : text);
    SetBkColor(dc, input ? field : (sidebar ? panel : black));
    return input ? field_brush_ : (sidebar ? panel_brush_ : background_brush_);
}

// A box with the tokens in use, the share of the context window and the last speed; a thin bar
// along its bottom fills up, turning amber then red as the window fills.
void Panel::paint_gauge(HDC dc) const {
    if (!gauge_visible_ || selected_ == no_selection) {
        return;
    }
    const auto& conversation = conversations_[selected_];
    const bool live = request_ && selected_ == active_;
    const auto used = live ? live_tokens_ + live_characters_ / 4
        : (conversation.context_tokens ? conversation.context_tokens : estimate_tokens(conversation));
    const auto total = context_size(models[conversation.model]);
    const double share = total ? std::min(1.0, static_cast<double>(used) / static_cast<double>(total)) : 0.0;

    SetBkMode(dc, TRANSPARENT);
    const auto previous = SelectObject(dc, small_font_ ? small_font_ : font_);
    const RECT box = gauge_;
    rectangle(dc, box, field);
    rectangle(dc, box, edge, true);
    const COLORREF fill = share >= 0.9 ? red : (share >= 0.75 ? amber : green);
    const LONG bar_width = static_cast<LONG>((box.right - box.left - 2) * share);
    if (total && bar_width > 0) {
        const RECT bar{box.left + 1, box.bottom - px(4), box.left + 1 + std::max<LONG>(bar_width, px(2)), box.bottom - 1};
        rectangle(dc, bar, fill);
    }

    std::wstring amount = std::wstring(L"Context  ") + (conversation.context_tokens || live ? L"" : L"≈ ") + thousands(used);
    amount += total ? L" / " + thousands(total) + L" tokens" : std::wstring(L" tokens");
    if (total) {
        const auto percent = share * 100.0;
        wchar_t buffer[32]{};
        swprintf_s(buffer, percent < 10 ? L"  ·  %.1f%%" : L"  ·  %.0f%%", percent);
        amount += buffer;
    }
    RECT words{box.left + px(10), box.top, box.right - px(10), box.bottom - px(3)};
    SetTextColor(dc, text);
    DrawTextW(dc, amount.c_str(), static_cast<int>(amount.size()), &words, DT_LEFT | DT_SINGLELINE | DT_NOPREFIX | DT_VCENTER | DT_END_ELLIPSIS);
    if (speed_ > 0 && speed_conversation_ == selected_) {
        wchar_t buffer[32]{};
        swprintf_s(buffer, L"%.1f tokens/s", speed_);
        SetTextColor(dc, muted);
        RECT measure{};
        DrawTextW(dc, amount.c_str(), static_cast<int>(amount.size()), &measure, DT_CALCRECT | DT_SINGLELINE | DT_NOPREFIX);
        if (measure.right - measure.left + px(120) < words.right - words.left) {
            DrawTextW(dc, buffer, -1, &words, DT_RIGHT | DT_SINGLELINE | DT_NOPREFIX | DT_VCENTER);
        }
    }
    SelectObject(dc, previous);
}

void Panel::refresh_gauge() {
    if (gauge_visible_) {
        InvalidateRect(window_, &gauge_, FALSE);
    }
}

void Panel::paint_item(const DRAWITEMSTRUCT& item) const {
    const bool button = item.CtlType == ODT_BUTTON;
    const bool selected = (item.itemState & ODS_SELECTED) != 0;
    const bool focused = (item.itemState & ODS_FOCUS) != 0;
    const bool disabled = (item.itemState & ODS_DISABLED) != 0;
    const bool primary = button && (item.CtlID == send_id || item.CtlID == save_options_id
        || (item.CtlID == memory_id && memory_open_) || (item.CtlID == prompt_id && !memory_open_)
        || (item.CtlID == tools_id && !settings_.tools.empty()));
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
                paint_gauge(dc);
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
                case tools_id: if (action == BN_CLICKED) choose_tools(); break;
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
        // Indexes shifted by one.
        if (speed_conversation_ != no_selection) {
            ++speed_conversation_;
        }
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
    refresh_gauge();
    if (request_) {
        set_status(index != active_ ? L"Reply running in another conversation."
            : pending_prompt_ ? L"Loading the local model…" : L"Waiting for the reply…");
    } else if (importing_) {
        set_status(index == attachment_target_ ? L"Preparing attachments…" : L"Preparing attachments in another conversation.");
    } else {
        set_status(ready_hint);
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
        refresh_gauge();
        if (has_pending_image() && !supports_images(models[conversation.model])) {
            set_status(L"Remove the pending image or select saias-smart or saias-pro.", true);
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

void Panel::refresh_tools_label() {
    const auto enabled = std::count_if(web_tools.begin(), web_tools.end(),
        [&](const Tool& tool) { return settings_.tool_enabled(tool.name); });
    const auto label = enabled ? L"Tools (" + std::to_wstring(enabled) + L")" : std::wstring(L"Tools off");
    SetWindowTextW(tools_, label.c_str());
    InvalidateRect(tools_, nullptr, FALSE);
}

// A menu of the web tools with a check mark on the enabled ones. The choice applies to every
// conversation and is saved with the chat options.
void Panel::choose_tools() {
    if (request_ || options_open_) {
        return;
    }
    const auto menu = CreatePopupMenu();
    if (!menu) {
        return;
    }
    for (std::size_t i = 0; i < web_tools.size(); ++i) {
        const auto checked = settings_.tool_enabled(web_tools[i].name) ? MF_CHECKED : MF_UNCHECKED;
        AppendMenuW(menu, MF_STRING | checked, tool_menu_base + static_cast<UINT>(i), std::wstring(web_tools[i].label).c_str());
    }
    AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(menu, MF_STRING, tool_menu_all, L"Turn all on");
    AppendMenuW(menu, MF_STRING, tool_menu_none, L"Turn all off");
    RECT button{};
    GetWindowRect(tools_, &button);
    const auto choice = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTALIGN | TPM_TOPALIGN | TPM_NONOTIFY,
        button.right, button.bottom + px(2), 0, window_, nullptr);
    DestroyMenu(menu);
    if (!choice) {
        return;
    }
    auto changed = settings_;
    const auto command = static_cast<UINT>(choice);
    if (command == tool_menu_all || command == tool_menu_none) {
        changed.tools.clear();
        if (command == tool_menu_all) {
            for (const auto& tool : web_tools) {
                changed.tools.emplace_back(tool.name);
            }
        }
    } else if (command >= tool_menu_base && command < tool_menu_base + web_tools.size()) {
        const auto name = std::wstring(web_tools[command - tool_menu_base].name);
        const auto found = std::find(changed.tools.begin(), changed.tools.end(), name);
        if (found != changed.tools.end()) {
            changed.tools.erase(found);
        } else {
            changed.tools.push_back(name);
        }
    }
    if (!archive_.save_settings(changed)) {
        set_status(L"The tool choice could not be saved to disk.", true);
        return;
    }
    settings_ = std::move(changed);
    refresh_tools_label();
    set_status(settings_.tools.empty() ? L"Tools are off: the model answers from what it knows."
        : L"The model can now use the checked tools when it needs them.");
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
    EnableWindow(tools_, ready);
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
    set_status(L"Preparing attachments…");
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
            transcript_, entry_, send_, attach_, tools_, options_}) {
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
        set_status(ready_hint);
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
        set_status(L"Remove the pending image or select saias-smart or saias-pro.", true);
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
    // Until the server counts them, the new message's tokens are estimated.
    const auto base = conversation.context_tokens ? conversation.context_tokens : estimate_tokens(conversation);
    std::size_t added = prompt.size();
    for (const auto& item : conversation.draft_attachments) {
        added += item.text.size();
    }
    try {
        request_ = std::make_unique<Request>(std::move(outgoing), settings_);
    } catch (const std::exception&) {
        KillTimer(window_, refresh_timer);
        throw;
    }
    pending_prompt_ = std::move(prompt);
    active_ = selected_;
    live_ = Message{false, L""};
    live_started_ = false;
    live_start_ = -1;
    live_mode_ = LiveMode::none;
    live_tokens_ = base + added / 4;
    live_characters_ = 0;
    update_controls();
    refresh_gauge();
    set_status(L"Loading the local model…");
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

// The reply's header, shown as soon as the model is ready.
void Panel::begin_live() {
    live_started_ = true;
    if (selected_ != active_) {
        return;
    }
    live_start_ = text_length();
    paragraph();
    append(std::wstring(models[conversations_[active_].model].id) + L"\r\n", model_header);
}

// Live view of one event: plain text while it streams. The finished reply is drawn again with
// its formatting.
void Panel::show_live_event(const LiveEvent& event) {
    using Kind = LiveEvent::Kind;
    switch (event.kind) {
        case Kind::reasoning: live_.reasoning += event.text; break;
        case Kind::text: live_.text += event.text; break;
        case Kind::tool_start:
            live_.rounds.push_back(ToolRound{std::exchange(live_.text, {}),
                {ToolCall{L"", event.text, event.detail}}});
            break;
        case Kind::tool_done:
            if (!live_.rounds.empty() && !live_.rounds.back().calls.empty()) {
                auto& call = live_.rounds.back().calls.back();
                call.result = event.detail;
                call.failed = event.failed;
            }
            break;
    }
    if (event.kind == Kind::text || event.kind == Kind::reasoning) {
        live_characters_ += event.text.size();
    } else if (event.kind == Kind::tool_done) {
        live_characters_ += event.detail.size();
    }
    if (selected_ != active_ || live_start_ < 0) {
        return;
    }
    switch (event.kind) {
        case Kind::reasoning:
            if (live_mode_ != LiveMode::reasoning) {
                if (live_mode_ != LiveMode::none) {
                    append(L"\r\n", body_style);
                }
                paragraph();
                append(L"Thinking\r\n", thinking_label);
                live_mode_ = LiveMode::reasoning;
            }
            append(event.text, thinking_style);
            break;
        case Kind::text:
            if (live_mode_ == LiveMode::reasoning) {
                append(L"\r\n\r\n", body_style);
            }
            if (live_mode_ != LiveMode::text) {
                paragraph();
            }
            live_mode_ = LiveMode::text;
            append(event.text, body_style);
            break;
        case Kind::tool_start:
            if (live_mode_ == LiveMode::reasoning || live_mode_ == LiveMode::text) {
                append(L"\r\n", body_style);
            }
            append_tool_call(live_.rounds.back().calls.back());
            live_mode_ = LiveMode::tool;
            break;
        case Kind::tool_done:
            if (!live_.rounds.empty() && !live_.rounds.back().calls.empty()) {
                append_tool_result(live_.rounds.back().calls.back());
            }
            live_mode_ = LiveMode::tool;
            break;
    }
}

void Panel::update_reply() {
    auto update = request_->take();
    const bool visible_conversation = selected_ == active_;
    if (update.backend == BackendStatus::confirm_start && !update.finished && IsWindowEnabled(send_)) {
        const auto model = models[conversations_[active_].model].id;
        const auto question = L"Start the SAIAS backend for " + std::wstring(model)
            + L"? Your message will be sent as soon as the model is ready.";
        if (MessageBoxW(GetAncestor(window_, GA_ROOT), question.c_str(), L"Start SAIAS backend",
                MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2) == IDYES) {
            request_->start_backend();
        } else {
            request_->stop();
        }
    } else if (update.backend == BackendStatus::loading && visible_conversation) {
        set_status(L"Starting the SAIAS backend and loading the model…");
    } else if (update.backend == BackendStatus::ready && pending_prompt_) {
        commit_pending_message();
        begin_live();
        if (visible_conversation) {
            set_status(L"Waiting for the reply…");
        }
    }
    if (update.context_size) {
        set_context_size(models[conversations_[active_].model].id, update.context_size);
        refresh_gauge();
    }

    if (!update.events.empty()) {
        if (!live_started_) {
            begin_live();
        }
        SCROLLINFO scroll{};
        POINT offset{};
        CHARRANGE selection{};
        bool follow = true;
        if (visible_conversation) {
            scroll.cbSize = sizeof(scroll);
            scroll.fMask = SIF_RANGE | SIF_PAGE | SIF_POS;
            GetScrollInfo(transcript_, SB_VERT, &scroll);
            follow = scroll.nPos + static_cast<int>(scroll.nPage) >= scroll.nMax - 3;
            SendMessageW(transcript_, EM_GETSCROLLPOS, 0, reinterpret_cast<LPARAM>(&offset));
            SendMessageW(transcript_, EM_EXGETSEL, 0, reinterpret_cast<LPARAM>(&selection));
        }
        for (const auto& event : update.events) {
            show_live_event(event);
        }
        if (visible_conversation) {
            if (follow && selection.cpMin == selection.cpMax) {
                SendMessageW(transcript_, EM_SCROLLCARET, 0, 0);
            } else {
                SendMessageW(transcript_, EM_EXSETSEL, 0, reinterpret_cast<LPARAM>(&selection));
                SendMessageW(transcript_, EM_SETSCROLLPOS, 0, reinterpret_cast<LPARAM>(&offset));
            }
            const auto& last = update.events.back();
            switch (last.kind) {
                case LiveEvent::Kind::reasoning: set_status(L"The model is thinking…"); break;
                case LiveEvent::Kind::text: set_status(L"Receiving reply…"); break;
                case LiveEvent::Kind::tool_start:
                    set_status(L"Running " + std::wstring(tool_label(last.text)) + L"…");
                    break;
                case LiveEvent::Kind::tool_done: set_status(L"Reading the tool result…"); break;
            }
        }
        refresh_gauge();
    }
    if (update.usage) {
        // The server's count replaces the estimate: everything read and written so far.
        live_tokens_ = update.usage->prompt + update.usage->completion;
        live_characters_ = 0;
        if (update.usage->speed > 0) {
            speed_ = update.usage->speed;
            speed_conversation_ = active_;
        }
        conversations_[active_].context_tokens = live_tokens_;
        refresh_gauge();
    }
    if (!update.finished) {
        return;
    }

    auto& conversation = conversations_[active_];
    if (visible_conversation && live_start_ >= 0) {
        remove_from(live_start_);
    }
    if (update.reply) {
        conversation.messages.push_back(std::move(*update.reply));
        if (visible_conversation) {
            append_message(conversation.messages.back());
            SendMessageW(transcript_, EM_SCROLLCARET, 0, 0);
        }
        persist(conversation);
    }
    const bool draft_kept = pending_prompt_.has_value();
    pending_prompt_.reset();
    active_ = no_selection;
    live_ = Message{false, L""};
    live_started_ = false;
    live_start_ = -1;
    live_mode_ = LiveMode::none;
    KillTimer(window_, refresh_timer);
    request_.reset();
    update_controls();
    refresh_gauge();
    if (!update.error.empty()) {
        set_status(update.error, true);
    } else if (update.stopped && draft_kept) {
        set_status(L"Canceled. Your message is still in the draft.");
    } else if (!history_saved_) {
        set_status(L"Conversation history could not be saved to disk.", true);
    } else if (update.stopped) {
        set_status(L"Reply stopped.");
    } else {
        set_status(ready_hint);
    }
}

// ---------------------------------------------------------------- transcript

LONG Panel::text_length() const {
    GETTEXTLENGTHEX query{GTL_NUMCHARS | GTL_PRECISE, 1200};
    return static_cast<LONG>(SendMessageW(transcript_, EM_GETTEXTLENGTHEX, reinterpret_cast<WPARAM>(&query), 0));
}

void Panel::append(std::wstring_view value, const Style& style) {
    if (value.empty()) {
        return;
    }
    const LONG length = text_length();
    const CHARRANGE end{length, length};
    SendMessageW(transcript_, EM_SETREADONLY, FALSE, 0);
    SendMessageW(transcript_, EM_EXSETSEL, 0, reinterpret_cast<LPARAM>(&end));
    CHARFORMAT2W format{};
    format.cbSize = sizeof(format);
    format.dwMask = CFM_COLOR | CFM_BOLD | CFM_ITALIC | CFM_UNDERLINE | CFM_SIZE | CFM_FACE | CFM_BACKCOLOR;
    format.dwEffects = (style.bold ? CFE_BOLD : 0) | (style.italic ? CFE_ITALIC : 0)
        | (style.underline ? CFE_UNDERLINE : 0) | (style.shaded ? 0 : CFE_AUTOBACKCOLOR);
    format.crTextColor = style.color;
    format.crBackColor = code_back;
    format.yHeight = style.twips;
    wcscpy_s(format.szFaceName, style.mono ? L"Consolas" : L"Segoe UI");
    SendMessageW(transcript_, EM_SETCHARFORMAT, SCF_SELECTION, reinterpret_cast<LPARAM>(&format));
    SendMessageW(transcript_, EM_REPLACESEL, FALSE, reinterpret_cast<LPARAM>(std::wstring(value).c_str()));
    SendMessageW(transcript_, EM_SETREADONLY, TRUE, 0);
}

// Indentation of the paragraph being written (twips): indent for its first line, offset for the
// lines that wrap.
void Panel::paragraph(LONG indent, LONG offset) {
    const LONG length = text_length();
    const CHARRANGE end{length, length};
    SendMessageW(transcript_, EM_EXSETSEL, 0, reinterpret_cast<LPARAM>(&end));
    PARAFORMAT2 format{};
    format.cbSize = sizeof(format);
    format.dwMask = PFM_STARTINDENT | PFM_OFFSET;
    format.dxStartIndent = indent;
    format.dxOffset = offset;
    SendMessageW(transcript_, EM_SETREADONLY, FALSE, 0);
    SendMessageW(transcript_, EM_SETPARAFORMAT, 0, reinterpret_cast<LPARAM>(&format));
    SendMessageW(transcript_, EM_SETREADONLY, TRUE, 0);
}

void Panel::remove_from(LONG position) {
    const CHARRANGE range{position, -1};
    SendMessageW(transcript_, EM_SETREADONLY, FALSE, 0);
    SendMessageW(transcript_, EM_EXSETSEL, 0, reinterpret_cast<LPARAM>(&range));
    SendMessageW(transcript_, EM_REPLACESEL, FALSE, reinterpret_cast<LPARAM>(L""));
    SendMessageW(transcript_, EM_SETREADONLY, TRUE, 0);
}

// Inline Markdown: **bold**, *italic*, `code` and [links](url).
void Panel::append_inline(std::wstring_view line, const Style& base) {
    constexpr auto npos = std::wstring_view::npos;
    std::wstring run;
    Style current = base;
    const auto flush = [&] {
        if (!run.empty()) {
            append(run, current);
            run.clear();
        }
    };
    std::size_t i = 0;
    while (i < line.size()) {
        const auto rest = line.substr(i);
        const wchar_t mark = rest[0];
        if (mark == L'`') {
            const auto close = line.find(L'`', i + 1);
            if (close != npos && close > i + 1) {
                flush();
                Style code = code_style;
                code.twips = current.twips;
                append(line.substr(i + 1, close - i - 1), code);
                i = close + 1;
                continue;
            }
        } else if (rest.starts_with(L"**") || rest.starts_with(L"__")) {
            const bool closing = current.bold != base.bold;
            if (closing || line.find(rest.substr(0, 2), i + 2) != npos) {
                flush();
                current.bold = !current.bold;
                i += 2;
                continue;
            }
        } else if (mark == L'*' || mark == L'_') {
            const bool closing = current.italic != base.italic;
            const bool inside_word = i > 0 && std::iswalnum(line[i - 1]);
            const bool opens = !(mark == L'_' && inside_word) && rest.size() > 1 && rest[1] != L' '
                && line.find(mark, i + 1) != npos;
            if (closing || opens) {
                flush();
                current.italic = !current.italic;
                ++i;
                continue;
            }
        } else if (mark == L'[') {
            const auto middle = line.find(L"](", i);
            const auto close = middle == npos ? npos : line.find(L')', middle + 2);
            if (middle != npos && close != npos && middle > i + 1) {
                flush();
                Style label = current;
                label.color = link_color;
                label.underline = true;
                append(line.substr(i + 1, middle - i - 1), label);
                Style address = current;
                address.color = dim;
                address.twips = small_twips;
                append(L" (" + std::wstring(line.substr(middle + 2, close - middle - 2)) + L")", address);
                i = close + 1;
                continue;
            }
        }
        run += mark;
        ++i;
    }
    flush();
}

// Block Markdown: headings, lists, quotes, rules, tables and fenced code.
void Panel::append_markdown(std::wstring_view source) {
    constexpr auto npos = std::wstring_view::npos;
    while (!source.empty() && (source.back() == L'\n' || source.back() == L'\r' || source.back() == L' ')) {
        source.remove_suffix(1);
    }
    bool code = false;
    bool blank = false;
    std::size_t start = 0;
    while (start < source.size()) {
        auto end = source.find(L'\n', start);
        if (end == npos) {
            end = source.size();
        }
        auto line = source.substr(start, end - start);
        start = end + 1;
        if (!line.empty() && line.back() == L'\r') {
            line.remove_suffix(1);
        }
        const auto first = line.find_first_not_of(L" \t");
        const auto trimmed = first == npos ? std::wstring_view{} : line.substr(first);
        if (trimmed.starts_with(L"```")) {
            code = !code;
            const auto language = trimmed.substr(3);
            if (code && !language.empty()) {
                paragraph(240);
                append(std::wstring(language) + L"\r\n", note_style);
            }
            continue;
        }
        if (code) {
            paragraph(240);
            append(std::wstring(line) + L"\r\n", code_style);
            continue;
        }
        if (trimmed.empty()) {
            if (!blank) {
                paragraph();
                append(L"\r\n", body_style);
            }
            blank = true;
            continue;
        }
        blank = false;

        std::size_t level = 0;
        while (level < trimmed.size() && level < 6 && trimmed[level] == L'#') {
            ++level;
        }
        if (level && level < trimmed.size() && trimmed[level] == L' ') {
            Style heading = body_style;
            heading.bold = true;
            heading.twips = level == 1 ? 300 : (level == 2 ? 260 : 230);
            paragraph();
            append_inline(trimmed.substr(level + 1), heading);
            append(L"\r\n", heading);
            continue;
        }
        if (trimmed == L"---" || trimmed == L"***" || trimmed == L"___") {
            paragraph();
            append(std::wstring(32, L'─') + L"\r\n", note_style);
            continue;
        }
        if (trimmed.starts_with(L">")) {
            auto quote = trimmed.substr(1);
            if (quote.starts_with(L" ")) {
                quote.remove_prefix(1);
            }
            Style quoted = body_style;
            quoted.color = muted;
            quoted.italic = true;
            paragraph(300);
            append_inline(quote, quoted);
            append(L"\r\n", quoted);
            continue;
        }
        const auto depth = static_cast<LONG>(std::min<std::size_t>(first / 2, 4));
        if (trimmed.size() > 1 && (trimmed[0] == L'-' || trimmed[0] == L'*' || trimmed[0] == L'+') && trimmed[1] == L' ') {
            paragraph(240 + depth * 300, 240);
            append(L"•  ", body_style);
            append_inline(trimmed.substr(2), body_style);
            append(L"\r\n", body_style);
            continue;
        }
        std::size_t digits = 0;
        while (digits < trimmed.size() && digits < 4 && std::iswdigit(trimmed[digits])) {
            ++digits;
        }
        if (digits && digits + 1 < trimmed.size() && (trimmed[digits] == L'.' || trimmed[digits] == L')')
                && trimmed[digits + 1] == L' ') {
            paragraph(240 + depth * 300, 300);
            append(std::wstring(trimmed.substr(0, digits + 1)) + L"  ", body_style);
            append_inline(trimmed.substr(digits + 2), body_style);
            append(L"\r\n", body_style);
            continue;
        }
        if (trimmed.starts_with(L"|")) {
            // Separator rows (|---|:--|) only align the columns in Markdown.
            if (trimmed.find_first_not_of(L"|-: ") == npos) {
                continue;
            }
            Style row = code_style;
            row.shaded = false;
            row.twips = small_twips;
            paragraph();
            append(std::wstring(trimmed) + L"\r\n", row);
            continue;
        }
        paragraph();
        append_inline(trimmed, body_style);
        append(L"\r\n", body_style);
    }
}

void Panel::append_reasoning(std::wstring_view reasoning, bool live) {
    constexpr std::size_t shown = 4000;
    paragraph();
    append(L"Thinking\r\n", thinking_label);
    if (!live && reasoning.size() > shown) {
        append(std::wstring(reasoning.substr(0, shown)) + L"…\r\n", thinking_style);
    } else {
        append(std::wstring(reasoning) + L"\r\n", thinking_style);
    }
}

void Panel::append_tool_call(const ToolCall& call) {
    paragraph(240);
    append(L"▸ " + std::wstring(tool_label(call.name)), tool_header);
    append(L"  " + one_line(call.arguments, 160) + L"\r\n", tool_detail);
}

void Panel::append_tool_result(const ToolCall& call) {
    paragraph(480);
    if (call.failed) {
        append(one_line(call.result, 240) + L"\r\n", tool_failed);
        return;
    }
    append(thousands(call.result.size()) + L" characters: " + one_line(call.result, 200) + L"\r\n", note_style);
}

void Panel::append_message(const Message& message) {
    paragraph();
    if (message.from_user) {
        append(L"You\r\n", user_header);
        for (const auto& item : message.attachments) {
            append((item.is_image() ? L"Image: " : L"PDF: ") + item.name + L"\r\n", note_style);
        }
        append_markdown(message.text);
        append(L"\r\n", body_style);
        return;
    }
    const auto& model = selected_ != no_selection ? models[conversations_[selected_].model].id : models[0].id;
    append(std::wstring(model) + L"\r\n", model_header);
    if (!message.reasoning.empty()) {
        append_reasoning(message.reasoning, false);
        append(L"\r\n", body_style);
    }
    for (const auto& round : message.rounds) {
        if (!round.text.empty()) {
            append_markdown(round.text);
        }
        for (const auto& call : round.calls) {
            append_tool_call(call);
            if (!call.result.empty()) {
                append_tool_result(call);
            }
        }
        paragraph();
        append(L"\r\n", body_style);
    }
    append_markdown(message.text);
    paragraph();
    append(L"\r\n", body_style);
}

void Panel::render_history() {
    SendMessageW(transcript_, WM_SETREDRAW, FALSE, 0);
    SetWindowTextW(transcript_, L"");
    for (const auto& message : conversations_[selected_].messages) {
        append_message(message);
    }
    live_start_ = -1;
    if (selected_ == active_ && live_started_) {
        // The reply so far, then the live view continues after it.
        live_start_ = text_length();
        paragraph();
        append(std::wstring(models[conversations_[active_].model].id) + L"\r\n", model_header);
        if (!live_.reasoning.empty()) {
            append_reasoning(live_.reasoning, true);
        }
        for (const auto& round : live_.rounds) {
            if (!round.text.empty()) {
                append_markdown(round.text);
            }
            for (const auto& call : round.calls) {
                append_tool_call(call);
                if (!call.result.empty()) {
                    append_tool_result(call);
                }
            }
        }
        paragraph();
        append(live_.text, body_style);
        live_mode_ = !live_.text.empty() ? LiveMode::text
            : (!live_.rounds.empty() ? LiveMode::tool : (!live_.reasoning.empty() ? LiveMode::reasoning : LiveMode::none));
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

} // namespace saias::chat
