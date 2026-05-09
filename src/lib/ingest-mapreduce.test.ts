import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Chunk } from "@/lib/text-chunker"

const streamChat = vi.fn()
vi.mock("./llm-client", () => ({
  streamChat: (...args: unknown[]) => streamChat(...args),
}))

import { analyzeChunkedSource } from "./ingest-mapreduce"

const llmConfig = {
  provider: "openai" as const,
  apiKey: "test",
  model: "gpt-4",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 128000,
}

function buildAnalysisPrompt(
  _purpose: string,
  _index: string,
  _sourceContent: string,
): string {
  return "ANALYZE"
}

const promptInputs = {
  buildAnalysisPrompt,
  purpose: "p",
  index: "i",
  fileName: "doc.md",
}

function chunk(text: string, index: number, headingPath = ""): Chunk {
  return {
    index,
    text,
    headingPath,
    charStart: 0,
    charEnd: text.length,
    oversized: false,
  }
}

beforeEach(() => {
  streamChat.mockReset()
})

describe("analyzeChunkedSource", () => {
  it("returns empty string for zero chunks", async () => {
    const result = await analyzeChunkedSource([], llmConfig, promptInputs)
    expect(result).toBe("")
    expect(streamChat).not.toHaveBeenCalled()
  })

  it("makes one call for a single chunk (fast-path)", async () => {
    streamChat.mockImplementationOnce(async (_cfg, _msgs, cb) => {
      cb.onToken("ANALYSIS-A")
      cb.onDone()
    })

    const result = await analyzeChunkedSource(
      [chunk("body A", 0)],
      llmConfig,
      promptInputs,
    )

    expect(result).toBe("ANALYSIS-A")
    expect(streamChat).toHaveBeenCalledTimes(1)
  })

  it("makes N+1 calls for N chunks (N map + 1 reduce)", async () => {
    streamChat
      .mockImplementationOnce(async (_cfg, _msgs, cb) => {
        cb.onToken("ANALYSIS-1")
        cb.onDone()
      })
      .mockImplementationOnce(async (_cfg, _msgs, cb) => {
        cb.onToken("ANALYSIS-2")
        cb.onDone()
      })
      .mockImplementationOnce(async (_cfg, _msgs, cb) => {
        cb.onToken("ANALYSIS-3")
        cb.onDone()
      })
      .mockImplementationOnce(async (_cfg, _msgs, cb) => {
        cb.onToken("MERGED")
        cb.onDone()
      })

    const result = await analyzeChunkedSource(
      [
        chunk("a", 0, "## A"),
        chunk("b", 1, "## B"),
        chunk("c", 2, "## C"),
      ],
      llmConfig,
      promptInputs,
    )

    expect(streamChat).toHaveBeenCalledTimes(4)
    expect(result).toBe("MERGED")
  })

  it("includes per-chunk analyses in the reduce prompt", async () => {
    streamChat
      .mockImplementationOnce(async (_cfg, _msgs, cb) => {
        cb.onToken("FIRST-CHUNK-ANALYSIS")
        cb.onDone()
      })
      .mockImplementationOnce(async (_cfg, _msgs, cb) => {
        cb.onToken("SECOND-CHUNK-ANALYSIS")
        cb.onDone()
      })
      .mockImplementationOnce(async (_cfg, msgs, cb) => {
        // Capture reduce-call user message; assert below.
        const user = msgs.find((m: { role: string }) => m.role === "user")
        // Stash on the mock so the test can read it.
        ;(streamChat as unknown as { __lastReduceUser?: string }).__lastReduceUser =
          user?.content as string
        cb.onToken("MERGED")
        cb.onDone()
      })

    await analyzeChunkedSource(
      [chunk("a", 0, "## Methods"), chunk("b", 1, "## Results")],
      llmConfig,
      promptInputs,
    )

    const reduceUser = (streamChat as unknown as { __lastReduceUser?: string })
      .__lastReduceUser
    expect(reduceUser).toBeDefined()
    expect(reduceUser).toContain("FIRST-CHUNK-ANALYSIS")
    expect(reduceUser).toContain("SECOND-CHUNK-ANALYSIS")
    expect(reduceUser).toContain("Methods")
    expect(reduceUser).toContain("Results")
  })

  it("user message for a chunk includes its index/total breadcrumb when N>1", async () => {
    let firstUserMsg = ""
    streamChat
      .mockImplementationOnce(async (_cfg, msgs, cb) => {
        firstUserMsg =
          msgs.find((m: { role: string }) => m.role === "user")?.content ?? ""
        cb.onToken("a")
        cb.onDone()
      })
      .mockImplementationOnce(async (_cfg, _msgs, cb) => {
        cb.onToken("b")
        cb.onDone()
      })
      .mockImplementationOnce(async (_cfg, _msgs, cb) => {
        cb.onToken("merged")
        cb.onDone()
      })

    await analyzeChunkedSource(
      [chunk("alpha", 0, "## Intro"), chunk("beta", 1, "## Methods")],
      llmConfig,
      promptInputs,
    )

    expect(firstUserMsg).toContain("Chunk:")
    expect(firstUserMsg).toContain("1/2")
    expect(firstUserMsg).toContain("Intro")
  })

  it("propagates errors from any map call (no silent empty)", async () => {
    streamChat
      .mockImplementationOnce(async (_cfg, _msgs, cb) => {
        cb.onToken("ANALYSIS-1")
        cb.onDone()
      })
      .mockImplementationOnce(async (_cfg, _msgs, cb) => {
        cb.onError(new Error("provider 500"))
        cb.onDone()
      })

    await expect(
      analyzeChunkedSource(
        [chunk("a", 0), chunk("b", 1), chunk("c", 2)],
        llmConfig,
        promptInputs,
      ),
    ).rejects.toThrow(/provider 500/)
  })

  it("propagates errors from the reduce call", async () => {
    streamChat
      .mockImplementationOnce(async (_cfg, _msgs, cb) => {
        cb.onToken("ANALYSIS-1")
        cb.onDone()
      })
      .mockImplementationOnce(async (_cfg, _msgs, cb) => {
        cb.onToken("ANALYSIS-2")
        cb.onDone()
      })
      .mockImplementationOnce(async (_cfg, _msgs, cb) => {
        cb.onError(new Error("synthesis blew up"))
        cb.onDone()
      })

    await expect(
      analyzeChunkedSource(
        [chunk("a", 0), chunk("b", 1)],
        llmConfig,
        promptInputs,
      ),
    ).rejects.toThrow(/synthesis blew up/)
  })

  it("reports map and reduce progress phases", async () => {
    streamChat
      .mockImplementationOnce(async (_cfg, _msgs, cb) => {
        cb.onToken("a")
        cb.onDone()
      })
      .mockImplementationOnce(async (_cfg, _msgs, cb) => {
        cb.onToken("b")
        cb.onDone()
      })
      .mockImplementationOnce(async (_cfg, _msgs, cb) => {
        cb.onToken("merged")
        cb.onDone()
      })

    const phases: Array<{ phase: string; current: number; total: number }> = []
    await analyzeChunkedSource(
      [chunk("a", 0), chunk("b", 1)],
      llmConfig,
      promptInputs,
      undefined,
      (p) => phases.push({ phase: p.phase, current: p.current, total: p.total }),
    )

    expect(phases).toEqual([
      { phase: "map", current: 1, total: 2 },
      { phase: "map", current: 2, total: 2 },
      { phase: "reduce", current: 0, total: 0 },
    ])
  })
})
