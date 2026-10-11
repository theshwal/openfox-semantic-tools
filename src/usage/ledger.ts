import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * A tiny, durable record of what the agent actually reached for.
 *
 * The plugin ships capabilities and skills, but nothing before could say
 * whether they were used. A skill that is offered every turn and read never is
 * pure prompt overhead; a capability nobody was ever offered cannot be
 * evaluated at all. Those are different facts, so they are counted apart.
 *
 * What is deliberately absent: no endpoint, no credential, no file content, no
 * repository path. Only capability/skill NAMES and integers. That is what
 * makes the file safe to persist, to print, and to commit.
 */

export const LEDGER_FILE_NAME = 'semantic-usage.json'

/** Hard bounds. A long-lived install must not grow this without limit. */
const DEFAULT_MAX_NAMES = 64
const DEFAULT_MAX_DAYS = 30

export interface UsageSnapshot {
  readonly schema: 1
  /** Day buckets, `YYYY-MM-DD` -> `YYYY-MM-DD`, holding counts. */
  readonly days: Record<string, Record<string, { offered: number; used: number }>>
  /** Lifetime totals, kept so a purged day bucket never loses the signal. */
  readonly totals: Record<string, { offered: number; used: number }>
}

export interface UsageReportEntry {
  readonly name: string
  readonly offered: number
  readonly used: number
  /** used / offered, or null when it was never offered. */
  readonly usageRatio: number | null
  /** A readable rate, because a bare 0.0 invites misreading. */
  readonly usageRateLabel: string
}

export interface UsageReport {
  readonly advisory: true
  readonly schema: 1
  readonly generatedAt: string
  readonly windowDays: number
  readonly retainedDays: readonly string[]
  readonly totalOffered: number
  readonly totalUsed: number
  readonly capabilities: readonly UsageReportEntry[]
  readonly note: string
}

const NOTE =
  'Counts and names only. No endpoint, credential, file content or repository path is recorded. "used" always counts real invocations. "offered" is counted for SKILLS, from the loads this plugin observes; for a TOOL it stays at zero, because a tool becomes reachable through the agent allowedTools, which this plugin never sees. A tool row therefore reads "available, never used" until it is actually called. No figure here is inferred.'

export interface UsageLedgerOptions {
  readonly maxNames?: number
  readonly maxDays?: number
}

interface Stored {
  readonly schema: 1
  readonly days: Record<string, Record<string, { offered: number; used: number }>>
  readonly totals: Record<string, { offered: number; used: number }>
  /** Shipped capability and skill names, so a reload keeps the floor. */
  readonly catalogue?: string[]
  /** Embedded so a human opening the file sees the report, not raw buckets. */
  readonly report?: UsageReport
}

/**
 * Default home for the ledger: the OpenFox config dir, never the repository.
 *
 * Deliberately outside any project: the counts describe how an AGENT behaves,
 * not what a repository contains, and a file inside the repo would be one more
 * thing a caller could commit by accident.
 */
export function defaultUsageLedgerDir(): string {
  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
    'openfox',
    'semantic-tools',
  )
}

/** Where the ledger lives. Placed next to the plugin config, not the repo. */
export function usageLedgerPath(baseDir?: string): string {
  return join(baseDir ?? defaultUsageLedgerDir(), LEDGER_FILE_NAME)
}

function today(now: Date): string {
  return now.toISOString().slice(0, 10)
}

function emptySnapshot(): UsageSnapshot {
  return { schema: 1, days: {}, totals: {} }
}

function increment(
  store: Record<string, { offered: number; used: number }>,
  name: string,
  field: 'offered' | 'used',
): void {
  const entry = store[name] ?? { offered: 0, used: 0 }
  entry[field] += 1
  store[name] = entry
}

export class UsageLedger {
  readonly #baseDir: string
  readonly #maxNames: number
  readonly #maxDays: number
  readonly #clock: () => Date
  #snapshot: UsageSnapshot
  /** Shipped capability and skill names, seeded at registration. */
  #catalogue = new Set<string>()
  #dirty = false

  constructor(
    baseDir: string,
    options: UsageLedgerOptions = {},
    clock: () => Date = () => new Date(),
  ) {
    this.#baseDir = baseDir
    this.#maxNames = options.maxNames ?? DEFAULT_MAX_NAMES
    this.#maxDays = options.maxDays ?? DEFAULT_MAX_DAYS
    this.#clock = clock
    this.#snapshot = UsageLedger.#loadFrom(baseDir)
    this.#catalogue = new Set(UsageLedger.#loadCatalogue(baseDir))
  }

  static #loadFrom(baseDir: string): UsageSnapshot {
    try {
      const parsed = JSON.parse(readFileSync(usageLedgerPath(baseDir), 'utf8')) as Stored
      if (parsed?.schema === 1 && parsed.days && parsed.totals) {
        return { schema: 1, days: parsed.days, totals: parsed.totals }
      }
    } catch {
      // A missing or corrupt ledger starts empty. Losing counters is
      // preferable to failing a tool call over bookkeeping.
    }
    return emptySnapshot()
  }

  /**
   * Reads the shipped-name floor written by a previous run.
   *
   * Separate from the counters because the two have different lifetimes:
   * counters are pruned, the catalogue is not.
   */
  static #loadCatalogue(baseDir: string): string[] {
    try {
      const parsed = JSON.parse(readFileSync(usageLedgerPath(baseDir), 'utf8')) as Stored
      return Array.isArray(parsed.catalogue) ? parsed.catalogue.filter((n) => typeof n === 'string') : []
    } catch {
      return []
    }
  }

  #prune(): void {
    const days = Object.keys(this.#snapshot.days).sort()
    while (days.length > this.#maxDays) {
      const oldest = days.shift()
      if (oldest !== undefined) delete this.#snapshot.days[oldest]
    }
    // Names are pruned from the day buckets AND from the totals, so a retired
    // capability stops being reported rather than lingering forever.
    const counts = new Map<string, number>()
    for (const bucket of Object.values(this.#snapshot.days)) {
      for (const [name, entry] of Object.entries(bucket)) {
        counts.set(name, (counts.get(name) ?? 0) + entry.offered + entry.used)
      }
    }
    if (counts.size <= this.#maxNames) return
    const ranked = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(this.#maxNames)
      .map(([name]) => name)
    const keep = new Set(ranked)
    for (const bucket of Object.values(this.#snapshot.days)) {
      for (const name of Object.keys(bucket)) {
        if (!keep.has(name)) delete bucket[name]
      }
    }
    for (const name of Object.keys(this.#snapshot.totals)) {
      if (!keep.has(name)) delete this.#snapshot.totals[name]
    }
  }

  /** Records that a set of capabilities/skills was presented to the agent. */
  noteOffered(names: readonly string[]): void {
    const bucketKey = today(this.#clock())
    const bucket = (this.#snapshot.days[bucketKey] ??= {})
    for (const name of names) {
      increment(bucket, name, 'offered')
      increment(this.#snapshot.totals, name, 'offered')
    }
    this.#prune()
    this.#markDirty()
  }

  /** Records a real invocation of one capability. */
  noteUsed(name: string): void {
    const bucketKey = today(this.#clock())
    const bucket = (this.#snapshot.days[bucketKey] ??= {})
    increment(bucket, name, 'used')
    increment(this.#snapshot.totals, name, 'used')
    this.#prune()
    this.#markDirty()
  }

  /**
   * Marks the ledger as needing a write, WITHOUT doing disk I/O.
   *
   * Writing synchronously on every tool call blocked the agent's event loop on
   * disk for optional bookkeeping, and a hot loop calls a tool every turn. The
   * counters are kept in memory and flushed when someone actually asks to read
   * them, or when `flushPending()` is called at shutdown.
   *
   * The cost of losing a few counts on a hard kill is the right trade here:
   * this is usage telemetry, not a ledger of record.
   */
  #markDirty(): void {
    this.#dirty = true
  }

  /** Writes the counters if anything changed since the last write. */
  async flushPending(): Promise<void> {
    if (!this.#dirty) return
    await this.writeReport()
  }

  /** True when a change is buffered and not yet on disk. */
  get hasPendingWrites(): boolean {
    return this.#dirty
  }

  /**
   * Synchronous flush, for a process `exit` handler where nothing async can run.
   *
   * Only the counters are written, not the rendered report: nobody is left to
   * read it at exit, and rendering costs a full pass over the ledger.
   */
  flushPendingSync(): void {
    if (!this.#dirty) return
    this.#persist()
  }

  #persist(): void {
    try {
      mkdirSync(this.#baseDir, { recursive: true })
      writeFileSync(
        usageLedgerPath(this.#baseDir),
        `${JSON.stringify({ ...this.#snapshot, catalogue: [...this.#catalogue] }, null, 2)}\n`,
        'utf8',
      )
      this.#dirty = false
    } catch {
      // Bookkeeping must never break a tool call. A ledger we cannot write is
      // a ledger we keep in memory for this process only.
      this.#dirty = true
    }
  }

  /**
 * Seeds the shipped catalogue so a fresh report lists every capability.
 *
 * `offered: 1` means "available", not "used once": it is the floor a real
 * usage count is read against, so a capability the agent ignored is
 * visibly different from one that was never shipped. Idempotent per name,
 * so a hot reload cannot inflate the count.
 */
  seed(names: readonly string[]): void {
    for (const name of names) {
      this.#catalogue.add(name)
    }
    this.#markDirty()
  }

  /** Synchronous view over whatever is in memory. */
  snapshot(): {
    readonly days: Record<string, Record<string, { offered: number; used: number }>>
    readonly totals: Record<string, { offered: number; used: number }>
    /** Lifetime offered counts, keyed by capability/skill name. */
    readonly offered: Record<string, number>
    /** Lifetime used counts, keyed by capability/skill name. */
    readonly used: Record<string, number>
    readonly totalUsed: number
    readonly totalOffered: number
  } {
    const offered: Record<string, number> = {}
    const used: Record<string, number> = {}
    let totalUsed = 0
    let totalOffered = 0
    for (const [name, entry] of Object.entries(this.#snapshot.totals)) {
      offered[name] = entry.offered
      used[name] = entry.used
      totalUsed += entry.used
      totalOffered += entry.offered
    }
    return {
      days: this.#snapshot.days,
      totals: this.#snapshot.totals,
      offered,
      used,
      totalUsed,
      totalOffered,
    }
  }

  report(): UsageReport {
    const snapshot = this.snapshot()
    // A shipped capability with no recorded use still appears: "available
    // and never used" is the finding this report exists to surface, and
    // dropping the row would hide exactly that.
    const names = new Set([...this.#catalogue, ...Object.keys(snapshot.totals)])
    const capabilities = [...names]
      .map((name) => ({
        name,
        offered: snapshot.offered[name] ?? 0,
        used: snapshot.used[name] ?? 0,
      }))
      .sort(
        (a, b) =>
          b.used - a.used ||
          b.offered - a.offered ||
          a.name.localeCompare(b.name),
      )
      .map((entry) => ({
        name: entry.name,
        offered: entry.offered,
        used: entry.used,
        usageRatio: entry.offered === 0 ? null : entry.used / entry.offered,
        usageRateLabel: label(entry.used, entry.offered),
      }))
    return {
      advisory: true,
      schema: 1,
      generatedAt: this.#clock().toISOString(),
      windowDays: this.#maxDays,
      retainedDays: Object.keys(snapshot.days).sort(),
      totalOffered: snapshot.totalOffered,
      totalUsed: snapshot.totalUsed,
      capabilities,
      note: NOTE,
    }
  }

  /**
   * Persists counters plus the readable report in one document.
   *
   * The embedded report is a rendering convenience for whoever opens the file.
   * It is never read back — `#loadFrom` and `#loadCatalogue` parse the counters
   * directly and the report is regenerated on demand — so it is small and a
   * stale copy can never disagree with a live one.
   */
  async writeReport(): Promise<string> {
    const report = this.report()
    const path = usageLedgerPath(this.#baseDir)
    mkdirSync(this.#baseDir, { recursive: true })
    const document = { ...this.#snapshot, catalogue: [...this.#catalogue], report }
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    this.#dirty = false
    return path
  }
}

function label(used: number, offered: number): string {
  if (offered === 0) {
    return used === 0
      ? 'available, never used'
      : 'used without being offered'
  }
  if (used === 0) return 'never used'
  const percent = Math.round((used / offered) * 100)
  if (percent >= 100) return 'used every time it was offered'
  return `used in ${percent}% of the turns where it was offered`
}