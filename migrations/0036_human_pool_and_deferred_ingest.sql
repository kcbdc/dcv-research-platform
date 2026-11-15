-- v0.10.13: pool prior-cycle main_v2 participants (opt-in) and defer auto-collected data instead of opening cycles.
ALTER TABLE projects ADD COLUMN human_pool_prior_cycles INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN deferred_data_events INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN deferred_data_at TEXT;
