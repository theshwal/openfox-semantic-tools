import { readFile, lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { ProviderError } from '../errors.js'
import type { SkipReasonCode } from '../relevance/envelope.js'
import { estimateTokens, tokenBudgetForPreset } from '../presets/token-budget.js'

/** Hard bounds on one discovery call. Exceeding any of them is a refusal. */
export const MAX_CANDIDATE_FILES = 40
export const MAX_FILE_BYTES = 16_000

/**
 * A coarse backstop on one assembled buffer, NOT the limit that governs a request.
 *
 * It was previously 120 000, which was an invented number in the wrong unit:
 * engines count TOKENS. Measured on the hosted endpoint, ~32.7k tokens are
 * accepted and ~60k are refused with HTTP 400 — a refusal that arrives AFTER the
 * request, so the caller saw an empty ranking with no stated reason.
 *
 * The budget that actually applies is `tokenBudgetForPreset`, enforced below.
 * This constant only stops a pathological read before it is tokenized.
 */
export const MAX_TOTAL_BYTES = 1_000_000

export interface CandidateFile {
  /** Repository-relative path, POSIX-style, safe to show and to transmit. */
  readonly path: string
  readonly content: string
}

/** A requested path that yielded no usable content, and why. */
export interface SkippedFile {
  /** Repository-relative path, POSIX-style, safe to display. */
  readonly path: string
  readonly reason: SkipReasonCode
}

export interface BoundedRead {
  readonly files: readonly CandidateFile[]
  readonly bytes: number
  /**
   * Every requested path that did not yield usable content, named one by one.
   *
   * A reason is recorded rather than the path merely being dropped: "this file
   * was never read" and "this file was read and found irrelevant" are opposite
   * conclusions, and a bare count cannot tell them apart.
   */
  readonly skipped: readonly SkippedFile[]
}

function reject(message: string, code = 'invalid_arguments'): never {
  throw new ProviderError(code, message)
}

/**
 * Renders skipped files so a refusal can still say WHAT was not read.
 *
 * An empty candidate set is exactly when this matters most: the caller
 * otherwise cannot tell "nothing matched" from "everything I asked for was
 * unreadable", and would conclude the code does not exist. Bounded, because
 * an unbounded list would put the whole repository into an error string.
 */
const MAX_SKIPPED_NAMED = 10

export function describeSkipped(skipped: readonly SkippedFile[]): string {
  if (skipped.length === 0) return ''
  const named = skipped.slice(0, MAX_SKIPPED_NAMED).map((entry) => `${entry.path} (${entry.reason})`)
  const rest = skipped.length - named.length
  return ` Not read: ${named.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}.`
}

/**
 * True when `child` is the root itself or lies under it. Comparison is done on
 * resolved paths so `..` segments and symlinked parents cannot escape.
 */
function isInside(root: string, child: string): boolean {
  if (child === root) return true
  return child.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * Reads an explicit, caller-supplied list of files under `root`.
 *
 * This is deliberately NOT a repository scan. The caller narrows the candidates
 * first, and this function only refuses what it cannot safely read:
 *
 * - too many candidates, or a file/total above the byte bounds;
 * - a path that escapes the root, including through a symlink;
 * - no readable content at all, which is reported as an explicit refusal rather
 *   than an empty result that would read as "nothing is relevant".
 *
 * Nothing is ever truncated: a cut file could drop the very code that answers
 * the query, which is the dangerous direction.
 */
export async function readBoundedCandidates(
  root: string,
  paths: readonly string[],
  options: { presetId?: string } = {},
): Promise<BoundedRead> {
  if (!Array.isArray(paths) || paths.length === 0) {
    reject('Provide at least one candidate path to read')
  }
  if (paths.length > MAX_CANDIDATE_FILES) {
    reject(`Provide at most ${MAX_CANDIDATE_FILES} candidate paths, received ${paths.length}`)
  }

  // The budget that actually governs a request, in TOKENS. Measured against
  // real engines, because a byte ceiling is the wrong unit and getting it
  // wrong is invisible until the provider refuses the request.
  const tokenBudget = tokenBudgetForPreset(options.presetId)

  // Resolve the root through symlinks so a symlinked root still contains the
  // files the caller addresses.
  let realRoot: string
  try {
    realRoot = await realpath(resolve(root))
  } catch {
    return reject('The repository root does not exist or is not readable')
  }

  const files: CandidateFile[] = []
  const skipped: SkippedFile[] = []
  let bytes = 0
  // Tracked alongside bytes because bytes do not govern the request: tokens do.
  let tokens = 0

  for (const raw of paths) {
    if (typeof raw !== 'string' || !raw.trim()) reject('Every candidate path must be a nonempty string')
    if (raw.includes('\0')) reject('Candidate paths must not contain NUL bytes')
    if (isAbsolute(raw)) reject(`Candidate path must be relative to the root: ${raw}`)

    const target = resolve(realRoot, raw)
    if (!isInside(realRoot, target)) reject(`Candidate path escapes the root: ${raw}`)

    // lstat first: a symlink is refused outright rather than followed, so a link
    // can never pull foreign content into the transmitted state.
    const stats = await lstat(target).catch(() => null)
    if (stats === null) {
      skipped.push({ path: raw, reason: 'missing' })
      continue
    }
    if (stats.isSymbolicLink()) {
      reject(`Candidate path is a symbolic link and is refused: ${raw}`)
    }
    if (!stats.isFile()) {
      skipped.push({ path: raw, reason: 'not-a-file' })
      continue
    }
    if (stats.size > MAX_FILE_BYTES) {
      reject(
        `Candidate ${raw} (${stats.size} bytes) exceeds the per-file limit of ${MAX_FILE_BYTES} bytes`,
      )
    }

    // The resolved path must still be inside after any intermediate symlink.
    const real = await realpath(target).catch(() => null)
    if (real === null || !isInside(realRoot, real)) {
      reject(`Candidate path escapes the root: ${raw}`)
    }

    let content: string
    try {
      content = await readFile(target, 'utf8')
    } catch {
      skipped.push({ path: raw, reason: 'unreadable' })
      continue
    }
    if (content.includes('\0')) {
      skipped.push({ path: raw, reason: 'binary' })
      continue
    }
    if (!content.trim()) {
      skipped.push({ path: raw, reason: 'empty' })
      continue
    }
    bytes += Buffer.byteLength(content, 'utf8')
    // Stop ADDING once the token budget is spent, and NAME what did not fit.
    //
    // Rejecting the whole call was the old behaviour, and it blamed the caller
    // for a limit it never saw: recall assembled the evidence, and the search
    // died before the rerank stage could run at all. Dropping the surplus is
    // safe because those files are reported as skipped, so a short result is
    // never read as "nothing else was relevant".
    if (tokens + estimateTokens(content) > tokenBudget) {
      skipped.push({ path: raw, reason: 'evidence-budget' })
      continue
    }
    tokens += estimateTokens(content)
    if (bytes > MAX_TOTAL_BYTES) {
      reject(`Assembled evidence exceeds the total evidence limit of ${MAX_TOTAL_BYTES} bytes`)
    }
    files.push({ path: relative(realRoot, real).split(sep).join('/'), content })
  }

  if (files.length === 0) {
    reject(
      'No readable file content was assembled. Narrow or correct the candidate paths before scanning.' +
        describeSkipped(skipped),
      'insufficient_evidence',
    )
  }

  return { files, bytes, skipped }
}
