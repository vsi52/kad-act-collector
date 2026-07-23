import {
  SAFE_DOWNLOAD_LIMITS,
  caseIdFromText,
  randomInteger
} from './utils.js';

const CASE_NUMBER_RE = /[АA]\d{1,3}-\d+\/\d{4}/i;
const PDF_PATH_RE = /^\/Kad\/PdfDocument\//i;
const ACCESS_LIMIT_TEXT_RE = /(?:доступ|ip[-\s]?адрес).{0,50}(?:ограничен|заблокирован)|слишком много запросов|too many requests|access denied|temporarily blocked/i;
const LEGAL_ACCEPTANCE_KEY = 'legalAcceptance';
const LEGAL_TERMS_VERSION = '2026-07-23-v1';
let legalAccepted = false;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const normalizeSpace = value => String(value || '').replace(/\s+/g, ' ').trim();

function accessLimitedError(detail = '') {
  const error = new Error(`Доступ КАД ограничен${detail ? `: ${detail}` : ''}. Новые запросы остановлены.`);
  error.code = 'KAD_ACCESS_BLOCKED';
  return error;
}

function challengePageDetected() {
  const challengeMarkers = Boolean(
    document.querySelector('#salto')
    && document.querySelector('form#searchForm input#token')
    && document.querySelector('input#datat')
  );
  const visibleText = normalizeSpace(`${document.title} ${document.body?.innerText || ''}`).slice(0, 2500);
  return challengeMarkers || (PDF_PATH_RE.test(location.pathname) && ACCESS_LIMIT_TEXT_RE.test(visibleText));
}

function reportAccessBlockIfPresent() {
  if (!challengePageDetected()) return false;
  if (document.documentElement.dataset.kadAccessBlockReported === 'true') return true;
  document.documentElement.dataset.kadAccessBlockReported = 'true';
  chrome.runtime.sendMessage({
    type: 'KAD_ACCESS_BLOCKED',
    reason: 'КАД вернул HTML-страницу защиты вместо судебного акта',
    url: location.href
  }).catch(() => {});
  return true;
}

function caseIdFromPage(preferredCaseId = '') {
  const directSources = [
    preferredCaseId,
    location.href,
    document.URL,
    document.querySelector('link[rel="canonical"]')?.href,
    document.querySelector('meta[property="og:url"]')?.content,
    document.querySelector('[data-case-id]')?.getAttribute('data-case-id'),
    document.querySelector('input[name="caseId" i]')?.value,
    document.querySelector('a[href*="/Card/" i]')?.href
  ];

  for (const source of directSources) {
    const caseId = caseIdFromText(source);
    if (caseId) return caseId;
  }

  // KAD's SPA can replace the visible route while keeping the loaded case open.
  // Its own metadata request remains the most reliable source in that situation.
  for (const entry of performance.getEntriesByType('resource')) {
    if (!/\/Kad\/CaseDocumentsPage(?:\?|$)/i.test(entry.name || '')) continue;
    try {
      const caseId = caseIdFromText(new URL(entry.name).searchParams.get('caseId'));
      if (caseId) return caseId;
    } catch {
      // Ignore malformed performance entries from third-party resources.
    }
  }

  const html = document.documentElement?.innerHTML || '';
  const embedded = html.match(/["']?CaseId["']?\s*[:=]\s*["']([0-9a-f-]{36})["']/i)?.[1];
  return caseIdFromText(embedded);
}

function caseNumberFromPage() {
  const source = `${document.title} ${document.body?.innerText || ''}`;
  const match = normalizeSpace(source).match(CASE_NUMBER_RE);
  return match ? match[0].replace(/^A/i, 'А') : '';
}

function pdfUrl(item, caseId) {
  if (!item.CaseId && !caseId) return '';
  if (!item.Id || !item.FileName) return '';
  return `${location.origin}/Kad/PdfDocument/${item.CaseId || caseId}/${item.Id}/${encodeURIComponent(item.FileName)}`;
}

function normalizeDocument(item, page, row, caseId, caseNumber) {
  return {
    page,
    row,
    caseNumber,
    caseId: item.CaseId || caseId,
    instanceId: item.InstanceId || '',
    id: item.Id || '',
    displayDate: item.DisplayDate || '',
    publishDisplayDate: item.PublishDisplayDate || '',
    documentTypeName: item.DocumentTypeName || '',
    decisionTypeName: item.DecisionTypeName || '',
    courtName: item.CourtName || '',
    fileNameOriginal: item.FileName || '',
    pdfUrl: pdfUrl(item, caseId)
  };
}

async function fetchCaseDocumentsPage(caseId, page, perPage = 25) {
  const query = new URLSearchParams({
    _: String(Date.now()),
    caseId,
    page: String(page),
    perPage: String(perPage)
  });

  const response = await fetch(`${location.origin}/Kad/CaseDocumentsPage?${query}`, {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
    referrer: location.href,
    headers: {
      Accept: 'application/json, text/javascript, */*',
      'X-Requested-With': 'XMLHttpRequest',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache'
    }
  });

  const contentType = response.headers.get('content-type') || '';
  const body = await response.text().catch(() => '');
  if (!response.ok) {
    const detail = normalizeSpace(body).slice(0, 180);
    if (response.status === 403 || response.status === 429 || ACCESS_LIMIT_TEXT_RE.test(detail)) {
      throw accessLimitedError(`HTTP ${response.status}`);
    }
    throw new Error(`КАД вернул HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }

  if (/text\/html/i.test(contentType) || /<html[\s>]/i.test(body)) {
    throw accessLimitedError('вместо списка документов получена HTML-страница защиты');
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error('КАД вернул некорректный ответ вместо списка документов.');
  }
}

async function collectCase(preferredCaseId = '') {
  const caseId = caseIdFromPage(preferredCaseId);
  const caseNumber = caseNumberFromPage();
  if (!caseId) {
    throw new Error(`Не найден идентификатор открытого дела. Адрес вкладки: ${location.href}`);
  }

  const first = await fetchCaseDocumentsPage(caseId, 1);
  const result = first.Result || {};
  const total = Number(result.TotalCount || 0);
  const pages = Math.max(1, Number(result.PagesCount || 1));
  const documents = [];

  for (let page = 1; page <= pages; page += 1) {
    if (page > 1) {
      await sleep(randomInteger(
        SAFE_DOWNLOAD_LIMITS.metadataDelayMinMs,
        SAFE_DOWNLOAD_LIMITS.metadataDelayMaxMs
      ));
    }
    const data = page === 1 ? first : await fetchCaseDocumentsPage(caseId, page);
    const items = data.Result?.Items || [];
    items.forEach((item, index) => {
      const doc = normalizeDocument(item, page, index + 1, caseId, caseNumber);
      if (doc.pdfUrl) documents.push(doc);
    });

    chrome.runtime.sendMessage({
      type: 'KAD_COLLECT_PROGRESS',
      caseId,
      page,
      pages,
      found: documents.length
    }).catch(() => {});
  }

  const unique = [...new Map(documents.map(doc => [doc.pdfUrl, doc])).values()];
  return {
    source: 'kad.arbitr.ru',
    caseId,
    caseNumber,
    totalReported: total,
    collectedAt: new Date().toISOString(),
    documents: unique
  };
}

async function downloadVerifiedPdf(documentInfo, filename) {
  const response = await fetch(documentInfo.pdfUrl, {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
    referrer: location.href,
    headers: { Accept: 'application/pdf,*/*' }
  });

  if (!response.ok) throw new Error(`PDF недоступен: HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 5 || String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') {
    const kind = /html/i.test(contentType) ? 'HTML-страница защиты КАД' : (contentType || 'ответ неизвестного типа');
    throw new Error(`Вместо PDF получена ${kind}`);
  }

  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return { byteLength: bytes.length, base64: btoa(binary), filename };
}

function installLauncher() {
  if (reportAccessBlockIfPresent()) return;
  if (!caseIdFromPage() || document.getElementById('kad-act-collector-launcher')) return;
  const button = document.createElement('button');
  button.id = 'kad-act-collector-launcher';
  button.type = 'button';
  button.textContent = 'Собрать судебные акты';
  button.title = 'Открыть сборщик документов из текущего дела';
  button.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'KAD_OPEN_WORKSPACE' }));
  document.body.appendChild(button);
}

async function refreshLegalAcceptance() {
  try {
    const stored = await chrome.storage.local.get(LEGAL_ACCEPTANCE_KEY);
    legalAccepted = stored[LEGAL_ACCEPTANCE_KEY]?.version === LEGAL_TERMS_VERSION;
  } catch {
    legalAccepted = false;
  }
  // The launcher only opens the extension UI. Keep it available before
  // acceptance so a first-time user has a clear path to the legal dialog.
  // Actual collection and PDF access remain blocked in onMessage below.
  installLauncher();
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[LEGAL_ACCEPTANCE_KEY]) return;
  refreshLegalAcceptance();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if ((message?.type === 'KAD_COLLECT_CASE' || message?.type === 'KAD_DOWNLOAD_VERIFIED_PDF') && !legalAccepted) {
    sendResponse({ ok: false, error: 'Сначала примите Пользовательское соглашение в рабочей вкладке расширения.' });
    return;
  }

  if (message?.type === 'KAD_COLLECT_CASE') {
    collectCase(message.expectedCaseId).then(result => sendResponse({ ok: true, result })).catch(error => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });
    return true;
  }

  if (message?.type === 'KAD_DOWNLOAD_VERIFIED_PDF') {
    downloadVerifiedPdf(message.document, message.filename).then(result => sendResponse({ ok: true, result })).catch(error => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });
    return true;
  }
});

refreshLegalAcceptance();
new MutationObserver(installLauncher).observe(document.documentElement, { childList: true, subtree: true });
// KAD is a single-page application: navigation to a case can change the URL
// without reloading the document. Recheck independently of DOM mutations.
setInterval(installLauncher, 1000);
