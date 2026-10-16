# Notable failures during build (all fixed)
- transcriptText extracted `parts` but messages use `content` → tool results (the bulk) vanished; compaction saw 78 tok instead of ~8K. Rewrote extractor.
- Prompt hook bail-guard assumed prompt is array → it's an object; fixed guard.
- 46.7K-token distiller prompt → invalid JSON from GLM-5.2 → safe native fallback (by design); fixed with JSONL + retry.
- `opencode api post .../compact` without body → 400 "Expected object"; /messages route → 404 (correct route is /context).
- First compaction of a live session was missed due to lazy plugin loading; tests used API-triggered compaction after hook registration.
- session.synthetic required unknown keys — discovered via 400 "Missing key" payloads.