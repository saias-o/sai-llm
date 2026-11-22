#include "pdf_ocr.hpp"

#include <windows.h>
#include <asyncinfo.h>
#include <roapi.h>
#include <robuffer.h>
#include <windows.graphics.imaging.h>
#include <winstring.h>
#include <wrl/client.h>

#include <cstring>

namespace sai::chat {
namespace {

using Microsoft::WRL::ComPtr;
namespace Imaging = ABI::Windows::Graphics::Imaging;
namespace Streams = ABI::Windows::Storage::Streams;

// MinGW provides the bitmap and buffer interfaces, but omits Windows.Media.Ocr.
// The declarations below use the published Windows SDK ABI.
struct OcrResult : IInspectable {
    STDMETHOD(get_Lines)(IInspectable**) PURE;
    STDMETHOD(get_TextAngle)(IInspectable**) PURE;
    STDMETHOD(get_Text)(HSTRING*) PURE;
};

struct OcrOperation : IInspectable {
    STDMETHOD(put_Completed)(IUnknown*) PURE;
    STDMETHOD(get_Completed)(IUnknown**) PURE;
    STDMETHOD(GetResults)(OcrResult**) PURE;
};

struct OcrEngine : IInspectable {
    STDMETHOD(RecognizeAsync)(Imaging::ISoftwareBitmap*, OcrOperation**) PURE;
};

struct OcrStatics : IInspectable {
    STDMETHOD(get_MaxImageDimension)(UINT32*) PURE;
    STDMETHOD(get_AvailableRecognizerLanguages)(IInspectable**) PURE;
    STDMETHOD(IsLanguageSupported)(IInspectable*, boolean*) PURE;
    STDMETHOD(TryCreateFromLanguage)(IInspectable*, OcrEngine**) PURE;
    STDMETHOD(TryCreateFromUserProfileLanguages)(OcrEngine**) PURE;
};

constexpr GUID ocr_statics_id{0x5bffa85a, 0x3384, 0x3540, {0x99, 0x40, 0x69, 0x91, 0x20, 0xd4, 0x28, 0xa8}};

class Apartment {
public:
    Apartment() : initialized_(SUCCEEDED(RoInitialize(RO_INIT_MULTITHREADED))) {}
    ~Apartment() { if (initialized_) RoUninitialize(); }
    explicit operator bool() const { return initialized_; }

private:
    bool initialized_;
};

template <typename Interface, std::size_t N>
ComPtr<Interface> activate(const wchar_t (&name)[N], const GUID& id) {
    HSTRING_HEADER header{};
    HSTRING runtime_class{};
    ComPtr<Interface> result;
    if (SUCCEEDED(WindowsCreateStringReference(name, static_cast<UINT32>(N - 1), &header, &runtime_class))) {
        RoGetActivationFactory(runtime_class, id, reinterpret_cast<void**>(result.GetAddressOf()));
    }
    return result;
}

ComPtr<Imaging::ISoftwareBitmap> make_bitmap(const unsigned char* pixels, int width, int height, int stride) {
    const auto factory = activate<Streams::IBufferFactory>(L"Windows.Storage.Streams.Buffer", __uuidof(Streams::IBufferFactory));
    const auto statics = activate<Imaging::ISoftwareBitmapStatics>(
        L"Windows.Graphics.Imaging.SoftwareBitmap", __uuidof(Imaging::ISoftwareBitmapStatics));
    if (!factory || !statics) {
        return {};
    }
    const auto row_size = static_cast<std::size_t>(width) * 4;
    const auto length = static_cast<UINT32>(row_size * height);
    ComPtr<Streams::IBuffer> buffer;
    ComPtr<Windows::Storage::Streams::IBufferByteAccess> access;
    byte* data = nullptr;
    if (FAILED(factory->Create(length, buffer.GetAddressOf())) || FAILED(buffer.As(&access))
            || FAILED(access->Buffer(&data)) || !data || FAILED(buffer->put_Length(length))) {
        return {};
    }
    for (int row = 0; row < height; ++row) {
        std::memcpy(data + row * row_size, pixels + static_cast<std::size_t>(row) * stride, row_size);
    }
    ComPtr<Imaging::ISoftwareBitmap> bitmap;
    statics->CreateCopyWithAlphaFromBuffer(buffer.Get(), Imaging::BitmapPixelFormat_Bgra8,
        width, height, Imaging::BitmapAlphaMode_Ignore, bitmap.GetAddressOf());
    return bitmap;
}

} // namespace

std::wstring recognize_pdf_page(const unsigned char* pixels, int width, int height, int stride, std::stop_token stop) {
    Apartment apartment;
    if (!apartment || stop.stop_requested()) {
        throw std::wstring(L"Windows OCR is unavailable.");
    }
    const auto statics = activate<OcrStatics>(L"Windows.Media.Ocr.OcrEngine", ocr_statics_id);
    ComPtr<OcrEngine> engine;
    UINT32 maximum = 0;
    if (!statics || FAILED(statics->TryCreateFromUserProfileLanguages(engine.GetAddressOf())) || !engine
            || FAILED(statics->get_MaxImageDimension(&maximum))) {
        throw std::wstring(L"Windows OCR needs a recognition language. Install one in Windows Language settings.");
    }
    if (static_cast<UINT32>(width) > maximum || static_cast<UINT32>(height) > maximum) {
        throw std::wstring(L"A scanned page exceeds the Windows OCR image size limit.");
    }
    const auto bitmap = make_bitmap(pixels, width, height, stride);
    ComPtr<OcrOperation> operation;
    ComPtr<IAsyncInfo> info;
    if (!bitmap || FAILED(engine->RecognizeAsync(bitmap.Get(), operation.GetAddressOf()))
            || !operation || FAILED(operation.As(&info))) {
        throw std::wstring(L"Windows OCR could not read a scanned page.");
    }
    const auto deadline = GetTickCount64() + 30000;
    AsyncStatus status = AsyncStatus::Started;
    while (SUCCEEDED(info->get_Status(&status)) && status == AsyncStatus::Started) {
        if (stop.stop_requested() || GetTickCount64() >= deadline) {
            info->Cancel();
            throw std::wstring(L"PDF recognition was interrupted.");
        }
        Sleep(15);
    }
    ComPtr<OcrResult> result;
    HSTRING text{};
    if (status != AsyncStatus::Completed || FAILED(operation->GetResults(result.GetAddressOf())) || !result
            || FAILED(result->get_Text(&text))) {
        throw std::wstring(L"Windows OCR could not read a scanned page.");
    }
    UINT32 length = 0;
    const auto* raw = WindowsGetStringRawBuffer(text, &length);
    const std::wstring recognized(raw, length);
    WindowsDeleteString(text);
    return recognized;
}

} // namespace sai::chat
