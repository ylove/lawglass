# 0013: Agent access

**Status:** proposed, pending the decision in issue #205

## Context

Lawglass is useful to people, and the user wants it to be useful to software agents too. Two questions come first: which interface an agent should use, and why an agent would use Lawglass instead of reading the pasted URL itself.

The options under study are:

- an MCP server;
- a `--json` mode on the CLI;
- the existing local HTTP API;
- a Claude skill or plugin that wraps the CLI.

The case for Lawglass over a plain paste is what it adds: struck and inserted text read correctly, citations to section, page and line that are validated, and the cached, bounded pipeline.

## Decision

Pending. Issue #205 runs a recorded debate among product, skeptic, backend and prompt-design reviewers and produces a feasibility report. This ADR will be filled in when the user has chosen a path. A thin MCP prototype is built only if MCP is chosen. Any other outcome goes back to the user first.

Whatever the interface, two constraints are already decided elsewhere and bind it:

- It goes through the budgets in core ([ADR 0012](0012-security-posture.md)), so an agent cannot run up the provider bill.
- Model output and document text stay untrusted. A tool that returns document text must label it as data.

## Consequences

To be written with the decision. Until then nothing here describes shipped behavior.
