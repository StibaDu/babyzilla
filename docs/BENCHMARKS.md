# Benchmarks

BabyZilla vs **Headroom 0.41.0**, measured end to end on a real OpenCode
session. Everything below comes from OpenCode's own token accounting — not from
estimates and not from a replay harness.

## Methodology

| | |
| --- | --- |
| Model | `ollama-cloud/deepseek-v4.1-flash` (same for both arms) |
| Context window | **128K, identical for both arms** (the model's native 1M window never compacts, so a 128K window was used to exercise compaction in both) |
| Arm A | BabyZilla (this plugin), loaded from the working tree |
| Arm B | Headroom proxy 0.41.0, `--backend litellm-openai --mode token --no-cache`, forwarding to the same upstream |
| Metric | per assistant message: `input + cache.read + cache.write`, summed per session (OpenCode's `session_message.tokens`) |
| Prompts | byte-identical between arms |
| Files | the same real files on disk, read in the same order |

Both arms ran in the same OpenCode install, with the same MCP servers and the
same model. Only the compression stack differs.

## Results

| Round | Workload | BabyZilla | Headroom | Winner |
| --- | --- | ---: | ---: | --- |
| R1 | 2-turn exploratory, 6 files | **860,211** (14 calls) | 1,029,753 (17 calls) | BabyZilla **−16.5%** |
| R2 | read-only, 4 files | **115,191** (5 calls) | 211,267 (6 calls) | BabyZilla **−45.5%** |
| R3 | read-only, 7 files, one read each | **46,516** (2 calls) | 103,470 (2 calls) | BabyZilla **−55.0%** |
| R4 | shell-only, 4 commands | **56,711** (3 calls) | 104,136 (5 calls) | BabyZilla **−45.5%** |

**Controlled rounds (R2–R4):** BabyZilla **218,418** vs Headroom **418,873** —
BabyZilla uses **52.1%** of Headroom's context tokens (−47.9%).

**All four rounds:** 1,078,629 vs 1,448,626 — BabyZilla uses 74.5% (−25.5%),
though R1 is the most call-count-sensitive round.

### Before Layer 2b

Tool-result compression (v0.3.0) is what flipped R2 and R3:

| Round | BabyZilla before | BabyZilla after | Headroom |
| --- | ---: | ---: | ---: |
| R2 | 257,175 | **115,191** | 211,267 |
| R3 | 561,290 (16 calls) | **46,516** | 103,470 |

## Caveats

- **One run per round.** Call counts vary between runs; totals are directional.
- **R3 has two versions.** The original (7 files, unrestricted reads) was
  confounded by OpenCode's 2 000-line read cap: the arms did different amounts
  of work (16 calls vs 8). The table above uses the constrained version — one
  `read` per file in both arms — so the comparison is apples-to-apples.
- **Headroom's router is content-dependent.** In some rounds it compressed read
  results by 19.7%; in others it protected them (`router:read_protected`) and
  saved ~50 tokens per request. The numbers reflect its defaults.
- **One model.** Latency and compaction thresholds differ by provider; these
  numbers should not be read as universal.

## Reproducing

1. Install the plugin from this repo (`plugins: ["/path/to/babyzilla"]`).
2. For the Headroom arm, run its proxy in `token` mode against the same
   upstream and point a second config's provider `baseURL` at it.
3. Run identical prompts, then read `session_message.tokens` from
   `~/.local/share/opencode/opencode.db` for each session.

The two battle configs used for these runs (`config-A` and `config-B`) are
reproducible from the descriptions above; no fixture files are needed — the
inputs are real files on disk.
