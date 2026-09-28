'use strict';
// Read-only OCR postprocessing. No SharePoint writes or external OCR calls.
function normalizeId(v) { return String(v ?? '').normalize('NFKC').replace(/[\s-]/g, ''); }
function normalizeAddress(v) { return String(v ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim(); }
function splitAddress(value) {
  const address = normalizeAddress(value);
  const m = address.match(/^(.*?)(\d+(?:-\d+){1,3})(?:\s*(.*))?$/);
  return m ? { area: m[1].trim(), block: m[2], remainder: (m[3] || '').trim() } : null;
}
function validateOcrCandidate(ocr, masterRows) {
  if (!ocr || !Array.isArray(masterRows)) return { ok: false, errors: ['入力またはマスタが不正です'] };
  const id = normalizeId(ocr.customerNumber);
  if (!id) return { ok: false, errors: ['顧客番号がありません'] };
  const matches = masterRows.filter(row => normalizeId(row.customerNumber) === id);
  if (matches.length !== 1) return { ok: false, errors: [matches.length ? '顧客番号が重複しています' : '顧客番号が一致しません'] };
  const row = matches[0], errors = [];
  if (!ocr.address || !row.address) errors.push('住所が未入力です');
  else if (normalizeAddress(ocr.address).replace(/\s/g, '') !== normalizeAddress(row.address).replace(/\s/g, '')) errors.push('住所が一致しません');
  const address = splitAddress(ocr.address);
  if (!address || !address.area || !address.block) errors.push('住所の分割を確認してください');
  if (ocr.workDate && row.workDate && String(ocr.workDate) !== String(row.workDate)) errors.push('作業日が一致しません');
  return { ok: errors.length === 0, errors, preview: { customerNumber: id, address, workDate: ocr.workDate ?? null }, requiresHumanApproval: true, saved: false };
}
module.exports = { normalizeId, splitAddress, validateOcrCandidate };
