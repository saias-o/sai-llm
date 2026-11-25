#pragma once

#include <windows.h>

namespace saias::webchat {

// The Chat view: SAIAS Chat (ui/chat, served by the hub) in a WebView2 control. Starts the hub
// when it is not running. Without the WebView2 runtime it shows the native chat panel instead.
HWND create_panel(HINSTANCE instance, HWND parent);

} // namespace saias::webchat
