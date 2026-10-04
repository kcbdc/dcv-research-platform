# v0.9.4 — responsive layout + project_cycle_stats schema repair

- Rebuilds `project_cycle_stats` when an older/partial table exists. The table is derived cache data, so rebuilding is lossless with respect to source research records.
- Adds migration `0028_project_cycle_stats_schema_repair.sql` for installations where 0027 is already recorded as applied.
- Makes migration 0027 itself safe for installations where it has not yet been applied but a manually-created partial table already exists.
- Adds a final responsive layout override: below 1400 CSS px the compute deck is always one column; chart canvas gets a fixed contained height and cannot protrude into the project section.
- Cache key / app version: 0.9.4.
