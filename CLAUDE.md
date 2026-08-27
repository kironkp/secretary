# secretary

## Adaptive dashboard (LayoutPlan system)
- Dashboard layout is data: a LayoutPlan rendered by the layout renderer.
  Never hardcode section order; change DEFAULT_PLAN or the planner instead.
- The component registry is the only UI vocabulary. New components = registry
  version bump + SPEC table update. Generated code never registers itself.
- The validator is load-bearing. Planner/chat output is DATA; it never reaches
  innerHTML/JSX unescaped. Never skip or weaken validation to make a test pass.
- The Spreadsheet view never adapts. Do not add adaptive behavior to it.
- Emphasis changes are free; SYSTEM-initiated reordering needs
  days_since_layout_change >= 1 plus a user-visible why. USER-initiated changes
  apply immediately.
- The Canvas is the only surface where the model writes markup: sanitized
  static HTML in a sandboxed iframe, no scripts/handlers/forms/external loads
  ever. The shell owns all interactivity (data-expand, data-link, data-check —
  the last is the one sanctioned write: tap an open task to mark it done, ids
  from SIGNALS.tasks only). Everywhere else, model output is data.
- Full spec: docs/adaptive-ui/SPEC.md — source of truth. To change behavior,
  update the spec first, then the code.
