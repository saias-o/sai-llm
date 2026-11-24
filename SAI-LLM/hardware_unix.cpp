#include "advisor.hpp"

#include <cwchar>
#include <stdexcept>

#if defined(__linux__)
#include "nvidia_inventory.hpp"
#include <dlfcn.h>
#include <filesystem>
#include <fstream>
#include <set>
#include <sstream>
#include <utility>
#elif defined(__APPLE__)
#include <cstdint>
#include <sys/sysctl.h>
#endif

namespace sai {
namespace {

constexpr double bytes_per_gib = 1024.0 * 1024.0 * 1024.0;

#if defined(__linux__) || defined(__APPLE__)
std::wstring wide(const std::string& value) {
    const char* input = value.c_str();
    std::mbstate_t state{};
    std::wstring converted(value.size(), L'\0');
    const auto count = std::mbsrtowcs(converted.data(), &input, converted.size(), &state);
    if (count == static_cast<std::size_t>(-1)) {
        return std::wstring(value.begin(), value.end());
    }
    converted.resize(count);
    return converted;
}
#endif

#if defined(__linux__)
namespace fs = std::filesystem;

template <typename Number>
Number number_file(const fs::path& path, std::ios_base& (*base)(std::ios_base&) = std::dec) {
    Number value{};
    std::ifstream(path) >> base >> value;
    return value;
}

std::wstring pci_name(unsigned vendor, unsigned device) {
    std::ifstream ids("/usr/share/hwdata/pci.ids");
    if (!ids) {
        ids.open("/usr/share/misc/pci.ids");
    }
    bool matching_vendor = false;
    std::string line;
    while (std::getline(ids, line)) {
        if (line.empty() || line[0] == '#') {
            continue;
        }
        if (line[0] != '\t') {
            if (matching_vendor) {
                break;
            }
            unsigned id = 0;
            matching_vendor = bool(std::istringstream(line) >> std::hex >> id) && id == vendor;
        } else if (matching_vendor && line.size() > 5 && line[1] != '\t') {
            std::istringstream entry(line);
            unsigned id = 0;
            if (entry >> std::hex >> id && id == device) {
                std::string name;
                std::getline(entry >> std::ws, name);
                return wide(name);
            }
        }
    }
    switch (static_cast<Vendor>(vendor)) {
        case Vendor::amd: return L"AMD adapter";
        case Vendor::intel: return L"Intel adapter";
        case Vendor::nvidia: return L"NVIDIA adapter";
        default: return L"Graphics adapter";
    }
}

std::vector<Adapter> linux_adapters() {
    std::vector<Adapter> adapters;
    if (auto* handle = dlopen("libnvidia-ml.so.1", RTLD_NOW | RTLD_LOCAL)) {
        struct Library {
            void* handle;
            ~Library() { dlclose(handle); }
        } library{handle};
        adapters = scan_nvml([handle](const char* name) { return dlsym(handle, name); });
    }
    const bool nvidia_found = !adapters.empty();
    std::error_code error;
    for (fs::directory_iterator card("/sys/class/drm", error), end; !error && card != end; card.increment(error)) {
        const auto name = card->path().filename().string();
        if (!name.starts_with("card") || name.size() == 4 || name.find_first_not_of("0123456789", 4) != std::string::npos) {
            continue;
        }
        const auto path = card->path() / "device";
        const auto id = number_file<unsigned>(path / "vendor", std::hex);
        if (!id || (nvidia_found && id == static_cast<unsigned>(Vendor::nvidia))) {
            continue;
        }
        const auto device = number_file<unsigned>(path / "device", std::hex);
        const auto bytes = number_file<unsigned long long>(path / "mem_info_vram_total");
        adapters.push_back({pci_name(id, device), static_cast<Vendor>(id), bytes / bytes_per_gib});
    }
    return adapters;
}

Hardware scan_linux() {
    Hardware hardware;
    hardware.platform = Platform::linux_pc;
    hardware.cpu = L"Processor name unavailable";
    std::ifstream cpuinfo("/proc/cpuinfo");
    std::string line;
    while (std::getline(cpuinfo, line) && !line.empty()) {
        const auto colon = line.find(':');
        if (colon == std::string::npos) {
            continue;
        }
        const auto key = line.substr(0, line.find_last_not_of(" \t", colon - 1) + 1);
        const auto start = line.find_first_not_of(" \t", colon + 1);
        const auto value = start == std::string::npos ? std::string{} : line.substr(start);
        if (key == "model name" || key == "Processor") {
            hardware.cpu = wide(value);
        } else if (key == "flags") {
            const auto surrounded = " " + value + " ";
            hardware.avx2 = surrounded.find(" avx2 ") != std::string::npos;
            hardware.cpu_compatible = surrounded.find(" sse4_2 ") != std::string::npos;
        }
    }
#if defined(__aarch64__)
    hardware.cpu_compatible = true;
#endif

    std::set<std::pair<int, int>> cores;
    std::error_code error;
    const fs::path root("/sys/devices/system/cpu");
    for (fs::directory_iterator node(root, error), end; !error && node != end; node.increment(error)) {
        const auto name = node->path().filename().string();
        if (!name.starts_with("cpu") || name.size() == 3 || name.find_first_not_of("0123456789", 3) != std::string::npos) {
            continue;
        }
        const auto topology = node->path() / "topology";
        int package = 0, core = 0;
        if (std::ifstream(topology / "physical_package_id") >> package
            && std::ifstream(topology / "core_id") >> core) {
            cores.emplace(package, core);
        }
    }
    hardware.physical_cores = static_cast<unsigned>(cores.size());

    std::ifstream memory("/proc/meminfo");
    while (std::getline(memory, line)) {
        std::istringstream entry(line);
        std::string key;
        unsigned long long kib = 0;
        if (entry >> key >> kib && key == "MemTotal:") {
            hardware.ram_gib = kib * 1024.0 / bytes_per_gib;
            break;
        }
    }
    if (hardware.ram_gib <= 0) {
        throw std::runtime_error("Linux did not report system memory.");
    }
    hardware.adapters = linux_adapters();
    return hardware;
}
#elif defined(__APPLE__)
template <typename Number>
Number sysctl_number(const char* key) {
    Number value{};
    std::size_t size = sizeof(value);
    return sysctlbyname(key, &value, &size, nullptr, 0) == 0 ? value : Number{};
}

Hardware scan_mac() {
    Hardware hardware;
    hardware.platform = Platform::mac;
    hardware.apple_silicon = sysctl_number<int>("hw.optional.arm64") == 1;
#if defined(__aarch64__) || defined(__arm64__)
    hardware.apple_silicon = true;
#endif
    hardware.avx2 = sysctl_number<int>("hw.optional.avx2_0") == 1;
    hardware.cpu_compatible = hardware.apple_silicon || hardware.avx2;
    hardware.physical_cores = sysctl_number<unsigned>("hw.physicalcpu");
    hardware.ram_gib = sysctl_number<std::uint64_t>("hw.memsize") / bytes_per_gib;
    if (hardware.ram_gib <= 0) {
        throw std::runtime_error("macOS did not report system memory.");
    }
    char name[256]{};
    std::size_t size = sizeof(name);
    if (sysctlbyname("machdep.cpu.brand_string", name, &size, nullptr, 0) == 0) {
        hardware.cpu = wide(name);
    } else {
        hardware.cpu = hardware.apple_silicon ? L"Apple silicon" : L"Processor name unavailable";
    }
    if (hardware.apple_silicon) {
        hardware.adapters.push_back({hardware.cpu + L" integrated GPU", Vendor::apple, 0, hardware.ram_gib});
    }
    return hardware;
}
#endif

} // namespace

Hardware scan_hardware() {
#if defined(__linux__)
    return scan_linux();
#elif defined(__APPLE__)
    return scan_mac();
#else
    throw std::runtime_error("Hardware inventory is unavailable on this operating system.");
#endif
}

} // namespace sai
