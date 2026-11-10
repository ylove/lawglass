# Security policy

## Reporting a vulnerability

Please report security problems privately, through GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for anything exploitable.

Include what you found, how to reproduce it, and what an attacker could do with it. If it involves a document, a link to the document is enough; please do not attach real API keys.

You can expect an acknowledgement within 3 days and a first assessment within 7. Fixes ship in a release with a GitHub security advisory that credits you, unless you prefer otherwise.

## Supported versions

Only the latest minor release (for example 2.0.x) gets security fixes. Please confirm the problem on the latest version first.

## Scope

In scope: the CLI, the local web server and UI, `serve --public` and `serve --private`, the hosted preview at lawglass.xyz, and the deployment files in `deploy/`.

Out of scope: the security of the model providers, Pinecone, GovInfo and the state legislature sites themselves, and attacks that need control of the user's own account or machine.

There is no bug bounty. Credit in the advisory is offered if you want it.

The threat model (`docs/security/threat-model.md`) lists the threats we design against and the controls in place.
