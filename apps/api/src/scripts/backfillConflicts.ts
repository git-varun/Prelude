import { sql } from "../db/client";
import { detectConflicts, type ConflictPair } from "../services/rules";

// One-off backfill (M7): conflict detection is new — nothing ingested since
// M2 has ever been checked for it. Run manually, not as a scheduled job:
//   bun run apps/api/src/scripts/backfillConflicts.ts [--dry-run]
// Runs detectConflicts against every currently-dated FACT. Each fact gets
// its own transaction so one failure doesn't roll back everything already
// checked; detectConflicts is idempotent (skips a pair that already has a
// conflicts row), so re-running this script is safe.
//
// --dry-run: reports every pair detectConflicts would touch (new vs.
// already-existing conflicts row) without writing anything — no INSERT, no
// coverage_status UPDATE. Use this before a real run against data you
// haven't backfilled yet, or to audit an existing conflicts table against
// the current detection logic after a code change.
const DRY_RUN = process.argv.includes("--dry-run");

async function run(): Promise<void> {
  const facts = await sql`
    SELECT id, patient_id, field_type, tracked_marker_id, as_of_date, value, needs_manual_date
    FROM facts
    WHERE as_of_date IS NOT NULL AND needs_manual_date = false
    ORDER BY as_of_date
  `;

  console.log(`${DRY_RUN ? "[dry run] " : ""}Checking ${facts.length} dated fact(s) for conflicts...`);
  let checked = 0;
  let failed = 0;
  const wouldCreate: ConflictPair[] = [];
  const alreadyExisted: ConflictPair[] = [];

  for (const fact of facts) {
    try {
      if (DRY_RUN) {
        const pairs = await detectConflicts(sql, fact, { dryRun: true });
        for (const pair of pairs) {
          (pair.alreadyExists ? alreadyExisted : wouldCreate).push(pair);
        }
      } else {
        await sql.begin(async (tx) => {
          await detectConflicts(tx, fact);
        });
      }
      checked++;
    } catch (err) {
      failed++;
      console.error(`Failed to check fact ${fact.id}:`, err);
    }
  }

  if (DRY_RUN) {
    console.log(`\n${wouldCreate.length} pair(s) would get a new conflicts row:`);
    for (const p of wouldCreate) console.log(`  ${p.factIdA}  <->  ${p.factIdB}`);
    console.log(`\n${alreadyExisted.length} pair(s) already have a conflicts row (unchanged).`);
  }

  console.log(`\nDone. ${checked} checked, ${failed} failed.`);
}

await run();
process.exit(0);
