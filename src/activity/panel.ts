import type {
  DeclarativeNode,
  LocalizedString,
  PluginRegistry,
  PluginToolContext,
  PluginUiAction,
  PluginUiPanel,
} from 'openfox/plugin'

import {
  ActivityStore,
  classifyActivity,
  parseActivityPanelEnabled,
  type ActivityVerdict,
} from './index.js'

/**
 * The Stats-panel section reporting how the semantic tools were used.
 *
 * It is a declarative component on the host-rendered `stats.modal` zone, so it
 * brings no React and no core change. It renders only what the registry can
 * prove: counts, timings, unusable answers and repeated questions. Every line
 * carries its proof level, and a call with no evidence is reported as
 * indeterminate rather than as useless.
 */

export const ACTIVITY_ACTION_ID = 'semantic-tools-activity'
export const ACTIVITY_ACTION_SLOT = 'session.header.actions'
export const ACTIVITY_PANEL_ID = 'semantic-tools-activity'
export const ACTIVITY_RPC_METHOD = 'semanticActivity'

/** A small activity glyph, drawn on the same 24-unit grid as the plugin icon. */
const ACTIVITY_ICON = 'M3 12h4l3 8 4-16 3 8h4'

/**
 * Shown when the session on screen has no recorded semantic call.
 *
 * Silence would read as a broken panel; this says what the number means, and
 * that recording only starts at the first call.
 */
const NO_ACTIVITY_SECTION: ActivityVerdict = {
  advisory: true,
  status: 'observed-propensity',
  note: '',
  calls: [],
  totalCalls: 0,
  totalLatencyMs: 0,
  toolMix: [],
  abandoned: 0,
  fellBackToLocal: 0,
  unusableAnswers: 0,
  repeatedQuestion: 0,
  narrowedQuestion: 0,
  heuristicNonConclusive: 0,
  passCandidate: 0,
  policyUnknown: 0,
  policyNeedsWork: 0,
  indeterminate: 0,
  conclusive: 0,
  coverageCovered: 0,
  coverageMissing: 0,
  coverageUncertain: 0,
  gateReasons: [],
}

function text(en: string, fr: string): LocalizedString {
  return { en, fr }
}

function number(value: number): string {
  return value.toLocaleString('en-US')
}


/**
 * Whether the operator's interface is French.
 *
 * `card`, `text` and `details` carry a `LocalizedString`, so the client picks
 * their language itself from its own `locale` state. A `table` carries PLAIN
 * STRINGS, which is why the rows above had to guess — so the guess is replaced
 * by a read: the host stores the display locale as the `display.locale`
 * setting, and a failure to read it costs one line of the panel, nothing more.
 */
/**
 * The language of the TABLE rows.
 *
 * `card`, `text` and `details` carry a `LocalizedString`, so the client picks
 * their language itself. A `table` carries plain strings and therefore has to
 * be told. The host forwards neither a locale nor `Accept-Language` to a plugin
 * RPC — verified in 2.0.161, where the handler context is only
 * `{sessionId, workdir, projectId}` — so the rows follow the `locale` PARAMETER
 * when the caller sends one and stay English otherwise.
 */
function isFrench(
  params: Record<string, unknown>,
  readSettings: (projectId?: string) => Record<string, unknown>,
  projectId?: string,
): boolean {
  // An explicit param wins, so a caller can always override for one open.
  const asked = params.locale ?? params.lang
  if (typeof asked === 'string') return asked.toLowerCase().startsWith('fr')
  try {
    return readSettings(projectId)?.activityLocale === 'fr'
  } catch {
    // A settings read can throw for secret-bearing reasons. The language is
    // cosmetic, so the English default stands rather than failing the panel.
    return false
  }
}

/**
 * The sentence the panel opens with.
 *
 * It names the outcome per TOOL, not as grand totals, because "3 searches and 1
 * verification" is what the reader recognises; totals make them do the sum. The
 * sentence is built from the same buckets as the rows, so it cannot disagree
 * with them, and it never dresses a non-answer as a result.
 */
function narrate(verdict: ActivityVerdict, fr: boolean): string {
  const n = (count: number): string => String(count)
  if (verdict.totalCalls === 0) return fr ? 'aucun appel' : 'no call'
  const failed = verdict.abandoned
  const usable = verdict.unusableAnswers
  const nothing = verdict.indeterminate
  const off = verdict.policyNeedsWork + verdict.policyUnknown
  const plural = (count: number, one: string, many: string): string =>
    `${n(count)} ${count === 1 ? one : many}`

  // The dominant outcome, stated plainly.
  let shape: string
  if (failed >= verdict.totalCalls / 2) {
    shape = fr
      ? `${n(failed)} appel${failed === 1 ? '' : 's'} sur ${n(verdict.totalCalls)} ont échoué avant toute réponse`
      : `${n(failed)} of ${n(verdict.totalCalls)} calls failed before any answer`
  } else if (usable > 0) {
    shape = fr
      ? `${plural(usable, 'réponse était', 'réponses étaient')} inexploitable${usable === 1 ? '' : 's'}`
      : `${plural(usable, 'answer was', 'answers were')} unusable`
  } else if (off > 0) {
    shape = fr
      ? `${plural(off, 'vérification n\'a pas pu', 'vérifications n\'ont pas pu')} conclure`
      : `${plural(off, 'check could not', 'checks could not')} conclude`
  } else {
    shape = fr
      ? `${plural(verdict.totalCalls, 'appel, aucun échec', 'appels, aucun échec')}`
      : `${plural(verdict.totalCalls, 'call, nothing failed', 'calls, nothing failed')}`
  }

  const rest: string[] = []
  if (nothing > 0 && failed < verdict.totalCalls / 2) {
    rest.push(fr ? `${n(nothing)} sans verdict d\'aucun côté` : `${n(nothing)} with no verdict either way`)
  }
  const reasked = verdict.repeatedQuestion + verdict.narrowedQuestion
  if (reasked > 0) {
    rest.push(fr ? `${n(reasked)} redemandée${reasked === 1 ? '' : 's'}` : `${n(reasked)} re-asked`)
  }
  return rest.length > 0 ? `${shape}, ${rest.join(', ')}` : shape
}

/**
 * The section's child nodes.
 *
 * A panel body is a LIST of nodes, so the wrapper the component used to need is
 * unwrapped here rather than nested.
 */
function sectionChildren(verdict: ActivityVerdict, fr: boolean): DeclarativeNode[] {
  const section = buildActivitySection(verdict, fr)
  return (section as { children?: DeclarativeNode[] }).children ?? []
}

/**
 * Builds the section. Returns an empty stack when there is nothing to report,
 * which is what keeps the zone invisible for a session that never called a
 * semantic tool.
 */
export function buildActivitySection(verdict: ActivityVerdict, fr = false): DeclarativeNode {
  if (verdict.totalCalls === 0) {
    return {
      type: 'stack',
      direction: 'column',
      gap: 'sm',
      children: [
        {
          type: 'card',
          title: text('Semantic tools', 'Outils sémantiques'),
          tone: 'neutral',
          children: [
            {
              type: 'text',
              muted: true,
              text: text(
                'No semantic tool was called in this session. Counting starts at the first call and everything stays in memory for the length of the session.',
                'Aucun outil sémantique n\'a été appelé dans cette session. Le comptage commence au premier appel et tout reste en mémoire pour la durée de la session.',
              ),
            },
          ],
        },
      ],
    }
  }

  /**
   * One row per CALL OUTCOME, and the buckets are exhaustive and mutually
   * exclusive: every call lands in exactly one of them, so the rows reconcile
   * against "Semantic calls" instead of leaving a reader to find the
   * remainder.
   */
  const rows: Array<{ key: LocalizedString; value: string }> = []
  const L = (label: LocalizedString): string => (fr ? label.fr : label.en)

  // WAY B: the panel opens with a sentence, not with a total. It says what
  // happened, so a reader never has to add the rows up themselves.
  rows.push({ key: text('What happened', 'Ce qui s\'est passé'), value: narrate(verdict, fr) })
  rows.push({
    key: text('Provider time', 'Temps fournisseur'),
    value: `${number(verdict.totalLatencyMs)} ms`,
  })

  if (verdict.abandoned > 0) {
    rows.push({
      key: text('Failed before an answer', 'Échecs avant réponse'),
      value: number(verdict.abandoned),
    })
  }
  if (verdict.fellBackToLocal > 0) {
    rows.push({
      key: text('Provider failed, local ranking used instead', 'Fournisseur en échec, classement local utilisé'),
      value: number(verdict.fellBackToLocal),
    })
  }
  if (verdict.unusableAnswers > 0) {
    rows.push({
      key: text('Answer unusable', 'Réponse inexploitable'),
      value: number(verdict.unusableAnswers),
    })
  }
  if (verdict.repeatedQuestion > 0) {
    rows.push({
      key: text('Asked again identically', 'Redemandée à l\'identique'),
      value: number(verdict.repeatedQuestion),
    })
  }
  if (verdict.narrowedQuestion > 0) {
    rows.push({
      key: text('Re-asked more narrowly', 'Redemandée plus précisément'),
      value: number(verdict.narrowedQuestion),
    })
  }
  if (verdict.heuristicNonConclusive > 0) {
    rows.push({
      key: text('Looks like the same subject', 'Ressemble au même sujet'),
      value: number(verdict.heuristicNonConclusive),
    })
  }
  /**
   * CHECK OUTCOMES, kept out of the call table on purpose.
   *
   * A verification call can report `unknown` AND `off-scope` at once, so these
   * numbers are outcomes of checks, not calls. Listing them beside the call
   * rows made the column look additive when it is not: 4 failed + 1 off-scope
   * + 2 no-verdict read as 7 against a total of 6.
   */
  const checkRows: Array<{ key: LocalizedString; value: string }> = []
  if (verdict.passCandidate > 0) {
    checkRows.push({ key: text('Pass candidate', 'Candidat au succès'), value: number(verdict.passCandidate) })
  }
  if (verdict.policyUnknown > 0) {
    checkRows.push({
      key: text('Unknown or insufficient evidence', 'Inconnu ou preuves insuffisantes'),
      value: number(verdict.policyUnknown),
    })
  }
  if (verdict.policyNeedsWork > 0) {
    checkRows.push({
      key: text('Off-scope or needs verification', 'Hors périmètre ou à vérifier'),
      value: number(verdict.policyNeedsWork),
    })
  }
  if (verdict.coverageCovered + verdict.coverageMissing + verdict.coverageUncertain > 0) {
    checkRows.push({
      key: text('Criteria covered / missing / uncertain', 'Critères couverts / manquants / incertains'),
      value: `${verdict.coverageCovered} / ${verdict.coverageMissing} / ${verdict.coverageUncertain}`,
    })
  }
  // The reasons the policy itself emitted, counted and never reinterpreted.
  for (const entry of verdict.gateReasons) {
    checkRows.push({
      key: text(`Reason: ${entry.reason}`, `Raison : ${entry.reason}`),
      value: number(entry.count),
    })
  }

  // Which tools were used, as a share OF THE SEMANTIC CALLS: the only
  // denominator observable without a session hook. Named once, here.
  //
  // Each tool is its own `keyValue` row rather than one row with embedded
  // newlines: the host renders a `keyValue` value through plain text
  // interpolation, so a "\n" collapses to a single space in the DOM.
  const toolRows = verdict.toolMix.map((entry) => ({
    key: text(entry.tool, entry.tool),
    value: `${entry.count} · ${Math.round(entry.share * 100)}%`,
  }))

  // Stated positively so a reader never reads silence as a negative verdict.
  rows.push({
    key: text('No verdict either way', 'Sans verdict'),
    value: number(verdict.indeterminate),
  })

  return {
    type: 'stack',
    direction: 'column',
    gap: 'sm',
    children: [
      {
        type: 'card',
        title: text('Semantic tools', 'Outils sémantiques'),
        tone: 'neutral',
        children: [
          {
            // A TABLE, not a keyValue grid: the host renders keyValue as
            // `grid-cols-[auto_1fr]`, so a long label pushes the value into a
            // column narrow enough to wrap "43.229 ms" onto two lines. A table
            // fills the panel width and keeps each value on one line.
            type: 'table',
            columns: [text('Measure', 'Mesure'), text('Value', 'Valeur')],
            rows: rows.map((row) => [L(row.key), row.value]),
          },
          // Check outcomes get their OWN table with a heading that says they
          // are not calls: one verification can yield several of them.
          ...(checkRows.length > 0
            ? [
                {
                  type: 'text',
                  muted: true,
                  text: text(
                    'Check outcomes — not calls: one check can produce several',
                    'Résultats des vérifications — pas des appels : une vérification peut en produire plusieurs',
                  ),
                } satisfies DeclarativeNode,
                {
                  type: 'table',
                  columns: [text('Outcome', 'Résultat'), text('Count', 'Nombre')],
                  rows: checkRows.map((row) => [L(row.key), row.value]),
                } satisfies DeclarativeNode,
              ]
            : []),
          // One table per tool, so each gets its own line in the DOM
          // instead of collapsing into a single run-on string.
          ...(toolRows.length > 0
            ? [
                {
                  type: 'text',
                  muted: true,
                  text: text('Tools used', 'Outils utilisés'),
                } satisfies DeclarativeNode,
                {
                  type: 'table',
                  columns: [text('Tool', 'Outil'), text('Calls', 'Appels')],
                  rows: toolRows.map((row) => [L(row.key), row.value]),
                } satisfies DeclarativeNode,
              ]
            : []),
          {
            type: 'details',
            title: text('How to read this', 'Comment le lire'),
            defaultOpen: false,
            children: [
              {
                type: 'text',
                muted: true,
                text: text(
                  'Observed usage for this session only, recorded from each tool\'s own report. Every percentage is a share of the SEMANTIC calls made here, because the host\'s total tool-call count is not reachable from a plugin. This counts what was called and how often an answer was not usable; it does not claim the semantic path is better than the deterministic one, and a call with no verdict is never counted as useless.',
                  'Usage observé pour cette session uniquement, enregistré depuis le rapport de chaque outil. Chaque pourcentage est une part des appels SÉMANTIques effectués ici, car le nombre total d\'appels d\'outils de l\'hôte n\'est pas accessible depuis un plugin. Compte ce qui a été appelé et la fréquence de réponses inexploitables ; ne prétend pas que le chemin sémantique est meilleur que le déterministe, et un appel sans verdict n\'est jamais compté comme inutile.',
                ),
              },
            ],
          },
        ],
      },
    ],
  }
}

/**
 * The header action that opens the activity panel.
 *
 * It is an ACTION opening a PANEL rather than a component mounted into a host
 * zone. The zone `stats.modal` was the first choice and is unusable in practice:
 * the host only mounts that modal once `sessionStats` is non-null, and that
 * value comes from `computeSessionStatsSummary`, so for a session with no
 * completed model turn the zone is never rendered and the section is invisible.
 * Owning the panel removes that dependency entirely.
 */
export function createActivityAction(): PluginUiAction {
  return {
    id: ACTIVITY_ACTION_ID,
    slot: ACTIVITY_ACTION_SLOT,
    label: { en: 'Semantic', fr: 'Sémantique' },
    icon: ACTIVITY_ICON,
    variant: 'ghost',
    tooltip: {
      en: 'How the semantic tools were used in this session',
      fr: 'Usage des outils sémantiques dans cette session',
    },
    visibleWhen: { hasSession: true },
    onActivate: { kind: 'openPanel', panelId: ACTIVITY_PANEL_ID },
  }
}

/**
 * The panel declaration.
 *
 * `content` is the static state shown before anything resolves. The host calls
 * the plugin's `initPanel` RPC on open, so the same RPC that fills a component
 * fills this panel; a failed call leaves the honest placeholder rather than an
 * empty panel.
 */
export function createActivityPanel(): PluginUiPanel {
  return {
    id: ACTIVITY_PANEL_ID,
    title: { en: 'Semantic activity', fr: 'Activité sémantique' },
    size: 'lg',
    kind: 'declarative',
    content: [
      {
        type: 'text',
        muted: true,
        text: text('Loading…', 'Chargement…'),
      },
    ],
  }
}

/**
 * Builds the RPC that fills the section.
 *
 * It is a pure reader: it reads the in-memory registry and returns declarative
 * nodes. It contacts no provider, writes no setting and sends nothing.
 */
export function createActivityRpc(
  store: ActivityStore,
  readSettings: (projectId?: string) => Record<string, unknown>,
  hostBaseUrl?: string | undefined,
): (params: Record<string, unknown>, context: PluginToolContext) => { content: unknown[] } {
  return (params, context) => {
    let enabled = true
    try {
      enabled = parseActivityPanelEnabled(readSettings(context.projectId))
    } catch {
      enabled = true
    }
    // The host DOES forward the focused session to `initPanel`, verified against
    // 2.0.161, so the panel is scoped to the session on screen. The whole
    // registry is only a fallback for a panel opened with no session at all,
    // and says so rather than silently mixing sessions.
    const sessionId =
      context.sessionId ||
      (typeof params.sessionId === 'string' ? params.sessionId : undefined)
    if (!enabled) {
      return { content: [] }
    }
    const calls = sessionId ? store.callsFor(sessionId) : store.snapshot()
    if (calls.length === 0) {
      return { content: sectionChildren(NO_ACTIVITY_SECTION, isFrench(params, readSettings, context.projectId)) }
    }
    return { content: sectionChildren(classifyActivity(calls), isFrench(params, readSettings, context.projectId)) }
  }
}

/** Registers the Stats section and its RPC. */
export function registerActivityPanel(
  registry: PluginRegistry,
  store: ActivityStore,
  readSettings: (projectId?: string) => Record<string, unknown>,
  hostBaseUrl?: string,
): void {
  registry.registerUiAction(createActivityAction())
  registry.registerUiPanel(createActivityPanel())
  // The host fills a panel by calling `initPanel` on open, so THAT is the
  // method that must exist; the data RPC keeps its own name for a refresh.
  registry.registerRpc('initPanel', createActivityRpc(store, readSettings, hostBaseUrl))
  registry.registerRpc(ACTIVITY_RPC_METHOD, createActivityRpc(store, readSettings, hostBaseUrl))
}
