# Tax rules live in code, their values live in cited, versioned data

TaxMaxi needs German tax law (EStG, BMF-Schreiben vom 06.03.2025) as testable rules instead of constants buried in the calculation service. We decided: rule logic is typed, pure functions in `packages/core`, keyed by the same rule key as the citable `legal_rules` rows. Values set by law — holding period, the §23 Freigrenze (600 EUR through 2023, 1000 EUR from 2024), the §22 Nr. 3 threshold (256 EUR) — are rule parameters stored in a new effective-dated table, windowed by assessment year and decoded with a per-rule schema. Every rule must cite at least one official source (EStG or BMF-Schreiben); this is enforced three times: seeding fails without a citation, CI walks every engine rule key against the seeded ruleset, and the engine fails closed at runtime if a rule resolves without citations or parameters. Per jurisdiction there is one active ruleset version governing all assessment years (matching how BMF letters replace each other for open cases); year differences live in parameter windows, and a new BMF letter becomes a new ruleset version.

## Considered options

- **Rules as data with a generic evaluator** (the old repo's `legal_atoms.jsonl` direction): rejected — an if/then DSL interpreted at runtime is an inner platform built for exactly one jurisdiction, and prose conditions are not executable anyway. The atoms and decision tables survive as traceability docs and test fixtures instead.
- **Pure code including the values**: rejected — the DB ruleset would no longer describe what the engine does, and the citation layer (`LegalReferenceService`) would stay a disconnected world.
- **Ruleset version per assessment year**: rejected — duplicates identical rules across years and misrepresents how BMF guidance applies retroactively to open cases.

## Consequences

- Tax assessment is account-scoped, never source-scoped: Freigrenzen are all-or-nothing thresholds on a person's yearly totals, so a per-source number that applies them would be legally wrong.
- The assessment output records the ruleset version, each applied rule with its parameter values and citations — this is the snapshot tax report PDFs store (see ADR 0005).
- Adding a jurisdiction means new rule functions plus seeded rules, parameters, and sources — not a new engine.
- Changing a law-set value is a data migration with a citation, not a code edit.
