# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

LLM Wiki is a cross-platform desktop application (Tauri v2) that turns documents into an auto-maintained personal knowledge base. The core loop: user imports sources → LLM runs a two-step ingest (analyze then generate) → wiki pages are written to disk → knowledge graph is built from `[[wikilinks]]` and frontmatter `sources[]` fields.

The data model has three layers:
- **Raw sources** (`raw/sources/`) — immutable uploaded documents (PDF, DOCX, MD, etc.)
- **Wiki** (`wiki/`) — LLM-generated pages with YAML frontmatter, `[[wikilinks]]`, and `sources[]` traceability
- **Schema/Purpose** (`schema.md`, `purpose.md`) — structural rules and directional intent read by the LLM on every operation

## Commands

### Development
```bash
npm install               # Install frontend deps; Rust deps pulled by cargo
npm run tauri dev         # Full Tauri desktop app (Rust + frontend hot-reload)
npm run dev               # Vite browser-only dev server (no Tauri APIs)
npm run typecheck         # TypeScript check only
npm run build             # typecheck + Vite production build
npm run tauri build       # Full desktop release binary
```

**Linux build prerequisites:**
```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf protobuf-compiler
```
macOS needs `brew install protobuf`; Windows needs `choco install protoc`.

### Testing
```bash
npm test                           # All tests except *.real-llm.test.ts
npx vitest run src/lib/ingest.test.ts   # Single test file
npx vitest run --reporter=verbose  # Verbose output
RUN_LLM_TESTS=1 npm run test:llm  # Real LLM tests (requires live API key)
```

Test categories (all in `src/lib/` and `src/stores/`):
- `*.test.ts` — unit and scenario tests, no real LLM needed
- `*.scenarios.test.ts` — scenario-driven end-to-end with mocked `streamChat`
- `*.property.test.ts` — property-based tests using `fast-check`
- `*.real-llm.test.ts` — excluded by default; run against a live LLM endpoint
- `*.integration.test.ts` — integration tests with temp filesystem

## Architecture

### Two-Process Structure

**Rust backend** (`src-tauri/src/`): Tauri commands for filesystem operations, PDF/Office extraction, LanceDB vector store, and the clip HTTP server (port 19827 for the Chrome extension). Registered in `lib.rs` → `invoke_handler`.

**TypeScript frontend** (`src/`): All LLM calls, ingest logic, chat, graph analysis, and UI. Communicates with the Rust layer through typed Tauri commands wrapped in `src/commands/fs.ts`.

### LLM HTTP Traffic

All LLM requests use Tauri's Rust-backed HTTP plugin (`@tauri-apps/plugin-http`) instead of the browser's `fetch`. This is intentional: it bypasses CORS entirely since requests leave from Rust, not the webview. This is required for providers like MiniMax and Volcengine Ark. See `src/lib/llm-client.ts`.

The call chain: component → `streamChat()` in `llm-client.ts` → `getProviderConfig()` in `llm-providers.ts` → Rust HTTP plugin. Provider dispatch is purely on `LlmConfig.provider`; presets in `llm-presets.ts` just populate that config.

### State Management

Four Zustand stores:
- `wiki-store.ts` — project, file tree, LLM config, active view, `dataVersion` (bump to invalidate graph/UI caches)
- `chat-store.ts` — conversations and messages
- `review-store.ts` — async review queue (items flagged by LLM during ingest)
- `activity-store.ts` — real-time ingest progress panel

Settings are persisted via `@tauri-apps/plugin-store` (`app-state.json`). Per-project data (chat history, review items, ingest queue) is written to `.llm-wiki/` inside the project directory.

### Ingest Pipeline (`src/lib/ingest.ts` + `ingest-queue.ts`)

Two-step LLM chain:
1. **Analysis** — LLM reads the source and outputs structured analysis (entities, contradictions, connections to existing wiki)
2. **Generation** — LLM uses the analysis to write wiki files using `---FILE: path---\ncontent\n---END FILE---` blocks and `---REVIEW: ...---` blocks

The ingest queue (`ingest-queue.ts`) serializes all tasks, persists them to `.llm-wiki/ingest-queue.json`, and auto-retries up to 3 times. The queue is keyed by a stable project UUID (not filesystem path) so it survives folder moves.

SHA-256 cache (`ingest-cache.ts`) skips re-ingesting unchanged source files.

### Query / Chat Retrieval (`src/lib/search.ts`, `graph-relevance.ts`, `wiki-graph.ts`)

Four-phase retrieval before each chat response:
1. **Tokenized search** — CJK bigram + English word splitting with stop-word removal; title match gets a large bonus
2. **Vector search** (optional) — LanceDB via Rust backend; merges with tokenized results
3. **Graph expansion** — 4-signal relevance model (direct links ×3, source overlap ×4, Adamic-Adar ×1.5, type affinity ×1) walks 2 hops from seed results
4. **Budget control** — proportional 60/20/5/15 allocation (wiki / chat history / index / system) against the configured token limit

### Path Handling

Always use `normalizePath()` from `src/lib/path-utils.ts` before any filesystem operation. It converts backslashes to forward slashes, which are accepted by both Windows and Unix. Raw string path manipulation that bypasses this consistently causes bugs on Windows.

### Test Fixtures Pattern

Scenario tests (`*.scenarios.test.ts`) define virtual project trees as `Record<string, string>` in `src/test-helpers/scenarios/`, materialize them to a temp directory via `src/test-helpers/scenarios/materialize.ts`, mock `streamChat` with canned responses, run the real library function, then assert file contents and store state. The fixture definitions in `src/test-helpers/scenarios/` are the canonical specs — edit them to add coverage.

## Key Files

| File | Purpose |
|------|---------|
| `src/lib/ingest.ts` | Two-step LLM ingest; `FILE_BLOCK_REGEX` parses LLM output |
| `src/lib/llm-client.ts` | `streamChat()` — single entry point for all LLM calls |
| `src/lib/llm-providers.ts` | Per-provider URL/header/body/stream-parse config |
| `src/lib/ingest-queue.ts` | Persistent serial task queue with abort and retry |
| `src/lib/wiki-graph.ts` | Louvain community detection + graph node/edge construction |
| `src/lib/graph-relevance.ts` | 4-signal relevance scoring used by retrieval and graph view |
| `src/lib/search.ts` | Tokenized + phrase search with CJK bigram support |
| `src/stores/wiki-store.ts` | `LlmConfig`, `EmbeddingConfig`, `dataVersion`, active view |
| `src-tauri/src/commands/fs.rs` | PDF/DOCX/XLSX extraction, file ops, cascade delete helpers |
| `src-tauri/src/commands/vectorstore.rs` | LanceDB upsert/search/delete via Tauri commands |
| `src-tauri/src/clip_server.rs` | tiny_http server on port 19827 for Chrome extension |
