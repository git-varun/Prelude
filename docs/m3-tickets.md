# M3 tickets — approved 2026-10-13

Build order: **Summary + Plan first, then rules.** Each ticket below is written as a GitHub issue (title, labels, body). Amendment refs point to `docs/03-implementation-invariants-M3-amendments.md`.

| # | Title | Ref | Depends on |
|---|---|---|---|
| M3-01 | Extraction tier 1 field types | AM-04 | — |
| M3-02 | Patient Summary screen | B1 | M3-01 |
| M3-03 | Care plan items + Plan tab | B3 | M3-01 |
| M3-04 | Batch sign-off | AM-01 | — |
| M3-05 | Priority order v2 | AM-05 | M3-03, M3-07 |
| M3-06 | Visits elsewhere | AM-03 | — |
| M3-07 | Per-patient pins + suggestion banner | B2 | — |
| M3-08 | Held documents: staff flag only | B5 | — |
| M3-09 | Prep status + "Mark ready" | B6 | — |
| M3-10 | "Other" document type | B8 | — |
| M3-11 | Document pane collapsed, opens at fact | B9 | — |
| M3-12 | Wording guard additions | AM-06 | — |
| M3-13 | Dictation audio pilot | AM-02 | — |

**Deferred past M3:** A5 summary fields · B4 lesion trend UI · B7 work queues (interim: per-patient banners) · unextracted-lines diff · consult recording, transcription and patient consent (AM-02b).

---

### M3-01 · Extraction tier 1 field types
**Labels:** `extraction` `backend` `M3` · **Ref:** AM-04

Add field types: diagnosis, histology/IHC, stage, surgery/procedure, regimen (as written), next review date, tests advised, procedures planned, lesion size.

**Acceptance**
- [ ] Each type is extracted from the document types it can appear in (path report, discharge, Rx, radiology).
- [ ] Values store verbatim source text plus provenance (exact / page / document).
- [ ] Each type passes through spot-check with type-specific error options.
- [ ] Nothing computed: no cycle count, line of therapy or RECIST.
- [ ] Facts marked Incorrect with "not in document" or "wrong patient" are excluded from Summary and Plan.

---

### M3-02 · Patient Summary screen
**Labels:** `frontend` `M3` · **Ref:** B1 · **Depends:** M3-01 · **Screens:** prototype › Summary

First item in the patient sidebar. Sections: What happened (dated), Disease history, Other medical history, Procedures and surgeries, Previous prescriptions per checkup, Medicines on latest prescription.

**Acceptance**
- [ ] Every line comes from a sourced fact, quoted as written, with a Source link that opens the document at the highlight.
- [ ] No generated prose. Items with no fact read "Not found in documents".
- [ ] A5 fields (comorbidities, allergies, family history, ECOG, medicines, devices, BRCA) read **"Not extracted yet"**.
- [ ] The medicines block is labelled "As written on the prescription. Not a reconciled medication list."
- [ ] Snapshot shows a 4-cell summary strip with "Full summary →".

---

### M3-03 · Care plan items + Plan tab
**Labels:** `backend` `frontend` `M3` · **Ref:** B3 · **Depends:** M3-01 · **Screens:** 10g, 9q

New `care_plan_item` (patient, type: test | procedure | review, text as written, advised_at, source fact, status, matched_document_id).

**Acceptance**
- [ ] Items are created from signed-off "tests advised", "procedures planned" and "next review" facts, or added by hand.
- [ ] Status wording is limited to: Planned · Report seen (confirm match) · Past advised date, no report seen.
- [ ] Report matches are suggested by test name and a date after the advice. Staff confirm them; there is no auto-match.
- [ ] Intervals are shown as stated, with ≈date in brackets.
- [ ] The Plan tab is in the patient sidebar. Plan items past their advised date feed priority rule 5.

---

### M3-04 · Batch sign-off
**Labels:** `backend` `frontend` `M3` · **Ref:** AM-01 · **Screens:** 8d, 10b

**Acceptance**
- [ ] Checkbox only on eligible facts (checked Correct, dated, no conflict, not held).
- [ ] Boxes start unchecked. No select-all.
- [ ] The button reads "Sign off N reviewed" and is disabled at 0.
- [ ] One audit row per fact. Undo for 4 s.

---

### M3-05 · Priority order v2
**Labels:** `frontend` `M3` · **Ref:** AM-05 · **Depends:** M3-03, M3-07

**Acceptance**
- [ ] `deltaPriority` implements the 7 rules. Ties are ordered by document date.
- [ ] Each row shows its rule tag. "How this is ordered" lists the rules.
- [ ] Unit tests cover each rule and the tie order.

---

### M3-06 · Visits elsewhere
**Labels:** `backend` `frontend` `data-model` `M3` · **Ref:** AM-03 · **Screens:** 10a, 10b, 10d

New `outside_encounter` (patient, date, facility, confirmed_by). Link facts and documents.

**Acceptance**
- [ ] Staff confirm the date and facility at upload. Never created silently.
- [ ] Shown dashed with "visit elsewhere · {facility}" in Today, Snapshot, History and Summary.
- [ ] The snapshot comparison toggle defaults to "Last visit here".

---

### M3-07 · Per-patient pins + suggestion banner
**Labels:** `backend` `frontend` `M3` · **Ref:** B2 · **Screens:** 9d, 9e, 10b

`patient_marker.is_pinned`, `pinned_by`, `suggested_by`, `suggested_note`.

**Acceptance**
- [ ] Only the oncologist pins. Staff see "Suggest pin".
- [ ] The suggestion shows as a banner/badge on that patient's watchlist (no queue in M3).
- [ ] The watchlist shows pinned markers in fixed order, including missing ones ("Not in this visit · last …").

---

### M3-08 · Held documents: staff flag only
**Labels:** `backend` `frontend` `M3` · **Ref:** B5 · **Screens:** 8r, 4c

**Acceptance**
- [ ] New `identity_status = awaiting_oncologist`.
- [ ] Staff record: likely same / likely different / can't tell, plus a note. Staff can't confirm or reject.
- [ ] The oncologist confirms or rejects from the snapshot banner. A preview shows what confirming adds and any new conflicts.
- [ ] The "Accepted with a name difference" list is restored.

---

### M3-09 · Prep status + "Mark ready"
**Labels:** `backend` `frontend` `M3` · **Ref:** B6 · **Screens:** 8b, 10a

`visit.prep_status` (preparing | ready), set_by, set_at.

**Acceptance**
- [ ] Checklist: uploaded · all facts checked · dates entered · held reviewed. Open conflicts don't block.
- [ ] Today groups: Ready for you · Staff preparing · Nothing new.

---

### M3-10 · "Other" document type
**Labels:** `backend` `frontend` `M3` · **Ref:** B8

**Acceptance**
- [ ] Selectable at upload. Stored and viewable in the document tree.
- [ ] Not extracted in M3 (the A5 fields are deferred).

---

### M3-11 · Document pane collapsed, opens at fact
**Labels:** `frontend` `M3` · **Ref:** B9 · **Screens:** 10m, prototype

**Acceptance**
- [ ] Collapsed rail by default. Clicking any fact opens the pane at that fact's highlight.
- [ ] Tree groups: Reports · Radiology · Prescriptions · Other.
- [ ] Shows the provenance level (exact / page / document). Never a broken deep link.
- [ ] Below 1180px the pane opens as an overlay.

---

### M3-12 · Wording guard additions
**Labels:** `frontend` `compliance` `M3` · **Ref:** AM-06

**Acceptance**
- [ ] New allowed and blocked terms are added to `wordingGuard` and its tests.
- [ ] Every new screen's copy passes the guard in CI.

---

### M3-13 · Dictation audio pilot
**Labels:** `backend` `frontend` `pilot` `M3` · **Ref:** AM-02

**Acceptance**
- [ ] Behind a feature flag, enabled for one oncologist.
- [ ] Record and play a dictated note per visit. Stored with the visit.
- [ ] No transcript and no plan suggestions.
- [ ] Staff have no access in M3. Every play is logged.
- [ ] Visit detail and History show "Dictated note · m:ss".
