# Security

Report vulnerabilities privately through GitHub's "Report a vulnerability" button on this
repository, not in a public issue.

## How SAIAS limits exposure

- The hub and every model server listen on `127.0.0.1` only. `SAIAS_HUB_HOST` can open the hub to
  the network, and then SAIAS refuses to start without `SAIAS_API_KEY`; requests that reach a model
  or a tool must carry it (`Authorization: Bearer <key>` or `x-api-key`).
- The hub's stop endpoint requires a custom header, which web pages cannot send to it.
- The web search tools refuse local and private network addresses unless
  `SAIAS_WEB_ALLOW_PRIVATE=1` is set.
- Every runtime, model and Node.js download is verified against a sha256 before use.
- Code written by models during `saias eval` runs in a separate Node.js process with the
  permission model and a time limit. This limits accidents; it is not a sandbox against hostile
  code, so only evaluate models you trust on machines you can rebuild.
