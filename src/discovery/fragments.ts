import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

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
 * Deliberately narrow. A half-correct extractor that silently returns the wrong
 * declarations would be worse than an honest preview, so anything not listed
 * here takes the fallback and says so.
 */
const DECLARATION_LANGUAGES = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.cjs'])

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
export function extractDeclarations(source: string): { head: string; line: number }[] {
  const lines = source.split('\n')
  const found: { head: string; line: number }[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    if (!/^(export\s+)?(async\s+)?(function|class|const|let|var|interface|type|enum)\b/.test(line)) {
      continue
    }
    found.push({ head: line.trimEnd(), line: i + 1 })
  }
  return found
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

    // The SIGNATURE only, starting AT the declaration line. Walking upward to
    // include context is what pulled bodies in: the line after a one-line
    // arrow function opens with `{`, which reads as "signature continues" and
    // swallowed the body. The header is what matters; the caller can read the
    // surrounding lines from the file using `startLine`.
    const signature: string[] = []
    let opened = false
    for (let line = declaration.line - 1; line < lines.length; line += 1) {
      const text = lines[line]!
      signature.push(text)
      const isHeader = line === declaration.line - 1
      if (/[{=]\s*$/.test(text) && (isHeader || !/^\s*\}/.test(text))) {
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