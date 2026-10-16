## Goal
ContextPack — OpenCode plugin replacing compaction summary with distilled "context modules" + tool-result journal + trigger-based module auto-attach. Phases 1–3 done in JS/Node; Phase 4 (Rust lowfat pack subcommands) deferred.

## Status: shipped + validated live
- Plugin: ~/.config/opencode/plugins/contextpack/index.js (~600 lines) + README.md; auto-loads in OpenCode v2.0.29, composes with lowfat-v2
- Data: ~/.opencode/contextpacks/ → sessions/<sid>/{00-state.md, <kind>-<name>.md, index.json, journal.jsonl}, library/<project>/, debug.log
- Options defaults: {distillModel:null (session model), maxAttach:2, attachBudgetTokens:6000, library:true, minRawTokens:4000}
- /contextpack command works: stats + module list (triggers, sizes, hot/cold)
- Verified: 8.1K→135tok (98%); 8.2K→608tok 4-module pack (93%); 18.4K→341tok (98%); 57.8K→44K fed→271tok; trigger auto-attach → native prompt files; corrupt distiller output → safe native-compaction fallback

## Next steps
1. Phase 4: lowfat rust `pack` subcommands — BLOCKED: lowfat source not found (~/src, ~/dev, ~/code checked); need location from user
2. Optional: expose distillModel via plugin options in opencode.json
3. Real-world: run /contextpack after first compaction of an actual long session