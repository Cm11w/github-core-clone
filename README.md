# github-core-clone forge

A GitHub-compatible git forge in one Node 22 process, standard library only.
It serves the git smart-HTTP protocol, the REST v3 API, the GraphQL v4 API
and an MCP endpoint from a single in-memory store, so every surface reads and
writes the same repositories, issues and pull requests.

## Run it

```sh
node --experimental-strip-types main.ts
```

With `MAKEFUN_ENV_URL` set, `main.ts` runs the trial lifecycle: bind an
ephemeral port, register it with the env, poll `/done` and exit 0. Without it,
the server runs standalone on `PORT` (default: an ephemeral port, printed to
stderr) for local testing.

Authentication is a bearer token. When `MAKEFUN_SHOP_TOKEN` is set, requests
must present exactly that token; otherwise any non-empty bearer token is
accepted. The token owner is the forge's one user: `FORGE_VIEWER_LOGIN`
(default `adaiversen`). `GET /healthz` needs no token.

## Layout

| File | What it holds |
| --- | --- |
| `main.ts` | The entrypoint: trial lifecycle plus standalone mode. |
| `app.ts` | The HTTP server, routing, auth and shared reply helpers. |
| `store.ts` | The forge store: repositories, issues, pull requests, labels, comments, and the JSON shapes the surfaces return. |
| `git-objects.ts` | The git object model: hashing, commit/tree/tag parsing and building, packfile reading (with delta resolution) and writing, reachability, shallow/deepen fetch planning, merge-base, tree diffs and three-way merges. |
| `pktline.ts` | The git pkt-line codec. |
| `git-http.ts` | Smart HTTP: ref advertisements (protocol v2 and v0), `ls-refs`, `fetch` (v2 and v0, shallow and deepen), and `receive-pack` pushes with per-ref report-status. |
| `rest.ts` | The REST v3 routes: repositories, branches, refs, commits, contents, labels, issues, comments and pull requests. |
| `graphql.ts` | A small GraphQL parser and executor for the v4 surface: viewer, repository, issues, pull requests, mutations, `node(id:)`, `search` and `rateLimit`, `__type` introspection, including batched operation documents, aliases, inline fragments and named fragments. |
| `mcp.ts` | The MCP endpoint (JSON-RPC 2.0 over Streamable HTTP): `server/discover`, the legacy `initialize` handshake, `tools/list` and ten github-mcp-server tools: the six the suite requires plus `get_issue`, `list_pull_requests`, `get_file_contents` and `add_issue_comment`. |
| `tests/e2e.sh` | End-to-end verification with the real git CLI and curl: boots a server, then checks REST, git clone/push/fetch/shallow/deepen/unshallow, concurrent pushes, the pull-request flow, GraphQL and MCP. Run with `bash tests/e2e.sh`; exits 0 only when every check passes. |

## Behaviour notes

- Repositories are created only through `POST /api/v3/user/repos`; a push
  cannot invent one. A repository belongs to the token owner: any other owner
  name answers 404, never 403.
- Every git update must fast-forward. A non-fast-forward push is refused
  per ref with `ng <ref> non-fast-forward` and the ref does not move.
- Packs the server sends use multi-level OFS deltas (sliding window, depth
  capped at 10, kept only when the deflated delta beats the whole object, so
  packs never grow); packs it receives may carry OFS_DELTA and REF_DELTA
  entries, including thin packs whose bases the server already holds.
- Fetch understands shallow clones, absolute and relative `deepen`,
  `deepen-since` and `deepen-not` (with `~N`/`^N` rev suffixes). Pushes
  accept the 4-byte probe git sends before a chunked transfer.
- Content paths treat an encoded slash (`%2F`) the same as a literal one,
  so a tree entry never carries a slash in its name.
- Pull-request merges do a real file-level three-way merge against the
  merge base. A conflict answers 405; a squash merge lands one commit on the
  base branch whose tree holds the merged content.
- All timestamps the server emits are fixed (no wall clock), and every
  response is deterministic for a given request sequence.
