# 03 · Implementation invariants — M3 amendments

Append to `docs/03-implementation-invariants.md`. Approved 2026-10-13. Each amendment states the rule it supersedes; where an amendment and the original conflict, the amendment wins. Everything not mentioned here stays as written in 01 and 03.

Source of design: `Prelude Wireframes.dc.html` (turn 5 approval list) and `Prelude Prototype.dc.html`.

---

## AM-01 · Batch sign-off (supersedes 01 §F7 "sign off individual facts")

**Rule.** The oncologist may sign off several facts in one action ("Sign off N reviewed").

**Invariants**
- A fact can be selected only if **all** of these are true: it has a spot-check mark of Correct; it has an as-of date; it has no open conflict; it is not held for identity.
- Selection boxes start **unchecked**. There is no "select all".
- Every selected fact's value, unit and source stay visible at the moment of sign-off.
- The backend writes **one audit record per fact**, never a single record for the batch.
- Per-fact sign-off remains available everywhere.

**Acceptance.** Ineligible facts show no checkbox and state why ("Needs staff check first"). Undo is available for 4 s after sign-off, and the audit records the reversal.

---

## AM-02 · Oncologist dictation audio (amends 01 §12 scope) — M3 pilot

**Rule.** For M3, the **oncologist's own dictated visit note** may be recorded and stored with the visit. **Consult recording and transcription are out of scope until a transcription vendor is chosen.**

**Invariants**
- Pilot is limited to one oncologist account (feature flag).
- Audio is stored per visit, playable in Visit detail and History. **No transcript and no extracted plan items** are produced.
- Access: the oncologist has full access. Staff can play a recording only through an assigned task (deferred with B7; in M3 staff have **no** access).
- Every play is written to an access log (who, when, which recording).
- Dictation does not capture the patient, so it needs **no patient consent** in M3. Patient consent (on file until withdrawn, re-confirmed at check-in, withdrawal deletes the recording) becomes mandatory **before** consult recording is enabled. Record it as AM-02b when the vendor is chosen.

---

## AM-03 · Visits elsewhere (supersedes 03: "a fact belongs to the visit it was uploaded in")

**Rule.** Documents from another facility may form a **visit elsewhere**: a record built from the document's own date and the facility named on it.

**Invariants**
- A visit elsewhere is created only when staff confirm the date and facility. It is never inferred silently.
- Facts keep a link to the upload visit **and** the visit elsewhere.
- UI always marks visits elsewhere (dashed rule plus the label "visit elsewhere · {facility}").
- The snapshot compares with **"Last visit here"** by default. **"Latest anywhere"** is a toggle and never the default.
- Visits elsewhere never get sign-off as a visit. Only their facts are signed off.

---

## AM-04 · Extraction scope tier 1 (amends 01 §3 field list)

**Added field types**
1. Diagnosis, as written
2. Histology / IHC, as written
3. Stage, as written
4. Surgery and procedures (text, date, facility)
5. Regimen, as written (already partial)
6. Next review date
7. Tests advised
8. Procedures planned
9. Radiology lesion sizes, as written (stored now; trend UI deferred with B4)

**Invariants**
- Same pipeline as today's facts: unverified → spot-check → sign-off. No field type skips the gate.
- "As written" fields store the source text verbatim. Nothing is normalised into a coded value in M3.
- No line of therapy, cycle count, response category (RECIST) or treatment history is computed from these fields.
- Each type has its own error-type options in spot-check.

**Deferred to tier 2:** CBC, kidney, liver. **Deferred (A5):** comorbidities, allergies, family history, ECOG, medicines on prescription, devices, BRCA. The Summary shows these as "Not extracted yet".

---

## AM-05 · Priority order (extends `deltaPriority`)

**Rule.** Items in "For this visit" follow one fixed order for every patient:

1. Conflict between sources
2. Pinned marker, changed or new
3. New radiology report
4. Changed or new, outside lab range
5. Plan item past advised date
6. Pinned marker not in this visit
7. Other changed or new

Then unchanged items, folded away.

**Invariants**
- No score, weighting or model. Ties keep document date order.
- The rule that placed each item is shown on that item. The full list is viewable in product ("How this is ordered").
- The order must not be described as triage, urgency or risk anywhere in UI or copy.

---

## AM-06 · Wording additions (extends §6 / `wordingGuard`)

Add these to the allowed set: "Planned", "Report seen", "Past advised date, no report seen", "Not found in documents", "Not extracted yet", "Visit elsewhere", "Pinned", "Suggested pin".

Add these to the blocked set: "done", "overdue", "missed", "due" (as a computed date), "triage", "urgent", "priority patient".

Advised intervals are shown as stated, with an approximate date in brackets: `"within 2 weeks" (≈27 Oct)`.
