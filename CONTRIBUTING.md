# Contributing to SAIAS

Thanks for helping. SAIAS has one promise: users never have to choose, download or configure a
local model themselves. Changes are judged by whether they keep that promise.

## Project layout

| Path | What it is |
| --- | --- |
| `catalog/catalog.json` | Runtimes, models and profiles. Most model changes are catalog changes. |
| `src/` | The `saias` command line and the hub (Node.js 22, no dependencies). |
| `src/eval/`, `src/bench.js` | Agent evaluation suite and speed benchmark. |
| `mcp/saias-web.js` | Web search MCP server. |
| `SAIAS-LLM/` | The Windows app (C++20, Direct2D). |
| `runtimes/` | Patches and the recipe for SAIAS llama.cpp builds. |
| `installer/` | Inno Setup script for the Windows installer. |
| `test/` | `npm test`: runs without loading any model. |

## Proposing a model

Open a "Model proposal" issue, then a pull request that changes `catalog/catalog.json`:

1. Pin every URL to a commit or release, and give each file's size and sha256 (Hugging Face lists
   them at `https://huggingface.co/api/models/<repo>/tree/<revision>`, GitHub in its releases API).
2. Include the license, and a `note` when it restricts use.
3. Run `saias eval --endpoint <server> --model <name>` on the candidate and on the current profile,
   and attach both reports. A candidate replaces a profile's model only when it does better on
   the `tools` and `code` suites without being much slower (`saias bench`).
4. Increase the catalog `version`.

## Code

- Run `npm test` before sending a change. New logic comes with a test that needs no model.
- No runtime dependencies in `src/`: Node.js built-ins only.
- Keep model knowledge in the catalog. Code must not test for a model or profile name.
- Write everything in English: code, comments, messages and documentation.
- Commit messages: an imperative subject under 72 characters, then why the change is needed.

## Windows app

Build it with CMake (see README). It must keep working when SAIAS is not installed: it then shows
how to install instead of failing.
