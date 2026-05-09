/**
 * Scenario-driven tests for autoIngest.
 *
 * Each scenario materializes an initial project, a source document, and two
 * canned LLM responses (stage 1 analysis, stage 2 generation with FILE +
 * REVIEW blocks). The runner mocks streamChat to emit them sequentially.
 *
 * After ingest runs, the runner asserts:
 *   - expected files exist on disk with expected substrings
 *   - expected review items were injected into the review store
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import path from "node:path"
import fs from "node:fs/promises"
import { realFs, createTempProject, readFileRaw, fileExists } from "@/test-helpers/fs-temp"
import { materializeScenario, copyDir } from "@/test-helpers/scenarios/materialize"
import { ingestScenarios } from "@/test-helpers/scenarios/ingest-scenarios"
import type { IngestScenario } from "@/test-helpers/scenarios/types"

vi.mock("@/commands/fs", () => realFs)

// Sequenced streamChat: stage-1 returns analysisResponse, stage-2 returns
// generationResponse. Any further calls return empty (shouldn't happen in a
// typical autoIngest run).
let pendingResponses: string[] = []
vi.mock("./llm-client", () => ({
  streamChat: vi.fn(async (_cfg, _msgs, cb) => {
    const resp = pendingResponses.shift() ?? ""
    cb.onToken(resp)
    cb.onDone()
  }),
}))

import { autoIngest } from "./ingest"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useActivityStore } from "@/stores/activity-store"
import { useChatStore } from "@/stores/chat-store"

const FIXTURES_ROOT = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "scenarios-ingest",
)

beforeAll(async () => {
  await fs.rm(FIXTURES_ROOT, { recursive: true, force: true })
  await fs.mkdir(FIXTURES_ROOT, { recursive: true })
  for (const s of ingestScenarios) {
    await materializeScenario(s, FIXTURES_ROOT)
  }
})

beforeEach(() => {
  pendingResponses = []
  useReviewStore.setState({ items: [] })
  useActivityStore.setState({ items: [] })
  useChatStore.setState({
    conversations: [],
    messages: [],
    activeConversationId: null,
    mode: "chat",
    ingestSource: null,
    isStreaming: false,
    streamingContent: "",
  })
})

interface Ctx {
  tmp: { path: string; cleanup: () => Promise<void> }
}
let ctx: Ctx | undefined

async function setup(scenario: IngestScenario): Promise<Ctx> {
  const tmp = await createTempProject(
    `ingest-${scenario.name.replace(/\//g, "-")}`,
  )
  const initialWikiDir = path.join(FIXTURES_ROOT, scenario.name, "initial-wiki")
  await copyDir(initialWikiDir, tmp.path)

  useWikiStore.setState({
    project: {
      name: "t",
      path: tmp.path,
      createdAt: 0,
      purposeText: "",
      fileTree: [],
    } as unknown as ReturnType<typeof useWikiStore.getState>["project"],
  })
  useWikiStore.getState().setLlmConfig({
    provider: "openai",
    apiKey: "test-key",
    model: "gpt-4",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 128000,
  })

  // Queue up the two sequenced LLM responses
  const analysis = await fs.readFile(
    path.join(FIXTURES_ROOT, scenario.name, "llm-analysis.txt"),
    "utf-8",
  )
  const generation = await fs.readFile(
    path.join(FIXTURES_ROOT, scenario.name, "llm-generation.txt"),
    "utf-8",
  )
  pendingResponses = [analysis, generation]

  return { tmp }
}

afterEach(async () => {
  if (ctx) {
    await ctx.tmp.cleanup()
    ctx = undefined
  }
})

// ── Assertions ──────────────────────────────────────────────────────────────

async function assertOutcome(
  scenario: IngestScenario,
  tmpPath: string,
): Promise<void> {
  const expected = scenario.expected

  // 1. Expected files exist
  for (const p of expected.writtenPaths) {
    const full = path.join(tmpPath, p)
    const exists = await fileExists(full)
    if (!exists) {
      // eslint-disable-next-line no-console
      console.error(
        `\n[ingest: ${scenario.name}] expected file not written: ${p}`,
      )
    }
    expect(exists, `file not written: ${p}`).toBe(true)
  }

  // 2. File contents contain expected substrings
  if (expected.fileContains) {
    for (const [relPath, substrs] of Object.entries(expected.fileContains)) {
      const full = path.join(tmpPath, relPath)
      const content = await readFileRaw(full)
      for (const sub of substrs) {
        expect(content, `${relPath} missing substring "${sub}"`).toContain(sub)
      }
    }
  }

  // 3. Review store has the expected items
  const expectedReviews = expected.reviewsCreated ?? []
  const actualReviews = useReviewStore.getState().items
  for (const e of expectedReviews) {
    const match = actualReviews.find(
      (r) => r.type === e.type && r.title.includes(e.titleContains),
    )
    if (!match) {
      // eslint-disable-next-line no-console
      console.error(
        `\n[ingest: ${scenario.name}] no review matching ${JSON.stringify(e)}. Actual:\n` +
          JSON.stringify(
            actualReviews.map((r) => ({ type: r.type, title: r.title })),
            null,
            2,
          ),
      )
    }
    expect(match, `review missing: ${JSON.stringify(e)}`).toBeTruthy()
  }

  // 4. If the scenario declared no reviews, store must be empty.
  if (expectedReviews.length === 0) {
    expect(actualReviews).toHaveLength(0)
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("ingest scenarios (fixture-driven)", () => {
  it.each(ingestScenarios.map((s) => [s.name, s]))(
    "%s",
    async (_name, scenario) => {
      ctx = await setup(scenario)

      const sourceFullPath = path.join(ctx.tmp.path, scenario.source.path)
      await autoIngest(
        ctx.tmp.path,
        sourceFullPath,
        useWikiStore.getState().llmConfig,
      )

      await assertOutcome(scenario, ctx.tmp.path)
    },
  )
})

describe("ingest long-document map-reduce", () => {
  // Builds a synthetic long markdown source with multiple `##` sections,
  // each well over the 30K-char chunk size implied by the test
  // llmConfig's 100K maxContextSize. The chunker should produce 3+
  // chunks; analyzeChunkedSource should fire one streamChat call per
  // chunk plus one reduce call; Step-2 Generation makes the final call.
  it("calls streamChat once per chunk + once for reduce + once for generation", async () => {
    // Reset the streamChat mock — it's shared with the fixture-driven
    // tests above, and we need to count only the calls this test makes.
    const { streamChat: streamChatMock } = await import("./llm-client")
    ;(streamChatMock as unknown as { mockClear: () => void }).mockClear()

    const tmp = await createTempProject("ingest-longdoc")
    ctx = { tmp }

    // Minimal wiki layout — must exist for the index/overview reads
    // and the writes to succeed.
    await fs.mkdir(path.join(tmp.path, "wiki"), { recursive: true })
    await fs.writeFile(path.join(tmp.path, "wiki", "index.md"), "# Index\n")
    await fs.writeFile(path.join(tmp.path, "wiki", "overview.md"), "# Overview\n")
    await fs.writeFile(path.join(tmp.path, "schema.md"), "")
    await fs.writeFile(path.join(tmp.path, "purpose.md"), "")

    // ~150K-char doc with 3 distinct headings, well above the per-chunk
    // budget computed from a 100K-char maxContextSize.
    const section = (h: string, n: number) =>
      `## ${h}\n\n` + "Lorem ipsum dolor sit amet. ".repeat(n) + "\n\n"
    const body =
      "# Long synthetic doc\n\n" +
      section("Section A", 1_800) +
      section("Section B", 1_800) +
      section("Section C", 1_800)

    await fs.mkdir(path.join(tmp.path, "raw"), { recursive: true })
    const sourcePath = path.join(tmp.path, "raw", "long.md")
    await fs.writeFile(sourcePath, body)

    useWikiStore.setState({
      project: {
        name: "t",
        path: tmp.path,
        createdAt: 0,
        purposeText: "",
        fileTree: [],
      } as unknown as ReturnType<typeof useWikiStore.getState>["project"],
    })
    useWikiStore.getState().setLlmConfig({
      provider: "openai",
      apiKey: "k",
      model: "m",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 100_000,
    })

    // Per-chunk analyses, one synthesis, one generation. We don't care
    // what the LLM "says" — we care that the right number of calls
    // happen and that the synthesis call sees output from each chunk.
    const generationBlock = [
      "---FILE: wiki/sources/long.md---",
      "---",
      'type: source',
      'title: "Source: long.md"',
      "created: 2026-05-08",
      "updated: 2026-05-08",
      'sources: ["long.md"]',
      "tags: []",
      "related: []",
      "---",
      "",
      "# Long doc summary",
      "Body.",
      "---END FILE---",
      "",
    ].join("\n")

    // Generous response queue — chunker may produce more than 3 chunks
    // depending on heading/paragraph splits. Per-chunk responses include
    // a unique marker so we can assert all of them flow into the reduce.
    pendingResponses = [
      "MAP-1: chunk 1 analysis content.",
      "MAP-2: chunk 2 analysis content.",
      "MAP-3: chunk 3 analysis content.",
      "MAP-4: chunk 4 analysis content.",
      "MAP-5: chunk 5 analysis content.",
      "MAP-6: chunk 6 analysis content.",
      "REDUCE: merged analysis covering all sections.",
      generationBlock,
    ]

    await autoIngest(tmp.path, sourcePath, useWikiStore.getState().llmConfig)

    const { streamChat } = await import("./llm-client")
    const mock = streamChat as unknown as { mock: { calls: unknown[][] } }
    // N chunks → N map + 1 reduce + 1 generation. With this synthetic
    // ~150K-char doc on a 100K maxContextSize, expect at least 3 map
    // calls (sometimes more if the splitter finds good boundaries).
    expect(mock.mock.calls.length).toBeGreaterThanOrEqual(5)

    // Find the reduce call: it's the one whose system prompt mentions
    // "consolidating multiple partial analyses". Same property the
    // mapreduce unit test pins down, but here verified through the
    // real autoIngest pipeline.
    const reduceCall = mock.mock.calls.find((call) => {
      const messages = call[1] as Array<{ role: string; content: string }>
      const sys = messages.find((m) => m.role === "system")?.content ?? ""
      return sys.includes("consolidating multiple partial analyses")
    })
    expect(reduceCall, "expected a reduce call in streamChat history").toBeDefined()
    const reduceMessages = reduceCall![1] as Array<{ role: string; content: string }>
    const reduceUser = reduceMessages.find((m) => m.role === "user")?.content ?? ""
    expect(reduceUser).toContain("MAP-1")
    expect(reduceUser).toContain("MAP-2")
    expect(reduceUser).toContain("MAP-3")

    // No `[...truncated...]` marker should leak into wiki output —
    // that's the marker the old 50K hard-truncation used.
    const generatedFiles = await fs.readdir(path.join(tmp.path, "wiki", "sources"))
    for (const f of generatedFiles) {
      const content = await fs.readFile(
        path.join(tmp.path, "wiki", "sources", f),
        "utf-8",
      )
      expect(content).not.toContain("[...truncated...]")
    }
  })
})
