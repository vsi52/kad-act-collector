import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  estimateSafePdfDuration,
  buildTextDocument,
  caseIdFromText,
  dateValue,
  isHtmlInsteadOfPdf,
  isDetermination,
  pdfDownloadPath,
  randomInteger,
  safeFilePart,
  sortedDocuments
} from './src/utils.js';

const root = dirname(fileURLToPath(import.meta.url));

assert.equal(safeFilePart('А40: 123/2024?'), 'А40_123_2024');
const caseId = '88150c56-1a50-4958-afea-2789892a85c1';
assert.equal(caseIdFromText(`https://kad.arbitr.ru/Card/${caseId}`), caseId);
assert.equal(caseIdFromText(`https://kad.arbitr.ru/?caseId=${caseId}`), caseId);
assert.equal(caseIdFromText(`{"CaseId":"${caseId}"}`), caseId);
assert.equal(caseIdFromText('https://kad.arbitr.ru/'), '');
assert.ok(dateValue('05.03.2024') < dateValue('06.03.2024'));
assert.equal(isDetermination({ documentTypeName: 'Определение о принятии' }), true);
assert.equal(isDetermination({ documentTypeName: 'Решение' }), false);
assert.equal(randomInteger(8, 15, () => 0), 8);
assert.equal(randomInteger(8, 15, () => 0.999999), 15);
assert.equal(isHtmlInsteadOfPdf({ mime: 'text/html; charset=utf-8', filename: 'document.pdf' }), true);
assert.equal(isHtmlInsteadOfPdf({ mime: 'application/pdf', filename: 'document.htm' }), true);
assert.equal(isHtmlInsteadOfPdf({ mime: 'application/pdf', filename: 'document.pdf' }), false);
assert.equal(estimateSafePdfDuration(1), '≈ 1 сек.');
assert.equal(estimateSafePdfDuration(2), '≈ 14 сек.');

const docs = [
  { id: 'b', displayDate: '02.01.2024' },
  { id: 'a', displayDate: '01.01.2024' }
];
assert.deepEqual(sortedDocuments(docs, 'asc').map(doc => doc.id), ['a', 'b']);
assert.deepEqual(sortedDocuments(docs, 'desc').map(doc => doc.id), ['b', 'a']);
assert.match(pdfDownloadPath('А40-1/2024', { id: 'id', displayDate: '01.01.2024', documentTypeName: 'Определение' }, 0), /^KAD\/А40-1_2024\/0001__/);

const text = buildTextDocument(
  { caseNumber: 'А40-1/2024', caseId: 'case-id' },
  [{ status: 'ok', document: { displayDate: '01.01.2024', documentTypeName: 'Определение', pdfUrl: 'https://example.test/a.pdf' }, result: { text: 'Текст акта', hasTextLayer: true } }],
  'asc'
);
assert.match(text, /Дело: А40-1\/2024/);
assert.match(text, /Текст акта/);

const manifest = JSON.parse(await readFile(resolve(root, 'dist/manifest.json'), 'utf8'));
const packageInfo = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, packageInfo.version);
assert.deepEqual(manifest.host_permissions, ['https://kad.arbitr.ru/*']);
assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'downloads', 'storage']);

for (const file of [
  'background.js',
  'content.js',
  'workspace.html',
  'workspace.js',
  'workspace.css',
  'terms.html',
  'privacy.html',
  'third-party.html',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'pdf.worker.min.mjs',
  'PDFJS_LICENSE.txt',
  'icons/icon128.png'
]) {
  await access(resolve(root, 'dist', file));
}

const contentBundle = await readFile(resolve(root, 'dist/content.js'), 'utf8');
const contentSource = await readFile(resolve(root, 'src/content.js'), 'utf8');
assert.equal(contentBundle.includes('new Function'), false);
assert.equal(contentBundle.includes('eval('), false);
assert.equal(contentBundle.includes('KAD_DOWNLOAD_VERIFIED_PDF'), true);
assert.equal(contentBundle.includes('CaseDocumentsPage'), true);
assert.equal(contentBundle.includes('location.href'), true);
assert.equal(contentBundle.includes('pdfjs-dist'), false);
assert.equal(contentBundle.includes('2026-07-23-v1'), true);
assert.equal(contentBundle.includes('legalAcceptance'), true);
assert.equal(
  /function installLauncher\(\)\s*\{\s*if \(!legalAccepted\)/.test(contentSource),
  false,
  'The launcher must remain visible before legal acceptance'
);
assert.equal(
  contentSource.includes("error: 'Сначала примите Пользовательское соглашение"),
  true,
  'Collection must remain blocked before legal acceptance'
);
assert.ok(contentBundle.length < 50000, 'Content script must remain lightweight');

const backgroundBundle = await readFile(resolve(root, 'dist/background.js'), 'utf8');
const backgroundSource = await readFile(resolve(root, 'src/background.js'), 'utf8');
assert.equal(backgroundBundle.includes('chrome.storage.session'), true);
assert.equal(backgroundBundle.includes("active: true"), true);
assert.equal(backgroundBundle.includes("conflictAction: 'overwrite'"), true);
assert.equal(backgroundBundle.includes('KAD_ACCESS_BLOCKED'), true);
assert.equal(backgroundBundle.includes('text\\/html'), true);
assert.equal(backgroundBundle.includes('chrome://settings/content/pdfDocuments'), true);
assert.equal(backgroundBundle.includes('KAD_OPEN_PDF_SETTINGS'), true);
assert.equal(backgroundSource.includes('chrome.windows.update'), false);
assert.equal(backgroundSource.includes("chrome.tabs.update(downloadTabId, { url, active: false })"), true);

const workspaceBundle = await readFile(resolve(root, 'dist/workspace.js'), 'utf8');
const workspaceSource = await readFile(resolve(root, 'src/workspace.js'), 'utf8');
assert.equal(workspaceBundle.includes('showDirectoryPicker'), true);
assert.match(workspaceBundle, /mode:\s*["']readwrite["']/);
assert.equal(workspaceBundle.includes('createWritable'), true);
assert.equal(workspaceBundle.includes('KAD_EXTRACT_TEXT'), false);
assert.equal(workspaceBundle.includes('new Function'), false);
assert.equal(workspaceBundle.includes('KAD_ACCESS_BLOCKED'), true);
assert.equal(workspaceSource.includes('Бережный режим'), true);
assert.equal(workspaceSource.includes('автоматических повторов не будет'), true);
assert.equal(workspaceSource.includes('pdfSetupNoticeDismissed'), true);
assert.equal(workspaceSource.includes('KAD_OPEN_PDF_SETTINGS'), true);
assert.equal(workspaceSource.includes('legalAcceptance'), true);
assert.equal(workspaceSource.includes('2026-07-23-v1'), true);
assert.equal(workspaceSource.includes('`Скачать ${selectedCount} PDF`'), false);
assert.equal(workspaceSource.includes('`Создать TXT из ${selectedCount} PDF`'), false);
assert.equal(workspaceSource.includes('`Готово · ${documentLabel(count)}`'), true);

const workspaceHtml = await readFile(resolve(root, 'dist/workspace.html'), 'utf8');
assert.equal(workspaceHtml.includes('id="text-label">Создать TXT</strong>'), true);
assert.equal(workspaceHtml.includes('id="counter" class="status-counter hidden"'), true);
assert.equal(workspaceHtml.includes(`v${packageInfo.version}`), true);
assert.equal(workspaceHtml.includes('Случайно 8–15 сек.'), true);
assert.equal(workspaceHtml.includes('class="card workflow-card"'), true);
assert.equal(workspaceHtml.includes('id="progress-details" class="status-details hidden"'), true);
assert.equal(workspaceHtml.includes('class="log-row"'), true);
assert.equal(workspaceHtml.includes('class="card progress-card"'), false);
assert.equal(workspaceHtml.includes('Примерное время'), false);
assert.equal(workspaceHtml.includes('id="delay"'), false);
assert.equal(workspaceHtml.includes('id="pdf-setup-dialog"'), true);
assert.equal(workspaceHtml.includes('id="legal-consent-dialog"'), true);
assert.equal(workspaceHtml.includes('id="legal-accept"'), true);
assert.equal(workspaceHtml.includes('Пользовательское соглашение'), true);
assert.equal(workspaceHtml.includes('Независимый продукт'), true);
assert.equal(workspaceHtml.includes('Все документы'), true);
assert.equal(workspaceHtml.includes('Настройки PDF в Chrome'), true);
assert.equal(workspaceHtml.includes('включите <strong>скачивание PDF</strong>'), true);
assert.equal(workspaceHtml.includes('href="third-party.html"'), true);
assert.equal(workspaceHtml.includes('href="THIRD_PARTY_NOTICES.md"'), false);
assert.equal(workspaceHtml.includes('class="segment-text">Только определения</span>'), true);

const workspaceCss = await readFile(resolve(root, 'dist/workspace.css'), 'utf8');
assert.equal(workspaceCss.includes('grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr)'), true);
assert.equal(workspaceCss.includes('align-items: end'), false);
assert.equal(workspaceCss.includes('.field select { width: 100%; height: 52px;'), true);
assert.equal(workspaceCss.includes('.segment-text { min-width: 0; white-space: nowrap; }'), true);

const termsHtml = await readFile(resolve(root, 'dist/terms.html'), 'utf8');
assert.equal(termsHtml.includes('не предназначена для массового формирования'), true);
assert.equal(termsHtml.includes('не является официальным сервисом'), true);
assert.equal(termsHtml.includes('статьях 1260, 1334 и 1335.1 ГК РФ'), true);
assert.equal(termsHtml.includes('доступ к файлу не означает'), false);
assert.equal(termsHtml.includes('Наличие технического доступа к файлу не означает'), true);

const privacyHtml = await readFile(resolve(root, 'dist/privacy.html'), 'utf8');
assert.equal(privacyHtml.includes('нет собственного сервера'), true);
assert.equal(privacyHtml.includes('не считывает значения логина, пароля, cookies или токенов'), true);
assert.equal(privacyHtml.includes('9. Ограниченное использование данных'), true);
assert.equal(privacyHtml.includes('Limited Use'), false);

const notices = await readFile(resolve(root, 'dist/THIRD_PARTY_NOTICES.md'), 'utf8');
assert.equal(notices.includes('pdfjs-dist'), true);
assert.equal(notices.includes('5.4.149'), true);
assert.equal(notices.includes('Сторонние компоненты'), true);
assert.equal(/[РС][ЎЃ‚Ј]/.test(notices), false);

const thirdPartyHtml = await readFile(resolve(root, 'dist/third-party.html'), 'utf8');
assert.equal(thirdPartyHtml.includes('<meta charset="utf-8">'), true);
assert.equal(thirdPartyHtml.includes('Сторонние компоненты'), true);
assert.equal(thirdPartyHtml.includes('pdfjs-dist'), true);
assert.equal(thirdPartyHtml.includes('5.4.149'), true);
assert.equal(/[РС][ЎЃ‚Ј]/.test(thirdPartyHtml), false);

const contentCss = await readFile(resolve(root, 'dist/content.css'), 'utf8');
assert.match(contentCss, /bottom:\s*calc\(120px/);
assert.equal(contentCss.includes('bottom: 22px'), false);

console.log('All checks passed');
