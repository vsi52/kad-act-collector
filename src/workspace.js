import {
  SAFE_DOWNLOAD_LIMITS,
  buildTextDocument,
  estimateSafePdfDuration,
  isDetermination,
  pdfDownloadPath,
  randomInteger,
  safeFilePart,
  sortedDocuments
} from './utils.js';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.mjs');

const params = new URLSearchParams(location.search);
const sourceTabId = Number(params.get('tabId')) || 0;
const expectedCaseId = params.get('caseId') || '';
const startupError = params.get('error') || '';
const ui = Object.fromEntries([...document.querySelectorAll('[id]')].map(element => [element.id, element]));

const state = {
  collection: null,
  running: false,
  paused: false,
  stopped: false,
  mode: '',
  total: 0,
  done: 0,
  success: 0,
  errors: 0,
  logCount: 0,
  blocked: false,
  blockReason: '',
  batchCount: 0,
  batchTarget: 0
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const CONTROL_STOPPED = 'KAD_TASK_STOPPED';
const CONTROL_BLOCKED = 'KAD_ACCESS_BLOCKED';
const PDF_SETUP_DISMISSED_KEY = 'pdfSetupNoticeDismissed';
const LEGAL_ACCEPTANCE_KEY = 'legalAcceptance';
const LEGAL_TERMS_VERSION = '2026-07-23-v1';
let legalConsentResolve = null;

function plural(value, forms) {
  const absolute = Math.abs(Number(value)) % 100;
  const last = absolute % 10;
  if (absolute > 10 && absolute < 20) return forms[2];
  if (last === 1) return forms[0];
  if (last > 1 && last < 5) return forms[1];
  return forms[2];
}

function documentLabel(count) {
  return `${count} ${plural(count, ['документ', 'документа', 'документов'])}`;
}

function determinationLabel(count) {
  return `${count} ${plural(count, ['определение', 'определения', 'определений'])}`;
}

function log(message, level = 'info') {
  const time = new Date().toLocaleTimeString('ru-RU');
  ui.log.textContent += `[${time}] ${message}\n`;
  ui.log.scrollTop = ui.log.scrollHeight;
  state.logCount += 1;
  ui['log-count'].textContent = `${state.logCount} ${plural(state.logCount, ['запись', 'записи', 'записей'])}`;
  ui['log-last'].textContent = `Последнее: ${message}`;
  if (level === 'error') ui['log-card'].open = true;
}

function setFatal(message) {
  ui.fatal.textContent = message;
  ui.fatal.classList.remove('hidden');
  setStatusTone('error');
}

function setStatusTone(tone) {
  ui['progress-card'].dataset.tone = tone;
}

async function openPdfSettings() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'KAD_OPEN_PDF_SETTINGS' });
    if (!response?.ok) throw new Error(response?.error || 'Chrome не открыл настройки.');
    log('Открыты настройки PDF в Chrome.');
  } catch (error) {
    setFatal(`Не удалось открыть настройки PDF. Откройте вручную chrome://settings/content/pdfDocuments. ${error.message || error}`);
  }
}

async function showPdfSetupNoticeOnce() {
  try {
    const stored = await chrome.storage.local.get(PDF_SETUP_DISMISSED_KEY);
    if (!stored[PDF_SETUP_DISMISSED_KEY] && !ui['pdf-setup-dialog'].open) {
      ui['pdf-setup-dialog'].showModal();
    }
  } catch (error) {
    log(`Не удалось проверить показ подсказки PDF: ${error.message || error}`, 'error');
  }
}

function dismissPdfSetupNotice() {
  if (ui['pdf-setup-dialog'].open) ui['pdf-setup-dialog'].close();
  chrome.storage.local.set({ [PDF_SETUP_DISMISSED_KEY]: true }).catch(error => {
    log(`Не удалось сохранить закрытие подсказки PDF: ${error.message || error}`, 'error');
  });
}

async function ensureLegalAgreement() {
  try {
    const stored = await chrome.storage.local.get(LEGAL_ACCEPTANCE_KEY);
    if (stored[LEGAL_ACCEPTANCE_KEY]?.version === LEGAL_TERMS_VERSION) return true;
  } catch (error) {
    log(`Не удалось проверить принятие соглашения: ${error.message || error}`, 'error');
  }

  if (!ui['legal-consent-dialog'].open) ui['legal-consent-dialog'].showModal();
  return new Promise(resolve => {
    legalConsentResolve = resolve;
  });
}

async function acceptLegalAgreement() {
  if (!ui['legal-consent-check'].checked) return;
  ui['legal-consent-error'].classList.add('hidden');
  ui['legal-accept'].disabled = true;
  try {
    await chrome.storage.local.set({
      [LEGAL_ACCEPTANCE_KEY]: {
        version: LEGAL_TERMS_VERSION,
        acceptedAt: new Date().toISOString()
      }
    });
    ui['legal-consent-dialog'].close();
    legalConsentResolve?.(true);
    legalConsentResolve = null;
  } catch (error) {
    ui['legal-consent-error'].textContent = `Не удалось сохранить согласие: ${error.message || error}`;
    ui['legal-consent-error'].classList.remove('hidden');
    ui['legal-accept'].disabled = false;
  }
}

function declineLegalAgreement() {
  if (ui['legal-consent-dialog'].open) ui['legal-consent-dialog'].close();
  legalConsentResolve?.(false);
  legalConsentResolve = null;
  window.close();
  setFatal('Для работы расширения необходимо принять Пользовательское соглашение и Политику конфиденциальности.');
}

function selectedScope() {
  return document.querySelector('input[name="scope"]:checked')?.value || 'determinations';
}

function selectedDocuments() {
  const all = state.collection?.documents || [];
  const scoped = selectedScope() === 'all' ? all : all.filter(isDetermination);
  return sortedDocuments(scoped, ui.order.value);
}

function updateEstimate() {
  const count = selectedDocuments().length;
  ui.estimate.textContent = count ? `Оценка: ${estimateSafePdfDuration(count)}` : 'Оценка: —';
}

function updateCollectionView() {
  const collection = state.collection;
  const all = collection?.documents || [];
  const determinations = all.filter(isDetermination);
  const selectedCount = selectedDocuments().length;
  ui['case-number'].textContent = collection?.caseNumber || 'Номер не определён';
  ui['case-id'].textContent = collection?.caseId || '';
  ui['all-count'].textContent = collection ? String(all.length) : '—';
  ui['determination-count'].textContent = collection ? String(determinations.length) : '—';
  ui['download-pdfs'].disabled = state.running || state.blocked || selectedCount === 0;
  ui['create-text'].disabled = state.running || selectedCount === 0;
  ui.collect.textContent = collection ? 'Обновить список' : 'Собрать список';
  ui['download-label'].textContent = 'Скачать PDF';
  ui['text-label'].textContent = 'Создать TXT';

  if (collection) {
    const collectedAt = new Date(collection.collectedAt || Date.now());
    const updated = Number.isNaN(collectedAt.getTime())
      ? 'только что'
      : `в ${collectedAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
    ui['case-meta'].textContent = `${documentLabel(all.length)} · ${determinationLabel(determinations.length)} · обновлено ${updated}`;
    ui['download-help'].textContent = `В Downloads/KAD/${safeFilePart(collection.caseNumber || collection.caseId)} · паузы 8–15 сек.`;
    ui['text-help'].textContent = 'Выберите папку дела. Повторных запросов к КАД не будет';
  }
  updateEstimate();
}

function updateProgressVisibility() {
  const isTask = state.mode === 'pdf' || state.mode === 'text';
  const hasTotal = state.total > 0;
  const showProgress = state.running || (isTask && hasTotal);
  const showTaskSummary = isTask && hasTotal;
  const showTaskControls = state.running && isTask;

  ui['progress-track'].classList.toggle('hidden', !showProgress);
  ui['progress-details'].classList.toggle('hidden', !showProgress);
  ui.counter.classList.toggle('hidden', !hasTotal);
  ui['operation-controls'].classList.toggle('hidden', !showTaskSummary);
  ui.pause.classList.toggle('hidden', !showTaskControls);
  ui.stop.classList.toggle('hidden', !showTaskControls);
  ui.stats.classList.toggle('hidden', !showTaskSummary);
}

function updateProgress(current = '') {
  const percentage = state.total ? Math.round((state.done / state.total) * 100) : 0;
  ui.progress.style.width = `${percentage}%`;
  ui['progress-track'].setAttribute('aria-valuenow', String(percentage));
  ui.counter.textContent = `${state.done} / ${state.total}`;
  ui.current.textContent = current || (state.running ? 'Обработка…' : 'Ожидание команды.');
  const successLabel = state.mode === 'pdf' ? 'Передано браузеру' : 'Обработано';
  ui.stats.textContent = `${successLabel}: ${state.success} из ${state.total} · Ошибок: ${state.errors}`;
  updateProgressVisibility();
}

function showReadyState(message = 'Выберите PDF или TXT.') {
  const count = selectedDocuments().length;
  state.mode = '';
  state.total = 0;
  state.done = 0;
  state.success = 0;
  state.errors = 0;
  ui.status.textContent = count ? `Готово · ${documentLabel(count)}` : 'Нет документов для обработки';
  ui.current.textContent = message;
  ui.progress.style.width = '0%';
  ui['progress-track'].setAttribute('aria-valuenow', '0');
  setStatusTone(count ? 'ready' : 'idle');
  updateProgressVisibility();
}

function setRunning(running, label = 'Ожидание') {
  state.running = running;
  ui.status.textContent = label;
  ui.collect.disabled = running;
  ui.pause.disabled = !running;
  ui.stop.disabled = !running;
  ui.pause.textContent = state.paused ? 'Продолжить' : 'Пауза';
  if (running) setStatusTone('active');
  updateCollectionView();
}

async function waitIfPaused() {
  while (state.paused && !state.stopped && !state.blocked) await sleep(250);
  throwIfInterrupted();
}

function controlError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function throwIfInterrupted() {
  if (state.blocked) throw controlError(CONTROL_BLOCKED);
  if (state.stopped) throw controlError(CONTROL_STOPPED);
}

async function waitBeforeNextRequest(durationMs, label) {
  let remaining = durationMs;
  let previous = Date.now();
  while (remaining > 0) {
    throwIfInterrupted();
    if (state.paused) {
      await sleep(250);
      previous = Date.now();
      continue;
    }
    const seconds = Math.max(1, Math.ceil(remaining / 1000));
    updateProgress(`${label}: ${seconds} сек.`);
    const step = Math.min(500, remaining);
    await sleep(step);
    const now = Date.now();
    remaining -= now - previous;
    previous = now;
  }
  throwIfInterrupted();
}

function handleAccessBlock(reason = '') {
  if (state.blocked) return;
  state.blocked = true;
  state.blockReason = reason || 'КАД вернул страницу защиты вместо PDF.';
  const activePdfTask = state.running && state.mode === 'pdf';
  ui.fatal.textContent = activePdfTask
    ? `${state.blockReason}. Загрузка остановлена; автоматических повторов не будет.`
    : `${state.blockReason}. Новое скачивание PDF отключено до обновления списка.`;
  ui.fatal.classList.remove('hidden');
  if (activePdfTask) {
    state.stopped = true;
    state.paused = false;
    ui.status.textContent = 'Доступ КАД ограничен — очередь остановлена';
    ui.current.textContent = 'Подождите снятия ограничения, затем обновите список документов.';
  }
  setStatusTone('error');
  log(`Защита КАД: ${state.blockReason}. Очередь немедленно остановлена.`, 'error');
  updateCollectionView();
}

async function collect() {
  if (!sourceTabId) {
    setFatal(startupError === 'not-a-case'
      ? 'Активная вкладка не относится к kad.arbitr.ru. Перейдите на вкладку с нужным делом и нажмите значок расширения ещё раз.'
      : 'Не удалось определить исходную вкладку КАД. Вернитесь в карточку дела и нажмите значок расширения ещё раз.');
    return;
  }

  ui.fatal.classList.add('hidden');
  state.blocked = false;
  state.blockReason = '';
  state.mode = 'collect';
  setRunning(true, 'Собираю список документов');
  state.total = 0;
  state.done = 0;
  state.success = 0;
  state.errors = 0;
  updateProgress('Запрашиваю первую страницу электронного дела…');
  log('Начат сбор метаданных дела.');

  let collected = false;
  try {
    const response = await chrome.tabs.sendMessage(sourceTabId, {
      type: 'KAD_COLLECT_CASE',
      expectedCaseId
    });
    if (!response?.ok) throw new Error(response?.error || 'Не удалось получить ответ от вкладки КАД.');
    state.collection = response.result;
    await chrome.storage.local.set({ lastCollection: state.collection });
    const determinationCount = state.collection.documents.filter(isDetermination).length;
    log(`Собрано документов: ${state.collection.documents.length}; определений: ${determinationCount}.`);
    updateCollectionView();
    collected = true;
  } catch (error) {
    const message = String(error?.message || error);
    log(`Сбор не выполнен: ${message}`, 'error');
    if (/Доступ КАД ограничен|KAD_ACCESS_BLOCKED/i.test(message)) {
      state.blocked = true;
      state.blockReason = message;
    }
    setFatal(message.includes('Receiving end does not exist') || message.includes('Could not establish connection')
      ? 'Расширение не подключилось к вкладке КАД. Обновите карточку дела (F5) и запустите сборщик ещё раз.'
      : message);
    ui.status.textContent = state.blocked ? 'Доступ КАД ограничен' : 'Ошибка сбора';
    setStatusTone('error');
  } finally {
    setRunning(false, ui.status.textContent);
    if (collected) showReadyState();
    else updateProgressVisibility();
  }
}

async function waitForDownload(downloadId, timeoutMs = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (!item) throw new Error('Chrome потерял задачу загрузки.');
    if (item.state === 'complete') return item;
    if (item.state === 'interrupted') throw new Error(`Загрузка прервана: ${item.error || 'неизвестная причина'}`);
    await sleep(500);
  }
  throw new Error('Загрузка не завершилась за 120 секунд.');
}

function base64ToBlob(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: 'application/pdf' });
}

async function downloadOnePdf(doc, index) {
  const path = pdfDownloadPath(state.collection.caseNumber, doc, index);
  const response = await chrome.runtime.sendMessage({
    type: 'KAD_OPEN_PDF_ORIGINAL',
    url: doc.pdfUrl,
    filename: path
  });
  if (!response?.ok) {
    throw new Error(response?.error || 'Не удалось открыть PDF в браузере.');
  }
  return { filename: path };
}

async function runPdfDownloads() {
  const docs = selectedDocuments();
  if (!docs.length || state.running) return;
  beginTask('pdf', docs.length, 'Скачиваю PDF');
  state.batchCount = 0;
  state.batchTarget = randomInteger(SAFE_DOWNLOAD_LIMITS.batchMin, SAFE_DOWNLOAD_LIMITS.batchMax);
  log('Первая загрузка может открыть служебную вкладку для разрешения Chrome; следующие PDF загружаются в ней без перехвата фокуса.');
  log(`Бережный режим: случайная пауза 8–15 сек.; после ${state.batchTarget} PDF — длинная пауза 1–2 мин.`);

  try {
    for (let index = 0; index < docs.length; index += 1) {
      await waitIfPaused();
      const doc = docs[index];
      updateProgress(`${doc.displayDate || 'Без даты'} · ${doc.documentTypeName || 'Судебный акт'}`);
      try {
        const { filename } = await downloadOnePdf(doc, index);
        state.success += 1;
        log(`${index + 1}/${docs.length}: передан браузеру ${filename}`);
      } catch (error) {
        state.errors += 1;
        log(`${index + 1}/${docs.length}: не скачан ${doc.pdfUrl} — ${error.message || error}`, 'error');
      }
      state.done = index + 1;
      state.batchCount += 1;
      updateProgress();
      if (index < docs.length - 1) {
        if (state.batchCount >= state.batchTarget) {
          const cooldown = randomInteger(
            SAFE_DOWNLOAD_LIMITS.cooldownMinMs,
            SAFE_DOWNLOAD_LIMITS.cooldownMaxMs
          );
          log(`Пакет из ${state.batchCount} PDF завершён. Пауза ${Math.ceil(cooldown / 1000)} сек.`);
          await waitBeforeNextRequest(cooldown, 'Бережная пауза перед следующим пакетом');
          state.batchCount = 0;
          state.batchTarget = randomInteger(SAFE_DOWNLOAD_LIMITS.batchMin, SAFE_DOWNLOAD_LIMITS.batchMax);
          log(`Следующий пакет: до ${state.batchTarget} PDF.`);
        } else {
          const delay = randomInteger(
            SAFE_DOWNLOAD_LIMITS.delayMinMs,
            SAFE_DOWNLOAD_LIMITS.delayMaxMs
          );
          await waitBeforeNextRequest(delay, 'Следующий запрос');
        }
      }
    }
    finishTask('Загрузка PDF завершена');
  } catch (error) {
    if (error.code === CONTROL_BLOCKED || state.blocked) finishBlockedTask();
    else if (error.code === CONTROL_STOPPED) finishTask('Загрузка остановлена');
    else failTask(error);
  }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('kad-act-collector', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('textChunks', { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function cacheGet(key) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('textChunks', 'readonly').objectStore('textChunks').get(key);
    request.onsuccess = () => { db.close(); resolve(request.result?.result || null); };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}

async function cachePut(key, result) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('textChunks', 'readwrite').objectStore('textChunks').put({ key, result, savedAt: Date.now() });
    request.onsuccess = () => { db.close(); resolve(); };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}

function pageTextFromItems(items) {
  const lines = [];
  let line = '';
  let previousY = null;
  for (const item of items) {
    const value = String(item.str || '').trim();
    if (!value) continue;
    const y = Number(item.transform?.[5]);
    if (previousY !== null && Number.isFinite(y) && Math.abs(y - previousY) > 2.5 && line.trim()) {
      lines.push(line.trim());
      line = '';
    }
    if (line && !/[-–—\s]$/.test(line) && !/^[,.;:!?%)\]]/.test(value)) line += ' ';
    line += value;
    if (item.hasEOL && line.trim()) {
      lines.push(line.trim());
      line = '';
    }
    if (Number.isFinite(y)) previousY = y;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function extractLocalPdf(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length < 5 || String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') {
    throw new Error('Выбранный файл не является PDF');
  }
  const loadingTask = pdfjsLib.getDocument({ data: bytes, useSystemFonts: true, isEvalSupported: false });
  const pdf = await loadingTask.promise;
  const pages = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent({ includeMarkedContent: false });
      const text = pageTextFromItems(content.items || []);
      pages.push(`--- Страница ${pageNumber} ---\n${text || '[Текстовый слой отсутствует]'}`);
      page.cleanup();
    }
  } finally {
    await pdf.destroy();
  }
  const text = pages.join('\n\n');
  const meaningfulLength = text.replace(/--- Страница \d+ ---|\[Текстовый слой отсутствует\]/g, '').trim().length;
  return { text, pageCount: pages.length, hasTextLayer: meaningfulLength >= 40, byteLength: bytes.length };
}

async function selectPdfFolder() {
  if (!window.showDirectoryPicker) {
    throw new Error('Chrome не поддерживает выбор папки. Обновите браузер до актуальной версии.');
  }
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  const filesByDocumentId = new Map();
  for await (const entry of handle.values()) {
    if (entry.kind !== 'file' || !/\.pdf$/i.test(entry.name)) continue;
    const match = entry.name.match(/__([0-9a-f-]{36})(?:\s*\(\d+\))?\.pdf$/i);
    if (match && !filesByDocumentId.has(match[1].toLowerCase())) {
      filesByDocumentId.set(match[1].toLowerCase(), entry);
    }
  }
  return { handle, filesByDocumentId };
}

async function extractOne(doc, filesByDocumentId) {
  const key = `${state.collection.caseId}:${doc.id || doc.pdfUrl}`;
  const cached = await cacheGet(key);
  if (cached) return { result: cached, cached: true };
  const fileHandle = filesByDocumentId.get(String(doc.id || '').toLowerCase());
  if (!fileHandle) throw new Error('PDF не найден в выбранной папке');
  const result = await extractLocalPdf(await fileHandle.getFile());
  await cachePut(key, result);
  return { result, cached: false };
}

async function saveTextFile(text, directoryHandle) {
  const filename = `KAD_${safeFilePart(state.collection.caseNumber || state.collection.caseId)}_${selectedScope() === 'all' ? 'все_документы' : 'определения'}.txt`;
  const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(text);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
  return filename;
}

async function runTextExtraction() {
  const docs = selectedDocuments();
  if (!docs.length || state.running) return;
  let folder;
  try {
    folder = await selectPdfFolder();
  } catch (error) {
    if (error?.name === 'AbortError') {
      log('Создание TXT отменено: папка не выбрана.');
      return;
    }
    failTask(error);
    return;
  }
  beginTask('text', docs.length, 'Извлекаю текст из локальных PDF');
  log(`Выбрана папка «${folder.handle.name}». Найдено PDF: ${folder.filesByDocumentId.size}.`);
  const rows = [];

  try {
    for (let index = 0; index < docs.length; index += 1) {
      await waitIfPaused();
      const doc = docs[index];
      updateProgress(`${doc.displayDate || 'Без даты'} · ${doc.documentTypeName || 'Судебный акт'}`);
      try {
        const { result, cached } = await extractOne(doc, folder.filesByDocumentId);
        rows.push({ status: 'ok', document: doc, result });
        state.success += 1;
        log(`${index + 1}/${docs.length}: текст извлечён (${result.pageCount} стр.)${cached ? ' — из локального кэша' : ''}${result.hasTextLayer ? '' : ' — нужен OCR'}.`);
      } catch (error) {
        rows.push({ status: 'error', document: doc, error: error.message || String(error) });
        state.errors += 1;
        log(`${index + 1}/${docs.length}: ошибка извлечения — ${error.message || error}`, 'error');
      }
      state.done = index + 1;
      updateProgress();
      if (index < docs.length - 1) await sleep(50);
    }

    const output = buildTextDocument(state.collection, rows, ui.order.value);
    const filename = await saveTextFile(output, folder.handle);
    log(`TXT сохранён в выбранную папку: ${filename}.`);
    finishTask('Единый TXT сформирован');
  } catch (error) {
    if (error.code === CONTROL_STOPPED) {
      if (rows.length) {
        const filename = await saveTextFile(buildTextDocument(state.collection, rows, ui.order.value), folder.handle);
        log(`Частичный TXT сохранён в выбранную папку: ${filename}; документов: ${rows.length}.`);
      }
      finishTask('Извлечение остановлено');
    } else {
      failTask(error);
    }
  }
}

function beginTask(mode, total, label) {
  state.mode = mode;
  state.total = total;
  state.done = 0;
  state.success = 0;
  state.errors = 0;
  state.paused = false;
  state.stopped = false;
  setRunning(true, label);
  updateProgress();
  log(`${label}. Документов: ${total}.`);
}

function finishTask(label) {
  state.paused = false;
  state.stopped = false;
  setRunning(false, label);
  setStatusTone(state.errors ? 'warning' : 'success');
  updateProgress(label);
  log(`${label}. Успешно: ${state.success}; ошибок: ${state.errors}.`);
}

function finishBlockedTask() {
  state.paused = false;
  state.stopped = true;
  setRunning(false, 'Доступ КАД ограничен — загрузка остановлена');
  setStatusTone('error');
  updateProgress('Новых запросов не будет. Подождите снятия ограничения и обновите список.');
  log(`Загрузка остановлена защитой КАД. Передано браузеру: ${state.success}; ошибок: ${state.errors}.`);
}

function failTask(error) {
  const message = error?.message || String(error);
  setRunning(false, 'Ошибка');
  setStatusTone('error');
  updateProgress(message);
  log(`Операция завершилась ошибкой: ${message}`, 'error');
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'KAD_ACCESS_BLOCKED') {
    handleAccessBlock(message.reason);
    return;
  }
  if (message?.type !== 'KAD_COLLECT_PROGRESS' || sender.tab?.id !== sourceTabId) return;
  ui.status.textContent = 'Собираю список документов';
  setStatusTone('active');
  ui['progress-details'].classList.remove('hidden');
  ui['progress-track'].classList.remove('hidden');
  ui.counter.classList.remove('hidden');
  ui.counter.textContent = `${message.page} / ${message.pages}`;
  const percentage = Math.round((message.page / message.pages) * 100);
  ui.progress.style.width = `${percentage}%`;
  ui['progress-track'].setAttribute('aria-valuenow', String(percentage));
  ui.current.textContent = `Страница ${message.page} из ${message.pages}; найдено PDF: ${message.found}`;
});

ui.collect.addEventListener('click', collect);
ui['download-pdfs'].addEventListener('click', runPdfDownloads);
ui['create-text'].addEventListener('click', runTextExtraction);
ui['open-pdf-settings'].addEventListener('click', openPdfSettings);
ui['open-pdf-settings-inline'].addEventListener('click', openPdfSettings);
ui['pdf-setup-done'].addEventListener('click', dismissPdfSetupNotice);
ui['legal-consent-check'].addEventListener('change', () => {
  ui['legal-accept'].disabled = !ui['legal-consent-check'].checked;
});
ui['legal-accept'].addEventListener('click', acceptLegalAgreement);
ui['legal-decline'].addEventListener('click', declineLegalAgreement);
ui['legal-consent-dialog'].addEventListener('cancel', event => {
  event.preventDefault();
});
ui['pdf-setup-dialog'].addEventListener('cancel', event => {
  event.preventDefault();
  dismissPdfSetupNotice();
});
ui.pause.addEventListener('click', () => {
  state.paused = !state.paused;
  ui.pause.textContent = state.paused ? 'Продолжить' : 'Пауза';
  ui.status.textContent = state.paused ? 'Пауза после текущего документа' : (state.mode === 'pdf' ? 'Скачиваю PDF' : 'Извлекаю текст из PDF');
  log(state.paused ? 'Пауза запрошена.' : 'Обработка продолжена.');
});
ui.stop.addEventListener('click', () => {
  state.stopped = true;
  state.paused = false;
  ui.pause.textContent = 'Пауза';
  ui.status.textContent = 'Останавливаю после текущего документа';
  log('Остановка запрошена.');
});
document.querySelectorAll('input[name="scope"], #order').forEach(element => {
  element.addEventListener('change', () => {
    updateCollectionView();
    if (!state.running && state.collection) showReadyState('Настройки обновлены. Выберите PDF или TXT.');
  });
});

async function initialize() {
  if (params.get('error') === 'not-a-case' || !sourceTabId) {
    setFatal('Откройте нужное дело на kad.arbitr.ru, затем нажмите значок расширения или кнопку «Собрать судебные акты» на странице.');
    ui.collect.disabled = true;
    return;
  }
  updateProgress('Нажмите «Собрать список».');
  if (await ensureLegalAgreement()) await showPdfSetupNoticeOnce();
}

initialize().catch(error => setFatal(`Не удалось запустить расширение: ${error.message || error}`));
