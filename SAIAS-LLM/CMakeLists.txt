cmake_minimum_required(VERSION 3.20)
project(SaiasLlmAdvisor LANGUAGES CXX)

if(WIN32)
    enable_language(RC)
    add_executable(SAIAS-LLM WIN32 main_windows.cpp hardware_windows.cpp advisor.cpp chat.cpp chat_windows.cpp
        attachments.cpp pdf_ocr.cpp app.rc)
    target_include_directories(SAIAS-LLM PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
    target_compile_definitions(SAIAS-LLM PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN
        WINVER=0x0A00 _WIN32_WINNT=0x0A00)
    target_link_libraries(SAIAS-LLM PRIVATE d2d1 dwrite dwmapi dxgi dxguid gdi32 user32 advapi32 shell32 winhttp ole32
        comctl32 comdlg32 crypt32 runtimeobject)
    include(cmake/Pdfium.cmake)
    if(MINGW)
        target_link_options(SAIAS-LLM PRIVATE -municode -static)
    elseif(MSVC)
        target_compile_options(SAIAS-LLM PRIVATE "$<$<COMPILE_LANGUAGE:CXX>:/utf-8>")
        set_property(TARGET SAIAS-LLM PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
    endif()
else()
    add_executable(SAIAS-LLM main_console.cpp hardware_unix.cpp advisor.cpp)
    target_link_libraries(SAIAS-LLM PRIVATE ${CMAKE_DL_LIBS})
endif()

target_compile_features(SAIAS-LLM PRIVATE cxx_std_20)
set_target_properties(SAIAS-LLM PROPERTIES CXX_EXTENSIONS OFF)
