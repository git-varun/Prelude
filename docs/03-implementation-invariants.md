# Implementation Invariants & State Contracts

2026-09-19 · @Someone

Authoritative engineering contracts for the OPD AI Snapshot Tool, subordinate to the frozen MVP Specification v1.1. This resolves the state-machine and API-shape ambiguity left open by the Implementation Blueprint — treat every table here as binding for Claude Code, not illustrative.

## 1. Coverage-State Representation & Transition Matrix

**Representation invariant (resolves the "how does `not_found_in_document_set` exist with no FACT row" ambiguity):** `coverage_status` is stored on `FACT` for five values only: `not_assessed`, `value_found`, `not_applicable`, `extraction_uncertain`, `conflicting_sources`. The sixth value, `not_found_in_document_set`, is never stored. It is synthesized at snapshot-read time: for every tracked field with no corresponding `FACT` row in the current visit's document set, the API response includes a synthetic entry with coverage\_status `not_found_in_document_set` and no fact id. This keeps "no evidence exists yet" and "evidence was found and says nothing's there" as genuinely different code paths, not two rows racing to describe the same gap.

| State | Entry condition | Set by | Auto/Human | Valid exits | UI text |
| --- | --- | --- | --- | --- | --- |
| not\_assessed | Extraction finds no usable evidence for this field | Extraction pipeline, at FACT creation (also the column default) | Automatic | None (terminal for this fact; a later document/visit can create a new FACT in a different state) | Not assessed |
| value\_found | Extraction produces a usable value at reasonable confidence, or staff/oncologist supplies a verified value from extraction\_uncertain | Extraction pipeline (creation) or Staff/Oncologist (correction) | Automatic or Human | To conflicting\_sources, only if the rules engine later detects a conflicting fact | Value, unit, reference range |
| not\_applicable | Source document explicitly states the test/result was not performed or not applicable | Extraction pipeline (creation), or Staff/Oncologist confirms this reading from extraction\_uncertain on review | Automatic or Human | None | Not applicable per source |
| extraction\_uncertain | Extraction produces a low-confidence or ambiguous result | Extraction pipeline, automatic | Automatic | To value\_found (verified value supplied), to not\_assessed (review confirms no usable value), to not\_applicable (review confirms source states non-performance) | Needs review |
| conflicting\_sources | Rules engine detects two FACTs for the same patient/field with differing values (see section 3) | Rules engine only, patient-wide, automatic | Automatic | To value\_found, only for the fact the oncologist marks authoritative on conflict resolution; otherwise stays conflicting\_sources permanently as the historical losing value | Conflicting values, see sources |
| not\_found\_in\_document\_set (derived) | No FACT row exists for this tracked field in the current visit | Computed, not stored | N/A | Resolves itself once any FACT is created for this field in this or a later visit | Not found in this visit's documents |

**Hard invariants:**

- The LLM/extraction step may only ever write not\_assessed, value\_found, not\_applicable, or extraction\_uncertain at creation. It can never write conflicting\_sources — only the deterministic rules engine sets that, and only by creating a CONFLICT row in the same transaction.
- Human correction (staff or oncologist) may only move a fact out of extraction\_uncertain, into value\_found, not\_assessed, or not\_applicable. Correction can never directly set conflicting\_sources or the derived not\_found\_in\_document\_set.
- coverage\_status and verification\_state (section 2) are independent axes, with one cross-cutting rule: a fact cannot be oncologist\_signed\_off while it has an open or annotated CONFLICT (section 3). Once that CONFLICT reaches resolved — either resolution path — sign-off is allowed even though coverage\_status may remain conflicting\_sources on a historical or both-stand fact; the block is tied to conflict-resolution state, not to the coverage\_status enum value itself.

## 2. Verification-State Transition Matrix

| State | Entry condition | Set by | Auto/Human | Valid exits |
| --- | --- | --- | --- | --- |
| unverified | FACT created by extraction pipeline | Extraction pipeline, automatic | Automatic | To staff\_corrected (staff or oncologist edits the value), to oncologist\_signed\_off (oncologist confirms as-is, no edit) |
| staff\_corrected | Staff or oncologist edits a fact's value while it is unverified or reopened\_by\_oncologist | Staff or Oncologist | Human | To oncologist\_signed\_off (oncologist confirms) |
| oncologist\_signed\_off | Oncologist signs off an unverified, staff\_corrected, or reopened\_by\_oncologist fact | Oncologist only | Human | To reopened\_by\_oncologist (oncologist reopens); no other exit |
| reopened\_by\_oncologist | Oncologist reopens a previously oncologist\_signed\_off fact | Oncologist only | Human | To staff\_corrected (staff or oncologist edits the value), to oncologist\_signed\_off (oncologist corrects directly without further staff involvement) |

**What happens after an oncologist reopens a fact and staff corrects it (the specific sequence the audit flagged):** reopen moves the fact from `oncologist_signed_off` to `reopened_by_oncologist`. A staff correction from that state moves it to `staff_corrected` — it does **not** jump back to `oncologist_signed_off` automatically. The fact is untrusted again the moment it's reopened, and stays untrusted (excluded from the delta view and from "trusted" display) until the oncologist explicitly signs it off again. This is the same rule that applies to a fresh `unverified` fact — reopening doesn't get special-cased trust.

**Hard invariants:**

- PATCH /facts/:id (correction) is only valid when verification\_state is unverified, staff\_corrected, or reopened\_by\_oncologist. A PATCH attempt on an oncologist\_signed\_off fact returns 409 (state precondition violation, not a permission error — the actor may well be an oncologist, but the fact isn't in an editable state yet).
- POST /facts/:id/sign-off is oncologist-only (403 for staff) and valid from unverified, staff\_corrected, or reopened\_by\_oncologist — not from oncologist\_signed\_off (already signed; 409).
- POST /facts/:id/reopen is oncologist-only (403 for staff) and valid only from oncologist\_signed\_off (409 from any other state — there's nothing to reopen).
- The LLM/extraction pipeline never writes any value other than unverified to verification\_state. It cannot create, correct into, or sign off a trusted fact under any code path — this is enforced structurally by the signed\_off\_requires\_oncologist database constraint (Implementation Blueprint, Database Schema) in addition to application-layer role checks.
- Cross-cutting rule with section 1: sign-off is blocked only while the fact has an open or annotated CONFLICT (section 3), not by its coverage\_status value per se. Once the CONFLICT is resolved — authoritative-pick or both-stand — sign-off is allowed, even for a historical losing fact or either both-stand fact, though coverage\_status stays conflicting\_sources as a permanent record of what happened.

## 3. Conflict Lifecycle & Resolution Semantics

**Detection scope:** patient-wide, not visit-scoped. Two FACTs for the same patient + field\_type (+ tracked\_marker\_id where applicable) with overlapping or ambiguous as\_of\_date and differing values auto-create a CONFLICT, whether they came from the same visit or different visits. Same value with compatible dates never creates a conflict, regardless of visit — both facts are retained as separate observations. The system never uses last-write-wins.

**Pairwise schema, multi-source reality:** the CONFLICT table is pairwise (fact\_id\_a, fact\_id\_b). When three or more documents disagree on the same field, the rules engine creates one CONFLICT per disagreeing pair, not one N-way conflict record. This is a deliberate scope limit, not an oversight — the frozen spec never asked for N-way conflict resolution, and collapsing pairwise conflicts into a single N-way UI is an unwarranted addition. The Snapshot and Conflict Resolution screens must group same-field conflicts visually so the oncologist sees all disagreeing values together, but the underlying records stay pairwise.

**Conflict state machine:**

| State | Entry condition | Set by | Exits |
| --- | --- | --- | --- |
| open | Rules engine detects a qualifying pair | Rules engine, automatic | To annotated (staff adds a note), to resolved (oncologist resolves directly) |
| annotated | Staff adds a note to an open conflict | Staff or Oncologist | To resolved (oncologist resolves) |
| resolved | Oncologist resolves the conflict | Oncologist only | Terminal |

**Resolution mechanics (the piece the frozen spec named but didn't mechanize — locked here):**

- CONFLICT gains a nullable authoritative\_fact\_id column (references facts.id).
- **Choosing an authoritative value:** the oncologist selects one of the two facts as authoritative. authoritative\_fact\_id is set to that fact's id. That fact's coverage\_status moves to value\_found if it was conflicting\_sources. The non-chosen fact's coverage\_status stays conflicting\_sources permanently, tagged historical: true in the API (section 4) — it is never deleted or overwritten, remains reachable for provenance/audit via the authoritative fact's conflicts array or the source view, but drops out of the Snapshot's primary field lists and the delta view going forward. It is a closed record, not an open item awaiting attention.
- **Both stand:** authoritative\_fact\_id stays null; resolution\_note records the oncologist's reasoning (e.g., "both values are clinically valid — different specimen types"). Both facts' coverage\_status remain conflicting\_sources, neither is tagged historical, and the Snapshot continues to display both as separate, live field entries side by side with their sources.
- Either resolution path sets CONFLICT.status = resolved, resolved\_by, resolved\_at.
- **Post-resolution sign-off (locked):** sign-off is blocked only while a CONFLICT is open or annotated (section 1, section 2). Once resolved — by either path — sign-off becomes available again: the authoritative fact signs off normally (its coverage\_status is now value\_found); a historical losing fact or either both-stand fact can also be signed off despite coverage\_status remaining conflicting\_sources, since "resolved" means an oncologist already exercised judgment on it. Coverage\_status is a record of what the evidence looked like, not a live gate on trust once a human has ruled on it.

## 4. Snapshot API Response Contract

`GET /patients/:id/snapshot` — the single response the frontend renders the entire Snapshot screen from. Every field object below is the same shape whether it's a stored FACT or a synthesized not\_found\_in\_document\_set entry.

```json
{
  "patient": {
    "id": "uuid",
    "name": "string",
    "cancer_type": "string"
  },
  "current_visit": {
    "id": "uuid",
    "visit_date": "2026-09-19"
  },
  "previous_visit": {
    "id": "uuid | null",
    "visit_date": "date | null"
  },
  "current_treatment": [ "<field object>" ],
  "tumor_markers": [ "<field object, one per tracked marker>" ],
  "radiology": [ "<field object>" ],
  "since_last_visit": [ "<field object, only entries where delta_status != unchanged>" ]
}
```

**Field object shape** (used identically in every block above):

```json
{
  "fact_id": "uuid | null",
  "field_type": "marker_value | reference_range | treatment_regimen | radiology_impression | disease_status_trend",
  "tracked_marker_id": "uuid | null",
  "marker_name": "string | null",
  "value": "string | null",
  "unit": "string | null",
  "reference_range": "string | null",
  "as_of_date": "date | null",
  "coverage_status": "value_found | not_assessed | not_applicable | extraction_uncertain | conflicting_sources | not_found_in_document_set",
  "verification_state": "unverified | staff_corrected | oncologist_signed_off | reopened_by_oncologist | null",
  "delta_status": "new | changed | unchanged | not_observed_in_current_document_set | null",
  "conflicts": [
    {
      "conflict_id": "uuid",
      "status": "open | annotated | resolved",
      "other_fact_id": "uuid",
      "other_value": "string",
      "other_source": "<provenance object>",
      "authoritative_fact_id": "uuid | null",
      "historical": "boolean"
    }
  ],
  "provenance": {
    "document_id": "uuid",
    "source_page": "integer | null",
    "source_location": "string | null",
    "source_snippet": "string | null",
    "fallback_level": "exact | page | document"
  } | null
}
```

**Contract rules (binding, not illustrative):**

- fact\_id: null occurs only for a synthesized not\_found\_in\_document\_set entry — every other coverage\_status implies a real, fetchable FACT row. verification\_state and delta\_status are also null on synthesized entries; there is nothing to verify or delta-compare when no fact exists.
- provenance: null is only valid alongside fact\_id: null. Any real FACT must return a provenance object — fallback\_level communicates precision honestly instead of omitting the object: "exact" when source\_page/source\_location are populated, "page" when only the page is known, "document" when neither is available (both fields null but document\_id is always present, since every FACT requires one per the frozen data model). The frontend must render the fallback level, not silently show a broken deep link.
- conflicts is always present, possibly []. It is non-empty for any fact that is or was party to a CONFLICT, whether open, annotated, or resolved — this is how a signed-off, resolved-authoritative fact still exposes its history. Each entry's historical flag distinguishes a closed, non-actionable record (true) from a live, still-relevant one (false).
- Server-side, not client-side, controls which facts appear as top-level entries in current\_treatment / tumor\_markers / radiology: while a CONFLICT is open or annotated, both disagreeing facts appear as separate top-level entries (each carrying the other in its own conflicts array) so the oncologist reviews them side by side. Once a CONFLICT resolves via authoritative pick, only the authoritative fact remains a top-level entry — the losing fact drops out of the primary arrays entirely and is reachable only through the authoritative fact's conflicts array (historical: true) or the source view. Once a CONFLICT resolves via both-stand, both facts stay as separate top-level entries — neither is historical, since the oncologist judged both clinically live.
- since\_last\_visit entries are filtered server-side to exclude unchanged — the frontend never re-derives delta filtering from the full field list, keeping the "what changed" rule in exactly one place (the rules engine, per section 1 of the Implementation Blueprint).
- current\_treatment returns the latest source-supported regimen/status fact only (frozen spec's Current Treatment scope) — the endpoint never returns a treatment history array. "Latest" is by as\_of\_date; if two treatment facts share an as\_of\_date, that's a conflict per this section's detection rule, not a silent pick of whichever row sorts first.
