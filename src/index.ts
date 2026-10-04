import { createDecisionTool } from './tool.js'
import { createVerifyTool } from './verify/tool.js'
import { createIssueCoverageTool } from './verify/coverage.js'
import { createDiscoveryTool } from './discovery/tool.js'
import { DEFAULT_BACKEND_ID, PRESETS } from './presets/index.js'
import { SKILL_SOURCE } from './skills/source.js'
import { ADVISORY_VERIFICATION_WORKFLOW, advisoryWorkflowFor, listAdvisoryWorkflows } from './workflow/templates.js'
import { createProviderSelfTestTool } from './calibration/self-test.js'
import { createCalibrationCandidateTool } from './calibration/candidate-tool.js'
import { createQuestionCalibrationTool } from './calibration/question-tool.js'
import { createReferenceAgreementTool } from './calibration/reference-tool.js'

/**
 * Advisory workflow templates, exported as reference data.
 *
 * The plugin deliberately does NOT register them as behaviour: it registers no
 * transition handler and no hook, so it can never branch a workflow on a
 * semantic result. A workflow author opts in by copying a template, and removing
 * the semantic step leaves the deterministic checks and the normal verifier
 * intact.
 */
export { ADVISORY_VERIFICATION_WORKFLOW, advisoryWorkflowFor, listAdvisoryWorkflows }
import type {
  PluginRegistry,
  PluginSettingsSchema,
} from 'openfox/plugin'

export const SETTINGS: PluginSettingsSchema = {
  fields: [
    {
      key: 'backend',
      type: 'select',
      label: { en: 'Backend', fr: 'Backend' },
      description: {
        en: 'Use hosted Jev or any compatible System One HTTP endpoint.',
        fr: 'Utiliser Jev hébergé ou un endpoint HTTP System One compatible.',
      },
      options: PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
      default: DEFAULT_BACKEND_ID,
    },
    {
      key: 'endpoint',
      type: 'text',
      label: { en: 'System One endpoint', fr: 'Endpoint System One' },
      description: {
        en: 'Full POST endpoint. Always required: a preset supplies defaults and declared capabilities, never a host.',
        fr: 'Endpoint POST complet. Toujours requis : un preset fournit des défauts et des capacités déclarées, jamais un hôte.',
      },
      default: '',
    },
    {
      key: 'model',
      type: 'text',
      label: { en: 'Model override', fr: 'Modèle (optionnel)' },
      description: {
        en: 'Optional provider model id. Leave empty to use the backend default.',
        fr: 'Identifiant de modèle optionnel. Laisser vide pour utiliser le modèle par défaut du backend.',
      },
      default: '',
    },
    {
      key: 'runtimeVersion',
      type: 'text',
      label: { en: 'Runtime/model version', fr: 'Version runtime/modèle' },
      description: {
        en: 'Optional runtime or model revision used only to detect stale calibration profiles.',
        fr: 'Révision runtime ou modèle optionnelle, utilisée uniquement pour détecter les profils de calibration obsolètes.',
      },
      default: '',
    },
    {
      key: 'calibrationProfileJson',
      type: 'textarea',
      label: { en: 'Calibration profile (JSON)', fr: 'Profil de calibration (JSON)' },
      description: {
        en: 'Optional versioned profile. It affects verification only when its own active field is true; stale/unverified status remains visible in the self-test.',
        fr: 'Profil versionné optionnel. Il n\'agit sur la vérification que si son champ active vaut true ; un état stale/unverified reste visible dans le self-test.',
      },
      default: '',
    },
    {
      key: 'calibrationOverridesJson',
      type: 'textarea',
      label: { en: 'Calibration overrides (JSON)', fr: 'Overrides de calibration (JSON)' },
      description: {
        en: 'Explicit operator overrides. These take precedence over an active profile and the conservative defaults.',
        fr: 'Overrides explicites de l\'opérateur. Ils sont prioritaires sur un profil actif et sur les valeurs conservatrices par défaut.',
      },
      default: '',
    },
    {
      key: 'apiKey',
      type: 'password',
      label: { en: 'API key', fr: 'Clé API' },
      description: {
        en: 'Optional for local endpoints. Never log this value.',
        fr: 'Optionnelle pour les endpoints locaux. Ne jamais journaliser cette valeur.',
      },
      secret: true,
    },
    {
      key: 'timeoutMs',
      type: 'number',
      label: { en: 'Timeout (ms)', fr: 'Timeout (ms)' },
      description: {
        en: 'Maximum provider request duration.',
        fr: 'Durée maximale d’une requête fournisseur.',
      },
      default: 5000,
    },
    {
      key: 'endpointClass',
      type: 'select',
      label: { en: 'Endpoint class', fr: 'Classe de l’endpoint' },
      description: {
        en: 'Auto-detect, or override whether the endpoint counts as local, private or remote for data-egress policy.',
        fr: 'Détection automatique, ou forcer la classe local/privé/distant pour la politique d’exfiltration de données.',
      },
      options: [
        { value: 'auto', label: { en: 'Auto-detect', fr: 'Détection automatique' } },
        { value: 'local', label: { en: 'Local', fr: 'Local' } },
        { value: 'private', label: { en: 'Private network', fr: 'Réseau privé' } },
        { value: 'remote', label: { en: 'Remote', fr: 'Distant' } },
      ],
      default: 'auto',
    },
    {
      key: 'egressPolicy',
      type: 'select',
      label: { en: 'Egress policy', fr: 'Politique d’exfiltration' },
      description: {
        en: 'Controls whether repository or session-derived content may be sent to a remote endpoint. Local and private endpoints are never blocked. Blocked calls return a structured failure and never reroute.',
        fr: 'Contrôle l’envoi de contenu issu du dépôt ou de la session vers un endpoint distant. Les endpoints locaux et privés ne sont jamais bloqués. Un appel bloqué renvoie un échec structuré et n’est jamais réacheminé.',
      },
      options: [
        {
          value: 'allow',
          label: { en: 'Allow', fr: 'Autoriser' },
        },
        {
          value: 'block-remote-automatic',
          label: {
            en: 'Block automatic remote calls (keep explicit calls)',
            fr: 'Bloquer les appels distants automatiques (garder les appels explicites)',
          },
        },
        {
          value: 'block-remote-all',
          label: { en: 'Block all remote calls', fr: 'Bloquer tous les appels distants' },
        },
      ],
      default: 'allow',
    },
    {
      key: 'cacheEnabled',
      type: 'boolean',
      label: { en: 'Decision cache', fr: 'Cache de décisions' },
      description: {
        en: 'Reuse an identical previous answer instead of calling the provider again. Off by default; only stored successful answers are reused, never an error.',
        fr: 'Réutilise une réponse identique au lieu d\'appeler à nouveau le fournisseur. Désactivé par défaut ; seules les réponses réussies sont réutilisées, jamais une erreur.',
      },
      default: false,
    },
    {
      key: 'cacheTtlMs',
      type: 'number',
      label: { en: 'Cache TTL (ms)', fr: 'TTL du cache (ms)' },
      description: {
        en: 'How long a cached answer may be reused. Zero disables reuse entirely.',
        fr: 'Durée pendant laquelle une réponse en cache peut être réutilisée. Zéro désactive toute réutilisation.',
      },
      default: 300000,
    },
    {
      key: 'cacheMaxEntries',
      type: 'number',
      label: { en: 'Cache max entries', fr: 'Entrées max du cache' },
      description: {
        en: 'Hard bound on stored answers, with oldest-first eviction.',
        fr: 'Limite stricte des réponses stockées, avec éviction de la plus ancienne.',
      },
      default: 128,
    },
  ],
}

export function register(registry: PluginRegistry): void {
  registry.registerSettings(SETTINGS)
  // `registry.context` is only readable WHILE a plugin is registering: the host
  // clears it in `endPlugin()` right after `register()` returns. Reading it
  // lazily from a tool closure would therefore throw
  // "Plugin context is only available while a plugin is registering" on the
  // first real execution, so the context object itself is captured now and used
  // later. The object stays a live view of the plugin's settings; only the
  // *accessor* is registration-scoped.
  const context = registry.context
  const readSettings = (projectId?: string) => context.settings('global', projectId)
  registry.registerTool(createDecisionTool(readSettings))
  registry.registerTool(createVerifyTool(readSettings))
  registry.registerTool(createIssueCoverageTool(readSettings))
  registry.registerTool(createDiscoveryTool('semantic_search', readSettings))
  registry.registerTool(createDiscoveryTool('semantic_scan', readSettings))
  registry.registerTool(createProviderSelfTestTool(readSettings))
  registry.registerTool(createCalibrationCandidateTool())
  registry.registerTool(createQuestionCalibrationTool(readSettings))
  registry.registerTool(createReferenceAgreementTool(readSettings))
  // Skills carry usage guidance only; they never grant tool access.
  registry.registerSkillSource(SKILL_SOURCE)
}
