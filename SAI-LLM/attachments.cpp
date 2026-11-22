#include "attachments.hpp"
#include "pdf_ocr.hpp"

#include <windows.h>
#include <wincrypt.h>

#include <fpdf_text.h>
#include <fpdfview.h>

#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cwctype>
#include <fstream>
#include <memory>
#include <mutex>
#include <string_view>

namespace sai::chat {
namespace {

constexpr std::size_t pdf_size_limit = 32 * 1024 * 1024;
constexpr std::size_t image_size_limit = 5 * 1024 * 1024;
constexpr std::size_t text_limit = 1024 * 1024;

std::string read_file(const std::filesystem::path& path, std::size_t limit, const wchar_t* size_error) {
    std::ifstream file(path, std::ios::binary | std::ios::ate);
    if (!file) {
        throw std::wstring(L"Could not open the file.");
    }
    const auto size = file.tellg();
    if (size <= 0) {
        throw std::wstring(L"The file is empty or unreadable.");
    }
    if (static_cast<std::size_t>(size) > limit) {
        throw std::wstring(size_error);
    }
    std::string bytes(static_cast<std::size_t>(size), '\0');
    file.seekg(0);
    if (!file.read(bytes.data(), static_cast<std::streamsize>(bytes.size()))) {
        throw std::wstring(L"Could not read the file.");
    }
    return bytes;
}

std::string image_url(const std::filesystem::path& path) {
    const auto bytes = read_file(path, image_size_limit, L"Images must be at most 5 MB.");
    const std::string_view header(bytes);
    const char* mime = nullptr;
    if (header.starts_with("\x89PNG\r\n\x1a\n")) {
        mime = "image/png";
    } else if (header.starts_with("\xff\xd8\xff")) {
        mime = "image/jpeg";
    } else {
        throw std::wstring(L"Choose a valid PNG or JPEG image.");
    }
    constexpr DWORD flags = CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF;
    DWORD length = 0;
    const auto* data = reinterpret_cast<const BYTE*>(bytes.data());
    const auto size = static_cast<DWORD>(bytes.size());
    if (!CryptBinaryToStringA(data, size, flags, nullptr, &length)) {
        throw std::wstring(L"Could not encode the image.");
    }
    auto encoded = std::string("data:") + mime + ";base64,";
    const auto begin = encoded.size();
    encoded.resize(begin + length);
    if (!CryptBinaryToStringA(data, size, flags, encoded.data() + begin, &length)) {
        throw std::wstring(L"Could not encode the image.");
    }
    encoded.resize(begin + length);
    return encoded;
}

class Library {
public:
    Library() {
        std::array<wchar_t, 32768> name{};
        const auto length = GetModuleFileNameW(nullptr, name.data(), static_cast<DWORD>(name.size()));
        if (length && length < name.size()) {
            const auto directory = std::filesystem::path(std::wstring_view(name.data(), length)).parent_path();
            if (directory.is_absolute()) {
                library_ = LoadLibraryExW((directory / L"pdfium.dll").c_str(), nullptr,
                    LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
            }
        }
        if (!library_) {
            throw std::wstring(L"PDF conversion needs pdfium.dll next to SAI-LLM.exe.");
        }
    }
    ~Library() { FreeLibrary(library_); }
    Library(const Library&) = delete;
    Library& operator=(const Library&) = delete;

    template <typename Function> Function get(const char* name) const {
        const auto address = GetProcAddress(library_, name);
        if (!address) {
            throw std::wstring(L"The installed PDFium runtime is incompatible.");
        }
        return std::bit_cast<Function>(address);
    }

private:
    HMODULE library_ = nullptr;
};

struct Pdfium {
    Pdfium() { FPDF_InitLibrary(); }
    ~Pdfium() { FPDF_DestroyLibrary(); }

private:
    Library library_;

public:
#define PDF_FUNCTION(name) const decltype(&::name) name = library_.get<decltype(&::name)>(#name)
    PDF_FUNCTION(FPDF_InitLibrary);
    PDF_FUNCTION(FPDF_DestroyLibrary);
    PDF_FUNCTION(FPDF_LoadMemDocument64);
    PDF_FUNCTION(FPDF_GetLastError);
    PDF_FUNCTION(FPDF_CloseDocument);
    PDF_FUNCTION(FPDF_GetPageCount);
    PDF_FUNCTION(FPDF_LoadPage);
    PDF_FUNCTION(FPDF_ClosePage);
    PDF_FUNCTION(FPDFText_LoadPage);
    PDF_FUNCTION(FPDFText_ClosePage);
    PDF_FUNCTION(FPDFText_CountChars);
    PDF_FUNCTION(FPDFText_GetText);
    PDF_FUNCTION(FPDF_GetPageWidthF);
    PDF_FUNCTION(FPDF_GetPageHeightF);
    PDF_FUNCTION(FPDFBitmap_Create);
    PDF_FUNCTION(FPDFBitmap_FillRect);
    PDF_FUNCTION(FPDF_RenderPageBitmap);
    PDF_FUNCTION(FPDFBitmap_GetBuffer);
    PDF_FUNCTION(FPDFBitmap_GetStride);
    PDF_FUNCTION(FPDFBitmap_Destroy);
#undef PDF_FUNCTION
};

template <typename Handle, typename Close>
auto owned(Handle handle, Close close) {
    return std::unique_ptr<std::remove_pointer_t<Handle>, Close>(handle, close);
}

void trim(std::wstring& text) {
    const auto printable = [](wchar_t character) { return character && character != 0xfeff && !std::iswspace(character); };
    const auto first = std::find_if(text.begin(), text.end(), printable);
    const auto last = std::find_if(text.rbegin(), text.rend(), printable).base();
    text = first < last ? std::wstring(first, last) : std::wstring{};
}

std::wstring read_text_layer(const Pdfium& pdf, FPDF_PAGE page) {
    const auto text_page = owned(pdf.FPDFText_LoadPage(page), pdf.FPDFText_ClosePage);
    const int count = text_page ? pdf.FPDFText_CountChars(text_page.get()) : 0;
    if (count <= 0) {
        return {};
    }
    if (static_cast<std::size_t>(count) > text_limit) {
        throw std::wstring(L"The extracted PDF text is too large. Split the document before attaching it.");
    }
    std::vector<unsigned short> characters(static_cast<std::size_t>(count) + 1);
    const int copied = pdf.FPDFText_GetText(text_page.get(), 0, count, characters.data());
    if (copied <= 1) {
        return {};
    }
    std::wstring result(characters.begin(), characters.begin() + copied - 1);
    trim(result);
    return result;
}

std::wstring read_scanned_page(const Pdfium& pdf, FPDF_PAGE page, std::stop_token stop) {
    const auto page_width = pdf.FPDF_GetPageWidthF(page);
    const auto page_height = pdf.FPDF_GetPageHeightF(page);
    if (!std::isfinite(page_width) || !std::isfinite(page_height) || page_width <= 0 || page_height <= 0) {
        throw std::wstring(L"A PDF page has invalid dimensions.");
    }
    const float scale = std::min(3.0f, 2304.0f / std::max(page_width, page_height));
    const int width = std::max(1, static_cast<int>(page_width * scale));
    const int height = std::max(1, static_cast<int>(page_height * scale));
    const auto bitmap = owned(pdf.FPDFBitmap_Create(width, height, 1), pdf.FPDFBitmap_Destroy);
    if (!bitmap || !pdf.FPDFBitmap_FillRect(bitmap.get(), 0, 0, width, height, 0xffffffffu)) {
        throw std::wstring(L"Could not render a scanned PDF page.");
    }
    pdf.FPDF_RenderPageBitmap(bitmap.get(), page, 0, 0, width, height, 0, 0);
    const auto* pixels = static_cast<const unsigned char*>(pdf.FPDFBitmap_GetBuffer(bitmap.get()));
    const int stride = pdf.FPDFBitmap_GetStride(bitmap.get());
    if (!pixels || stride < width * 4) {
        throw std::wstring(L"Could not read a rendered PDF page.");
    }
    for (int row = 0; row < height; ++row) {
        const auto* pixel = pixels + static_cast<std::size_t>(row) * stride;
        for (int col = 0; col < width; ++col, pixel += 4) {
            if (std::min({pixel[0], pixel[1], pixel[2]}) < 245) {
                auto result = recognize_pdf_page(pixels, width, height, stride, stop);
                trim(result);
                return result;
            }
        }
    }
    return {};
}

std::wstring pdf_text(const std::filesystem::path& path, std::stop_token stop) {
    const auto bytes = read_file(path, pdf_size_limit, L"PDF files must be at most 32 MB.");
    static std::mutex pdfium_mutex;
    std::lock_guard lock(pdfium_mutex);
    const Pdfium pdf;
    const auto document = owned(pdf.FPDF_LoadMemDocument64(bytes.data(), bytes.size(), nullptr), pdf.FPDF_CloseDocument);
    if (!document) {
        throw std::wstring(pdf.FPDF_GetLastError() == FPDF_ERR_PASSWORD
            ? L"The PDF needs a password. Attach an unlocked copy."
            : L"Could not open this PDF.");
    }
    std::wstring result;
    const int pages = pdf.FPDF_GetPageCount(document.get());
    for (int number = 0; number < pages; ++number) {
        if (stop.stop_requested()) {
            return {};
        }
        const auto page = owned(pdf.FPDF_LoadPage(document.get(), number), pdf.FPDF_ClosePage);
        if (!page) {
            throw std::wstring(L"A PDF page could not be read.");
        }
        auto text = read_text_layer(pdf, page.get());
        if (text.empty()) {
            text = read_scanned_page(pdf, page.get(), stop);
        }
        if (text.empty()) {
            continue;
        }
        if (!result.empty()) {
            result += L"\n\n";
        }
        result += L"Page " + std::to_wstring(number + 1) + L"\n" + text;
        if (result.size() > text_limit) {
            throw std::wstring(L"The extracted PDF text is too large. Split the document before attaching it.");
        }
    }
    if (result.empty()) {
        throw std::wstring(L"No readable text was found in the PDF.");
    }
    return result;
}

} // namespace

AttachmentImport import_attachment(const std::filesystem::path& path, const Model& model, std::stop_token stop) {
    AttachmentImport result;
    try {
        result.attachment.name = path.filename().wstring();
        auto extension = path.extension().wstring();
        std::transform(extension.begin(), extension.end(), extension.begin(),
            [](wchar_t letter) { return static_cast<wchar_t>(std::towlower(letter)); });
        if (extension == L".pdf") {
            result.attachment.text = pdf_text(path, stop);
        } else if (extension == L".png" || extension == L".jpg" || extension == L".jpeg") {
            if (!supports_images(model)) {
                throw std::wstring(model.id == L"sai-flash" ? L"sai-flash accepts text and PDFs. Select sai-max for images."
                    : L"Images require sai-max with the current configuration.");
            }
            result.attachment.image_url = image_url(path);
        } else {
            throw std::wstring(L"Choose a PDF, PNG, or JPEG file.");
        }
    } catch (const std::wstring& message) {
        result.error = message;
    }
    return result;
}

} // namespace sai::chat
