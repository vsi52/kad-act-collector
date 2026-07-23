const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const LOOSE_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export const SAFE_DOWNLOAD_LIMITS = Object.freeze({
  delayMinMs: 8000,
  delayMaxMs: 15000,
  batchMin: 15,
  batchMax: 20,
  cooldownMinMs: 60000,
  cooldownMaxMs: 120000,
  metadataDelayMinMs: 2000,
  metadataDelayMaxMs: 5000
});

export function randomInteger(min, max, random = Math.random) {
  const lower = Math.ceil(Math.min(Number(min), Number(max)));
  const upper = Math.floor(Math.max(Number(min), Number(max)));
  return lower + Math.floor(random() * (upper - lower + 1));
}

export function isHtmlInsteadOfPdf({ mime = '', filename = '' } = {}) {
  return /^text\/html(?:;|$)/i.test(String(mime).trim()) || /\.html?$/i.test(String(filename).trim());
}

export function caseIdFromText(value) {
  const source = String(value || '');
  return source.match(UUID_RE)?.[0] || source.match(LOOSE_UUID_RE)?.[0] || '';
}

export function safeFilePart(value, fallback = 'без_названия') {
  const clean = String(value || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_\.]+|[_\.]+$/g, '')
    .slice(0, 120);
  return clean || fallback;
}

export function dateValue(value) {
  const source = String(value || '');
  const ru = source.match(/(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/);
  if (ru) return Date.UTC(Number(ru[3]), Number(ru[2]) - 1, Number(ru[1]));
  const parsed = Date.parse(source);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isDetermination(doc) {
  return String(doc.documentTypeName || '').toLowerCase().includes('определение');
}

export function sortedDocuments(documents, order = 'asc') {
  const direction = order === 'desc' ? -1 : 1;
  return [...documents].sort((a, b) => {
    const byDate = (dateValue(a.displayDate) - dateValue(b.displayDate)) * direction;
    if (byDate) return byDate;
    return String(a.id).localeCompare(String(b.id), 'ru') * direction;
  });
}

export function pdfDownloadPath(caseNumber, doc, index) {
  const number = String(index + 1).padStart(4, '0');
  const date = safeFilePart(doc.displayDate || 'без_даты');
  const type = safeFilePart(doc.documentTypeName || 'судебный_акт');
  const id = safeFilePart(doc.id || String(index + 1));
  return `KAD/${safeFilePart(caseNumber || doc.caseId)}/${number}__${date}__${type}__${id}.pdf`;
}

export function buildTextDocument(collection, rows, order) {
  const succeeded = rows.filter(row => row.status === 'ok').length;
  const failed = rows.filter(row => row.status === 'error').length;
  const withoutText = rows.filter(row => row.status === 'ok' && !row.result.hasTextLayer).length;
  const header = [
    'СУДЕБНЫЕ АКТЫ ИЗ КАРТОТЕКИ АРБИТРАЖНЫХ ДЕЛ',
    '',
    `Дело: ${collection.caseNumber || 'номер не определён'}`,
    `Идентификатор дела: ${collection.caseId}`,
    `Источник: https://kad.arbitr.ru/Card/${collection.caseId}`,
    `Сформировано: ${new Date().toISOString()}`,
    `Порядок: ${order === 'desc' ? 'от новых к старым' : 'от старых к новым'}`,
    `Документов: ${rows.length}; успешно: ${succeeded}; ошибок: ${failed}; без текстового слоя: ${withoutText}`,
    '',
    'Примечание: текст извлечён автоматически и может содержать ошибки порядка строк. Сверяйте цитаты с исходным PDF.',
    '='.repeat(96)
  ];

  const bodies = rows.map((row, index) => {
    const doc = row.document;
    const metadata = [
      `ДОКУМЕНТ ${index + 1} ИЗ ${rows.length}`,
      `Дата: ${doc.displayDate || 'не указана'}`,
      `Тип: ${doc.documentTypeName || 'не указан'}`,
      doc.decisionTypeName ? `Вид решения: ${doc.decisionTypeName}` : '',
      doc.courtName ? `Суд: ${doc.courtName}` : '',
      `Исходный PDF: ${doc.pdfUrl}`,
      '-'.repeat(96)
    ].filter(Boolean);

    let text;
    if (row.status === 'error') {
      text = `[ОШИБКА ИЗВЛЕЧЕНИЯ: ${row.error}]`;
    } else if (!row.result.hasTextLayer) {
      text = `[В PDF НЕ НАЙДЕН ПОЛНОЦЕННЫЙ ТЕКСТОВЫЙ СЛОЙ. ДЛЯ ЭТОГО ДОКУМЕНТА НУЖЕН OCR.]\n\n${row.result.text}`;
    } else {
      text = row.result.text;
    }

    return `${metadata.join('\n')}\n\n${text}\n\n${'='.repeat(96)}`;
  });

  return `\uFEFF${header.join('\n')}\n\n${bodies.join('\n\f\n')}`;
}

export function estimateDuration(count, delayMs, averageWorkMs = 900) {
  const seconds = Math.ceil((count * (Number(delayMs) + averageWorkMs)) / 1000);
  return formatDuration(seconds);
}

export function estimateSafePdfDuration(count, limits = SAFE_DOWNLOAD_LIMITS, averageWorkMs = 900) {
  const documents = Math.max(0, Number(count) || 0);
  if (!documents) return '—';
  const gaps = Math.max(0, documents - 1);
  const averageDelayMs = (limits.delayMinMs + limits.delayMaxMs) / 2;
  const averageBatchSize = (limits.batchMin + limits.batchMax) / 2;
  const cooldowns = Math.floor(gaps / averageBatchSize);
  const regularGaps = gaps - cooldowns;
  const averageCooldownMs = (limits.cooldownMinMs + limits.cooldownMaxMs) / 2;
  const seconds = Math.ceil((
    documents * averageWorkMs
    + regularGaps * averageDelayMs
    + cooldowns * averageCooldownMs
  ) / 1000);
  return formatDuration(seconds);
}

function formatDuration(seconds) {
  if (seconds < 60) return `≈ ${seconds} сек.`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `≈ ${minutes} мин.`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `≈ ${hours} ч ${rest} мин.`;
}
