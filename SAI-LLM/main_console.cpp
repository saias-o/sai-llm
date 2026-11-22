#include "advisor.hpp"

#include <clocale>
#include <exception>
#include <iostream>

namespace {

void print_choice(const sai::Choice& choice) {
    std::wcout << choice.profile->name << L"  |  " << choice.profile->context << L" tokens\n";
    if (!choice.mode.empty()) {
        std::wcout << L"    " << choice.mode << L". ";
    } else {
        std::wcout << L"    ";
    }
    std::wcout << choice.reason << L'\n';
}

} // namespace

int main() {
    std::setlocale(LC_ALL, "");
    try {
        const auto pc = sai::scan_hardware();
        const auto advice = sai::recommend(pc);
        std::wcout << L"SAI-LLM Model Advisor\n"
                   << L"CPU: " << pc.cpu << L"  |  Physical cores: " << pc.physical_cores << L'\n'
                   << L"Usable system RAM: " << sai::gib(pc.ram_gib) << L'\n';
        for (const auto& gpu : pc.adapters) {
            std::wcout << L"GPU: " << gpu.name;
            if (gpu.dedicated_gib > 0) {
                std::wcout << L"  |  " << sai::gib(gpu.dedicated_gib) << L" dedicated";
            }
            if (gpu.shared_gib > 0) {
                std::wcout << L"  |  " << sai::gib(gpu.shared_gib) << L" shared";
            }
            std::wcout << L'\n';
        }
        std::wcout << L"\nMost capable: ";
        if (advice.most_capable) {
            print_choice(*advice.most_capable);
        } else {
            std::wcout << L"No full preset fits the detected hardware.\n";
        }
        std::wcout << L"Everyday pick: ";
        print_choice(advice.everyday);
        const auto speed = advice.everyday.target_plausible ? L"plausible" : L"uncertain";
        std::wcout << L"    20 tokens/s is " << speed << L" for a short prompt with the model already loaded.\n";
    } catch (const std::exception& error) {
        std::cerr << "Hardware scan failed: " << error.what() << '\n';
        return 1;
    }
    return 0;
}
