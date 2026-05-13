/**
 * One-shot driver for the Phase 16 Plan 04 Task 2 operator checkpoint.
 *
 * Spawns fix-image-pollution-manual.ts as a child, watches stdout for known
 * prompt patterns, and writes the corresponding scripted answer. Required
 * because `node:readline/promises` closes the interface when piped stdin
 * reaches EOF, so we must keep stdin open until the CLI exits.
 *
 * Run: NODE_OPTIONS=--use-system-ca npx tsx scripts/drive-checkpoint.ts
 *
 * Hardcoded answer sequence (covers the FORCE path on row 1 + DELETE on row 2):
 *   1. "r"     — replace BackImage on CHECKPOINT-TEST-001
 *   2. <URL>   — paste the side-image URL as the new BackImage
 *   3. "f"     — choose force after verifier fails
 *   4. "FORCE" — literal force confirmation
 *   5. "d"     — delete DirectSideImage on CHECKPOINT-TEST-002
 *   6. "DELETE"— literal delete confirmation
 */

import { spawn } from 'child_process';
import { existsSync, readdirSync } from 'fs';

interface Step {
  match: RegExp;
  answer: string;
  label: string;
  consumed?: boolean;
}

function findQueueTsv(): string {
  if (!existsSync('tmp')) throw new Error('tmp/ dir missing');
  const files = readdirSync('tmp')
    .filter((f) => /^image-pollution-manual-queue-\d{4}-\d{2}-\d{2}-test\.tsv$/.test(f))
    .sort()
    .reverse();
  if (files.length === 0) {
    throw new Error('No checkpoint queue TSV found in tmp/ — run seed-checkpoint-test-data.ts first');
  }
  return `tmp/${files[0]}`;
}

function main(): void {
  const queueFile = findQueueTsv();
  console.log(`[driver] using queue: ${queueFile}`);

  // Scripted answers, matched in order. Each step fires exactly once when its
  // regex first matches in the buffered stdout.
  const steps: Step[] = [
    { match: /\[r\]eplace .* \[q\]uit:/, answer: 'r', label: 'choice=r (TEST-001 replace)' },
    {
      match: /New URL or fileId:/,
      answer: 'https://drive.google.com/uc?id=1kIdeNgjGG7_WhcPgBcG-1BftDpzGA-GE',
      label: 'paste replacement URL',
    },
    { match: /\[r\]etry \| \[s\]kip \| \[f\]orce/, answer: 'f', label: 'choice=f (after verifier fail)' },
    { match: /Type FORCE to confirm:/, answer: 'FORCE', label: 'literal FORCE' },
    { match: /\[r\]eplace .* \[q\]uit:/, answer: 'd', label: 'choice=d (TEST-002 delete)' },
    { match: /Type DELETE to confirm:/, answer: 'DELETE', label: 'literal DELETE' },
  ];

  let buffer = '';
  let stepIdx = 0;
  const startTime = Date.now();

  const child = spawn(
    'npx',
    ['tsx', 'scripts/fix-image-pollution-manual.ts', '--queue-file', queueFile],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '--use-system-ca' },
      shell: true,
    },
  );

  function onChunk(chunk: Buffer | string, isErr: boolean): void {
    const text = chunk.toString();
    process[isErr ? 'stderr' : 'stdout'].write(text);
    buffer += text;
    while (stepIdx < steps.length) {
      const step = steps[stepIdx];
      if (step.consumed) {
        stepIdx++;
        continue;
      }
      const m = step.match.exec(buffer);
      if (!m) break;
      step.consumed = true;
      // Drop everything up to and including the match so the same regex on a
      // later step doesn't re-fire prematurely (steps 1 + 5 share a regex).
      buffer = buffer.slice(m.index + m[0].length);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`\n[driver +${elapsed}s] step ${stepIdx + 1}/${steps.length}: ${step.label} → "${step.answer}"`);
      child.stdin.write(step.answer + '\n');
      stepIdx++;
    }
  }

  child.stdout.on('data', (chunk) => onChunk(chunk, false));
  child.stderr.on('data', (chunk) => onChunk(chunk, true));

  child.on('exit', (code) => {
    console.log(`\n[driver] child exited with code ${code}`);
    console.log(`[driver] steps fired: ${stepIdx}/${steps.length}`);
    process.exit(code ?? 1);
  });

  // 5-minute hard timeout — protects against verifier hang.
  setTimeout(() => {
    console.error('[driver] HARD TIMEOUT 5min — killing child');
    child.kill('SIGTERM');
    process.exit(1);
  }, 300_000);
}

main();
