set(SAIAS_PDFIUM_DIR "" CACHE PATH "Optional path to an extracted PDFium distribution")

if(SAIAS_PDFIUM_DIR)
    set(saias_pdfium_root "${SAIAS_PDFIUM_DIR}")
else()
    include(FetchContent)
    if(POLICY CMP0135)
        cmake_policy(SET CMP0135 NEW)
    endif()

    set(saias_pdfium_target "${CMAKE_GENERATOR_PLATFORM}")
    if(NOT saias_pdfium_target)
        set(saias_pdfium_target "${CMAKE_CXX_COMPILER_TARGET}:${CMAKE_SYSTEM_PROCESSOR}")
    endif()
    string(TOLOWER "${saias_pdfium_target}" saias_pdfium_target)
    if(CMAKE_SIZEOF_VOID_P EQUAL 4)
        set(saias_pdfium_arch x86)
        set(saias_pdfium_hash fc697d735516b2dd408072ecdd808a67e12c6402f3e762299015da1d81142986)
    elseif(saias_pdfium_target MATCHES "(arm64|aarch64)")
        set(saias_pdfium_arch arm64)
        set(saias_pdfium_hash d65e405c59cffe6fe36c0935b90d40ddf3ce75ef284f3168a28dcf00d0388131)
    else()
        set(saias_pdfium_arch x64)
        set(saias_pdfium_hash ca7338ae7779b8b1b82f4580305c4d762d214f8df1d54b47647fe3cc75989ded)
    endif()

    FetchContent_Declare(saias_pdfium
        URL "https://github.com/bblanchon/pdfium-binaries/releases/download/chromium/8165/pdfium-win-${saias_pdfium_arch}.tgz"
        URL_HASH "SHA256=${saias_pdfium_hash}"
    )
    FetchContent_MakeAvailable(saias_pdfium)
    set(saias_pdfium_root "${saias_pdfium_SOURCE_DIR}")
endif()

if(NOT EXISTS "${saias_pdfium_root}/include/fpdfview.h" OR NOT EXISTS "${saias_pdfium_root}/bin/pdfium.dll")
    message(FATAL_ERROR "PDFium headers and pdfium.dll are required. Set SAIAS_PDFIUM_DIR to the extracted distribution.")
endif()

target_include_directories(SAIAS-LLM PRIVATE "${saias_pdfium_root}/include")
add_custom_command(TARGET SAIAS-LLM POST_BUILD
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${saias_pdfium_root}/bin/pdfium.dll" "$<TARGET_FILE_DIR:SAIAS-LLM>/pdfium.dll"
    COMMAND "${CMAKE_COMMAND}" -E copy_directory "${saias_pdfium_root}/licenses" "$<TARGET_FILE_DIR:SAIAS-LLM>/PDFium-licenses"
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${saias_pdfium_root}/LICENSE" "$<TARGET_FILE_DIR:SAIAS-LLM>/PDFium-licenses/LICENSE"
    VERBATIM
)
