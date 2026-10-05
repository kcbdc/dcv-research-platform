# v0.10.6 — Live Human Report Synchronization

- The report API overlays the paper preflight participant line with live D1 counts, so a stored report can no longer keep showing `0명` after the current protocol has 32 participants.
- Separates current-protocol participants from publication-ready participants (30 main + 3 attention, no EXCLUDE flag).
- When a stale report is opened after the current-protocol participant threshold is reached, a coalesced `generate_report` job is automatically queued.
- Participant EXCLUDE flags now persist across evidence revisions within the same human protocol/research cycle; a later trial revision can no longer accidentally erase an earlier exclusion.
- Statistical tables and inferential results remain snapshot-bound until the fresh report is generated; only the operational preflight participant status is overlaid live.
