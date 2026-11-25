#pragma once

#include <string>
#include <string_view>
#include <vector>

namespace saias {

enum class Vendor : unsigned { other = 0, amd = 0x1002, nvidia = 0x10de, intel = 0x8086, apple = 0x106b };
enum class Platform { windows, linux_pc, mac };

struct Adapter {
    std::wstring name;
    Vendor vendor = Vendor::other;
    double dedicated_gib = 0;
    double shared_gib = 0;
    int cuda_major = 0;
};

struct Hardware {
    Platform platform = Platform::windows;
    std::wstring cpu;
    unsigned physical_cores = 0;
    double ram_gib = 0;
    bool avx2 = false;
    bool cpu_compatible = false;
    bool apple_silicon = false;
    std::vector<Adapter> adapters;
};

// Hardware inventory shown by the SAIAS app. Profile choices come from the catalog (saias recommend).
Hardware scan_hardware();
std::wstring gib(double amount);

} // namespace saias
