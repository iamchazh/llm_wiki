import { describe, it, expect, beforeEach } from "vitest"
import {
  buildAnalysisPrompt,
  buildGenerationPrompt,
  buildGenerationSourceSlab,
} from "./ingest"
import type { Chunk } from "@/lib/text-chunker"
import { useWikiStore } from "@/stores/wiki-store"

beforeEach(() => {
  useWikiStore.getState().setOutputLanguage("auto")
})

describe("buildAnalysisPrompt language directive", () => {
  it("injects the user's explicit language setting", () => {
    useWikiStore.getState().setOutputLanguage("Chinese")
    const prompt = buildAnalysisPrompt("purpose", "index", "english source content")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })

  it("uses user setting even when source is in a different language", () => {
    useWikiStore.getState().setOutputLanguage("Japanese")
    const prompt = buildAnalysisPrompt("", "", "这段内容是中文")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Japanese")
    expect(prompt).not.toContain("OUTPUT LANGUAGE: Chinese")
  })

  it("auto mode falls back to detecting source content language", () => {
    useWikiStore.getState().setOutputLanguage("auto")
    const prompt = buildAnalysisPrompt("", "", "これは日本語の文章です")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Japanese")
  })

  it("auto mode with empty source defaults to English", () => {
    useWikiStore.getState().setOutputLanguage("auto")
    const prompt = buildAnalysisPrompt("", "", "")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: English")
  })

  it("contains structural analysis sections", () => {
    const prompt = buildAnalysisPrompt("", "", "")
    expect(prompt).toContain("## Key Entities")
    expect(prompt).toContain("## Key Concepts")
    expect(prompt).toContain("## Main Arguments & Findings")
    expect(prompt).toContain("## Recommendations")
  })
})

describe("buildGenerationPrompt language directive", () => {
  it("injects the user's explicit language setting", () => {
    useWikiStore.getState().setOutputLanguage("Chinese")
    const prompt = buildGenerationPrompt("schema", "purpose", "index", "source.pdf")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })

  it("honors Vietnamese setting", () => {
    useWikiStore.getState().setOutputLanguage("Vietnamese")
    const prompt = buildGenerationPrompt("", "", "", "file.pdf")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Vietnamese")
  })

  it("auto mode detects from source content", () => {
    useWikiStore.getState().setOutputLanguage("auto")
    const prompt = buildGenerationPrompt("", "", "", "file.pdf", undefined, "这是中文源文档内容")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })

  it("includes the source filename in output instructions", () => {
    const prompt = buildGenerationPrompt("", "", "", "my-paper.pdf")
    expect(prompt).toContain("my-paper.pdf")
  })

  it("respects user setting regardless of source content language", () => {
    useWikiStore.getState().setOutputLanguage("English")
    const prompt = buildGenerationPrompt("", "", "", "x.pdf", undefined, "私は日本語の文章を書きます")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: English")
    expect(prompt).not.toContain("OUTPUT LANGUAGE: Japanese")
  })
})

describe("analysis + generation prompt consistency", () => {
  // Both stages MUST declare the same target language — otherwise the wiki
  // files generated in stage 2 may disagree with the analysis from stage 1.
  it("both stages declare the same language for a given setting", () => {
    useWikiStore.getState().setOutputLanguage("Korean")
    const analysis = buildAnalysisPrompt("", "", "")
    const generation = buildGenerationPrompt("", "", "", "f.pdf")
    expect(analysis).toContain("MANDATORY OUTPUT LANGUAGE: Korean")
    expect(generation).toContain("MANDATORY OUTPUT LANGUAGE: Korean")
  })

  it("both stages in auto mode agree on detected language from source", () => {
    useWikiStore.getState().setOutputLanguage("auto")
    const korean = "이것은 한국어 문장입니다"
    const analysis = buildAnalysisPrompt("", "", korean)
    const generation = buildGenerationPrompt("", "", "", "f.pdf", undefined, korean)
    expect(analysis).toContain("MANDATORY OUTPUT LANGUAGE: Korean")
    expect(generation).toContain("MANDATORY OUTPUT LANGUAGE: Korean")
  })
})

describe("buildGenerationSourceSlab — chunk-aware Step-2 source", () => {
  const llmConfig = {
    provider: "openai" as const,
    apiKey: "k",
    model: "m",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 200_000,
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

  it("returns empty string for no chunks", () => {
    expect(buildGenerationSourceSlab([], llmConfig)).toBe("")
  })

  it("passes a single chunk through untouched (matches today's single-pass)", () => {
    const text = "# Title\n\nFull source body."
    const slab = buildGenerationSourceSlab([chunk(text, 0)], llmConfig)
    expect(slab).toBe(text)
  })

  it("for multi-chunk input, prepends the first chunk and outlines the rest", () => {
    const slab = buildGenerationSourceSlab(
      [
        chunk("first chunk body", 0, "## Intro"),
        chunk("second chunk body", 1, "## Methods"),
        chunk("third chunk body", 2, "## Results > ### Table 1"),
      ],
      llmConfig,
    )
    expect(slab).toContain("first chunk body")
    expect(slab).toContain("Outline of remaining chunks")
    expect(slab).toContain("Methods")
    expect(slab).toContain("Results > ### Table 1")
    // Subsequent chunk bodies are NOT included verbatim — only their
    // heading paths — because Stage-1 analysis already extracted them.
    expect(slab).not.toContain("second chunk body")
    expect(slab).not.toContain("third chunk body")
  })

  it("caps the slab at the chunker's per-chunk char budget", () => {
    const huge = "x".repeat(500_000)
    const slab = buildGenerationSourceSlab(
      [chunk(huge, 0, "## A"), chunk("b", 1, "## B")],
      llmConfig,
    )
    // 200K maxContextSize → ~120K chunkChars cap. Slab must be <=
    // budget + a small overflow for the trailing summary marker.
    expect(slab.length).toBeLessThanOrEqual(120_500)
  })
})
