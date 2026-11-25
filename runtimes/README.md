# SAIAS runtimes

The catalog points each profile at a llama.cpp build. The published b12631 builds miss three chat
parser fixes that tool calls need, especially with Inkling 2 Mini (`saias-pro`). The fixes are
merged upstream after b12631 and are kept here as patches:

| Patch | Upstream change |
| --- | --- |
| `0001-chat-token-aware-parsing-29307.patch` | chat: implement token aware parsing (#29307) |
| `0002-chat-lazy-grammar-bare-json-tool-calls-32497.patch` | chat: trigger lazy grammar on bare JSON tool calls (#32497) |
| `0003-chat-improve-inkling-parser-32833.patch` | chat: improve inkling parser/grammar (#32833) |

They apply in this order to the `b12631-mix-acc0843` source, without the `docs/` changes the
source archive does not ship (`git apply --exclude=docs/*`).

## Building

`scripts\Build-Runtime.ps1` reads [build.json](build.json), builds the patched server libraries
for the CPU, and replaces those files in the official CUDA and Vulkan archives listed in the
catalog. Only the server and common libraries change; the GPU backends (`ggml-cuda.dll`,
`ggml-vulkan.dll`) are the official ones. The script writes the archives and their catalog entries
to `dist\runtimes`; publish the archives at the `release` URL, add the entries to
`catalog\catalog.json`, point the variants at them and increase the catalog version.

When an upstream llama.cpp release includes these fixes, switch the catalog to it and delete the
patches.

The patches come from the llama.cpp project and are distributed under its MIT license.
