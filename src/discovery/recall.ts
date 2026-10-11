import { opendir, readFile, realpath } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

import { ProviderError } from '../errors.js'
import type { SkipReasonCode } from '../relevance/envelope.js'
import { MAX_FILE_BYTES, MAX_CANDIDATE_FILES } from './read.js'

export const MAX_RECALL_SCANNED_FILES = 2_000
export const MAX_LOCAL_RECALL_CANDIDATES = Math.min(24, MAX_CANDIDATE_FILES)

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.cache',
  'vendor',
  'target',
  '__pycache__',
])

export interface LocalRecallCandidate {
  readonly path: string
  readonly score: number
  readonly signals: readonly string[]
}

/** A file the walk saw but could not use as a candidate, and why. */
export interface RecallSkip {
  readonly path: string
  readonly reason: SkipReasonCode
}

export interface LocalRecallResult {
  readonly candidates: readonly LocalRecallCandidate[]
  readonly scannedFiles: number
  readonly scoredFiles: number
  readonly ignoredDirectories: number
  /**
   * Files seen but not scored.
   *
   * This is what makes "nothing matched" distinguishable from "nothing could
   * be read": an oversized or binary file never became a candidate, so its
   * absence from the result list says nothing about its relevance.
   */
  readonly skipped: readonly RecallSkip[]
}

function tokens(text: string): string[] {
  return [...new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2),
  )]
}

function countOccurrences(haystack: string, needle: string, cap: number): number {
  if (!needle) return 0
  let count = 0
  let offset = 0
  while (count < cap) {
    const next = haystack.indexOf(needle, offset)
    if (next < 0) break
    count += 1
    offset = next + needle.length
  }
  return count
}

/**
 * Dependency-free, repository-local first-stage recall.
 *
 * It deliberately uses only cheap lexical/path signals. It does not build an
 * index and it never transmits repository content. Only the resulting bounded
 * paths can later be read by the normal semantic stage.
 */
export async function localRecall(root: string, query: string): Promise<LocalRecallResult> {
  const queryTokens = tokens(query)
  if (queryTokens.length === 0) {
    throw new ProviderError('invalid_arguments', 'query must contain searchable terms')
  }

  let realRoot: string
  try {
    realRoot = await realpath(resolve(root))
  } catch {
    throw new ProviderError('invalid_arguments', 'The repository root does not exist or is not readable')
  }

  let scannedFiles = 0
  let scoredFiles = 0
  let ignoredDirectories = 0
  const scored: LocalRecallCandidate[] = []
  const skipped: RecallSkip[] = []

  async function walk(directory: string): Promise<void> {
    if (scannedFiles >= MAX_RECALL_SCANNED_FILES) return
    let dir
    try {
      dir = await opendir(directory)
    } catch {
      return
    }

    for await (const entry of dir) {
      if (scannedFiles >= MAX_RECALL_SCANNED_FILES) break
      if (entry.name.startsWith('.') && entry.name !== '.github') {
        if (entry.isDirectory()) ignoredDirectories += 1
        continue
      }
      if (entry.isSymbolicLink()) continue

      const full = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) {
          ignoredDirectories += 1
          continue
        }
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue

      scannedFiles += 1
      const rel = relative(realRoot, full).split(sep).join('/')
      const pathLower = rel.toLowerCase()

      let content = ''
      try {
        const raw = await readFile(full)
        // Keep the recall stage aligned with what the semantic reader can later
        // consume. Oversized or binary files are not valid semantic candidates,
        // so they are NAMED rather than silently dropped: the caller must be
        // able to see that a file existed and was never judged.
        if (raw.byteLength > MAX_FILE_BYTES) {
          skipped.push({ path: rel, reason: 'too-large' })
          continue
        }
        if (raw.includes(0)) {
          skipped.push({ path: rel, reason: 'binary' })
          continue
        }
        content = raw.toString('utf8').toLowerCase()
      } catch {
        skipped.push({ path: rel, reason: 'unreadable' })
        continue
      }
      if (!content.trim()) {
        skipped.push({ path: rel, reason: 'empty' })
        continue
      }

      let score = 0
      const signals: string[] = []
      for (const token of queryTokens) {
        const pathHits = countOccurrences(pathLower, token, 3)
        const contentHits = countOccurrences(content, token, 8)
        if (pathHits > 0) {
          score += pathHits * 4
          signals.push(`path:${token}`)
        }
        if (contentHits > 0) {
          score += Math.min(contentHits, 4)
          signals.push(`content:${token}`)
        }
      }
      const phrase = query.trim().toLowerCase()
      if (phrase.length >= 4 && content.includes(phrase)) {
        score += 6
        signals.push('content:exact')
      }
      if (phrase.length >= 4 && pathLower.includes(phrase)) {
        score += 8
        signals.push('path:exact')
      }
      if (score <= 0) continue

      scoredFiles += 1
      scored.push({ path: rel, score, signals: [...new Set(signals)] })
    }
  }

  await walk(realRoot)

  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  return {
    candidates: scored.slice(0, MAX_LOCAL_RECALL_CANDIDATES),
    scannedFiles,
    scoredFiles,
    ignoredDirectories,
    skipped,
  }
}
