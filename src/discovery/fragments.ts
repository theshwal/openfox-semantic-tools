import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  MAX_QUESTIONS_PER_REQUEST,
  TOKENS_PER_QUESTION,
  estimateTokens,
  tokenBudgetForPreset,
} from '../presets/token-budget.js'

/**
 * Fragment-level evidence, the way the state of the art does it.
 *
 * THE PROBLEM THIS SOLVES
 * We were sending a whole file per question — ~4 000 tokens to decide whether
 * that file deserved a read. Measured on a 137-file repo, that budget is what
 * turned a few searches into 45 M tokens.
 *
 * WHAT OTHERS DO, READ RATHER THAN INVENTED
 *   - aider: SIGNATURES ONLY, bodies replaced by an ellipsis. Its cost is a
 *     function of symbol COUNT, not of file size.
 *   - Continue: keep the class header and each method SIGNATURE, collapse bodies
 *     to `{ ... }`, then drop methods from the end until the token count fits.
 *   - zvec-grep: index "symbols, signatures, breadcrumbs and surrounding source"
 *     per language, with a per-language size cap at INDEX time.
 *
 * WHAT WE DO
 * One fragment per declaration, carrying the declaration's signature and enough
 * context to judge it, with its line range so the caller can read the real
 * thing afterwards. When a file cannot be parsed, or is small enough to be
 * cheaper whole, it is sent whole — and that is STATED on the fragment, so a
 * short result is never mistaken for an exhaustive one.
 */

/** A fragment never exceeds this, whatever the file looked like. */
export const MAX_FRAGMENT_BYTES = 4_000

/**
 * Below this, sending the file whole is cheaper than fragmenting it.
 *
 * 1 200 bytes is ~300 tokens. Above it, fragmenting wins even on a small file:
 * a 2 KB file already costs 500 tokens to judge, and the declarations in it are
 * individually much cheaper.
 */
export const WHOLE_FILE_BYTES = 1_200

/** How the fragment was produced. Carried on every fragment, never implied. */
export type FragmentKind = 'declaration' | 'whole-file' | 'preview'

export interface Fragment {
  readonly path: string
  /** 1-based, inclusive. Lets the caller jump straight to the real code. */
  readonly startLine: number
  readonly endLine: number
  readonly text: string
  readonly bytes: number
  readonly kind: FragmentKind
  /** True only when the whole file is included, so `preview` is never a guess. */
  readonly wholeFile: boolean
  /** Why this fragment looks the way it does. */
  readonly source: string
}

/**
 * Languages we can pull declarations out of without a dependency.
 *
 * Python is here because it has to be: on a real 137-file repository, 15 335
 * files are Python and none are JavaScript or TypeScript. With the table
 * limited to JS/TS, every file scored there came back as a `preview`.
 *
 * Still narrow on purpose. A half-correct extractor that silently returns the
 * wrong declarations would be worse than an honest preview, so anything not
 * listed takes the fallback and says so.
 */
const DECLARATION_LANGUAGES = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.cjs',
  '.py', '.pyi',
])

/** Indented `def`, as found inside a Python class. */
const PY_METHOD = /^\s+(async\s+)?def\s+\w+/
/** Top-level `def`. */
const PY_FUNCTION = /^def\s+\w+/
/** `class`, at any indentation. */
const PY_CLASS = /^\s*class\s+\w+/
/** Module-level constant: NAME = value, or NAME: type = value. */
const PY_CONSTANT = /^[A-Z][A-Z0-9_]{2,}\s*(?::[^=]+)?=/

/** Lines kept around a declaration so the model can judge it in context. */
const CONTEXT_LINES = 2

/**
 * Pulls declaration signatures out of a source file.
 *
 * A regex, not a parser: it has to find the head of a declaration, which is a
 * far weaker requirement than understanding the file. It is anchored on the
 * line shape (`export`/`const`/`function`/`class` at column 0), so it does not
 * match calls inside a body — the failure mode that would produce a fragment
 * pointing at the wrong place.
 */
const JS_DECLARATION =
  /^(export\s+)?(async\s+)?(function|class|const|let|var|interface|type|enum)\b/

export function extractDeclarations(source: string): { head: string; line: number }[] {
  const lines = source.split('\n')
  const found: { head: string; line: number }[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    if (!JS_DECLARATION.test(line) && !isPythonDeclaration(line)) {
      continue
    }
    found.push({ head: line.trimEnd(), line: i + 1 })
  }
  return found
}

/**
 * Python: a `def` or `class`, at module level or indented inside a class.
 *
 * Indented `def`s are kept on purpose. A method is frequently what a caller
 * actually needs to open, and dropping it would send the agent to the class
 * when the useful code is three lines inside it.
 *
 * An `import` or a docstring cannot match any of these shapes, which is what
 * keeps a module header from being reported as a declaration.
 */
function isPythonDeclaration(line: string): boolean {
  return PY_METHOD.test(line) || PY_FUNCTION.test(line) || PY_CLASS.test(line) || PY_CONSTANT.test(line)
}

/**
 * Builds the evidence for a candidate list.
 *
 * One fragment per declaration. When nothing parses, or the file is small
 * enough that fragmenting it costs more than sending it, the whole file is
 * used — and the fragment records which of the two happened.
 */
export async function buildFragments(
  root: string,
  paths: readonly string[],
): Promise<Fragment[]> {
  const out: Fragment[] = []
  for (const raw of paths) {
    const target = resolve(root, raw)
    let source: string
    try {
      source = await readFile(target, 'utf8')
    } catch {
      continue
    }
    out.push(...fragmentsFor(raw, source))
  }
  return out
}

function fragmentFor(
  path: string,
  text: string,
  startLine: number,
  endLine: number,
  kind: FragmentKind,
  source: string,
): Fragment {
  const bounded = bound(text)
  return {
    path,
    startLine,
    endLine,
    text: bounded,
    bytes: Buffer.byteLength(bounded, 'utf8'),
    kind,
    wholeFile: kind === 'whole-file',
    source,
  }
}

function fragmentsFor(path: string, source: string): Fragment[] {
  const ext = path.slice(path.lastIndexOf('.'))
  const bytes = Buffer.byteLength(source, 'utf8')

  // Small enough that fragmenting costs more than sending: the whole file IS
  // the cheapest honest representation, and it is declared as such.
  if (bytes <= WHOLE_FILE_BYTES) {
    const lines = source.split('\n').length
    return [
      fragmentFor(path, source, 1, lines, 'whole-file', 'the whole file is smaller than a fragment set'),
    ]
  }

  if (!DECLARATION_LANGUAGES.has(ext)) {
    // Unparseable by design: preview the head, say why, never pretend.
    const lines = source.split('\n')
    const head = lines.slice(0, 40).join('\n')
    return [
      fragmentFor(
        path,
        head,
        1,
        Math.min(40, lines.length),
        'preview',
        `${ext || 'this file type'} is not fragmentable; the first 40 lines stand in for the rest`,
      ),
    ]
  }

  const declarations = extractDeclarations(source)
  if (declarations.length === 0) {
    const lines = source.split('\n')
    const head = lines.slice(0, 40).join('\n')
    return [
      fragmentFor(
        path,
        head,
        1,
        Math.min(40, lines.length),
        'preview',
        'no top-level declaration was found; the first 40 lines stand in for the rest',
      ),
    ]
  }

  const lines = source.split('\n')
  const isPython = ext === '.py' || ext === '.pyi'
  return declarations.map((declaration, index) => {
    const next = declarations[index + 1]
    // Everything up to the next declaration is this one's body; it is dropped
    // on purpose, keeping only a little context above and below.
    const bodyEnd = next ? next.line - 1 : lines.length
    const start = Math.max(1, declaration.line - CONTEXT_LINES)
    const end = Math.min(lines.length, Math.max(declaration.line, bodyEnd))

    // Trim trailing closing braces left over from the PREVIOUS declaration, so a
    // fragment starts on its own header instead of inheriting a stray `}`.
    let head = start
    while (head <= declaration.line && /^[\s}]*$/.test(lines[head - 1]!)) head += 1
    const from = Math.min(head, declaration.line)

    // The SIGNATURE only, starting AT the declaration line.
    //
    // Walking upward to include context is what pulled bodies in: the line
    // after a one-line arrow function opens with `{`, which reads as
    // "signature continues" and swallowed the body.
    const signature: string[] = []
    let opened = false
    const isAssignment = isPython && PY_CONSTANT.test(declaration.head)
    for (let line = declaration.line - 1; line < lines.length; line += 1) {
      const text = lines[line]!
      signature.push(text)
      const isHeader = line === declaration.line - 1
      // A Python signature ends at `:`, possibly several lines down; a JS one
      // ends at `{` or `=`. Testing both shapes on every line would stop a
      // wrapped Python signature at its first parameter, so the language
      // decides which terminator counts.
      const opensBody = isPython
        ? // A module-level assignment is complete on its header line: it has no
          // `:` and never wraps the way a `def` signature does. Without this it
          // would swallow the blank lines and the next declaration.
          isAssignment
          ? true
          : /:\s*$/.test(text)
        : /[{=]\s*$/.test(text) && (isHeader || !/^\s*\}/.test(text))
      if (opensBody) {
        opened = true
        break
      }
      if (line - (declaration.line - 1) > 20) break
    }
    const header = signature.join('\n')
    // Where the body ends, so the caller knows what range to read.
    const rangeEnd = opened
      ? Math.min(lines.length, Math.max(declaration.line, bodyEnd))
      : declaration.line

    return fragmentFor(
      path,
      `${header}\n${'… (body elided) …'}`,
      from,
      rangeEnd,
      'declaration',
      'declaration signature with its body elided; read the file for the body',
    )
  })
}

/** Never grows past the ceiling, and says so when it cuts. */
function bound(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= MAX_FRAGMENT_BYTES) return text
  let cut = text
  while (Buffer.byteLength(cut, 'utf8') > MAX_FRAGMENT_BYTES && cut.length > 0) {
    cut = cut.slice(0, Math.floor(cut.length * 0.9))
  }
  return `${cut}\n… (fragment truncated at ${MAX_FRAGMENT_BYTES} bytes) …`
}

/**
 * Trims a fragment set to the engine's token budget, keeping the strongest.
 *
 * The budget has to be applied HERE, not only at the file level: a budget
 * satisfied by 8 whole files can become 131 fragments once a file is split per
 * declaration, and 131 fragments is a 29k-token state the hosted engine refuses
 * with HTTP 400. Measured on a Python-heavy repository.
 *
 * A caller that omits `skipped` gets the trimming silently, which is why the
 * discovery tool always passes it: a trimmed fragment that nobody is told
 * about is exactly the "short result that reads as complete" failure.
 */
export function withinFragmentBudget(
  fragments: readonly Fragment[],
  options: {
    presetId?: string
    skipped?: { path: string; reason: 'evidence-budget' | 'candidate-limit' }[]
  } = {},
): Fragment[] {
  const budget = tokenBudgetForPreset(options.presetId)
  // Each kept fragment costs its instruction block too, so the per-question
  // cost is subtracted up front rather than discovered as a 400.
  const effective = Math.max(
    0,
    budget - Math.min(fragments.length, MAX_QUESTIONS_PER_REQUEST) * TOKENS_PER_QUESTION,
  )
  const kept: Fragment[] = []
  let tokens = 0
  for (const fragment of fragments) {
    const cost = estimateTokens(fragment.text)
    if (tokens + cost > effective) {
      options.skipped?.push({
        path: `${fragment.path}:${fragment.startLine}`,
        reason: 'evidence-budget',
      })
      continue
    }
    kept.push(fragment)
    tokens += cost
  }
  // Then cap the COUNT, since a fragment set can satisfy the byte budget and
  // still be too many questions for one call.
  if (kept.length > MAX_QUESTIONS_PER_REQUEST) {
    for (const fragment of kept.slice(MAX_QUESTIONS_PER_REQUEST)) {
      options.skipped?.push({
        path: `${fragment.path}:${fragment.startLine}`,
        reason: 'candidate-limit',
      })
    }
    return kept.slice(0, MAX_QUESTIONS_PER_REQUEST)
  }
  return kept
}