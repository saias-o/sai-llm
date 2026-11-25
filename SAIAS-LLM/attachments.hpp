#pragma once

#include "chat.hpp"

#include <stop_token>

namespace saias::chat {

inline constexpr std::size_t draft_attachment_limit = 6;

struct AttachmentImport {
    Attachment attachment;
    std::wstring error;
};

AttachmentImport import_attachment(const std::filesystem::path& path, const Model& model, std::stop_token stop);

} // namespace saias::chat
