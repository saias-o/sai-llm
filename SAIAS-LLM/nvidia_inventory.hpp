#pragma once

#include "hardware.hpp"

#include <array>
#include <utility>

namespace saias {

// NVML is optional. Only public, read-only inventory calls are used.
template <typename SymbolAddress>
std::vector<Adapter> scan_nvml(SymbolAddress symbol) {
    using Device = void*;
    struct Memory { unsigned long long total, free, used; };
    const auto init = reinterpret_cast<int (*)()>(symbol("nvmlInit_v2"));
    const auto shutdown = reinterpret_cast<int (*)()>(symbol("nvmlShutdown"));
    const auto count = reinterpret_cast<int (*)(unsigned*)>(symbol("nvmlDeviceGetCount_v2"));
    const auto get = reinterpret_cast<int (*)(unsigned, Device*)>(symbol("nvmlDeviceGetHandleByIndex_v2"));
    const auto name = reinterpret_cast<int (*)(Device, char*, unsigned)>(symbol("nvmlDeviceGetName"));
    const auto memory = reinterpret_cast<int (*)(Device, Memory*)>(symbol("nvmlDeviceGetMemoryInfo"));
    const auto cuda = reinterpret_cast<int (*)(Device, int*, int*)>(symbol("nvmlDeviceGetCudaComputeCapability"));

    std::vector<Adapter> result;
    if (!init || !shutdown || !count || !get || !name || init() != 0) {
        return result;
    }

    struct Session {
        int (*shutdown)();
        ~Session() { shutdown(); }
    } session{shutdown};
    unsigned devices = 0;
    if (count(&devices) != 0) {
        return result;
    }
    for (unsigned index = 0; index < devices; ++index) {
        Device device = nullptr;
        std::array<char, 128> label{};
        if (get(index, &device) != 0 || name(device, label.data(), label.size()) != 0) {
            continue;
        }
        std::wstring description;
        for (char character : label) {
            if (!character) {
                break;
            }
            description.push_back(static_cast<unsigned char>(character));
        }
        Adapter adapter{std::move(description), Vendor::nvidia};
        Memory vram{};
        if (memory && memory(device, &vram) == 0) {
            adapter.dedicated_gib = vram.total / (1024.0 * 1024.0 * 1024.0);
        }
        int minor = 0;
        if (cuda) {
            cuda(device, &adapter.cuda_major, &minor);
        }
        result.push_back(std::move(adapter));
    }
    return result;
}

} // namespace saias
