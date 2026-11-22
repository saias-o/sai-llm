set(SAI_PDFIUM_DIR "" CACHE PATH "Optional path to an extracted PDFium distribution")

if(SAI_PDFIUM_DIR)
    set(sai_pdfium_root "${SAI_PDFIUM_DIR}")
else()
    include(FetchContent)
    if(POLICY CMP0135)
        cmake_policy(SET CMP0135 NEW)
    endif()

    set(sai_pdfium_target "${CMAKE_GENERATOR_PLATFORM}")
    if(NOT sai_pdfium_target)
        set(sai_pdfium_target "${CMAKE_CXX_COMPILER_TARGET}:${CMAKE_SYSTEM_PROCESSOR}")
    endif()
    string(TOLOWER "${sai_pdfium_target}" sai_pdfium_target)
    if(CMAKE_SIZEOF_VOID_P EQUAL 4)
        set(sai_pdfium_arch x86)
        set(sai_pdfium_hash fc697d735516b2dd408072ecdd808a67e12c6402f3e762299015da1d81142986)
    elseif(sai_pdfium_target MATCHES "(arm64|aarch64)")
        set(sai_pdfium_arch arm64)
        set(sai_pdfium_hash d65e405c59cffe6fe36c0935b90d40ddf3ce75ef284f3168a28dcf00d0388131)
    else()
        set(sai_pdfium_arch x64)
        set(sai_pdfium_hash ca7338ae7779b8b1b82f4580305c4d762d214f8df1d54b47647fe3cc75989ded)
    endif()

    FetchContent_Declare(sai_pdfium
        URL "https://github.com/bblanchon/pdfium-binaries/releases/download/chromium/8165/pdfium-win-${sai_pdfium_arch}.tgz"
        URL_HASH "SHA256=${sai_pdfium_hash}"
    )
    FetchContent_MakeAvailable(sai_pdfium)
    set(sai_pdfium_root "${sai_pdfium_SOURCE_DIR}")
endif()

if(NOT EXISTS "${sai_pdfium_root}/include/fpdfview.h" OR NOT EXISTS "${sai_pdfium_root}/bin/pdfium.dll")
    message(FATAL_ERROR "PDFium headers and pdfium.dll are required. Set SAI_PDFIUM_DIR to the extracted distribution.")
endif()

target_include_directories(SAI-LLM PRIVATE "${sai_pdfium_root}/include")
add_custom_command(TARGET SAI-LLM POST_BUILD
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${sai_pdfium_root}/bin/pdfium.dll" "$<TARGET_FILE_DIR:SAI-LLM>/pdfium.dll"
    COMMAND "${CMAKE_COMMAND}" -E copy_directory "${sai_pdfium_root}/licenses" "$<TARGET_FILE_DIR:SAI-LLM>/PDFium-licenses"
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${sai_pdfium_root}/LICENSE" "$<TARGET_FILE_DIR:SAI-LLM>/PDFium-licenses/LICENSE"
    VERBATIM
)
