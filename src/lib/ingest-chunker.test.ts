import { describe, it, expect } from "vitest"
import { chunkSourceForIngest, computeIngestChunkBudget } from "./ingest-chunker"

describe("computeIngestChunkBudget", () => {
  it("caps chunk size at the 120K hard limit for big-context models", () => {
    const b = computeIngestChunkBudget(1_000_000)
    expect(b.chunkChars).toBe(120_000)
    expect(b.maxChunkChars).toBe(120_000)
  })

  it("scales chunk size with maxContextSize for mid-sized windows", () => {
    // 100K ctx → 60% available = 60K → below the cap, so we get the
    // computed value (not the cap).
    const b = computeIngestChunkBudget(100_000)
    expect(b.chunkChars).toBe(60_000)
    expect(b.maxChunkChars).toBeGreaterThan(60_000)
    expect(b.maxChunkChars).toBeLessThanOrEqual(120_000)
  })

  it("scales down for small contexts", () => {
    // 50K ctx → 60% = 30K
    const b = computeIngestChunkBudget(50_000)
    expect(b.chunkChars).toBe(30_000)
  })

  it("falls back to default for missing maxContextSize", () => {
    const b1 = computeIngestChunkBudget(undefined)
    const b2 = computeIngestChunkBudget(0)
    const b3 = computeIngestChunkBudget(NaN)
    expect(b1.chunkChars).toBeGreaterThan(0)
    expect(b2.chunkChars).toBe(b1.chunkChars)
    expect(b3.chunkChars).toBe(b1.chunkChars)
  })

  it("respects a custom prompt-overhead fraction", () => {
    // With 50% overhead, available = 50K * (1 - .15 - .50) = 17.5K.
    const b = computeIngestChunkBudget(50_000, 0.5)
    expect(b.chunkChars).toBe(17_500)
  })

  it("ignores nonsensical prompt-overhead values", () => {
    // < 0 and >= 1 fall back to the default 25%.
    const baseline = computeIngestChunkBudget(50_000)
    expect(computeIngestChunkBudget(50_000, -0.1).chunkChars).toBe(
      baseline.chunkChars,
    )
    expect(computeIngestChunkBudget(50_000, 1.1).chunkChars).toBe(
      baseline.chunkChars,
    )
  })

  it("floors chunk size at a sane minimum on tiny contexts", () => {
    // 4K ctx is unusable for ingest in practice, but the budget must
    // still return a positive number rather than 0/NaN.
    const b = computeIngestChunkBudget(4_000)
    expect(b.chunkChars).toBeGreaterThanOrEqual(4_000)
    expect(b.maxChunkChars).toBeGreaterThanOrEqual(b.chunkChars)
  })
})

describe("chunkSourceForIngest", () => {
  it("returns a single chunk for short content", () => {
    const chunks = chunkSourceForIngest(
      "# Title\n\nA short paragraph that fits well below any chunk budget.",
      200_000,
    )
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toContain("A short paragraph")
  })

  it("returns empty array for empty / whitespace-only content", () => {
    expect(chunkSourceForIngest("", 200_000)).toEqual([])
    expect(chunkSourceForIngest("   \n\n  \n", 200_000)).toEqual([])
  })

  it("splits a long document at heading boundaries", () => {
    // Build a doc with three large `##` sections, each well over the
    // 30K-char chunk size we'll get from a 50K-context budget.
    const body = (h: string, n: number) =>
      `## ${h}\n\n` + "Lorem ipsum dolor sit amet. ".repeat(n) + "\n\n"
    const doc =
      "# Long doc\n\n" + body("Section A", 1_500) + body("Section B", 1_500) + body("Section C", 1_500)

    const chunks = chunkSourceForIngest(doc, 50_000)
    expect(chunks.length).toBeGreaterThanOrEqual(3)

    // Each chunk records which heading it came from.
    const headings = chunks.map((c) => c.headingPath).filter(Boolean)
    expect(headings.some((h) => h.includes("Section A"))).toBe(true)
    expect(headings.some((h) => h.includes("Section B"))).toBe(true)
    expect(headings.some((h) => h.includes("Section C"))).toBe(true)
  })

  it("scales chunk count inversely with maxContextSize", () => {
    const doc = "# Doc\n\n" + "Lorem ipsum dolor sit amet. ".repeat(8_000)
    const big = chunkSourceForIngest(doc, 1_000_000)
    const small = chunkSourceForIngest(doc, 50_000)
    expect(small.length).toBeGreaterThan(big.length)
  })

  it("flags oversized atomic blocks rather than tearing them", () => {
    // Build a single fenced code block bigger than any reasonable
    // chunk budget. The chunker MUST keep it intact — flagged via
    // `oversized: true` rather than split mid-code.
    const huge = "```\n" + "x".repeat(200_000) + "\n```\n"
    const chunks = chunkSourceForIngest(huge, 50_000)
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    expect(chunks.some((c) => c.oversized)).toBe(true)
    // The fenced content must still be present somewhere — never torn.
    const joined = chunks.map((c) => c.text).join("\n")
    expect(joined).toContain("```")
  })

  it("preserves heading breadcrumbs through the splitter", () => {
    const doc =
      "# Top\n\n" +
      "## Methods\n\n" +
      "### Setup\n\n" +
      "Setup details. ".repeat(3_000) +
      "\n\n## Results\n\nResults summary.\n"
    const chunks = chunkSourceForIngest(doc, 50_000)
    const setupChunks = chunks.filter((c) =>
      c.headingPath.includes("Setup"),
    )
    expect(setupChunks.length).toBeGreaterThanOrEqual(1)
    // Breadcrumb must include the parent Methods heading.
    expect(setupChunks[0].headingPath).toContain("Methods")
  })
})
