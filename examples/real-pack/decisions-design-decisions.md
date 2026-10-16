# Design decisions + rationale
- **JS/Node plugin now, Rust deferred** — lowfat Rust source absent locally (~/src, ~/dev, ~/code); user must reveal it before Phase 4.
- **Distiller output = JSONL** (one self-contained JSON object per line): single big JSON object failed on 46.7K-token prompt (GLM-5.2 → "JSON Parse error: Expected '}'"); JSONL truncation drops only trailing modules. Tolerant line parser (recovers any {...}) + legacy {"modules":[...]} fallback; one retry with stricter instruction.
- **Plugin shape**: bare `export default {id:"contextpack", setup:async(ctx)=>{}}`; feature-gate all ctx.* APIs defensively (tool.hook, session.hook fine on v2.0.29).
- **Debug via file** ~/.opencode/contextpacks/debug.log — console.warn doesn't reach ~/.local/share/opencode/log/opencode.log under the service.
- **Hot/cold policy**: 00-state + decisions always inlined into summary, never auto-attached (hot); topic/code/tool/errors cold → auto-attached only on prompt trigger match (max 2 modules, 6000-token budget); tool/errors also promoted to library/<project>/ for cross-session reuse (home-dir sessions skipped).
- **minRawTokens=4000**: transcripts below → let native compaction run.
- **Key functions in index.js**: transcriptText, toolBlockText, parseModules, normalizeModel, writeJournal.