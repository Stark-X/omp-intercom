# omp-intercom

An [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) extension for two-way messaging with local OMP and Pi sessions, including sessions in other repositories. OMP and [pi-intercom](https://github.com/nicobailon/pi-intercom) share a broker. Each OMP session uses one connection and one identity for sending, receiving, and replying.

## Install

Verified with OMP **19.2.1** and pi-intercom **0.19.0**. The default broker launcher requires Node.js 20 or later on `PATH`.

```sh
git clone https://github.com/Stark-X/omp-intercom.git
cd omp-intercom
npm ci
omp -e "$PWD"
```

Passing the package directory loads the extension and discovers its bundled `intercom` skill. To load it on every launch, add the checkout's absolute path to `extensions` in your OMP `config.yml`.

```yaml
extensions:
  - /absolute/path/to/omp-intercom
```

In Pi, install the matching release with `pi install npm:pi-intercom@0.19.0`. Either harness can start the broker.

## Use

Ask OMP to find another session or coordinate with it. The extension exposes the `intercom` tool.

| Action | Arguments | Behavior |
| --- | --- | --- |
| `list` | | List connected peers with their names, session IDs, and working directories. |
| `send` | `to`, `message`, optional `noWake` | Deliver a message and report whether the broker delivered or queued it. |
| `ask` | `to`, `message` | Ask a connected peer and wait for its correlated reply. |
| `reply` | `message`, optional `replyTo` and `to` | Reply to an incoming ask. Use its `replyTo` ID if several asks are pending. |
| `status` | | Show the current session ID, connection state, and pending asks. |

Use a peer's name or a unique session ID prefix. Use the full session ID when names collide. Inbound messages wake idle OMP sessions by default. During an active turn they queue for a later turn. `noWake: true` makes a message available without starting a turn on its own.

## Configuration

OMP uses the default Pi broker directory `~/.pi/agent/intercom/`. If Pi uses a custom `PI_CODING_AGENT_DIR`, set `OMP_INTERCOM_PI_AGENT_DIR` to that same **Pi agent directory** when launching OMP. OMP's own agent directory remains separate. If you set `PI_INTERCOM_SCOPE_ID`, use the same value for both harnesses.

```sh
OMP_INTERCOM_PI_AGENT_DIR=/path/to/pi-agent OMP_INTERCOM_NAME=frontend omp -e "$PWD"
```

By default the extension uses the OMP session ID and name. `OMP_INTERCOM_NAME` overrides the display name. `OMP_INTERCOM_STABLE_ID` pins the broker address for a particular OMP instance. Use a distinct stable ID for each concurrently running instance. `PI_INTERCOM_ASK_TIMEOUT_MS` defaults to 600000 (ten minutes). Set it consistently across clients and the process that starts the broker.

Optional settings go in `intercom/config.json` under the active OMP agent directory, normally `~/.omp/agent/`.

```json
{
  "enabled": true,
  "inboundTrigger": "always",
  "confirmSend": false,
  "replyHint": true
}
```

Set `inboundTrigger` to `replies` to wake only for inbound replies, or `never` to keep unsolicited messages quiet. Replies to outstanding `ask` calls always resolve their waiting tool call. `confirmSend` prompts before `send` and `ask` in interactive sessions. You can also set `stableId`, `brokerCommand`, and `brokerArgs`.

## Tests

```sh
npm test
python3 tests/cross-harness.py /path/to/pi-intercom/index.ts
```

The cross-harness test expects `omp`, `pi`, and `pi-intercom` on `PATH` and uses a local model fixture. It checks broker sharing, delivery across projects, idle wake, quiet messages, reply correlation, session switching, and reconnect.

The **Tests** GitHub Actions workflow runs unit tests on Node.js 20 and 24 and cross-harness integration tests with pinned versions on every push and pull request.

## Compatibility maintenance

**Upstream compatibility** is scheduled daily at 05:23 UTC+8 (21:23 UTC on the previous day). You can also run it from **Actions → Upstream compatibility → Run workflow**. It resolves the exact npm `latest` versions of Pi, OMP, Bun, and pi-intercom and runs the pinned baseline, each upstream update individually (OMP with Bun), and all updates together.

With a passing baseline and a reproducible failure on a changed version combination, the workflow asks Codex for a repair. It runs unit tests and the entire integration matrix against the patch before opening a PR into `master` and requesting a GitHub review from the repository owner. One automated repair PR stays open at a time. When the configured reviewer merges the repair PR, the release workflow bumps the patch version on `master` and publishes a tagged GitHub Release.

Enable automatic repairs by adding the `OPENAI_API_KEY` repository Actions secret and enabling **Allow GitHub Actions to create and approve pull requests** under **Settings → Actions → General**. The workflow requests your review. Tests and compatibility reports run using the local model fixture without an API key.

The optional Actions variable `INTERCOM_REVIEWER` sets the reviewer and the account whose merge triggers a release. The version bump is a fast-forward commit to `master`, so any branch rules must permit that version commit from the release workflow.

## License

MIT. The adapter vendors the broker and client from Nico Bailon's pi-intercom v0.19.0. See [Third-party notices](THIRD_PARTY_NOTICES.md).
