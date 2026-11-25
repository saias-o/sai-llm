#include "advisor.hpp"

#include <algorithm>
#include <iomanip>
#include <regex>
#include <sstream>
#include <utility>

namespace sai {
namespace {

// Estimates include engine and context overhead plus host headroom.
// Dedicated VRAM is considered per adapter, since most engines do not pool it.
constexpr Profile pro_profile{L"sai-pro", L"500,000", 0, 10, 32};
constexpr Profile smart_profile{L"sai-smart", L"200,000", 0, 12, 16};
constexpr Profile flash_profile{L"sai-flash", L"262,144", 6, 4, 5};
constexpr const Profile* profiles[]{&pro_profile, &smart_profile, &flash_profile};
constexpr auto ignore_case = std::regex_constants::icase;

bool datacenter_cuda_gpu(const Adapter& card) {
    static const std::wregex families(LR"(\b(?:G?B200|G?B300|H200)\b|\bRTX PRO 6000.*Blackwell\b)", ignore_case);
    return card.vendor == Vendor::nvidia && std::regex_search(card.name, families);
}

bool supports_offload(const Adapter& card) {
    static const std::wregex nvidia(LR"(\b(?:RTX|GTX\s+16\d\d)\b)", ignore_case);
    static const std::wregex amd(LR"(\b(?:RX\s*[5-9]\d{3}[MS]?|W[5-9]\d{3}|MI[23]\d\dX?)\b)", ignore_case);
    static const std::wregex intel(LR"(\bArc\b)", ignore_case);
    switch (card.vendor) {
        case Vendor::nvidia:
            return card.cuda_major >= 7 || std::regex_search(card.name, nvidia) || datacenter_cuda_gpu(card);
        case Vendor::amd:
            return std::regex_search(card.name, amd);
        case Vendor::intel:
            return std::regex_search(card.name, intel);
        default:
            return false;
    }
}

bool faster_gpu(const Adapter& card) {
    static const std::wregex nvidia(LR"(\bRTX\s+(?:[345]\d{3}|A[2-9]\d{3}|PRO)\b)", ignore_case);
    static const std::wregex amd(LR"(\b(?:RX\s*|W)([6-9]\d{3})[MS]?\b)", ignore_case);
    if (card.vendor == Vendor::nvidia) {
        return card.cuda_major >= 8 || datacenter_cuda_gpu(card) || std::regex_search(card.name, nvidia);
    }
    if (card.vendor == Vendor::amd) {
        std::wsmatch model;
        return std::regex_search(card.name, model, amd) && std::stoi(model[1].str()) >= 6700;
    }
    return false;
}

bool known_hybrid_flash(const Hardware& pc) {
    static const std::wregex ryzen(L"5700U", ignore_case);
    const auto mx450 = [](const Adapter& card) {
        static const std::wregex model(L"MX450", ignore_case);
        return card.dedicated_gib >= 1.9 && std::regex_search(card.name, model);
    };
    const auto radeon = [](const Adapter& card) {
        return card.vendor == Vendor::amd && card.shared_gib >= 2 && card.dedicated_gib < 2;
    };
    // This Windows configuration has a short-prompt reference measurement.
    return pc.platform == Platform::windows && pc.ram_gib >= 7 && std::regex_search(pc.cpu, ryzen)
        && std::any_of(pc.adapters.begin(), pc.adapters.end(), mx450)
        && std::any_of(pc.adapters.begin(), pc.adapters.end(), radeon);
}

bool faster_flash_cpu(const Hardware& pc) {
    static const std::wregex families(
        LR"(Ryzen\s+(?:(?:[579]\s+[789]\d{3})|AI)|Core\s+(?:Ultra|i[579]-1[234]\d{3}))", ignore_case);
    return pc.avx2 && pc.physical_cores >= 8 && std::regex_search(pc.cpu, families);
}

std::optional<Choice> evaluate(const Profile& profile, const Hardware& pc) {
    const bool pro = &profile == &pro_profile;
    const bool smart = &profile == &smart_profile;
    const bool flash = &profile == &flash_profile;
    const Adapter* best = nullptr;
    bool best_fast = false;

    if (pc.ram_gib >= profile.gpu_host_ram_gib) {
        for (const auto& card : pc.adapters) {
            if (card.dedicated_gib < profile.gpu_vram_gib - 0.125
                || !supports_offload(card) || ((pro || smart) && card.vendor != Vendor::nvidia)) {
                continue;
            }
            const bool fast = faster_gpu(card);
            if (!best || (fast && !best_fast) || (fast == best_fast && card.dedicated_gib > best->dedicated_gib)) {
                best = &card;
                best_fast = fast;
            }
        }
    }
    if (best) {
        return Choice{
            &profile, smart ? L"Bonsai 2 27B (CUDA)" : pro ? L"llama.cpp CUDA offload" : L"llama.cpp GPU offload",
            best->name + L" has " + gib(best->dedicated_gib) + L" of dedicated VRAM.",
            !pro && (flash || best_fast),
        };
    }
    if (flash && known_hybrid_flash(pc)) {
        return Choice{
            &profile, L"Dual-GPU Vulkan",
            L"A matching Ryzen 7 5700U, Radeon and MX450 setup reached the short-prompt target.",
            true,
        };
    }
    if (profile.cpu_ram_gib > 0 && pc.cpu_compatible && pc.ram_gib >= profile.cpu_ram_gib) {
        const bool metal = flash && pc.apple_silicon;
        return Choice{
            &profile, metal ? L"Metal on unified memory" : L"CPU",
            gib(pc.ram_gib) + L" of system memory clears this profile’s context threshold.",
            flash && (metal || faster_flash_cpu(pc)),
        };
    }
    return std::nullopt;
}

} // namespace

Advice recommend(const Hardware& hardware) {
    Advice result{std::nullopt, {&flash_profile, L"", L"There is insufficient hardware evidence for this preset’s full context."}};
    for (const Profile* profile : profiles) {
        auto candidate = evaluate(*profile, hardware);
        if (!candidate) {
            continue;
        }
        if (!result.most_capable) {
            result.most_capable = candidate;
        }
        if (candidate->target_plausible) {
            result.everyday = std::move(*candidate);
            break;
        }
        if (profile == &flash_profile) {
            result.everyday = std::move(*candidate);
        }
    }
    return result;
}

std::wstring gib(double amount) {
    std::wostringstream text;
    text << std::fixed << std::setprecision(1) << amount << L" GiB";
    return text.str();
}

} // namespace sai
