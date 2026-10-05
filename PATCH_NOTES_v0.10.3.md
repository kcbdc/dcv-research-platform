# v0.10.3 — Official connector collection recovery

- Official data collection is no longer blocked while candidate computation is pending.
- Enabling official connectors immediately queues a collect_project job.
- This fixes configured connectors remaining QUEUED_OR_NOT_FETCHED with zero rows during long compute backlogs.
- Existing secret-missing connectors remain skipped/error-isolated without blocking other official sources.
