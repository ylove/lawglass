# 0016: A per-reader library in hosted modes

**Status:** accepted (2026-10-26), issues #278 and #279

## Context

In the v1.0 hosted preview, everyone with the invite link saw one shared "Your documents" list. That included the showcase bills seeded for the demo, and any invitee could remove a document for everyone. Thomson Reuters' feedback was direct: the running list of documents is good, but it should belong to the reader, not show whatever has been retrieved so far. Visitors also landed on the last document someone had opened instead of on a homepage.

The server keeps one store of documents (the registry, the index and the answer caches). Copying documents per reader would multiply ingest cost and storage for no benefit: a bill's text and its index are the same for everyone.

## Decision

1. **A shared store, private lists.** Documents stay in one store. In private and public modes each reader gets a random list key in an `HttpOnly; Secure; SameSite=Strict` cookie. It is issued only after the session check, and the server keeps that reader's list of document ids. `GET /api/docs` returns the reader's list. Ingest, including reusing a document someone else already loaded, adds to it. Remove takes the document off that reader's list only.
2. **The cookie is a list key, not an authorization boundary.** Everyone behind the invite shares one store, and a link to `/doc/<id>` opens that document for any invitee. The list key only decides whose list a document appears on. Lists are stored under the SHA-256 of the key, so a crafted cookie can never name a file path, and the key is never logged.
3. **Eviction prefers documents nobody lists.** When the store reaches its document cap, documents no reader lists go first, oldest first. Documents still being ingested are protected. A document some reader lists is evicted only when nothing else can be.
4. **Routes, and a homepage on arrival.** `/` is the homepage (the URL box, a few examples, the reader's documents) and `/doc/<id>` is a document. The logo always goes home. Local mode keeps one list for the one person at the machine.

## Consequences

- A new invitee starts with an empty list, so the seeded bills no longer clutter it. They remain one click away as homepage examples, configured with `LAWGLASS_EXAMPLES`.
- Removing a document no longer frees space in the store by itself; eviction of unlisted documents does that.
- Reader lists are part of the Cloud Run state snapshot (`.lawglass/readers`).
- Readers are not accounts: clearing cookies starts a new, empty list. Sign-in is out of scope for the preview.
