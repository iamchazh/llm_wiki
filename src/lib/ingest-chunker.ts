/**
 * Ingest-sized chunker. Wraps the embedding-tuned `chunkMarkdown`
 * recursive splitter (`src/lib/text-chunker.ts`) with much larger
 * target sizes, so a long source document can be fed through the
 * analysis stage in semantically-coherent slabs rather than being
 * hard-truncated at a fixed byte count.
 *
 * The actual splitter logic — heading > paragraph > line > sentence
 * > whitespace, never tearing fenced code or pipe tables, never
 * splitting inside frontmatter — is reused unchanged. We only
 * compute different size knobs.
 *
 * Sizing heuristic. The codebase works in characters, not tokens,
 * so we estimate the LLM's effective window from
 * `llmConfig.maxContextSize` (already a char count). Out of the
 * full window:
 *
 *     ┌─────────────────────────────────────────────────────┐
 *     │              maxContextSize                         │
 *     ├──────────────────┬──────────────────┬───────────────┤
 *     │ chunk content    │ prompt scaffold  │ response room │
 *     │      ~60%        │      ~25%        │     ~15%      │
 *     └──────────────────┴──────────────────┴───────────────┘
 *
 * The 60% slice is then capped at MAX_CHUNK_HARD_CAP (120K chars
 * ≈ 30K tokens at the standard ~4 chars/token estimate) per the
 * user's stated chunk-size target, and floored at MIN_CHUNK_FLOOR
 * so we don't fragment a moderately-long document into hundreds of
 * tiny pieces on a small-context model.
 */

import { chunkMarkdown, type Chunk } from "@/lib/text-chunker"

/** Computed character budgets for one ingest chunk. */
export interface IngestChunkBudget {
  /** Aim-for size of each emitted chunk's body content. */
  chunkChars: number
  /** Hard ceiling — atomic blocks (huge code fences) larger than this
   *  will still be emitted but flagged `oversized` by the splitter. */
  maxChunkChars: number
}

const DEFAULT_MAX_CTX = 204_800
const RESPONSE_RESERVE_FRAC = 0.15
const PROMPT_OVERHEAD_FRAC = 0.25
const MAX_CHUNK_HARD_CAP = 120_000
const MIN_CHUNK_FLOOR = 4_000

/**
 * Derive the per-chunk character budget from the active LLM's
 * `maxContextSize`. `promptOverhead` is the fraction of the window
 * the analysis prompt itself (system + user wrapper + index/purpose
 * context) is expected to consume; defaults to 0.25 — generous
 * enough to cover the ~5-10K-char system prompt plus the wiki
 * index excerpt without crowding the chunk content.
 */
export function computeIngestChunkBudget(
  maxContextSize: number | undefined,
  promptOverhead?: number,
): IngestChunkBudget {
  const maxCtx =
    typeof maxContextSize === "number" && maxContextSize > 0
      ? maxContextSize
      : DEFAULT_MAX_CTX

  const overheadFrac =
    typeof promptOverhead === "number" &&
    promptOverhead >= 0 &&
    promptOverhead < 1
      ? promptOverhead
      : PROMPT_OVERHEAD_FRAC

  const available = Math.floor(maxCtx * (1 - RESPONSE_RESERVE_FRAC - overheadFrac))
  const chunkChars = Math.min(
    MAX_CHUNK_HARD_CAP,
    Math.max(MIN_CHUNK_FLOOR, available),
  )
  const maxChunkChars = Math.min(MAX_CHUNK_HARD_CAP, Math.floor(chunkChars * 1.2))
  return { chunkChars, maxChunkChars }
}

/**
 * Split a source document into ingest-sized chunks at semantic
 * boundaries. Returns the same `Chunk` shape the embedding pipeline
 * uses (`text`, `headingPath`, `charStart/End`, `index`, `oversized`).
 *
 * Empty / whitespace-only input returns `[]`. Short documents that
 * fit within one chunk return a 1-element array — callers can
 * short-circuit map-reduce on `chunks.length <= 1` for zero overhead
 * relative to the pre-chunked single-pass flow.
 */
export function chunkSourceForIngest(
  content: string,
  maxContextSize: number | undefined,
): Chunk[] {
  const { chunkChars, maxChunkChars } = computeIngestChunkBudget(maxContextSize)
  // Clamp overlap so `chunkMarkdown`'s defensive halving (overlap >=
  // target → halved) doesn't kick in, and so tiny configs don't get
  // an overlap larger than the chunk itself.
  const overlapChars = Math.min(
    2_000,
    Math.max(0, Math.floor(chunkChars * 0.05)),
  )
  // minChars governs greedy merging of small siblings — set it well
  // below targetChars so the chunker doesn't refuse to emit a slightly
  // small final chunk.
  const minChars = Math.max(500, Math.floor(chunkChars * 0.3))

  return chunkMarkdown(content, {
    targetChars: chunkChars,
    maxChars: maxChunkChars,
    minChars,
    overlapChars,
  })
}
