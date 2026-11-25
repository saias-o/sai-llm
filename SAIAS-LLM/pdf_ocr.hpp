#pragma once

#include <stop_token>
#include <string>

namespace saias::chat {

std::wstring recognize_pdf_page(const unsigned char* pixels, int width, int height, int stride, std::stop_token stop);

} // namespace saias::chat
