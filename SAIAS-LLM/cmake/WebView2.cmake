# WebView2 SDK (headers and the static loader) for the chat view, from the pinned NuGet package.
# The WebView2 runtime itself ships with Windows 10 and 11. SAIAS_WEBVIEW2_DIR can point to an
# extracted package for offline builds.
set(SAIAS_WEBVIEW2_DIR "" CACHE PATH "Optional path to an extracted Microsoft.Web.WebView2 package")

if(SAIAS_WEBVIEW2_DIR)
    set(saias_webview2_root "${SAIAS_WEBVIEW2_DIR}")
else()
    include(FetchContent)
    if(POLICY CMP0135)
        cmake_policy(SET CMP0135 NEW)
    endif()
    FetchContent_Declare(saias_webview2
        URL "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/1.0.4314.35"
        URL_HASH "SHA512=70e6a256a3f7066407327c46a59cc034cdb6b545e0c9cae2b322478c818dcc868cb26f225e3ecac7e71e620f916d8c09b734f4d3da9f7054e872f54b63e7a433"
        DOWNLOAD_NAME "microsoft.web.webview2.1.0.4314.35.zip"
    )
    FetchContent_MakeAvailable(saias_webview2)
    set(saias_webview2_root "${saias_webview2_SOURCE_DIR}")
endif()

if(CMAKE_SIZEOF_VOID_P EQUAL 4)
    set(saias_webview2_arch x86)
elseif(CMAKE_GENERATOR_PLATFORM MATCHES "(ARM64|arm64)" OR CMAKE_SYSTEM_PROCESSOR MATCHES "(ARM64|arm64|aarch64)")
    set(saias_webview2_arch arm64)
else()
    set(saias_webview2_arch x64)
endif()

set(saias_webview2_loader "${saias_webview2_root}/build/native/${saias_webview2_arch}/WebView2LoaderStatic.lib")
if(NOT EXISTS "${saias_webview2_root}/build/native/include/WebView2.h" OR NOT EXISTS "${saias_webview2_loader}")
    message(FATAL_ERROR "WebView2 headers and WebView2LoaderStatic.lib are required. Set SAIAS_WEBVIEW2_DIR to the extracted package.")
endif()

target_include_directories(SAIAS-LLM PRIVATE "${saias_webview2_root}/build/native/include")
target_link_libraries(SAIAS-LLM PRIVATE "${saias_webview2_loader}" version)
