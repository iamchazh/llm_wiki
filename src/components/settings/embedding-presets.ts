/**
 * Curated embedding-provider presets — the embedding-side analogue of
 * `llm-presets.ts`.
 *
 * Selecting a preset pre-fills the underlying `EmbeddingConfig`
 * fields so users don't have to remember endpoint URLs per vendor.
 * The fetch layer in `src/lib/embedding.ts` already speaks the
 * OpenAI-compatible `/v1/embeddings` wire, so any server that
 * exposes it (llama.cpp, Ollama, LM Studio, vLLM, OpenAI, Jina,
 * Voyage, Cohere) Just Works once the user picks a preset and
 * supplies a model + (optional) API key.
 */

export interface EmbeddingPreset {
  /** Stable id used as the row key. */
  id: string
  /** Display label in the row. */
  label: string
  /** Short subtitle shown under the label. */
  hint?: string
  /** Suggested base URL with the embeddings path included. */
  defaultEndpoint?: string
  /**
   * Curated list of model ids the UI shows as clickable chips above
   * the Model input. The user can still type a custom value — the
   * input stays free-form. An empty/missing list means "no
   * suggestions, type freely" (e.g. local servers where the model
   * set is whatever the user pulled).
   */
  suggestedModels?: string[]
  /** Suggested per-chunk char budget hint shown in the UI. Servers
   *  with tiny n_ctx (llama.cpp default 512) want smaller chunks. */
  defaultMaxChunkChars?: number
}

export const EMBEDDING_PRESETS: EmbeddingPreset[] = [
  {
    id: "llamacpp-local",
    label: "llama.cpp (Local)",
    hint: "Self-hosted llama.cpp embedding server",
    defaultEndpoint: "http://127.0.0.1:8080/v1/embeddings",
    suggestedModels: ["nomic-embed-text-v1.5", "bge-small-en-v1.5"],
    // llama.cpp's default n_ctx is 512 tokens (~2K chars). Even with
    // -c 8192 most users haven't tuned it, so keep chunks small.
    defaultMaxChunkChars: 1000,
  },
  {
    id: "ollama-local",
    label: "Ollama (Local)",
    hint: "localhost:11434 — uses the OpenAI-compat endpoint",
    defaultEndpoint: "http://localhost:11434/v1/embeddings",
    suggestedModels: ["nomic-embed-text", "mxbai-embed-large", "bge-m3"],
    defaultMaxChunkChars: 1500,
  },
  {
    id: "lmstudio-local",
    label: "LM Studio (Local)",
    hint: "127.0.0.1:1234 — LM Studio's default",
    defaultEndpoint: "http://127.0.0.1:1234/v1/embeddings",
    suggestedModels: [
      "text-embedding-qwen3-embedding-0.6b",
      "text-embedding-nomic-embed-text-v1.5",
    ],
    defaultMaxChunkChars: 1500,
  },
  {
    id: "openai",
    label: "OpenAI",
    hint: "api.openai.com — requires API key",
    defaultEndpoint: "https://api.openai.com/v1/embeddings",
    suggestedModels: [
      "text-embedding-3-small",
      "text-embedding-3-large",
      "text-embedding-ada-002",
    ],
  },
  {
    id: "jina",
    label: "Jina AI",
    hint: "api.jina.ai — multilingual specialist",
    defaultEndpoint: "https://api.jina.ai/v1/embeddings",
    suggestedModels: ["jina-embeddings-v3", "jina-embeddings-v2-base-en"],
  },
  {
    id: "voyage",
    label: "Voyage AI",
    hint: "api.voyageai.com",
    defaultEndpoint: "https://api.voyageai.com/v1/embeddings",
    suggestedModels: ["voyage-3", "voyage-3-lite", "voyage-large-2"],
  },
  {
    id: "cohere",
    label: "Cohere",
    // Cohere uses /v1/embed (not /v1/embeddings). The normalizer
    // respects this when it sees an explicit /v1/embed path.
    hint: "api.cohere.ai/v1/embed (Cohere-specific path)",
    defaultEndpoint: "https://api.cohere.ai/v1/embed",
    suggestedModels: ["embed-english-v3.0", "embed-multilingual-v3.0"],
  },
  {
    id: "custom",
    label: "Custom",
    hint: "Any OpenAI-compatible /v1/embeddings endpoint",
  },
]

/**
 * Reverse lookup: given a stored endpoint URL, which preset does it
 * most likely correspond to? Used so the UI can show the right preset
 * row as "active" after reload, even for users on pre-presets configs.
 */
export function matchEmbeddingPreset(endpoint: string): EmbeddingPreset | null {
  if (!endpoint) return null
  const norm = endpoint.replace(/\/+$/, "").toLowerCase()
  for (const preset of EMBEDDING_PRESETS) {
    if (!preset.defaultEndpoint) continue
    if (preset.defaultEndpoint.replace(/\/+$/, "").toLowerCase() === norm) {
      return preset
    }
  }
  // Fuzzy host-only match for the local presets so a user who edited
  // the path still gets the right preset highlighted.
  try {
    const u = new URL(endpoint)
    const hostPort = `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`
    if (hostPort === "localhost:11434" || hostPort === "127.0.0.1:11434") {
      return EMBEDDING_PRESETS.find((p) => p.id === "ollama-local") ?? null
    }
    if (hostPort === "127.0.0.1:1234" || hostPort === "localhost:1234") {
      return EMBEDDING_PRESETS.find((p) => p.id === "lmstudio-local") ?? null
    }
    if (hostPort === "127.0.0.1:8080" || hostPort === "localhost:8080") {
      return EMBEDDING_PRESETS.find((p) => p.id === "llamacpp-local") ?? null
    }
  } catch {
    // unparseable — fall through
  }
  return null
}
