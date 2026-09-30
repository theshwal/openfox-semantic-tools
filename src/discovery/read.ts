import { readFile, lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { ProviderError } from '../errors.js'

/** Hard bounds on one discovery call. Exceeding any of them is a refusal. */
export const MAX_CANDIDATE_FILES = 40
export const MAX_FILE_BYTES = 16_000
export const MAX_TOTAL_BYTES = 120_000

export interface CandidateFile {
  /** Repository-relative path, POSIX-style, safe to show and to transmit. */
  readonly path: string
  readonly content: string
}

export interface BoundedRead {
  readonly files: readonly CandidateFile[]
  readonly bytes: number
  /** Requested paths that did not yield readable content. */
  readonly skipped: readonly string[]
}

function reject(message: string, code = 'invalid_arguments'): never {
  throw new ProviderError(code, message)
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
): Promise<BoundedRead> {
  if (!Array.isArray(paths) || paths.length === 0) {
    reject('Provide at least one candidate path to read')
  }
  if (paths.length > MAX_CANDIDATE_FILES) {
    reject(`Provide at most ${MAX_CANDIDATE_FILES} candidate paths, received ${paths.length}`)
  }

  // Resolve the root through symlinks so a symlinked root still contains the
  // files the caller addresses.
  let realRoot: string
  try {
    realRoot = await realpath(resolve(root))
  } catch {
    return reject('The repository root does not exist or is not readable')
  }

  const files: CandidateFile[] = []
  const skipped: string[] = []
  let bytes = 0

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
      skipped.push(raw)
      continue
    }
    if (stats.isSymbolicLink()) {
      reject(`Candidate path is a symbolic link and is refused: ${raw}`)
    }
    if (!stats.isFile()) {
      skipped.push(raw)
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

    const content = await readFile(target, 'utf8')
    if (!content.trim()) {
      skipped.push(raw)
      continue
    }
    bytes += Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_TOTAL_BYTES) {
      reject(`Assembled evidence exceeds the total evidence limit of ${MAX_TOTAL_BYTES} bytes`)
    }
    files.push({ path: relative(realRoot, real).split(sep).join('/'), content })
  }

  if (files.length === 0) {
    reject(
      'No readable file content was assembled. Narrow or correct the candidate paths before scanning.',
      'insufficient_evidence',
    )
  }

  return { files, bytes, skipped }
}
