import { describe, it, expect, vi, beforeEach } from "vitest"

const mockHttpFetch = vi.fn<(url: string, opts?: RequestInit) => Promise<Response>>()
vi.mock("@/lib/tauri-fetch", () => ({
  getHttpFetch: () => Promise.resolve(mockHttpFetch),
  isFetchNetworkError: (err: unknown) =>
    err instanceof TypeError ||
    (err instanceof Error &&
      (err.message === "Load failed" || err.message === "Failed to fetch")),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  listDirectory: vi.fn(),
}))

import { probeEmbedding } from "./embedding-probe"

const cfg = {
  enabled: true,
  endpoint: "http://localhost:1234/v1/embeddings",
  apiKey: "",
  model: "test-embed",
}

function okResponse(embedding: number[]): Response {
  return new Response(JSON.stringify({ data: [{ embedding }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

beforeEach(() => {
  mockHttpFetch.mockReset()
})

describe("probeEmbedding", () => {
  it("returns ok with dims and latency on success", async () => {
    mockHttpFetch.mockResolvedValueOnce(okResponse(new Array(384).fill(0.1)))
    const r = await probeEmbedding(cfg)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.dims).toBe(384)
      expect(r.latencyMs).toBeGreaterThanOrEqual(0)
    }
  })

  it("returns ok=false with a 4xx error message", async () => {
    mockHttpFetch.mockResolvedValueOnce(
      new Response('{"error":"invalid api key"}', {
        status: 401,
        statusText: "Unauthorized",
      }),
    )
    const r = await probeEmbedding(cfg)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/401|invalid api key/i)
    }
  })

  it("returns ok=false on a network error (TypeError)", async () => {
    mockHttpFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    const r = await probeEmbedding(cfg)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/network|fetch/i)
    }
  })

  it("rejects empty endpoint without making an HTTP call", async () => {
    const r = await probeEmbedding({ ...cfg, endpoint: "" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/endpoint/i)
    }
    expect(mockHttpFetch).not.toHaveBeenCalled()
  })

  it("rejects empty model without making an HTTP call", async () => {
    const r = await probeEmbedding({ ...cfg, model: "" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/model/i)
    }
    expect(mockHttpFetch).not.toHaveBeenCalled()
  })

  it("does not retry on oversize errors (maxRetries=0 surfaces the real error)", async () => {
    // Even though the fetch layer can auto-halve, the probe asks
    // fetchEmbedding to skip that — we want to see the raw failure.
    mockHttpFetch.mockResolvedValueOnce(
      new Response('{"error":"input too long"}', {
        status: 413,
        statusText: "Payload Too Large",
      }),
    )
    const r = await probeEmbedding(cfg)
    expect(r.ok).toBe(false)
    expect(mockHttpFetch).toHaveBeenCalledTimes(1)
  })
})
