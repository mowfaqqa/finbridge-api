import PDFDocument from 'pdfkit';
import { resolve as resolvePath } from 'node:path';
import type { Readiness } from './readiness';

const text = '#0F172A';
const muted = '#475569';
const action = '#0F766E';
const divider = '#CBD5E1';
const margin = 42;
const checkLabels = { COMPLETE: 'Complete', NEEDS_ATTENTION: 'Needs attention', NOT_APPLICABLE: 'Not applicable' };
const dateFormat = new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const timeFormat = new Intl.DateTimeFormat('en-NG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Lagos' });
const monthFormat = new Intl.DateTimeFormat('en-NG', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const date = (iso: string) => dateFormat.format(new Date(`${iso}T00:00:00Z`));

function money(kobo: string) {
  const value = BigInt(kobo);
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}${(absolute / 100n).toLocaleString('en-NG')}.${(absolute % 100n).toString().padStart(2, '0')}`;
}

export function renderEvidencePdf(id: string, checksum: string, snapshot: Readiness) {
  return new Promise<Buffer>((resolve, reject) => {
    const created = new Date(snapshot.asOf);
    const doc = new PDFDocument({
      size: 'A4', margin, bufferPages: true,
      info: { Title: 'FinBridge OS Financing Readiness Pack', Author: 'FinBridge OS', CreationDate: created, ModDate: created },
    });
    const fonts = resolvePath(__dirname, '../../assets/fonts');
    doc.registerFont('Plex', resolvePath(fonts, 'IBMPlexSans-Regular.ttf'));
    doc.registerFont('PlexSemibold', resolvePath(fonts, 'IBMPlexSans-SemiBold.ttf'));
    const buffers: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => buffers.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(buffers)));

    const width = doc.page.width - 2 * margin;
    const body = (value: string) => doc.font('Plex').fontSize(10).fillColor(text).text(value, { lineGap: 2 });
    const meta = (value: string) => doc.font('Plex').fontSize(9).fillColor(muted).text(value, { lineGap: 1 });
    const heading = (value: string) => {
      if (doc.y + 65 > doc.page.height - margin) doc.addPage();
      doc.moveDown(0.55).font('PlexSemibold').fontSize(14).fillColor(action).text(value);
      doc.moveDown(0.18);
    };

    doc.font('PlexSemibold').fontSize(11).fillColor(action).text('FinBridge OS');
    doc.moveDown(0.4).fontSize(24).fillColor(text).text('Financing readiness pack');
    doc.moveDown(0.3).fontSize(14).text(snapshot.workspaceName);
    doc.moveDown(0.4);
    meta(`${timeFormat.format(created)} WAT  |  Rules ${snapshot.rulesVersion}`);
    meta(`${date(snapshot.cashFlow.period.start)} to ${date(snapshot.cashFlow.period.end)}`);
    doc.moveDown(0.5).font('PlexSemibold').fontSize(10).fillColor(snapshot.incomplete ? '#92400E' : action)
      .text(snapshot.incomplete ? 'Incomplete evidence pack' : 'Readiness checklist complete');
    body('Evidence preparation only');

    heading('Readiness checklist');
    for (const check of snapshot.checks) {
      if (doc.y + 48 > doc.page.height - margin) doc.addPage();
      doc.font('PlexSemibold').fontSize(10).fillColor(text).text(`${check.label} - ${checkLabels[check.state]}`);
      meta(check.detail);
      if (check.action) meta(check.action);
      doc.moveDown(0.18);
    }

    heading('Monthly statement movements');
    meta('Amounts in NGN');
    const columns = [105, 131, 131, width - 367];
    const monthly = (values: string[], emphasized = false) => {
      const y = doc.y;
      let x = margin;
      doc.font(emphasized ? 'PlexSemibold' : 'Plex').fontSize(9).fillColor(text);
      values.forEach((value, index) => {
        doc.text(value, x, y, { width: columns[index] - 6, align: index ? 'right' : 'left', lineBreak: false });
        x += columns[index];
      });
      doc.x = margin;
      doc.y = y + 16;
      doc.moveTo(margin, doc.y - 4).lineTo(margin + width, doc.y - 4).strokeColor(divider).lineWidth(0.5).stroke();
    };
    if (doc.y + 110 > doc.page.height - margin) doc.addPage();
    monthly(['Month', 'Inflow', 'Outflow', 'Net'], true);
    for (const row of snapshot.cashFlow.monthly) {
      monthly([monthFormat.format(new Date(`${row.month}-01T00:00:00Z`)), money(row.inflowKobo), money(row.outflowKobo), money(row.netKobo)]);
    }
    const totals = snapshot.cashFlow.totals;
    monthly(['Observed total', money(totals.inflowKobo), money(totals.outflowKobo), money(totals.netKobo)], true);

    heading('Statement coverage');
    if (!snapshot.cashFlow.accounts.length) body('No active statement accounts.');
    for (const account of snapshot.cashFlow.accounts) {
      if (doc.y + 55 > doc.page.height - margin) doc.addPage();
      body(`${account.label}${account.lastFour ? ` (ending ${account.lastFour})` : ''} - ${account.coveredDays} of ${account.totalDays} days covered`);
      const gaps = account.gaps.slice(0, 4).map((gap) => `${date(gap.start)} to ${date(gap.end)}`);
      if (gaps.length) meta(`Uncovered dates ${gaps.join(', ')}${account.gaps.length > gaps.length ? '. See the snapshot for remaining dates.' : ''}`);
    }
    meta(`${snapshot.cashFlow.matchedCount} of ${snapshot.cashFlow.nonTransferCount} non-transfer rows reconciled. ${snapshot.cashFlow.unmatchedCount} unmatched lines.`);

    heading('Current receivables');
    body(`Open NGN ${money(snapshot.receivables.totalOpenKobo)}  |  Current NGN ${money(snapshot.receivables.currentKobo)}  |  Overdue NGN ${money(snapshot.receivables.overdueKobo)}`);
    for (const row of snapshot.receivables.aging) meta(`${row.label.replaceAll('–', '-')} days overdue  NGN ${money(row.amountKobo)}`);

    if (doc.y + 115 > doc.page.height - margin) doc.addPage();
    heading('Assumptions and source references');
    body('Cash flow uses committed statement movements and confirmed coverage. Both legs of confirmed transfers are excluded when both accounts are selected.');
    body('Receivables reflect issued invoices and active settlements as of the snapshot time.');
    doc.moveDown(0.5);
    meta(`Snapshot ID ${id}`);
    meta(`Checksum ${checksum}`);
    meta(`${snapshot.sourceBatchIds.length} committed source batches. Open the workspace snapshot for their IDs.`);

    const pages = doc.bufferedPageRange();
    for (let index = pages.start; index < pages.start + pages.count; index++) {
      doc.switchToPage(index);
      const previousMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Plex').fontSize(8).fillColor(muted).text(
        `FinBridge OS  |  Evidence preparation only  |  ${index + 1} of ${pages.count}`,
        margin, doc.page.height - 30, { width, align: 'right' },
      );
      doc.page.margins.bottom = previousMargin;
    }
    doc.end();
  });
}
