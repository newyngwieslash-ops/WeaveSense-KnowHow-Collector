#!/usr/bin/env node
// Run via sync-video-workbook.sh so artifact-tool resolves only in the primary runtime.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool';

const args = process.argv.slice(2);
function option(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing ${name} value`);
  return args[i + 1];
}
const repo = path.resolve(option('--repo', process.cwd()));
const docs = path.join(repo, 'docs/video-ingestion');
const baselinePath = path.resolve(option('--baseline', path.join(docs, 'spec/tasks.baseline.xlsx')));
const outputPath = path.resolve(option('--output', path.join(docs, 'WeaveSense_完整开发任务清单_执行版.xlsx')));
const qaDir = path.resolve(option('--qa-dir', path.join(repo, '.local/workbook-qa')));
const inspectOnly = args.includes('--inspect-baseline');
if (baselinePath === outputPath) throw new Error('Refusing to overwrite the immutable baseline');
if (process.execPath !== process.env.CODEX_PRIMARY_RUNTIME_NODE) throw new Error('Use CODEX_PRIMARY_RUNTIME_NODE');
await fs.mkdir(qaDir, { recursive: true });
const baselineBytes = await fs.readFile(baselinePath);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const baselineHash = hash(baselineBytes);
const inputManifest = JSON.parse(await fs.readFile(path.join(docs, 'spec/manifest.json'), 'utf8'));
const expectedBaseline = inputManifest.inputs.find(item => item.file === 'tasks.baseline.xlsx');
if (!expectedBaseline || expectedBaseline.sha256 !== baselineHash) throw new Error('Workbook differs from the immutable approved baseline');
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(baselinePath));
const sheets = ['交付总览', '开发任务', '任务规格', '需求与验收', '端到端用例', '基线与约定'];
const overview = await workbook.inspect({ kind: 'sheet', include: 'id,name', maxChars: 3000 });
await fs.writeFile(path.join(qaDir, 'sheets.ndjson'), overview.ndjson);
for (let i = 0; i < sheets.length; i++) {
  if (workbook.worksheets.getItemAt(i).name !== sheets[i]) throw new Error(`Unexpected sheet ${i}`);
}
async function render(prefix) {
  const views = [
    ['summary', '交付总览', 'A6:H39'],
    ['tasks', '开发任务', 'F6:L13'],
    ['notes', '开发任务', 'P6:Q10'],
    ['acceptance', '端到端用例', 'G6:K11'],
    ['p2', '开发任务', 'A107:H113'],
  ];
  const noteRows = workbook.worksheets.getItem('开发任务').getRange('Q7:Q113').values;
  const longestNoteIndex = noteRows.reduce((best, row, index) => String(row[0] ?? '').length > String(noteRows[best][0] ?? '').length ? index : best, 0);
  const longestRow = longestNoteIndex + 7;
  views.push(['long-note', '开发任务', `P${longestRow}:Q${longestRow}`]);
  const results = [];
  for (const [name, sheetName, range] of views) {
    try {
      const image = await workbook.render({ sheetName, range, scale: 1.3, format: 'png' });
      const file = path.join(qaDir, `${prefix}-${name}.png`);
      await fs.writeFile(file, new Uint8Array(await image.arrayBuffer()));
      results.push({ name, sheetName, range, file });
    } catch (error) { results.push({ name, sheetName, range, error: String(error) }); }
  }
  return results;
}
if (inspectOnly) {
  const renders = await render('baseline');
  await fs.writeFile(path.join(qaDir, 'baseline-renders.json'), JSON.stringify(renders, null, 2));
  console.log(JSON.stringify({ baseline: baselinePath, sha256: baselineHash, renders }));
  process.exit(renders.some(x => x.error) ? 2 : 0);
}

const python = process.env.CODEX_PRIMARY_RUNTIME_PYTHON;
if (!python) throw new Error('CODEX_PRIMARY_RUNTIME_PYTHON is required for read-only validation');
execFileSync(python, [path.join(repo, 'scripts/video-task-ledger.py'), 'validate'], { cwd: repo });
const spec = JSON.parse(await fs.readFile(path.join(docs, 'spec/tasks.baseline.json'), 'utf8'));
const ledgerBytes = await fs.readFile(path.join(docs, 'PROGRESS.json'));
const ledger = JSON.parse(ledgerBytes);
const tasks = workbook.worksheets.getItem('开发任务');
const cases = workbook.worksheets.getItem('端到端用例');
// Imported differential fills lose their explicit solid pattern in this runtime.
// Reapply the exact source rules with an explicit public FillConfig, not new rules.
const conditionalFormats = JSON.parse(execFileSync(python, [path.join(repo, 'scripts/verify-video-workbook.py'), '--conditional-formatting', baselinePath], { encoding: 'utf8' }));
for (const group of conditionalFormats) {
  const range = workbook.worksheets.getItem(group.sheet).getRange(group.range);
  range.conditionalFormats.deleteAll();
  for (const rule of group.rules) range.conditionalFormats.add(rule.type, rule.config);
}
const before = {};
for (const name of sheets) {
  const s = workbook.worksheets.getItem(name);
  const range = s.getUsedRange();
  before[name] = { address: range.address, values: range.values, formulas: range.formulas };
}
function mapRows(sheet, expectedIds, endRow) {
  const values = sheet.getRange(`A7:A${endRow}`).values;
  const rows = new Map();
  values.forEach(([id], index) => {
    if (!id || rows.has(id)) throw new Error(`Missing/duplicate ${sheet.name} ID: ${id}`);
    rows.set(id, index + 7);
  });
  if (rows.size !== expectedIds.length || expectedIds.some(id => !rows.has(id))) throw new Error(`IDs differ: ${sheet.name}`);
  return rows;
}
const taskRows = mapRows(tasks, spec.tasks.map(t => t.id), 113);
const caseRows = mapRows(cases, spec.acceptance.map(c => c.id), 36);
const edits = [];
function set(sheet, address, value, id, field) {
  const current = sheet.getRange(address).values[0][0];
  const next = value === '' ? null : value;
  if ((current ?? null) !== next) {
    sheet.getRange(address).values = [[next]];
    edits.push({ sheet: sheet.name, address, id, field, before: current ?? null, after: next });
  }
}
function lines(value) { return value.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('\n'); }
for (const task of spec.tasks) {
  const state = ledger.tasks[task.id], row = taskRows.get(task.id);
  set(tasks, `G${row}`, state.owner, task.id, 'owner');
  set(tasks, `H${row}`, state.status, task.id, 'status');
  set(tasks, `P${row}`, state.issue, task.id, 'issue');
  const original = tasks.getRange(`Q${row}`).values[0][0] ?? '';
  const operational = [...state.blocking_notes];
  const checkCounts = {};
  for (const check of Object.values(state.acceptance_checks)) checkCounts[check.status] = (checkCounts[check.status] || 0) + 1;
  if (state.status !== '未开始' || operational.length || state.code_evidence.length) {
    operational.push('逐条验收：' + Object.entries(checkCounts).map(([status, count]) => `${status} ${count}`).join('，') + '。');
  }
  const next = operational.length ? `${original}${original ? '\n\n' : ''}【执行记录】\n${operational.join('\n')}` : original;
  set(tasks, `Q${row}`, next, task.id, 'execution_notes');
  if (next !== original) {
    const noteRange = tasks.getRange(`Q${row}`);
    const previousHeight = noteRange.format.rowHeight;
    noteRange.format.autofitRows();
    noteRange.format.rowHeight = Math.ceil(Math.max(previousHeight, noteRange.format.rowHeight + 6));
    const edit = edits.find(e => e.sheet === tasks.name && e.address === `Q${row}`);
    edit.row_height_before = previousHeight;
    edit.row_height_after = noteRange.format.rowHeight;
  }
}
for (const ac of spec.acceptance) {
  const state = ledger.acceptance[ac.id], row = caseRows.get(ac.id);
  set(cases, `H${row}`, state.status, ac.id, 'status');
  set(cases, `I${row}`, state.reviewer, ac.id, 'reviewer');
  set(cases, `J${row}`, lines(state.evidence), ac.id, 'evidence');
  set(cases, `K${row}`, lines(state.defects), ac.id, 'defects');
}
// Test the live dependency chain, then restore every temporary input before export.
const taskId = spec.tasks.find(t => t.phase === 'P0').id;
const caseId = spec.acceptance.find(c => c.phase === 'P0').id;
const taskCell = tasks.getRange(`H${taskRows.get(taskId)}`);
const caseCell = cases.getRange(`H${caseRows.get(caseId)}`);
const summarySheet = workbook.worksheets.getItem('交付总览');
const taskOriginal = taskCell.values[0][0], caseOriginal = caseCell.values[0][0];
const dependent = spec.tasks.find(t => t.deps.includes(taskId));
const dependencyCell = tasks.getRange(`K${taskRows.get(dependent.id)}`);
const originalDependencyCount = dependencyCell.values[0][0];
const taskComplete = spec.tasks.filter(t => t.phase === 'P0' && ledger.tasks[t.id].status === '已完成').length;
const caseComplete = spec.acceptance.filter(c => ['P0', 'P1'].includes(c.phase) && ledger.acceptance[c.id].status === '通过').length;
taskCell.values = [['已完成']];
caseCell.values = [['通过']];
workbook.recalculate();
const testResults = {
  p0_complete: summarySheet.getRange('E9').values[0][0],
  v1_cases_passed: summarySheet.getRange('D39').values[0][0],
  downstream_incomplete_dependencies: dependencyCell.values[0][0],
};
taskCell.values = [[taskOriginal]];
caseCell.values = [[caseOriginal]];
if (testResults.p0_complete !== taskComplete + (taskOriginal === '已完成' ? 0 : 1) || testResults.v1_cases_passed !== caseComplete + (caseOriginal === '通过' ? 0 : 1) || testResults.downstream_incomplete_dependencies !== originalDependencyCount - (taskOriginal === '已完成' ? 0 : 1)) throw new Error(`Recalculation probe failed: ${JSON.stringify(testResults)}`);
workbook.recalculate();
await fs.writeFile(path.join(qaDir, 'recalculation-probe.json'), JSON.stringify({ taskId, caseId, temporary_results: testResults, restored_p0_complete: summarySheet.getRange('E9').values[0][0], restored_v1_cases_passed: summarySheet.getRange('D39').values[0][0] }, null, 2));
const errorScan = await workbook.inspect({ kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!', options: { useRegex: true, maxResults: 300 }, maxChars: 10000 });
await fs.writeFile(path.join(qaDir, 'formula-errors.ndjson'), errorScan.ndjson);
const summary = await workbook.inspect({ kind: 'table', range: "'交付总览'!A6:H39", include: 'values,formulas', tableMaxRows: 34, tableMaxCols: 8, maxChars: 14000 });
await fs.writeFile(path.join(qaDir, 'summary.ndjson'), summary.ndjson);
const after = {};
for (const name of sheets) {
  const s = workbook.worksheets.getItem(name), range = s.getUsedRange();
  after[name] = { address: range.address, values: range.values, formulas: range.formulas };
}
await fs.writeFile(path.join(qaDir, 'artifact-snapshots.json'), JSON.stringify({ before, after }));
await fs.writeFile(path.join(qaDir, 'expected-edits.json'), JSON.stringify(edits, null, 2));
const renders = await render('execution');
if (renders.some(result => result.error)) throw new Error(`Preview failed: ${JSON.stringify(renders.filter(result => result.error))}`);
const output = await SpreadsheetFile.exportXlsx(workbook);
const candidate = path.join(qaDir, 'candidate.xlsx');
await output.save(candidate);
if (hash(await fs.readFile(baselinePath)) !== baselineHash) throw new Error('Baseline changed during synchronization');
if (hash(await fs.readFile(path.join(docs, 'PROGRESS.json'))) !== hash(ledgerBytes)) throw new Error('Ledger changed during build; rerun with the current ledger');
const auditPath = path.join(qaDir, 'preservation-audit.json');
execFileSync(python, [path.join(repo, 'scripts/verify-video-workbook.py'), baselinePath, candidate, path.join(qaDir, 'expected-edits.json'), auditPath], { cwd: repo, stdio: 'inherit' });
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.copyFile(candidate, outputPath);
await fs.copyFile(auditPath, path.join(docs, 'workbook-validation.json'));
const report = { baseline: baselinePath, baseline_sha256: baselineHash, ledger_sha256: hash(ledgerBytes), output: outputPath, output_sha256: hash(await fs.readFile(outputPath)), edits: edits.length, task_count: taskRows.size, acceptance_count: caseRows.size, status_counts: Object.values(ledger.tasks).reduce((a, t) => (a[t.status] = (a[t.status] || 0) + 1, a), {}), renders, audit: auditPath, limitations: ['Native Microsoft Excel/LibreOffice recalculation and interactive dropdowns were not executed.'] };
await fs.writeFile(path.join(qaDir, 'build-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
