/**
 * Probe an embedding endpoint with a single tiny request and report
 * back whether it responded with a usable vector.
 *
 * Used by the Settings → Embedding "Test connection" button so users
 * can verify their endpoint + key + model combo without running a
 * full re-index. Goes through the same `getHttpFetch` path as the
 * real fetchEmbedding call, so what the probe tests is exactly what
 * the live pipeline will see.
 *
 * Auto-halve retry is intentionally bypassed (`maxRetries = 0`).
 * Surfacing the real error is more valuable than silently shrinking
 * the payload — users want to know if their model id is wrong, not
 * see a green pill produced by a 4-char fallback.
 */

import type { EmbeddingConfig } from "@/stores/wiki-store"
import { fetchEmbedding, getLastEmbeddingError } from "@/lib/embedding"

export type EmbeddingProbeResult =
  | { ok: true; dims: number; latencyMs: number }
  | { ok: false; error: string }

/** A short factual string. The point is to land a successful response —
 *  we don't care about the resulting vector's content. */
const PROBE_TEXT = "embedding probe"

export async function probeEmbedding(
  cfg: EmbeddingConfig,
): Promise<EmbeddingProbeResult> {
  if (!cfg.endpoint) {
    return { ok: false, error: "Endpoint URL is empty." }
  }
  if (!cfg.model) {
    return { ok: false, error: "Model id is empty." }
  }

  const start = performance.now()
  let vec: number[] | null = null
  try {
    vec = await fetchEmbedding(PROBE_TEXT, cfg, 0)
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
  const latencyMs = Math.round(performance.now() - start)

  if (!vec) {
    return {
      ok: false,
      error: getLastEmbeddingError() ?? "Unknown error — no vector returned.",
    }
  }
  return { ok: true, dims: vec.length, latencyMs }
}
