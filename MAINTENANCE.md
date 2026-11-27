# Maintenance

[简体中文](MAINTENANCE.zh-CN.md)

## Tests

```sh
npm test
python3 tests/cross-harness.py /path/to/pi-intercom/index.ts
```

The cross-harness test expects `omp`, `pi`, and `pi-intercom` on `PATH` and uses a local model fixture. It checks broker sharing, delivery across projects, idle wake, quiet messages, reply correlation, session switching, and reconnect.

The **Tests** GitHub Actions workflow runs unit tests on Node.js 20 and 24 and cross-harness integration tests with pinned versions on every push and pull request.

## Translation maintenance

The **Update Simplified Chinese translations** workflow runs when the English catalog, README, maintenance guide, or third-party notices change on the default branch. It also supports manual runs from the default branch. It reuses the repair model provider settings described below, sends only changed English strings for catalog translation, and opens one review PR for the updated Chinese files. For changed Markdown documents, it uses the current Chinese document as a reference.

The workflow validates catalog keys and placeholders and checks that the translated Markdown preserves code blocks, inline code, headings, and link destinations. Review the translated prose before merging. The PR uses the repository Actions token and the same pull request creation permission as compatibility repairs. If a translation PR is already open, the workflow leaves it available for review and catches up on subsequent source changes after that PR merges.

The workflow records the English source revisions in `.github/translation-sources.json`. The interface falls back to English for missing messages or incompatible placeholders while translations are pending. Tests enforce exact catalog parity when the English catalog matches its recorded revision.

## Compatibility maintenance

**Upstream compatibility** is scheduled daily at 05:23 UTC+8 (21:23 UTC on the previous day). You can also run it from **Actions → Upstream compatibility → Run workflow**. It resolves the exact npm `latest` versions of Pi, OMP, Bun, and pi-intercom and runs the pinned baseline, each upstream update individually (OMP with Bun), and all updates together.

With a passing baseline and a reproducible failure on a changed version combination, the workflow uses OpenCode with your configured model provider to propose a repair. It runs unit tests and the entire integration matrix against the patch before opening a PR into `master` and requesting a GitHub review. One automated repair PR stays open at a time.

### Configure the repair model provider

Set these in the repository's [Actions variables](https://github.com/Stark-X/omp-intercom/settings/variables/actions) and [Actions secrets](https://github.com/Stark-X/omp-intercom/settings/secrets/actions).

| Setting | Location | Value |
| --- | --- | --- |
| `REPAIR_BASE_URL` | Variable | API prefix reachable by the GitHub-hosted runner, such as `https://gateway.example.com/v1` or `https://openrouter.ai/api/v1`. |
| `REPAIR_MODEL` | Variable | Exact model ID from the provider. Choose one that supports tool calls. |
| `REPAIR_API_KEY` | Secret | API key issued for that endpoint. |
| `REPAIR_API` | Optional variable | `chat-completions` (default), `responses`, or `anthropic-messages`. |

The agent appends `/chat/completions`, `/responses`, or `/messages` to the API prefix, according to the selected protocol. Its file edits are limited to adapter source, skills, and project documentation. For automatic PR creation, enable **Allow GitHub Actions to create and approve pull requests** in [Actions settings](https://github.com/Stark-X/omp-intercom/settings/actions). Tests and compatibility reports use the local model fixture and run without a repair provider.

The optional Actions variable `INTERCOM_REVIEWER` selects the requested reviewer. It defaults to the repository owner.

## Releases

When a PR merges into `master`, the **Release plugin changes** workflow checks its changed files. Changes to `src/` (excluding Markdown, reStructuredText, and license or notice files), `skills/`, `package.json`, or `package-lock.json` trigger a patch release. A PR limited to documentation, tests, or CI configuration skips the release. The workflow also checks the original path of renamed files.

For an eligible PR, the workflow increments the patch version in `package.json` and `package-lock.json`, pushes the version commit and matching `vX.Y.Z` tag, and publishes a GitHub Release. The release jobs run in sequence. Rerunning a job reuses its version commit and tag if they were already pushed. Branch and tag rules must allow the workflow to push those refs with `GITHUB_TOKEN`.
