import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  XCircle,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useWikiStore } from "@/stores/wiki-store"
import {
  dropLegacyVectorTable,
  embedAllPages,
  getEmbeddingCount,
  getLastEmbeddingError,
  legacyVectorRowCount,
} from "@/lib/embedding"
import { probeEmbedding, type EmbeddingProbeResult } from "@/lib/embedding-probe"
import { normalizeEmbeddingEndpoint } from "@/lib/endpoint-normalizer"
import {
  EMBEDDING_PRESETS,
  matchEmbeddingPreset,
  type EmbeddingPreset,
} from "../embedding-presets"
import type { SettingsDraft, DraftSetter } from "../settings-types"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

type ReindexState =
  | { kind: "idle" }
  | { kind: "running"; done: number; total: number }
  | { kind: "done"; count: number }

/**
 * Resolve which preset id is "active" — the explicit draft value if
 * the user has picked one, otherwise a fuzzy match against the stored
 * endpoint URL so pre-presets configs slot into the right row.
 */
function resolveActivePresetId(draft: SettingsDraft): string | undefined {
  if (draft.embeddingPresetId) return draft.embeddingPresetId
  const matched = matchEmbeddingPreset(draft.embeddingEndpoint)
  return matched?.id
}

export function EmbeddingSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const embeddingConfig = useWikiStore((s) => s.embeddingConfig)

  const [chunkCount, setChunkCount] = useState<number | null>(null)
  const [legacyCount, setLegacyCount] = useState<number>(0)
  const [lastError, setLastError] = useState<string | null>(null)
  const [reindex, setReindex] = useState<ReindexState>({ kind: "idle" })
  const [legacyDropped, setLegacyDropped] = useState(false)

  const refreshStats = useCallback(async () => {
    if (!project) return
    try {
      const [chunks, legacy] = await Promise.all([
        getEmbeddingCount(project.path),
        legacyVectorRowCount(project.path),
      ])
      setChunkCount(chunks)
      setLegacyCount(legacy)
    } catch {
      setChunkCount(null)
    }
    setLastError(getLastEmbeddingError())
  }, [project])

  useEffect(() => {
    void refreshStats()
  }, [refreshStats])

  const handleReindex = useCallback(async () => {
    if (!project) return
    setReindex({ kind: "running", done: 0, total: 0 })
    const count = await embedAllPages(project.path, embeddingConfig, (done, total) => {
      setReindex({ kind: "running", done, total })
    })
    setReindex({ kind: "done", count })
    await refreshStats()
  }, [project, embeddingConfig, refreshStats])

  const handleDropLegacy = useCallback(async () => {
    if (!project) return
    await dropLegacyVectorTable(project.path)
    setLegacyCount(0)
    setLegacyDropped(true)
  }, [project])

  const showLegacyMigration =
    legacyCount > 0 && (chunkCount === null || chunkCount === 0)

  const activePresetId = resolveActivePresetId(draft)

  const [expanded, setExpanded] = useState<Record<string, boolean>>(() =>
    activePresetId ? { [activePresetId]: true } : {},
  )
  const toggleExpand = (id: string) =>
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }))

  // Picking a preset row swaps in its defaults but preserves any
  // user-typed apiKey — re-typing keys for every preset switch would
  // be a poor UX. Endpoint and model only overwrite when the field
  // is empty (so an in-flight edit isn't clobbered).
  const onPickPreset = (preset: EmbeddingPreset) => {
    setDraft("embeddingPresetId", preset.id)
    setExpanded((prev) => ({ ...prev, [preset.id]: true }))

    const currentMatch = matchEmbeddingPreset(draft.embeddingEndpoint)
    const switchingFromMatched = currentMatch && currentMatch.id !== preset.id
    if (
      preset.defaultEndpoint &&
      (!draft.embeddingEndpoint || switchingFromMatched)
    ) {
      setDraft("embeddingEndpoint", preset.defaultEndpoint)
    }
    if (
      !draft.embeddingModel &&
      preset.suggestedModels &&
      preset.suggestedModels.length > 0
    ) {
      setDraft("embeddingModel", preset.suggestedModels[0])
    }
    if (!draft.embeddingMaxChunkChars && preset.defaultMaxChunkChars) {
      setDraft("embeddingMaxChunkChars", preset.defaultMaxChunkChars)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t("settings.sections.embedding.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.embedding.description")}
        </p>
      </div>

      <div className="flex items-center justify-between rounded-md border p-3">
        <div>
          <div className="text-sm font-medium">{t("settings.sections.embedding.enableLabel")}</div>
          <div className="text-xs text-muted-foreground">
            {t("settings.sections.embedding.enableHint")}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setDraft("embeddingEnabled", !draft.embeddingEnabled)}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            draft.embeddingEnabled ? "bg-primary" : "bg-muted"
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
              draft.embeddingEnabled ? "translate-x-4.5" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      {draft.embeddingEnabled && (
        <>
          <div className="space-y-2">
            {EMBEDDING_PRESETS.map((preset) => (
              <PresetRow
                key={preset.id}
                preset={preset}
                isActive={activePresetId === preset.id}
                isExpanded={!!expanded[preset.id]}
                draft={draft}
                setDraft={setDraft}
                onPick={() => onPickPreset(preset)}
                onToggleExpand={() => toggleExpand(preset.id)}
              />
            ))}
          </div>

          <div className="space-y-3 rounded-md border p-3">
            <div className="text-sm font-medium">
              {t("settings.sections.embedding.chunking")}
            </div>

            <div className="space-y-2">
              <Label>{t("settings.sections.embedding.maxChunkChars")}</Label>
              <Input
                type="number"
                min={200}
                step={100}
                value={draft.embeddingMaxChunkChars ?? ""}
                onChange={(e) => {
                  const v = e.target.value.trim()
                  setDraft(
                    "embeddingMaxChunkChars",
                    v === "" ? undefined : Number(v),
                  )
                }}
                placeholder="1000"
              />
              <p className="text-xs text-muted-foreground">
                {t("settings.sections.embedding.maxChunkCharsHint")}
              </p>
            </div>

            <div className="space-y-2">
              <Label>{t("settings.sections.embedding.overlapChunkChars")}</Label>
              <Input
                type="number"
                min={0}
                step={50}
                value={draft.embeddingOverlapChunkChars ?? ""}
                onChange={(e) => {
                  const v = e.target.value.trim()
                  setDraft(
                    "embeddingOverlapChunkChars",
                    v === "" ? undefined : Number(v),
                  )
                }}
                placeholder="200"
              />
              <p className="text-xs text-muted-foreground">
                {t("settings.sections.embedding.overlapChunkCharsHint")}
              </p>
            </div>
          </div>

          {showLegacyMigration && (
            <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <div className="text-sm font-medium text-destructive">
                {t("settings.sections.embedding.legacyPromptTitle")}
              </div>
              <p className="text-xs text-muted-foreground">
                {t("settings.sections.embedding.legacyPromptBody", { count: legacyCount })}
              </p>
            </div>
          )}

          <div className="space-y-3 rounded-md border p-3">
            <div className="text-sm font-medium">
              {t("settings.sections.embedding.statsHeading")}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("settings.sections.embedding.chunkCount", { count: chunkCount ?? 0 })}
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleReindex}
                disabled={reindex.kind === "running" || !project}
              >
                {reindex.kind === "running"
                  ? t("settings.sections.embedding.reindexing", {
                      done: reindex.done,
                      total: reindex.total,
                    })
                  : t("settings.sections.embedding.reindexAll")}
              </Button>

              {legacyCount > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDropLegacy}
                  disabled={!project}
                >
                  {t("settings.sections.embedding.dropLegacy")}
                </Button>
              )}
            </div>

            {reindex.kind === "done" && (
              <p className="text-xs text-muted-foreground">
                {t("settings.sections.embedding.reindexDone", { count: reindex.count })}
              </p>
            )}

            {legacyDropped && (
              <p className="text-xs text-muted-foreground">
                {t("settings.sections.embedding.dropLegacyDone")}
              </p>
            )}

            {lastError && (
              <div className="space-y-1">
                <div className="text-xs font-medium">
                  {t("settings.sections.embedding.lastErrorHeading")}
                </div>
                <pre className="max-h-32 overflow-auto rounded bg-muted/50 p-2 text-[11px] leading-snug text-muted-foreground">
                  {lastError}
                </pre>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

interface PresetRowProps {
  preset: EmbeddingPreset
  isActive: boolean
  isExpanded: boolean
  draft: SettingsDraft
  setDraft: DraftSetter
  onPick: () => void
  onToggleExpand: () => void
}

function PresetRow({
  preset,
  isActive,
  isExpanded,
  draft,
  setDraft,
  onPick,
  onToggleExpand,
}: PresetRowProps) {
  const { t } = useTranslation()
  // For non-active rows, show the preset's defaults so users can see
  // what they'd get; for active rows, show the live draft values.
  const endpoint = isActive ? draft.embeddingEndpoint : preset.defaultEndpoint ?? ""
  const apiKey = isActive ? draft.embeddingApiKey : ""
  const model = isActive ? draft.embeddingModel : ""

  return (
    <div
      className={`rounded-lg border transition-colors ${
        isActive ? "border-primary/60 bg-primary/5" : "border-border"
      }`}
    >
      <div className="flex items-center gap-3 px-3 py-2.5">
        <button
          type="button"
          onClick={onToggleExpand}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent"
        >
          {isExpanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </button>

        <button type="button" onClick={onToggleExpand} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{preset.label}</span>
            {isActive && (
              <span className="shrink-0 rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                {t("settings.sections.embedding.activeBadge", "Active")}
              </span>
            )}
          </div>
          {preset.hint && (
            <div className="mt-0.5 truncate text-xs text-muted-foreground">{preset.hint}</div>
          )}
        </button>

        <button
          type="button"
          onClick={onPick}
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
            isActive
              ? "border-primary bg-primary"
              : "border-muted-foreground/30 bg-muted-foreground/20 hover:bg-muted-foreground/30"
          }`}
          aria-label={isActive ? "Active" : "Activate"}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm ring-1 ring-black/10 transition-transform ${
              isActive ? "translate-x-4" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      {isExpanded && (
        <div className="space-y-4 border-t bg-background/50 px-4 py-3">
          <EmbeddingEndpointField
            value={endpoint}
            placeholder={preset.defaultEndpoint ?? "http://127.0.0.1:8080/v1/embeddings"}
            onChange={(v) => {
              if (!isActive) onPick()
              setDraft("embeddingEndpoint", v)
            }}
          />

          <div className="space-y-2">
            <Label>{t("settings.sections.embedding.apiKey")}</Label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => {
                if (!isActive) onPick()
                setDraft("embeddingApiKey", e.target.value)
              }}
              placeholder={t("settings.sections.embedding.apiKeyPlaceholder")}
            />
          </div>

          <div className="space-y-2">
            <Label>{t("settings.sections.embedding.model")}</Label>
            <ModelPicker
              value={model}
              suggestions={preset.suggestedModels ?? []}
              placeholder={preset.suggestedModels?.[0] ?? "embedding-model-id"}
              onChange={(v) => {
                if (!isActive) onPick()
                setDraft("embeddingModel", v)
              }}
            />
          </div>

          {isActive && <TestConnectionPill draft={draft} />}
        </div>
      )}
    </div>
  )
}

interface EmbeddingEndpointFieldProps {
  value: string
  placeholder: string
  onChange: (value: string) => void
}

function EmbeddingEndpointField({ value, placeholder, onChange }: EmbeddingEndpointFieldProps) {
  const { t } = useTranslation()
  const preview = useMemo(() => normalizeEmbeddingEndpoint(value), [value])

  function handleBlur() {
    if (preview.changed && preview.normalized !== value.trim()) {
      onChange(preview.normalized)
    }
  }

  const showHint = value.trim().length > 0 && (preview.changed || preview.warning)

  return (
    <div className="space-y-1.5">
      <Label>{t("settings.sections.embedding.endpoint")}</Label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={handleBlur}
        placeholder={placeholder}
      />
      {showHint && (
        <div
          className={`flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs ${
            preview.changed
              ? "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400"
              : "border-blue-500/40 bg-blue-500/5 text-blue-700 dark:text-blue-400"
          }`}
        >
          {preview.changed ? (
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : (
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          )}
          <div className="min-w-0 flex-1 space-y-0.5">
            {preview.changed && (
              <div>
                {t(
                  "settings.sections.embedding.endpointPreviewWillUse",
                  "Will use:",
                )}{" "}
                <code className="break-all rounded bg-background/60 px-1 py-0.5 font-mono">
                  {preview.normalized || "(empty)"}
                </code>
              </div>
            )}
            {preview.warning && <div>{preview.warning}</div>}
          </div>
        </div>
      )}
    </div>
  )
}

interface ModelPickerProps {
  value: string
  suggestions: string[]
  placeholder: string
  onChange: (value: string) => void
}

function ModelPicker({ value, suggestions, placeholder, onChange }: ModelPickerProps) {
  const hasSuggestions = suggestions.length > 0
  const isCustom = hasSuggestions && value.length > 0 && !suggestions.includes(value)

  return (
    <div className="space-y-2">
      {hasSuggestions && (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((m) => {
            const active = m === value
            return (
              <button
                key={m}
                type="button"
                onClick={() => onChange(m)}
                className={`rounded-md border px-2 py-0.5 text-xs font-mono transition-colors ${
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background hover:bg-accent hover:text-accent-foreground"
                }`}
              >
                {m}
              </button>
            )
          })}
          <button
            type="button"
            onClick={() => onChange("")}
            className={`rounded-md border px-2 py-0.5 text-xs transition-colors ${
              isCustom
                ? "border-primary/60 bg-primary/10 text-primary"
                : "border-dashed border-muted-foreground/40 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            }`}
          >
            {isCustom ? `Custom: ${value}` : "Custom…"}
          </button>
        </div>
      )}
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  )
}

type TestState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "result"; result: EmbeddingProbeResult }

function TestConnectionPill({ draft }: { draft: SettingsDraft }) {
  const { t } = useTranslation()
  const [state, setState] = useState<TestState>({ kind: "idle" })

  const run = async () => {
    setState({ kind: "running" })
    const result = await probeEmbedding({
      enabled: true,
      endpoint: draft.embeddingEndpoint,
      apiKey: draft.embeddingApiKey,
      model: draft.embeddingModel,
    })
    setState({ kind: "result", result })
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={run} disabled={state.kind === "running"}>
          {state.kind === "running"
            ? t("settings.sections.embedding.probeRunning", "Testing…")
            : t("settings.sections.embedding.probeButton", "Test connection")}
        </Button>
      </div>

      {state.kind === "result" && (
        <div
          className={`flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs ${
            state.result.ok
              ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
              : "border-rose-500/40 bg-rose-500/5 text-rose-700 dark:text-rose-400"
          }`}
        >
          {state.result.ok ? (
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : (
            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            {state.result.ok ? (
              <span>
                {t("settings.sections.embedding.probeOk", "OK")} ·{" "}
                {t("settings.sections.embedding.probeDims", "{{dims}}d", {
                  dims: state.result.dims,
                })}{" "}
                · {state.result.latencyMs}ms
              </span>
            ) : (
              <span className="break-words">{state.result.error}</span>
            )}
          </div>
        </div>
      )}

      {state.kind === "running" && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          <span>
            {t("settings.sections.embedding.probeContacting", "Contacting endpoint…")}
          </span>
        </div>
      )}
    </div>
  )
}
