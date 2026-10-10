# Ranked matchmaking & officer ranks

Competitive 1v1 ladder on top of the existing `ranked` mode. Casual / listed / bot / training never change MMR or officer ranks.

## MMR (Elo)

- Starting MMR: `STARTING_MMR` (default **1000**). Persistent; no seasonal resets.
- Placed K: `ELO_K` (default 32). Provisional K: `ELO_K_PROVISIONAL` (default 48).
- Only completed ranked 1v1 matches update MMR. Surrenders and abandonments after tickets are charged count as losses.
- Rematches inside `REMATCH_SOFT_WINDOW_MS` after `REMATCH_SOFT_COUNT` prior rematches use `REMATCH_SOFT_K`.

## Placements

- New accounts are **Ensign** with hidden MMR until `PLACEMENT_MATCHES` (default 10) ranked games complete.
- Matchmaking uses hidden MMR the whole time.
- UI: “Commission Pending: N/10 Battles”. After placements, numerical MMR and daily officer rank are revealed (rank posts on the next commission roll).

## Officer ranks

Daily UTC job assigns titles from percentile standing among **eligible** players:

- Placements complete
- At least one ranked match in the last `RANK_ACTIVE_DAYS` (default 30)
- Not deleted / not banned

With fewer than `RANK_SMALL_POP` (default 100) eligible players: only Major / Lieutenant Colonel / Colonel (25% / 50% / 25%). Provisional players stay Ensign and are excluded from the pool.

Inactive players keep MMR and last title but leave the percentile pool until they play again. `highest_rank` is monotonic.

## Matchmaking

- Pair by MMR, not displayed rank.
- Allowed spread starts at `MMR_MAX_SPREAD` and grows by `MMR_EXPAND_PER_MS` up to `MMR_EXPAND_CAP`.
- Recent opponents (`REMATCH_COOLDOWN_MS`) are deprioritized; rematches still allowed after long wait (`MATCH_WAIT_MS`).

## Multi-worker

- Queues stay in-process; owner pinning keeps a pair on one worker.
- Daily rank job uses a SQLite `job_leases` row so only one worker runs per UTC day.

## Env knobs

See `.env.template`: `STARTING_MMR`, `ELO_K`, `ELO_K_PROVISIONAL`, `PLACEMENT_MATCHES`, `MMR_MAX_SPREAD`, `MMR_EXPAND_PER_MS`, `MMR_EXPAND_CAP`, `MATCH_WAIT_MS`, `RANK_ACTIVE_DAYS`, `RANK_SMALL_POP`, `REMATCH_*`.
