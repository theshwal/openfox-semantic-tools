#!/usr/bin/env node
/**
 * Conformance CLI. The SUITE itself lives in `conformance-suite.ts`.
 *
 * This file only reads the environment, runs the one shared suite and writes
 * the report. It deliberately contains no case list and no protocol logic of
 * its own: `conformance-campaign.ts` and the tests import the same
 * `runConformanceSuite`, so `npm run conformance` and a campaign can never
 * disagree about what "the suite" checks. Two copies of a protocol suite would
 * each claim authority and drift apart silently.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { runConformanceSuite } from './conformance-suite.ts'

const startedAt = new Date().toISOString()

// Credentials and endpoint are read only from the process environment and never persisted.
const endpoint = process.env.SEMANTIC_ENDPOINT
if (!endpoint) throw new Error('Set SEMANTIC_ENDPOINT to the verified full POST endpoint')

const report = await runConformanceSuite({
  endpoint,
  ...(process.env.SEMANTIC_API_KEY ? { apiKey: process.env.SEMANTIC_API_KEY } : {}),
  ...(process.env.SEMANTIC_MODEL?.trim() ? { model: process.env.SEMANTIC_MODEL.trim() } : {}),
  ...(process.env.SEMANTIC_UNSUPPORTED_MODEL?.trim()
    ? { unsupportedModel: process.env.SEMANTIC_UNSUPPORTED_MODEL.trim() }
    : {}),
  ...(process.env.SEMANTIC_PROVIDER_ID?.trim() ? { providerId: process.env.SEMANTIC_PROVIDER_ID.trim() } : {}),
  ...(process.env.SEMANTIC_AUTH_PROBE === 'omit' ? { authProbe: 'omit' as const } : {}),
})

const out = resolve(process.argv[2] ?? 'benchmark/results/conformance')
await mkdir(out, { recursive: true })
await writeFile(
  resolve(out, 'report.json'),
  JSON.stringify(
    {
      ...report,
      /**
       * Campaign metadata.
       *
       * Everything here is either OPERATOR-DECLARED or OBSERVED-IN-THIS-RUN.
       * Nothing is inferred, and nothing is copied from a previous run:
       *
       * - `startedAt`/`finishedAt` — observed, this run only.
       * - `runtimeVersion` — OPERATOR-DECLARED, `null` when not supplied. It
       *   is a label the operator typed; nothing in this suite verifies it.
       * - `model` — the configured model id (operator-declared), `null` when
       *   none was configured. Never a model echoed back by a runtime.
       * - `command` — the fixed command that produces this report.
       *
       * The endpoint stays `redacted` and no API key, URL, header or private
       * path is written here.
       */
      campaign: {
        startedAt,
        finishedAt: new Date().toISOString(),
        runtimeVersion: process.env.SEMANTIC_RUNTIME_VERSION?.trim() || null,
        model: process.env.SEMANTIC_MODEL?.trim() || null,
        command: 'npm run conformance -- <report-directory>',
        // What each value is, so a reader never has to guess whether a field
        // was measured or merely declared.
        provenance: {
          startedAt: 'observed',
          finishedAt: 'observed',
          runtimeVersion: 'operator-declared',
          model: 'operator-declared',
          command: 'fixed',
        },
      },
    },
    null,
    2,
  ) + '\n',
)

console.log(
  `Conformance: ${report.matchedCases}/${report.totalCases} cases matched expectations; compatible=${report.compatible}; strictCompatible=${report.strictCompatible}; remoteEndpointObserved=${report.remoteEndpointObserved}; ${report.deviations.length} deviation(s). No provider identity is asserted.`,
)
if (!report.compatible || !report.strictCompatible) process.exitCode = 1