# Pinpoint — Supabase

Results are logged to the shared **Misc** project, ref **`atqhfbaurrmivjarowco`**
(region East US / Ohio). Everything Pinpoint owns is prefixed `pin_`, matching the
project's convention (`bus_`, `fec_`, `fin_`, `gs_`, `mc_`, `angry_`).

## Access model — read this before changing any policy

There is **no login**. Each browser mints a random uuid on first play (the "player
key", in `localStorage` under `pinpoint.player`) and tags every round with it. The
key *is* the credential:

- `anon` may **INSERT** into `pin_rounds` and nothing else.
- There is **no SELECT policy**, so `GET /rest/v1/pin_rounds` returns `[]` to
  everyone. The table cannot be dumped with the publishable key.
- History is read only through `pin_stats(p_player uuid)`, a `SECURITY DEFINER`
  function that filters to that one player. You must know the uuid to get anything
  back, so results are not enumerable.

The publishable key `sb_publishable_G44hmJHuAwEcoxq0QPWI7w_BWt_owiB` is committed in
`app.js`. **This is correct and intended** — publishable keys are designed to ship in
client code, and this one grants insert-only. It is not a secret and does not need
rotating. (The `service_role` / `sb_secret_` keys are a different matter and must
never appear in this repo.)

Consequences worth remembering:
- Anyone who finds the site can write junk rows under their own uuid. The CHECK
  constraints below bound what a row can contain; nothing stops volume. Acceptable
  for a personal practice tracker — revisit if it is ever abused.
- Clearing site data loses the key, and a new browser gets a new one. That is why
  the Progress panel shows the key with Copy / "Use another" — it is the only way
  to carry history across devices.

## Schema

```sql
create table public.pin_rounds (
  id          bigint generated always as identity primary key,
  player_id   uuid        not null,
  played_at   timestamptz not null default now(),
  question_id text        not null check (length(question_id) <= 200),
  question    text        not null check (length(question) <= 400),
  answer      text        not null check (length(answer) <= 200),
  category    text        not null check (category in ('history','landmark','nature','city','culture')),
  guess_lat   double precision not null check (guess_lat between -90 and 90),
  guess_lon   double precision not null check (guess_lon between -180 and 180),
  answer_lat  double precision not null check (answer_lat between -90 and 90),
  answer_lon  double precision not null check (answer_lon between -180 and 180),
  miss_km     double precision not null check (miss_km >= 0 and miss_km <= 20100),
  score       smallint    not null check (score between 0 and 100)
);
create index pin_rounds_player_time_idx on public.pin_rounds (player_id, played_at desc);
```

`miss_km` is stored in kilometres even though the UI defaults to miles — one
canonical unit in the database, converted for display. `score` is the 0–100 value.
The `category` CHECK must be kept in step with the categories in `questions.js`.

## pin_stats(p_player uuid) → jsonb

One round trip returns everything the Progress panel draws:

| key | shape |
|---|---|
| `total`, `mean_score`, `median_miss_km`, `best_miss_km`, `first_played` | scalars |
| `daily` | `[{day, rounds, mean_score}]`, last 60 days played, ascending |
| `by_category` | `[{category, rounds, mean_score}]`, best mean first |
| `toughest` | `[{answer, seen, mean_score}]`, worst mean first, 12 max |

Days are bucketed in **America/New_York**, not UTC, so a late-evening session
doesn't land on tomorrow's bar.

## Running SQL against the project

The CLI isn't linked to this repo. Use the Management API with the CLI's stored
token — note it is base64-wrapped by go-keyring:

```bash
TOKEN=$(security find-generic-password -s "Supabase CLI" -w | sed 's/^go-keyring-base64://' | base64 -d)
curl -s -X POST "https://api.supabase.com/v1/projects/atqhfbaurrmivjarowco/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"select count(*) from public.pin_rounds;"}'
```

Check what is in the table before deleting anything — group by `player_id` first.
Real rounds and test rounds live side by side, distinguishable by `question_id`
(seeded/test rows used `seed` or `test-q`; real ones are question slugs).
