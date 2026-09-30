// Runs the real conformance suite against a local offline System One stub.
// This produces reproducible protocol evidence without any hosted or paid provider.
// It is NOT evidence of decision quality, latency or OpenFox end-to-end benefit.
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port = Number(process.env.SMOKE_PORT ?? 0) || 8899
const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/smoke-server.ts'], {
  env: { ...process.env, SMOKE_PORT: String(port) },
  stdio: ['ignore', 'pipe', 'inherit'],
})

const waitForServer = new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('smoke server did not start in time')), 10_000)
  child.stdout.on('data', (chunk: Buffer) => {
    if (String(chunk).includes('listening')) {
      clearTimeout(timer)
      resolve()
    }
  })
  child.on('exit', (code) => reject(new Error(`smoke server exited early with code ${code}`)))
})

let exitCode = 1
const out = await mkdtemp(join(tmpdir(), 'semantic-conformance-'))
try {
  await waitForServer
  exitCode = await new Promise<number>((resolve) => {
    const run = spawn(
      process.execPath,
      ['--import', 'tsx', 'scripts/conformance.ts', out],
      {
        env: {
          ...process.env,
          SEMANTIC_ENDPOINT: `http://127.0.0.1:${port}/v1/systemone`,
          SEMANTIC_PROVIDER_ID: 'offline-smoke-stub',
          SEMANTIC_MODEL: 'smoke-model',
          SEMANTIC_UNSUPPORTED_MODEL: 'unsupported-model-for-smoke',
          // Never forward real credentials to the local stub.
          SEMANTIC_API_KEY: '',
        },
        stdio: 'inherit',
      },
    )
    run.on('exit', (code) => resolve(code ?? 1))
  })
  if (exitCode === 0) console.log(`Offline conformance report written to ${out}`)
} finally {
  // Always stop the stub and remove the temporary directory, including when the
  // suite fails or the server never became ready.
  child.kill('SIGTERM')
  await rm(out, { recursive: true, force: true })
}

if (exitCode !== 0) process.exitCode = exitCode
