#include "advisor.hpp"
#include "nvidia_inventory.hpp"

#include <windows.h>
#include <dxgi.h>

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstring>
#include <stdexcept>
#include <utility>

namespace saias {
namespace {

constexpr double bytes_per_gib = 1024.0 * 1024.0 * 1024.0;
constexpr DWORD sse42_feature = 38;
constexpr DWORD avx2_feature = 40;
constexpr DWORD arm64_feature = 29;

std::wstring cpu_name() {
    constexpr auto key = LR"(HARDWARE\DESCRIPTION\System\CentralProcessor\0)";
    std::array<wchar_t, 256> value{};
    DWORD size = static_cast<DWORD>(sizeof(value));
    if (RegGetValueW(HKEY_LOCAL_MACHINE, key, L"ProcessorNameString", RRF_RT_REG_SZ,
                     nullptr, value.data(), &size) == ERROR_SUCCESS) {
        std::wstring name(value.data());
        const auto first = name.find_first_not_of(L" \t");
        const auto last = name.find_last_not_of(L" \t");
        if (first != std::wstring::npos) {
            return name.substr(first, last - first + 1);
        }
    }
    return L"Processor name unavailable";
}

unsigned physical_cores() {
    DWORD bytes = 0;
    GetLogicalProcessorInformationEx(RelationProcessorCore, nullptr, &bytes);
    if (!bytes) {
        return 0;
    }
    std::vector<std::byte> data(bytes);
    if (!GetLogicalProcessorInformationEx(RelationProcessorCore,
            reinterpret_cast<SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX*>(data.data()), &bytes)) {
        return 0;
    }
    unsigned cores = 0;
    for (DWORD offset = 0; offset + 2 * sizeof(DWORD) <= bytes;) {
        std::array<DWORD, 2> header{};
        std::memcpy(header.data(), data.data() + offset, sizeof(header));
        if (header[1] < sizeof(header) || header[1] > bytes - offset) {
            return 0;
        }
        cores += header[0] == RelationProcessorCore;
        offset += header[1];
    }
    return cores;
}

std::vector<Adapter> dxgi_adapters() {
    IDXGIFactory1* factory = nullptr;
    if (FAILED(CreateDXGIFactory1(IID_IDXGIFactory1, reinterpret_cast<void**>(&factory)))) {
        return {};
    }
    std::vector<Adapter> result;
    for (UINT index = 0;; ++index) {
        IDXGIAdapter1* adapter = nullptr;
        if (FAILED(factory->EnumAdapters1(index, &adapter))) {
            break;
        }
        DXGI_ADAPTER_DESC1 desc{};
        const auto status = adapter->GetDesc1(&desc);
        adapter->Release();
        if (SUCCEEDED(status) && !(desc.Flags & (DXGI_ADAPTER_FLAG_SOFTWARE | DXGI_ADAPTER_FLAG_REMOTE))) {
            result.push_back({
                desc.Description, static_cast<Vendor>(desc.VendorId),
                desc.DedicatedVideoMemory / bytes_per_gib, desc.SharedSystemMemory / bytes_per_gib,
            });
        }
    }
    factory->Release();
    return result;
}

std::vector<Adapter> nvml_adapters() {
    HMODULE library = LoadLibraryExW(L"nvml.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!library) {
        std::array<wchar_t, MAX_PATH> programs{};
        const auto size = GetEnvironmentVariableW(L"ProgramFiles", programs.data(), programs.size());
        if (size && size < programs.size()) {
            const auto path = std::wstring(programs.data()) + LR"(\NVIDIA Corporation\NVSMI\nvml.dll)";
            library = LoadLibraryExW(path.c_str(), nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
        }
    }
    if (!library) {
        return {};
    }

    struct Library {
        HMODULE handle;
        ~Library() { FreeLibrary(handle); }
    } loaded{library};
    return scan_nvml([library](const char* name) { return GetProcAddress(library, name); });
}

void merge_nvidia_adapters(std::vector<Adapter>& adapters) {
    const auto dxgi_count = adapters.size();
    std::vector<bool> matched(dxgi_count);
    for (auto& driver : nvml_adapters()) {
        std::size_t index = 0;
        for (; index < dxgi_count; ++index) {
            if (!matched[index] && adapters[index].vendor == Vendor::nvidia
                && CompareStringOrdinal(adapters[index].name.c_str(), -1, driver.name.c_str(), -1, TRUE) == CSTR_EQUAL) {
                break;
            }
        }
        if (index == dxgi_count) {
            adapters.push_back(std::move(driver));
            continue;
        }
        auto& current = adapters[index];
        matched[index] = true;
        current.cuda_major = driver.cuda_major;
        if (driver.dedicated_gib > 0) {
            current.dedicated_gib = driver.dedicated_gib;
        }
    }
}

} // namespace

Hardware scan_hardware() {
    MEMORYSTATUSEX memory{};
    memory.dwLength = sizeof(memory);
    if (!GlobalMemoryStatusEx(&memory)) {
        throw std::runtime_error("Windows did not report system memory.");
    }

    Hardware hardware;
    hardware.cpu = cpu_name();
    hardware.physical_cores = physical_cores();
    hardware.ram_gib = memory.ullTotalPhys / bytes_per_gib;
    hardware.avx2 = IsProcessorFeaturePresent(avx2_feature);
    hardware.cpu_compatible = IsProcessorFeaturePresent(sse42_feature) || IsProcessorFeaturePresent(arm64_feature);
    hardware.adapters = dxgi_adapters();
    merge_nvidia_adapters(hardware.adapters);
    return hardware;
}

} // namespace saias
