const KAD_URL_RE = /^https:\/\/kad\.arbitr\.ru(?:\/|$)/i;
const PDF_URL_RE = /^https:\/\/kad\.arbitr\.ru\/Kad\/PdfDocument\//i;
const CASE_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const PDF_SETTINGS_URL = 'chrome://settings/content/pdfDocuments';

// The original userscript worked reliably because it reused one browser tab and
// merely navigated it to each PDF.  Do the same here; do not fetch the PDF and do
// not wait for a downloads event, since KAD may answer with an interstitial page.
const DOWNLOAD_TAB_KEY = 'kadDownloadTabId';
const EXPECTED_NAMES_KEY = 'kadExpectedDownloadNames';

async function getDownloadTabId() {
  const stored = await chrome.storage.session.get(DOWNLOAD_TAB_KEY);
  return Number(stored[DOWNLOAD_TAB_KEY]) || null;
}

async function setDownloadTabId(tabId) {
  if (tabId) await chrome.storage.session.set({ [DOWNLOAD_TAB_KEY]: tabId });
  else await chrome.storage.session.remove(DOWNLOAD_TAB_KEY);
}

async function rememberExpectedName(documentId, filename) {
  const stored = await chrome.storage.session.get(EXPECTED_NAMES_KEY);
  const names = stored[EXPECTED_NAMES_KEY] || {};
  names[documentId] = { filename, expiresAt: Date.now() + 120000 };
  await chrome.storage.session.set({ [EXPECTED_NAMES_KEY]: names });
}

async function takeExpectedName(documentId) {
  const stored = await chrome.storage.session.get(EXPECTED_NAMES_KEY);
  const names = stored[EXPECTED_NAMES_KEY] || {};
  const entry = names[documentId];
  if (!entry) return null;
  delete names[documentId];
  await chrome.storage.session.set({ [EXPECTED_NAMES_KEY]: names });
  return entry.expiresAt >= Date.now() ? entry.filename : null;
}

function documentIdFromUrl(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts[3] || '';
  } catch {
    return '';
  }
}

function isHtmlInsteadOfPdf(item) {
  return /^text\/html(?:;|$)/i.test(String(item?.mime || '').trim())
    || /\.html?$/i.test(String(item?.filename || '').trim());
}

function reportAccessBlock(item) {
  chrome.runtime.sendMessage({
    type: 'KAD_ACCESS_BLOCKED',
    reason: 'КАД вернул HTML-страницу защиты вместо PDF',
    url: item.finalUrl || item.url || ''
  }).catch(() => {});
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const documentId = documentIdFromUrl(item.finalUrl || item.url || '');
  if (!documentId) return;
  takeExpectedName(documentId)
    .then(filename => {
      if (filename && isHtmlInsteadOfPdf(item)) {
        // Do not disguise a protection page as PDF and do not let the queue
        // continue issuing requests after the first explicit block response.
        suggest();
        chrome.downloads.cancel(item.id).catch(() => {});
        reportAccessBlock(item);
        return;
      }
      // A repeated collection of the same case must refresh the existing file,
      // not create "(1)", "(2)" copies beside it.
      if (filename) suggest({ filename, conflictAction: 'overwrite' });
      else suggest();
    })
    .catch(() => suggest());
  return true;
});

async function openPdfLikeOriginal(url, filename) {
  if (!PDF_URL_RE.test(url || '')) throw new Error('Недопустимый адрес документа.');
  const documentId = documentIdFromUrl(url);
  if (!documentId) throw new Error('Не удалось определить идентификатор документа.');

  await rememberExpectedName(documentId, filename);

  try {
    const downloadTabId = await getDownloadTabId();
    if (downloadTabId) {
      const existing = await chrome.tabs.get(downloadTabId).catch(() => null);
      if (existing) {
        // The first PDF may open this service tab in the foreground so Chrome
        // can show a download permission prompt. Reusing it must never steal
        // focus from the tab or even another application the user switched to.
        await chrome.tabs.update(downloadTabId, { url, active: false });
        return { ok: true };
      }
    }
    const tab = await chrome.tabs.create({ url, active: true });
    await setDownloadTabId(tab.id);
    return { ok: true };
  } catch (error) {
    await takeExpectedName(documentId).catch(() => null);
    throw error;
  }
}

chrome.tabs.onRemoved.addListener(tabId => {
  getDownloadTabId().then(storedId => {
    if (tabId === storedId) return setDownloadTabId(null);
  }).catch(() => {});
});

async function openWorkspace(tab) {
  // Do not try to duplicate KAD's client-side routing rules here. The site is
  // an SPA and has used several Card URL shapes. The content script is the
  // authoritative place for deciding whether the current page is a case.
  if (!tab?.id || !KAD_URL_RE.test(tab.url || '')) {
    await chrome.tabs.create({ url: chrome.runtime.getURL('workspace.html?error=not-a-case') });
    return;
  }
  const query = new URLSearchParams({ tabId: String(tab.id) });
  const caseId = String(tab.url || '').match(CASE_ID_RE)?.[0] || '';
  if (caseId) query.set('caseId', caseId);
  await chrome.tabs.create({ url: chrome.runtime.getURL(`workspace.html?${query}`) });
}

chrome.action.onClicked.addListener(openWorkspace);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'KAD_OPEN_PDF_ORIGINAL') {
    openPdfLikeOriginal(message.url, message.filename)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (message?.type === 'KAD_OPEN_PDF_SETTINGS') {
    chrome.tabs.create({ url: PDF_SETTINGS_URL })
      .then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (message?.type !== 'KAD_OPEN_WORKSPACE') return;
  openWorkspace(sender.tab).catch(console.error);
});
