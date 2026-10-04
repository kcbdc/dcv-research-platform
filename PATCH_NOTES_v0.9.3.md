# v0.9.3 — Mobile layout recovery

- Forces the analytical deck into a single-column stack on mobile/touch viewports, independent of older desktop grid overrides.
- Prevents `#regionCanvas`, chart wrappers, project cards, and nested Bootstrap rows from widening the document.
- Resets legacy absolute positioning for PNG/SVG quick actions and region badges on mobile.
- Adds a ≤480px fallback with one-column workflow and compact chart sizing.
- Bumps static asset cache keys to v0.9.3.
