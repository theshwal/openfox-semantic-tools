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
  ],
}

export function register(registry: PluginRegistry): void {
  registry.registerSettings(SETTINGS)
  registry.registerTool(createDecisionTool(() => registry.context.settings('global')))
}
