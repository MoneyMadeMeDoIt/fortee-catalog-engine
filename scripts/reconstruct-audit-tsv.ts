/**
 * Reconstruct the audit summary TSV from the partial trail of a hung audit run.
 *
 * The audit writes the summary TSV atomically at the end — but the trail is
 * fsynced per row. When the audit hangs, the trail contains all the data we
 * need to reconstruct most of the summary:
 *
 *   - Pass 1 shared_url      → trail.notes "pass1 shared_url collision (with …)"
 *   - Pass 1 invalid_image_format → NOT in trail; rerun audit Pass 1 to recover
 *   - Pass 2 content_mismatch → trail.notes "pass2 <col>-vs-<col>: …"
 *   - Pass 2 model_pollution  → trail.notes "pass2 Model*-vs-front: …"
 *   - Pass 3 shape_drift      → trail.notes "pass3 …"
 *
 * Output schema matches scripts/audit-image-pollution.ts D-09:
 *   pid  pollution_class  affected_columns  affected_drive_urls
 *   expected_supplier_url  recommended_fix_tier  pass_detected_in  notes
 *
 * `recommended_fix_tier` is set to "3" (conservative) for all reconstructed
 * rows — the fix orchestrator can still escalate to Tier 1/2 based on class
 * and supplier-canonical availability per its own logic.
 *
 * Run: npx tsx scripts/reconstruct-audit-tsv.ts \
 *        --trail tmp/image-pollution-fix-trail-YYYY-MM-DD.tsv \
 *        --out   tmp/image-pollution-audit-YYYY-MM-DD.tsv
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';

interface TrailRow {
  ts: string;
  pid: string;
  op: string;
  column: string;
  oldVal: string;
  newVal: string;
  tier: string;
  runId: string;
  notes: string;
}

type PollutionClass =
  | 'shared_url'
  | 'invalid_image_format'
  | 'content_mismatch'
  | 'model_pollution'
  | 'shape_drift';

interface AuditRow {
  pid: string;
  pollution_class: PollutionClass;
  affected_columns: string;
  affected_drive_urls: string;
  expected_supplier_url: string;
  recommended_fix_tier: string;
  pass_detected_in: string;
  notes: string;
}

function parseArgs(argv: string[]): { trail: string; out: string } {
  const a = (k: string): string | undefined => {
    const v = argv.find((x) => x.startsWith(`--${k}=`));
    return v ? v.slice(`--${k}=`.length) : undefined;
  };
  const today = new Date().toISOString().slice(0, 10);
  return {
    trail: a('trail') ?? `tmp/image-pollution-fix-trail-${today}.tsv`,
    out: a('out') ?? `tmp/image-pollution-audit-${today}.tsv`,
  };
}

function parseTrail(path: string): TrailRow[] {
  if (!existsSync(path)) {
    console.error(`Trail not found: ${path}`);
    process.exit(1);
  }
  const lines = readFileSync(path, 'utf8').split('\n');
  const out: TrailRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const c = lines[i].split('\t');
    out.push({
      ts: c[0] ?? '',
      pid: c[1] ?? '',
      op: c[2] ?? '',
      column: c[3] ?? '',
      oldVal: c[4] ?? '',
      newVal: c[5] ?? '',
      tier: c[6] ?? '',
      runId: c[7] ?? '',
      notes: c[8] ?? '',
    });
  }
  return out;
}

/**
 * Map a trail VERIFIER_FAIL row to (pollution_class, pass) by parsing the
 * `notes` prefix that audit-image-pollution.ts writes.
 */
function classifyFail(row: TrailRow): { cls: PollutionClass; pass: '1' | '2' | '3' } | null {
  const n = row.notes;
  if (n.startsWith('pass1 shared_url')) return { cls: 'shared_url', pass: '1' };
  if (n.startsWith('pass1 invalid_image_format')) return { cls: 'invalid_image_format', pass: '1' };
  if (n.startsWith('pass2 Model')) return { cls: 'model_pollution', pass: '2' };
  if (n.startsWith('pass2')) return { cls: 'content_mismatch', pass: '2' };
  if (n.startsWith('pass3')) return { cls: 'shape_drift', pass: '3' };
  return null;
}

function buildAuditRows(trail: TrailRow[]): AuditRow[] {
  const out: AuditRow[] = [];
  for (const r of trail) {
    if (r.op !== 'VERIFIER_FAIL') continue;
    const c = classifyFail(r);
    if (!c) {
      console.warn(`Skipping unclassifiable fail: ${r.pid} notes="${r.notes.slice(0, 60)}"`);
      continue;
    }
    out.push({
      pid: r.pid,
      pollution_class: c.cls,
      affected_columns: r.column,
      affected_drive_urls: r.oldVal,
      expected_supplier_url: '',
      recommended_fix_tier: '3',
      pass_detected_in: c.pass,
      notes: r.notes,
    });
  }
  return out;
}

function main(): void {
  const { trail, out } = parseArgs(process.argv);
  console.log(`Reading trail:  ${trail}`);
  console.log(`Writing audit:  ${out}\n`);

  const trailRows = parseTrail(trail);
  const auditRows = buildAuditRows(trailRows);

  if (auditRows.length === 0) {
    console.error('No VERIFIER_FAIL rows found in trail — nothing to reconstruct.');
    process.exit(1);
  }

  const reconstructionTs = new Date().toISOString();
  const header =
    `# audit_run_id=${reconstructionTs} (reconstructed from trail)\n` +
    `pid\tpollution_class\taffected_columns\taffected_drive_urls\texpected_supplier_url\trecommended_fix_tier\tpass_detected_in\tnotes\n`;

  const body = auditRows
    .map((r) =>
      [
        r.pid,
        r.pollution_class,
        r.affected_columns,
        r.affected_drive_urls,
        r.expected_supplier_url,
        r.recommended_fix_tier,
        r.pass_detected_in,
        r.notes,
      ].join('\t'),
    )
    .join('\n') + '\n';

  writeFileSync(out, header + body, 'utf8');

  // Summary
  const byClass = new Map<string, number>();
  const byPid = new Set<string>();
  for (const r of auditRows) {
    byClass.set(r.pollution_class, (byClass.get(r.pollution_class) ?? 0) + 1);
    byPid.add(r.pid);
  }

  console.log(`Wrote ${auditRows.length} rows across ${byPid.size} unique pids.`);
  console.log('');
  console.log('Class breakdown:');
  for (const [cls, n] of [...byClass.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cls.padEnd(22)} ${n}`);
  }
  console.log('');
  console.log(`Audit TSV: ${out}`);
  console.log(`Run fix orchestrator (dry-run first) with: --audit-file=${out}`);
}

main();
