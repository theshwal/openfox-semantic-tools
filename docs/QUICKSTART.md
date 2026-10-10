# Quickstart

Install the plugin and make your first semantic call. About five minutes.

Everything else is in the [user guide](./USER-GUIDE.md).

---

## 1. Prerequisites

- **OpenFox 2.0.161 or later** — check with `openfox --version`
- **Node.js 24+** — check with `node --version`

## 2. Install

```bash
git clone https://github.com/theshwal/openfox-semantic-tools.git
cd openfox-semantic-tools
npm ci --ignore-scripts
npm run build
```

> Do **not** install the packed `.tgz`. It ships without a `tsconfig.json`, so
> the host's build step fails. Why: [INSTALLATION.md](./INSTALLATION.md).

## 3. Add it to OpenFox

**Settings → Plugins → Source d'installation: Chemin local**, then paste the
absolute path of your checkout (it **must start with `/`**):

```
/home/you/openfox-semantic-tools
```

Then click **Installer**, then **enable** the plugin.

You should see the plugin listed with its icon and the author `theshwal`.

## 4. Configure the endpoint

In the plugin's settings, fill in **`endpoint`** — the full POST URL of a
System One-compatible runtime:

```
https://example.com/v1/systemone
```

That is the only required setting. Add `apiKey` if your endpoint needs one.

Leave `contextReduce` **off**. Its recorded verdict is DEFER: no benefit has
been measured.

## 5. Allow the tool

Plugin tools are **not** granted by installing. Go to **Settings → Agents**,
and add `semantic_decide` to that agent's `allowedTools`. Without this the agent
cannot call it, and you will see a refusal rather than a result.

## 6. Make your first call

Ask your agent something, or call the tool directly:

```json
{
  "state": "The handler returns HTTP 500 when the database is unreachable.",
  "questions": {
    "is_a_bug": {
      "type": "noul",
      "instructions": "Does this state describe a defect rather than intended behaviour?"
    }
  }
}
```

You get back a probability:

```json
{
  "provider": "system-one",
  "answers": { "is_a_bug": { "type": "noul", "probability": 0.94 } },
  "latencyMs": 412
}
```

A high probability is **not** a verdict. Check it against the code as you
normally would — the plugin exists to prioritise your attention, not to replace
it.

## 7. Check the wiring

```bash
npm run verify:local
```

Runs every offline check, contacts no provider, then tells you what remains to
try by hand.

---

## If something goes wrong

| Message | Fix |
| --- | --- |
| `Configure a full System One endpoint…` | `endpoint` is empty. |
| The agent refuses the call | The tool is not in that agent's `allowedTools`. |
| Every call fails on a `score` question | `score` criteria must be an ordered **array**. |
| Nothing happens after enabling `contextReduce` | Expected. Run `semantic_transform_status`; it reports the reason. |

More: [USER-GUIDE.md §6](./USER-GUIDE.md#6-troubleshooting).