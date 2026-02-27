/**
 * Universal Document Ingestion Pipeline
 *
 * Accepts uploaded files (PDF, DOCX, TXT, images, PPTX, XLS) and normalises
 * them into a NormalizedDocument that the chat-stream route can hand to the
 * appropriate AI model.
 *
 *   const { ingestAttachment } = require('./document-ingestion');
 *   const doc = await ingestAttachment(buffer, originalName, mimeType);
 *
 * NormalizedDocument shape:
 *   { kind, detectedLanguage, title?, text?, pages?, imagePath?,
 *     meta: { fileName, mimeType, sizeBytes, pageCount?, extractionMethod } }
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');
const { getSetting } = require('./settings');

/* ── Lazy-loaded heavy libs (keep startup fast) ──────────── */
let mammoth, pdfParse, franc, XLSX;

function loadMammoth()  { if (!mammoth)  mammoth  = require('mammoth');   return mammoth; }
function loadPdfParse() { if (!pdfParse) pdfParse = require('pdf-parse'); return pdfParse; }
function loadFranc()    { if (!franc)    franc    = require('franc-min'); return franc; }
function loadXLSX()     { if (!XLSX)    XLSX     = require('xlsx');       return XLSX; }

/* ── Configurable limits (env vars) ──────────────────────── */
const MAX_UPLOAD_MB       = parseInt(process.env.MAX_UPLOAD_MB       || '20', 10);
const MAX_PDF_PAGES       = parseInt(process.env.MAX_PDF_PAGES       || '5', 10);
const PDF_RENDER_DPI      = parseInt(process.env.PDF_RENDER_DPI      || '180', 10);
const MAX_TEXT_CHARS       = parseInt(process.env.MAX_TEXT_CHARS      || '120000', 10);
const MIN_TEXT_CHARS       = 200; // minimum chars to consider PDF text "usable"
const MAX_SHEETS          = parseInt(process.env.MAX_SHEETS          || '3', 10);
const MAX_ROWS_PER_SHEET  = parseInt(process.env.MAX_ROWS_PER_SHEET  || '50', 10);
const MAX_CONTEXT_CHARS   = parseInt(process.env.MAX_CONTEXT_CHARS   || '120000', 10);

/* ── Allowed MIME types ──────────────────────────────────── */
const MIME_IMAGE = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MIME_DOC   = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',    // .docx
  'text/plain',
  'text/csv',                                                                    // .csv
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',  // .pptx
  'application/vnd.ms-excel',                                                   // .xls
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',          // .xlsx
]);

/** All accepted MIME types */
const ALLOWED_MIMES = new Set([...MIME_IMAGE, ...MIME_DOC]);

/**
 * Accept string for the HTML file input
 */
const FILE_INPUT_ACCEPT = [
  'image/png', 'image/jpeg', 'image/webp',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain', 'text/csv',
  '.pdf', '.docx', '.txt', '.pptx', '.xlsx', '.xls', '.csv',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
].join(',');

/* ── Temp directory management ───────────────────────────── */
const TEMP_ROOT = path.join(os.tmpdir(), 'getouch-docs');

function ensureTempDir() {
  if (!fs.existsSync(TEMP_ROOT)) fs.mkdirSync(TEMP_ROOT, { recursive: true });
  return TEMP_ROOT;
}

/** Write buffer to temp file, return absolute path */
function writeTempFile(buf, ext) {
  ensureTempDir();
  const name = `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
  const p = path.join(TEMP_ROOT, name);
  fs.writeFileSync(p, buf);
  return p;
}

/** Remove one or more temp paths */
function cleanupFiles(...paths) {
  for (const p of paths.flat()) {
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }
}

/* ── Language detection helpers ───────────────────────────── */
const LANG_MAP = { msa: 'ms', zlm: 'ms', ind: 'ms', eng: 'en', und: 'unknown' };

function detectLanguage(text) {
  if (!text || text.length < 30) return 'unknown';
  try {
    const detected = loadFranc()(text.slice(0, 4000));
    return LANG_MAP[detected] || (detected === 'unknown' ? 'unknown' : 'en');
  } catch {
    return 'unknown';
  }
}

/* ── Heuristic: is this an extension we can map from filename? ── */
function mimeFromFilename(name) {
  const ext = path.extname(name || '').toLowerCase();
  const map = {
    '.pdf':  'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.txt':  'text/plain',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.xls':  'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.csv':  'text/csv',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
  };
  return map[ext] || null;
}

/* ═══════════════════════════════════════════════════════════
   Main entry point
   ═══════════════════════════════════════════════════════════ */

/**
 * Ingest an uploaded file buffer and produce a NormalizedDocument.
 *
 * @param {Buffer}  buf       - raw file content
 * @param {string}  fileName  - original file name
 * @param {string}  mimeType  - MIME type (may be inferred from extension)
 * @param {Object}  [opts]    - optional overrides
 * @param {number}  [opts.maxPdfPages] - override MAX_PDF_PAGES
 * @param {boolean} [opts.isGuest]     - true for guest users (tighter limits)
 * @returns {Promise<NormalizedDocument>}
 */
async function ingestAttachment(buf, fileName, mimeType, opts = {}) {
  // ── Mime fallback from extension ──
  if (!mimeType || mimeType === 'application/octet-stream') {
    mimeType = mimeFromFilename(fileName) || mimeType || 'application/octet-stream';
  }

  // ── Size check (settings-aware) ──
  const sizeBytes = buf.length;
  const sizeMB = sizeBytes / (1024 * 1024);
  const maxMb = opts.maxMb || await getSetting('limits.max_file_size_mb', MAX_UPLOAD_MB).catch(() => MAX_UPLOAD_MB);
  if (sizeMB > Number(maxMb)) {
    throw new IngestionError(`File too large (${sizeMB.toFixed(1)} MB). Maximum is ${maxMb} MB.`);
  }

  // ── Type check ──
  if (!ALLOWED_MIMES.has(mimeType)) {
    throw new IngestionError(`Unsupported file type: ${mimeType}. Supported: PNG, JPG, WebP, PDF, DOCX, TXT, PPTX, XLS/XLSX.`);
  }

  // Resolve max PDF pages from settings
  let effectiveMaxPages = MAX_PDF_PAGES;
  if (opts.maxPdfPages) {
    effectiveMaxPages = opts.maxPdfPages;
  } else {
    const settingKey = opts.isGuest ? 'limits.max_pdf_pages_guest' : 'limits.max_pdf_pages_registered';
    const fallbackKey = 'limits.max_pdf_pages';
    try {
      effectiveMaxPages = Number(await getSetting(settingKey, null)) || Number(await getSetting(fallbackKey, MAX_PDF_PAGES));
    } catch { effectiveMaxPages = MAX_PDF_PAGES; }
  }

  // ── Route to handler ──
  if (MIME_IMAGE.has(mimeType))                                     return handleImage(buf, fileName, mimeType, sizeBytes);
  if (mimeType === 'text/plain')                                    return handleTxt(buf, fileName, sizeBytes);
  if (mimeType === 'text/csv')                                      return handleCsv(buf, fileName, sizeBytes);
  if (mimeType.includes('wordprocessingml'))                        return handleDocx(buf, fileName, sizeBytes);
  if (mimeType === 'application/pdf')                               return handlePdf(buf, fileName, sizeBytes, effectiveMaxPages);
  if (mimeType.includes('spreadsheetml') || mimeType.includes('ms-excel'))
    return handleXlsx(buf, fileName, mimeType, sizeBytes);
  if (mimeType.includes('presentationml'))
    return handlePptx(buf, fileName, mimeType, sizeBytes);

  throw new IngestionError('Unhandled type: ' + mimeType);
}

/* ═══════════════════════════════════════════════════════════
   Format handlers
   ═══════════════════════════════════════════════════════════ */

/** Images — keep existing flow */
function handleImage(buf, fileName, mimeType, sizeBytes) {
  const base64 = buf.toString('base64');
  return {
    kind: 'image',
    detectedLanguage: 'unknown',  // vision model will detect
    imagePath: null,
    imageBase64: base64,
    meta: { fileName, mimeType, sizeBytes, extractionMethod: 'image' },
  };
}

/** Plain text */
function handleTxt(buf, fileName, sizeBytes) {
  let text = buf.toString('utf-8');
  if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);
  return {
    kind: 'text',
    detectedLanguage: detectLanguage(text),
    title: fileName,
    text,
    meta: { fileName, mimeType: 'text/plain', sizeBytes, extractionMethod: 'txt' },
  };
}

/** DOCX via mammoth */
async function handleDocx(buf, fileName, sizeBytes) {
  const m = loadMammoth();
  const result = await m.extractRawText({ buffer: buf });
  let text = (result.value || '').trim();
  if (text.length < MIN_TEXT_CHARS) {
    throw new IngestionError('Unable to extract text from DOCX — the file may be image-only or corrupted.');
  }
  if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);
  return {
    kind: 'text',
    detectedLanguage: detectLanguage(text),
    title: fileName,
    text,
    meta: {
      fileName,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes,
      extractionMethod: 'docx-text',
    },
  };
}

/** PDF — text extraction first, scanned-page fallback */
async function handlePdf(buf, fileName, sizeBytes, maxPages) {
  const effectiveMaxPages = maxPages || MAX_PDF_PAGES;

  // Check for encryption (very basic heuristic)
  const header = buf.slice(0, 1024).toString('latin1');
  if (header.includes('/Encrypt')) {
    throw new IngestionError('This PDF is encrypted / password-protected. Please unlock it first.');
  }

  // A) Try text extraction
  const pdf = loadPdfParse();
  let pdfData;
  try {
    pdfData = await pdf(buf, { max: effectiveMaxPages });
  } catch (e) {
    throw new IngestionError('Failed to parse PDF: ' + (e.message || 'unknown error'));
  }

  const pageCount = pdfData.numpages || 1;
  let text = (pdfData.text || '').trim();

  if (text.length >= MIN_TEXT_CHARS) {
    // Good text extraction
    if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);
    return {
      kind: 'text',
      detectedLanguage: detectLanguage(text),
      title: pdfData.info?.Title || fileName,
      text,
      meta: {
        fileName, mimeType: 'application/pdf', sizeBytes,
        pageCount, extractionMethod: 'pdf-text',
      },
    };
  }

  // B) Scanned PDF — render pages to PNG
  const pagesToRender = Math.min(pageCount, effectiveMaxPages);
  const tmpPdf = writeTempFile(buf, '.pdf');
  const pages = [];

  try {
    for (let i = 1; i <= pagesToRender; i++) {
      const outBase = path.join(TEMP_ROOT, `page_${Date.now()}_${i}`);
      const outFile = outBase + '.png';

      // Try pdftoppm (poppler), then ImageMagick convert
      let rendered = false;
      try {
        execSync(
          `pdftoppm -png -r ${PDF_RENDER_DPI} -f ${i} -l ${i} -singlefile "${tmpPdf}" "${outBase}"`,
          { stdio: 'pipe', timeout: 30000 }
        );
        rendered = fs.existsSync(outFile);
      } catch {}

      if (!rendered) {
        try {
          execSync(
            `convert -density ${PDF_RENDER_DPI} "${tmpPdf}[${i - 1}]" -quality 92 "${outFile}"`,
            { stdio: 'pipe', timeout: 30000 }
          );
          rendered = fs.existsSync(outFile);
        } catch {}
      }

      if (rendered) {
        const imgBuf = fs.readFileSync(outFile);
        pages.push({
          page: i,
          imageBase64: imgBuf.toString('base64'),
          imagePath: outFile,
        });
      }
    }
  } finally {
    cleanupFiles(tmpPdf);
  }

  if (pages.length === 0) {
    throw new IngestionError('Could not extract text or render pages from this PDF.');
  }

  return {
    kind: 'pages',
    detectedLanguage: 'unknown', // vision model will detect
    title: pdfData.info?.Title || fileName,
    pages,
    meta: {
      fileName, mimeType: 'application/pdf', sizeBytes,
      pageCount: pages.length, extractionMethod: 'pdf-render',
    },
  };
}

/** XLSX / XLS — structured spreadsheet extraction via xlsx (SheetJS) */
function handleXlsx(buf, fileName, mimeType, sizeBytes) {
  try {
    const xl = loadXLSX();
    const wb = xl.read(buf, { type: 'buffer', cellDates: true });
    const sheetNames = wb.SheetNames.slice(0, MAX_SHEETS);

    if (sheetNames.length === 0) {
      throw new IngestionError('The spreadsheet has no sheets.');
    }

    const sections = [];
    let totalText = '';

    for (let si = 0; si < sheetNames.length; si++) {
      const name = sheetNames[si];
      const ws = wb.Sheets[name];
      const rows = xl.utils.sheet_to_json(ws, { header: 1, defval: '' });

      // Limit rows
      const limitedRows = rows.slice(0, MAX_ROWS_PER_SHEET + 1); // +1 for header
      const truncated = rows.length > MAX_ROWS_PER_SHEET + 1;

      // Build markdown table
      let section = `### Sheet ${si + 1}: ${name}\n`;
      section += `(${rows.length} rows total${truncated ? `, showing first ${MAX_ROWS_PER_SHEET}` : ''})\n\n`;

      if (limitedRows.length > 0) {
        // First row as header
        const header = limitedRows[0].map(c => String(c ?? ''));
        section += '| ' + header.join(' | ') + ' |\n';
        section += '| ' + header.map(() => '---').join(' | ') + ' |\n';

        for (let ri = 1; ri < limitedRows.length; ri++) {
          const row = limitedRows[ri].map(c => String(c ?? ''));
          section += '| ' + row.join(' | ') + ' |\n';
        }
      }

      sections.push(section);
      totalText += section + '\n';

      if (totalText.length > MAX_CONTEXT_CHARS) break;
    }

    const finalText = totalText.slice(0, MAX_CONTEXT_CHARS);
    const sheetInfo = sheetNames.length > 1
      ? `This workbook has ${wb.SheetNames.length} sheet(s). Showing: ${sheetNames.join(', ')}.`
      : '';

    return {
      kind: 'text',
      detectedLanguage: detectLanguage(finalText),
      title: fileName,
      text: sheetInfo + '\n\n' + finalText,
      meta: {
        fileName, mimeType, sizeBytes,
        sheetCount: wb.SheetNames.length,
        extractionMethod: 'xlsx-structured',
      },
    };
  } catch (err) {
    if (err instanceof IngestionError) throw err;
    throw new IngestionError(
      `Unable to read spreadsheet (${path.extname(fileName)}): ${err.message}. ` +
      'Tip: Make sure the file is not corrupted.'
    );
  }
}

/** CSV — parse to structured text */
function handleCsv(buf, fileName, sizeBytes) {
  let raw = buf.toString('utf-8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim());

  if (lines.length === 0) {
    throw new IngestionError('CSV file is empty.');
  }

  // Simple CSV split (handles basic cases)
  const parseRow = (line) => {
    const cells = [];
    let current = '', inQuote = false;
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === ',' && !inQuote) { cells.push(current.trim()); current = ''; }
      else { current += ch; }
    }
    cells.push(current.trim());
    return cells;
  };

  const limited = lines.slice(0, MAX_ROWS_PER_SHEET + 1);
  const truncated = lines.length > MAX_ROWS_PER_SHEET + 1;

  let text = `### CSV: ${fileName}\n`;
  text += `(${lines.length} rows total${truncated ? `, showing first ${MAX_ROWS_PER_SHEET}` : ''})\n\n`;

  if (limited.length > 0) {
    const header = parseRow(limited[0]);
    text += '| ' + header.join(' | ') + ' |\n';
    text += '| ' + header.map(() => '---').join(' | ') + ' |\n';

    for (let i = 1; i < limited.length; i++) {
      const row = parseRow(limited[i]);
      text += '| ' + row.join(' | ') + ' |\n';
    }
  }

  if (text.length > MAX_CONTEXT_CHARS) text = text.slice(0, MAX_CONTEXT_CHARS);

  return {
    kind: 'text',
    detectedLanguage: detectLanguage(text),
    title: fileName,
    text,
    meta: { fileName, mimeType: 'text/csv', sizeBytes, rowCount: lines.length, extractionMethod: 'csv-structured' },
  };
}

/** PPTX — extract text from slides via xlsx (SheetJS can read PPTX XML) or mammoth fallback */
async function handlePptx(buf, fileName, mimeType, sizeBytes) {
  // Try mammoth first (works for some OOXML)
  try {
    const m = loadMammoth();
    const result = await m.extractRawText({ buffer: buf });
    let text = (result.value || '').trim();
    if (text.length >= MIN_TEXT_CHARS) {
      if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);
      return {
        kind: 'text',
        detectedLanguage: detectLanguage(text),
        title: fileName,
        text,
        meta: { fileName, mimeType, sizeBytes, extractionMethod: 'pptx-text' },
      };
    }
  } catch {}

  // If mammoth can't handle it, try to extract XML text from the PPTX zip
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(buf);
    const slides = zip.getEntries()
      .filter(e => /^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName))
      .sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true }));

    if (slides.length > 0) {
      let text = '';
      for (let i = 0; i < slides.length; i++) {
        const xml = slides[i].getData().toString('utf-8');
        // Extract text between <a:t> tags
        const texts = [];
        xml.replace(/<a:t[^>]*>([^<]+)<\/a:t>/g, (_, t) => texts.push(t));
        if (texts.length > 0) {
          text += `--- Slide ${i + 1} ---\n${texts.join(' ')}\n\n`;
        }
      }
      text = text.trim();
      if (text.length >= MIN_TEXT_CHARS) {
        if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);
        return {
          kind: 'text',
          detectedLanguage: detectLanguage(text),
          title: fileName,
          text,
          meta: { fileName, mimeType, sizeBytes, slideCount: slides.length, extractionMethod: 'pptx-xml' },
        };
      }
    }
  } catch {}

  throw new IngestionError(
    `Unable to extract usable text from this PPTX file. ` +
    'Tip: Export it as PDF first, then upload the PDF.'
  );
}

/* ── Custom error class ──────────────────────────────────── */
class IngestionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IngestionError';
  }
}

/* ── Default prompts ─────────────────────────────────────── */

function getDefaultPrompt(lang, fileName, isMultiPage) {
  const pageRef = isMultiPage ? '\nJika boleh, rujuk muka surat (m/s X). Jika tak pasti, nyatakan \'anggaran\'.' : '';
  const pageRefEn = isMultiPage ? '\nIf possible, include page references (p. X). If unsure, say so.' : '';

  if (lang === 'ms') {
    return (
      `Semak dokumen yang dimuat naik: "${fileName}". Susun jawapan:\n\n` +
      `1. Ringkasan dokumen (5–10 poin)\n` +
      `2. Isu / tuntutan / klausa utama (susun ikut topik bernombor seperti contoh: 1, 2, 3…)\n` +
      `3. Angka penting (RM, tarikh, nama pihak) — senaraikan\n` +
      `4. Risiko / pemerhatian penting (jika ada)\n` +
      `5. Tindakan seterusnya (apa perlu dibuat)` +
      pageRef
    );
  }

  return (
    `Review the uploaded document: "${fileName}". Structure your answer:\n\n` +
    `1. Executive summary (5–10 bullets)\n` +
    `2. Key issues/claims/clauses (numbered sections: 1, 2, 3…)\n` +
    `3. Important figures (amounts, dates, parties) — list them\n` +
    `4. Risks / notable observations\n` +
    `5. Next actions (what to do next)` +
    pageRefEn
  );
}

function getSystemPromptForDoc(lang, fileName, kind) {
  const langInstruction = lang === 'ms'
    ? 'Balas dalam Bahasa Melayu. Kekalkan istilah penting dan nama asal.'
    : lang === 'mixed'
      ? 'Reply in the dominant language of the document. Keep important terms and proper nouns as-is.'
      : 'Reply in English.';

  return (
    `You are Getouch AI, a helpful document analyst. ` +
    `The user uploaded a document: "${fileName}". ` +
    `${langInstruction} ` +
    `Start your response with: "I reviewed the document you uploaded: ${fileName}"\n` +
    `Use numbered sections with emoji markers (1️⃣, 2️⃣, etc.) and bullet points. ` +
    `Be thorough but concise. ` +
    (kind === 'pages'
      ? 'The document was provided as page images. Reference page numbers where possible.'
      : 'The document text is provided below.')
  );
}

function getUserPromptWithQuestion(userText, lang, fileName) {
  const prefix = lang === 'ms'
    ? `Mengenai dokumen "${fileName}", jawab soalan ini dahulu, kemudian beri ringkasan pendek berstruktur:\n\n`
    : `Regarding the document "${fileName}", answer this question first, then provide a short structured summary:\n\n`;
  return prefix + userText;
}

/* ── Exports ─────────────────────────────────────────────── */
module.exports = {
  ingestAttachment,
  IngestionError,
  ALLOWED_MIMES,
  MIME_IMAGE,
  MIME_DOC,
  FILE_INPUT_ACCEPT,
  MAX_UPLOAD_MB,
  MAX_TEXT_CHARS,
  cleanupFiles,
  detectLanguage,
  getDefaultPrompt,
  getSystemPromptForDoc,
  getUserPromptWithQuestion,
};
