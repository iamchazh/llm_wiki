/**
 * Map-reduce orchestration for the ingest analysis stage.
 *
 * For documents that exceed a single LLM call's effective context,
 * the chunker (`src/lib/ingest-chunker.ts`) splits the source into
 * semantically-coherent slabs. This module runs the analysis prompt
 * on each slab (map), then a single synthesis call that consolidates
 * the per-chunk analyses into one global analysis (reduce). The
 * resulting string is the same shape downstream Generation expects,
 * so the Step-2 prompt and FILE-block parser don't change.
 *
 * For 0/1-chunk inputs the function short-circuits to a single
 * Analysis call — zero overhead vs the pre-chunking single-pass
 * behavior.
 *
 * Errors abort the run by rejecting the returned promise, matching
 * the today's single-call semantics where the caller's catch block
 * marks the task as failed.
 */

import { streamChat } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import type { Chunk } from "@/lib/text-chunker"

export interface AnalysisPromptInputs {
  /** Build the system prompt for an analysis call given the chunk text. */
  buildAnalysisPrompt: (
    purpose: string,
    index: string,
    sourceContent: string,
  ) => string
  purpose: string
  index: string
  fileName: string
  folderContext?: string
}

export type AnalysisProgressPhase = "map" | "reduce"

export interface AnalysisProgress {
  phase: AnalysisProgressPhase
  /** 1-indexed chunk number for "map" phase; 0 for "reduce". */
  current: number
  /** Total chunks in the map phase; 0 for "reduce". */
  total: number
}

const ANALYSIS_OVERRIDES = {
  temperature: 0.1,
  reasoning: { mode: "off" as const },
  max_tokens: 4096,
}

/**
 * Run the analysis stage over an arbitrary number of chunks.
 *
 * - `chunks.length === 0`: returns "" (nothing to analyze).
 * - `chunks.length === 1`: a single Analysis call over that chunk.
 * - `chunks.length > 1`: per-chunk Analysis (map), then one synthesis
 *   call (reduce) that stitches the per-chunk analyses into a unified
 *   global analysis.
 */
export async function analyzeChunkedSource(
  chunks: Chunk[],
  llmConfig: LlmConfig,
  prompts: AnalysisPromptInputs,
  signal?: AbortSignal,
  onProgress?: (p: AnalysisProgress) => void,
): Promise<string> {
  if (chunks.length === 0) return ""

  if (chunks.length === 1) {
    onProgress?.({ phase: "map", current: 1, total: 1 })
    return runAnalysis(
      chunks[0].text,
      buildSingleChunkUserMessage(chunks[0], prompts, 1, 1),
      llmConfig,
      prompts,
      signal,
    )
  }

  // Map phase: per-chunk Analysis. Run sequentially — matches the
  // existing dedup-runner.ts pattern (predictable error semantics,
  // no need to reason about concurrent zustand mutations or shared
  // streamChat callbacks).
  const perChunkAnalyses: string[] = []
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.({ phase: "map", current: i + 1, total: chunks.length })
    const userMsg = buildSingleChunkUserMessage(chunks[i], prompts, i + 1, chunks.length)
    const analysis = await runAnalysis(
      chunks[i].text,
      userMsg,
      llmConfig,
      prompts,
      signal,
    )
    perChunkAnalyses.push(analysis)
  }

  // Reduce phase: one synthesis call.
  onProgress?.({ phase: "reduce", current: 0, total: 0 })
  return runReduce(perChunkAnalyses, chunks, llmConfig, prompts, signal)
}

function buildSingleChunkUserMessage(
  chunk: Chunk,
  prompts: AnalysisPromptInputs,
  index: number,
  total: number,
): string {
  const headingPath = chunk.headingPath.trim()
  const chunkInfo =
    total > 1
      ? `**Chunk:** ${index}/${total}${headingPath ? ` — ${headingPath}` : ""}\n`
      : ""
  const folderInfo = prompts.folderContext
    ? `**Folder context:** ${prompts.folderContext}\n`
    : ""
  return [
    `Analyze this source document:`,
    "",
    `**File:** ${prompts.fileName}`,
    folderInfo + chunkInfo,
    "---",
    "",
    chunk.text,
  ].join("\n")
}

async function runAnalysis(
  chunkText: string,
  userMessage: string,
  llmConfig: LlmConfig,
  prompts: AnalysisPromptInputs,
  signal: AbortSignal | undefined,
): Promise<string> {
  let out = ""
  let streamErr: Error | null = null
  await streamChat(
    llmConfig,
    [
      {
        role: "system",
        content: prompts.buildAnalysisPrompt(prompts.purpose, prompts.index, chunkText),
      },
      { role: "user", content: userMessage },
    ],
    {
      onToken: (token) => {
        out += token
      },
      onDone: () => {},
      onError: (err) => {
        streamErr = err instanceof Error ? err : new Error(String(err))
      },
    },
    signal,
    ANALYSIS_OVERRIDES,
  )
  if (streamErr) throw streamErr
  return out
}

async function runReduce(
  perChunkAnalyses: string[],
  chunks: Chunk[],
  llmConfig: LlmConfig,
  prompts: AnalysisPromptInputs,
  signal: AbortSignal | undefined,
): Promise<string> {
  const reduceSystem = [
    "You are an expert research analyst consolidating multiple partial analyses of one source document.",
    "Each partial analysis below was produced from one chunk of the document; together they cover the whole.",
    "Your job: merge them into a single unified analysis with the same structure each part used.",
    "",
    "Consolidation rules:",
    "- Deduplicate entities and concepts that appear in more than one chunk — keep one canonical entry.",
    "- Merge contradictions and tensions across chunks into the Contradictions & Tensions section.",
    "- Recommendations should reflect the document as a whole, not any single chunk.",
    "- Preserve the section headings (## Key Entities, ## Key Concepts, ## Main Arguments & Findings, ## Connections to Existing Wiki, ## Contradictions & Tensions, ## Recommendations).",
    "- Do not output chain-of-thought, hidden reasoning, or a thinking transcript. Output only the final unified analysis.",
    "- Preserve the language of the partial analyses — do not translate.",
  ].join("\n")

  const partsBlock = perChunkAnalyses
    .map((a, i) => {
      const heading = chunks[i]?.headingPath?.trim() || "(no heading)"
      return [
        `### Partial analysis ${i + 1}/${perChunkAnalyses.length} — ${heading}`,
        "",
        a.trim(),
      ].join("\n")
    })
    .join("\n\n---\n\n")

  const reduceUser = [
    `Source document: **${prompts.fileName}**`,
    "",
    "Below are the partial analyses produced from each chunk of this document.",
    "Consolidate them into one unified analysis following the rules in the system prompt.",
    "",
    "## Partial analyses",
    "",
    partsBlock,
  ].join("\n")

  let out = ""
  let streamErr: Error | null = null
  await streamChat(
    llmConfig,
    [
      { role: "system", content: reduceSystem },
      { role: "user", content: reduceUser },
    ],
    {
      onToken: (token) => {
        out += token
      },
      onDone: () => {},
      onError: (err) => {
        streamErr = err instanceof Error ? err : new Error(String(err))
      },
    },
    signal,
    ANALYSIS_OVERRIDES,
  )
  if (streamErr) throw streamErr
  return out
}
