import { createDecisionTool } from './tool.js'
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
      options: [
        {
          value: 'jev',
          label: { en: 'Jev (hosted)', fr: 'Jev (hébergé)' },
        },
        {
          value: 'custom',
          label: {
            en: 'Custom / local System One',
            fr: 'System One personnalisé / local',
          },
        },
      ],
      default: 'custom',
    },
    {
      key: 'endpoint',
      type: 'text',
      label: { en: 'System One endpoint', fr: 'Endpoint System One' },
      description: {
        en: 'Full POST endpoint. Provider presets may supply a default later.',
        fr: 'Endpoint POST complet. Les presets fournisseur pourront fournir une valeur par défaut plus tard.',
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
  ],
}

export function register(registry: PluginRegistry): void {
  registry.registerSettings(SETTINGS)
  registry.registerTool(createDecisionTool(() => registry.context.settings('global')))
}
