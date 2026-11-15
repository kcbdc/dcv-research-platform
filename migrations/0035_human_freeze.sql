-- v0.10.12: human-experiment freeze.
-- While human_freeze=1 no evidence change may open a new research cycle, so invite codes,
-- participant sessions and trials stay attached to one cycle for the whole recruitment window.
ALTER TABLE projects ADD COLUMN human_freeze INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN human_freeze_at TEXT;
ALTER TABLE projects ADD COLUMN human_freeze_reason TEXT;
ALTER TABLE projects ADD COLUMN human_freeze_cycle INTEGER;
