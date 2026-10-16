# Graph Report - babyzilla  (2026-10-16)

## Corpus Check
- 15 files · ~10,403 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 14 nodes · 13 edges · 2 communities
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `ea916c77`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- BabyZilla Installation Guide (for your AI agent)
- Step 3 — Functional test (compaction produces a ContextPack)

## God Nodes (most connected - your core abstractions)
1. `BabyZilla Installation Guide (for your AI agent)` - 9 edges
2. `Step 3 — Functional test (compaction produces a ContextPack)` - 5 edges
3. `Step 0 — Environment check` - 1 edges
4. `Step 1 — Install the plugin (Method A: one command)` - 1 edges
5. `Step 2 — Verify the plugin loads` - 1 edges
6. `3a. Create the scratch session` - 1 edges
7. `3b. Fill it with the sample prompt (≈11K tokens)` - 1 edges
8. `3c. Request compaction, then force the step boundary` - 1 edges
9. `3d. Wait for the pack and measure` - 1 edges
10. `Step 4 — Optional: the babyzilla CLI` - 1 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Communities (2 total, 0 thin omitted)

### Community 0 - "BabyZilla Installation Guide (for your AI agent)"
Cohesion: 0.22
Nodes (8): BabyZilla Installation Guide (for your AI agent), Privacy, Step 0 — Environment check, Step 1 — Install the plugin (Method A: one command), Step 2 — Verify the plugin loads, Step 4 — Optional: the babyzilla CLI, Step 5 — Report to your human, Troubleshooting quick reference

### Community 1 - "Step 3 — Functional test (compaction produces a ContextPack)"
Cohesion: 0.40
Nodes (5): 3a. Create the scratch session, 3b. Fill it with the sample prompt (≈11K tokens), 3c. Request compaction, then force the step boundary, 3d. Wait for the pack and measure, Step 3 — Functional test (compaction produces a ContextPack)

## Knowledge Gaps
- **11 isolated node(s):** `Step 0 — Environment check`, `Step 1 — Install the plugin (Method A: one command)`, `Step 2 — Verify the plugin loads`, `3a. Create the scratch session`, `3b. Fill it with the sample prompt (≈11K tokens)` (+6 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `BabyZilla Installation Guide (for your AI agent)` connect `BabyZilla Installation Guide (for your AI agent)` to `Step 3 — Functional test (compaction produces a ContextPack)`?**
  _High betweenness centrality (0.872) - this node is a cross-community bridge._
- **Why does `Step 3 — Functional test (compaction produces a ContextPack)` connect `Step 3 — Functional test (compaction produces a ContextPack)` to `BabyZilla Installation Guide (for your AI agent)`?**
  _High betweenness centrality (0.538) - this node is a cross-community bridge._
- **What connects `Step 0 — Environment check`, `Step 1 — Install the plugin (Method A: one command)`, `Step 2 — Verify the plugin loads` to the rest of the system?**
  _11 weakly-connected nodes found - possible documentation gaps or missing edges._