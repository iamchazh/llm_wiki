/**
 * Clean up user-entered LLM endpoint URLs. Catches the two most common
 * mistakes:
 *
 *   1. User pastes the full path (e.g. ".../v1/chat/completions") — our
 *      dispatch would then append ANOTHER "/chat/completions" on top,
 *      producing a 404. Always strip trailing path segments that belong
 *      on the request, not on the base.
 *
 *   2. User forgets the version segment entirely (e.g. "https://host.com"
 *      with no /v1). We can't auto-add it because providers use different
 *      segments (OpenAI `/v1`, Zhipu `/api/paas/v4`, Groq `/openai/v1`) —
 *      but we CAN flag it so the user sees the hint.
 *
 * Auto-fixes apply deterministically on blur; hints explain what happened.
 * Warnings are shown inline but never block saving — some self-hosted
 * gateways really do mount the API at a bare host.
 */

export type EndpointMode = "chat_completions" | "anthropic_messages"

export interface NormalizedEndpoint {
  /** The cleaned-up URL to store. Empty string for empty input. */
  normalized: string
  /** True if normalization changed the input (show a "will use" hint). */
  changed: boolean
  /** Human-readable hint / warning. Undefined when the input is fine. */
  warning?: string
}

// Path tails that are always wrong as a base URL and can be safely
// stripped regardless of mode — these belong on the request, not on the
// configured endpoint.
const ALWAYS_WRONG_TAILS = /\/+(chat\/completions|embeddings)\/?$/i
// `/messages` is ambiguous: in anthropic_messages mode our dispatch uses
// it verbatim when present, so we must preserve it. Only strip when the
// configured mode is chat_completions.
const MESSAGES_TAIL = /\/+messages\/?$/i

export function normalizeEndpoint(raw: string, mode: EndpointMode): NormalizedEndpoint {
  const trimmed = (raw ?? "").trim()
  if (!trimmed) return { normalized: "", changed: false }

  // Detect missing protocol — we never auto-add https:// because that
  // would mask the user's typo; just flag it.
  const missingProtocol = !/^https?:\/\//i.test(trimmed)
  if (missingProtocol) {
    return {
      normalized: trimmed.replace(/\/+$/, ""),
      changed: trimmed !== trimmed.replace(/\/+$/, ""),
      warning: "URL should start with http:// or https://",
    }
  }

  let url = trimmed
  const notes: string[] = []

  // Sanity-check the URL can be parsed at all. `new URL(...)` catches
  // typos like five-octet IPs ("192.168.1.1.50"), triple-t protocols
  // ("htttp://"), stray backslashes, and similar paste mistakes that
  // would otherwise only be diagnosed at request time by the HTTP
  // client — a much worse user experience. Emit the warning up front
  // and still return whatever we've got so the input field behaves.
  let parsed: URL | null = null
  try {
    parsed = new URL(trimmed)
  } catch {
    return {
      normalized: trimmed.replace(/\/+$/, ""),
      changed: trimmed !== trimmed.replace(/\/+$/, ""),
      warning: "URL is not well-formed — check for typos in the host / port / path.",
    }
  }

  // Also catch IPv4-shaped hostnames with too many / too few octets
  // — these parse fine as generic DNS names but will fail at lookup.
  // If the hostname looks IP-shaped but isn't a valid IPv4, flag it.
  const host = parsed.hostname
  const looksNumericDotted = /^\d+(?:\.\d+)+$/.test(host)
  if (looksNumericDotted) {
    const octets = host.split(".")
    const validIpv4 =
      octets.length === 4 &&
      octets.every((o) => {
        const n = Number(o)
        return Number.isInteger(n) && n >= 0 && n <= 255
      })
    if (!validIpv4) {
      notes.push(
        `Host "${host}" looks like an IPv4 address but has ${octets.length} octets (valid IPv4 has exactly 4, each 0-255).`,
      )
    }
  }

  // Strip trailing slashes (cheap, always safe)
  url = url.replace(/\/+$/, "")

  // Strip request-path tails users paste by accident. Works in both
  // modes for /chat/completions and /embeddings (wrong shape for either
  // wire). /messages is only wrong in chat_completions mode — in
  // anthropic_messages mode the dispatch uses it verbatim.
  if (ALWAYS_WRONG_TAILS.test(url)) {
    const match = url.match(ALWAYS_WRONG_TAILS)
    url = url.replace(ALWAYS_WRONG_TAILS, "")
    if (match) notes.push(`stripped trailing "${match[0].replace(/^\/+/, "").replace(/\/+$/, "")}" — this is appended per-request, not part of the base URL`)
  } else if (mode === "chat_completions" && MESSAGES_TAIL.test(url)) {
    const match = url.match(MESSAGES_TAIL)
    url = url.replace(MESSAGES_TAIL, "")
    if (match) notes.push(`stripped trailing "${match[0].replace(/^\/+/, "").replace(/\/+$/, "")}" — this is an Anthropic-wire path, not a chat/completions base`)
  }

  // After stripping, check for the "bare host, no version segment" case.
  // Only hint for chat_completions — anthropic_messages endpoints sit at
  // various non-/v1 paths (MiniMax `/anthropic`, Anthropic native `/`)
  // and we can't reliably flag them.
  if (mode === "chat_completions") {
    try {
      const u = new URL(url)
      const pathname = u.pathname.replace(/\/+$/, "")
      const hasVersionSegment = /\/(v\d+|paas\/v\d+|openai\/v\d+|api\/v\d+)$/i.test(pathname)
      if (!hasVersionSegment && !notes.length) {
        notes.push('URL has no version segment (expected e.g. "/v1"). Double-check the provider\'s docs.')
      }
    } catch {
      // Malformed URL — leave alone, browser will fail loudly at fetch time.
    }
  }

  const changed = url !== trimmed
  return {
    normalized: url,
    changed,
    warning: notes.length ? notes.join(" ") : undefined,
  }
}

/**
 * Normalize an embedding endpoint URL.
 *
 * Unlike the chat-completions normalizer, the embedding wire is the
 * full request URL (including the path) — the fetch layer doesn't
 * append anything. So:
 *
 *   - `/v1/embeddings` and `/v1/embed` (Cohere) are valid request
 *     paths and stay as-is.
 *   - A bare `/v1` is auto-extended to `/v1/embeddings` because
 *     that's almost certainly what the user meant.
 *   - A bare host warns — different vendors mount the API at
 *     different sub-paths (Cohere: `/v1/embed`, OpenAI: `/v1/embeddings`,
 *     llama.cpp: `/v1/embeddings` or `/embeddings` depending on flags),
 *     so we can't pick one for them.
 *   - Trailing slashes always strip.
 */
export function normalizeEmbeddingEndpoint(raw: string): NormalizedEndpoint {
  const trimmed = (raw ?? "").trim()
  if (!trimmed) return { normalized: "", changed: false }

  const missingProtocol = !/^https?:\/\//i.test(trimmed)
  if (missingProtocol) {
    const stripped = trimmed.replace(/\/+$/, "")
    return {
      normalized: stripped,
      changed: stripped !== trimmed,
      warning: "URL should start with http:// or https://",
    }
  }

  let parsed: URL | null = null
  try {
    parsed = new URL(trimmed)
  } catch {
    const stripped = trimmed.replace(/\/+$/, "")
    return {
      normalized: stripped,
      changed: stripped !== trimmed,
      warning: "URL is not well-formed — check for typos in the host / port / path.",
    }
  }

  const host = parsed.hostname
  const notes: string[] = []
  const looksNumericDotted = /^\d+(?:\.\d+)+$/.test(host)
  if (looksNumericDotted) {
    const octets = host.split(".")
    const validIpv4 =
      octets.length === 4 &&
      octets.every((o) => {
        const n = Number(o)
        return Number.isInteger(n) && n >= 0 && n <= 255
      })
    if (!validIpv4) {
      notes.push(
        `Host "${host}" looks like an IPv4 address but has ${octets.length} octets (valid IPv4 has exactly 4, each 0-255).`,
      )
    }
  }

  let url = trimmed.replace(/\/+$/, "")

  // Already a valid embeddings path — leave alone.
  const hasEmbeddingsPath = /\/v\d+\/(embeddings|embed)\/?$/i.test(url)
  if (hasEmbeddingsPath) {
    const changed = url !== trimmed
    return {
      normalized: url,
      changed,
      warning: notes.length ? notes.join(" ") : undefined,
    }
  }

  // Bare `/v1` (or `/v2`, etc.) — auto-append `/embeddings`. This is
  // by far the most common shape users paste from a vendor's docs.
  const versionTail = url.match(/\/(v\d+)$/i)
  if (versionTail) {
    url = `${url}/embeddings`
    notes.push(
      `appended "/embeddings" to the version segment — this is the OpenAI-compatible request path.`,
    )
    return {
      normalized: url,
      changed: true,
      warning: notes.join(" "),
    }
  }

  // Bare host or arbitrary base — warn but don't auto-pick a path.
  try {
    const u = new URL(url)
    const pathname = u.pathname.replace(/\/+$/, "")
    if (pathname === "" || pathname === "/") {
      notes.push(
        'URL has no embeddings path — most servers expect "/v1/embeddings" (Cohere uses "/v1/embed"). Double-check the provider\'s docs.',
      )
    } else if (!/\/v\d+/.test(pathname)) {
      notes.push(
        'URL has no version segment (expected e.g. "/v1/embeddings"). Double-check the provider\'s docs.',
      )
    }
  } catch {
    // already handled above
  }

  const changed = url !== trimmed
  return {
    normalized: url,
    changed,
    warning: notes.length ? notes.join(" ") : undefined,
  }
}
