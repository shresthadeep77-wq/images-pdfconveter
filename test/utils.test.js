'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    escapeHtml,
    formatBytes,
    getFileExtension,
    getMimeType,
    isImageType,
    isOfficeType,
    getOutputOptions,
    formatToExt,
    estimateKey,
    sanitizeForPdf,
} = require('../src/utils.js');

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------
test('escapeHtml: returns empty string for falsy input', () => {
    assert.equal(escapeHtml(''), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(0), '');
});

test('escapeHtml: escapes the four special characters', () => {
    assert.equal(escapeHtml('<b>'), '&lt;b&gt;');
    assert.equal(escapeHtml('a & b'), 'a &amp; b');
    assert.equal(escapeHtml('say "hi"'), 'say &quot;hi&quot;');
});

test('escapeHtml: escapes a combined XSS-style payload', () => {
    assert.equal(
        escapeHtml('<img src="x" onerror="a&b">'),
        '&lt;img src=&quot;x&quot; onerror=&quot;a&amp;b&quot;&gt;'
    );
});

test('escapeHtml: leaves plain text untouched', () => {
    assert.equal(escapeHtml('hello world'), 'hello world');
    // single quotes are intentionally NOT escaped
    assert.equal(escapeHtml("it's fine"), "it's fine");
});

// ---------------------------------------------------------------------------
// formatBytes
// ---------------------------------------------------------------------------
test('formatBytes: zero bytes', () => {
    assert.equal(formatBytes(0), '0 B');
});

test('formatBytes: scales through units', () => {
    assert.equal(formatBytes(500), '500 B');
    assert.equal(formatBytes(1024), '1 KB');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(1048576), '1 MB');
    assert.equal(formatBytes(1073741824), '1 GB');
    assert.equal(formatBytes(1099511627776), '1 TB');
});

test('formatBytes: rounds to two decimals', () => {
    assert.equal(formatBytes(1234567), '1.18 MB');
});

// ---------------------------------------------------------------------------
// getFileExtension
// ---------------------------------------------------------------------------
test('getFileExtension: basic and lowercased', () => {
    assert.equal(getFileExtension('photo.PNG'), 'png');
    assert.equal(getFileExtension('archive.tar.GZ'), 'gz');
    assert.equal(getFileExtension('Document.PdF'), 'pdf');
});

test('getFileExtension: no dot returns the whole name lowercased', () => {
    assert.equal(getFileExtension('README'), 'readme');
});

// ---------------------------------------------------------------------------
// getMimeType
// ---------------------------------------------------------------------------
test('getMimeType: known image extensions', () => {
    assert.equal(getMimeType('jpg'), 'image/jpeg');
    assert.equal(getMimeType('jpeg'), 'image/jpeg');
    assert.equal(getMimeType('png'), 'image/png');
    assert.equal(getMimeType('svg'), 'image/svg+xml');
    assert.equal(getMimeType('tif'), 'image/tiff');
    assert.equal(getMimeType('heif'), 'image/heic');
});

test('getMimeType: documents and office formats', () => {
    assert.equal(getMimeType('pdf'), 'application/pdf');
    assert.equal(getMimeType('docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal(getMimeType('xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.equal(getMimeType('pptx'), 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    assert.equal(getMimeType('htm'), 'text/html');
});

test('getMimeType: unknown extension falls back to octet-stream', () => {
    assert.equal(getMimeType('xyz'), 'application/octet-stream');
    assert.equal(getMimeType(''), 'application/octet-stream');
});

// ---------------------------------------------------------------------------
// isImageType / isOfficeType
// ---------------------------------------------------------------------------
test('isImageType', () => {
    assert.equal(isImageType('image/png'), true);
    assert.equal(isImageType('image/svg+xml'), true);
    assert.equal(isImageType('application/pdf'), false);
    assert.equal(isImageType('text/html'), false);
});

test('isOfficeType', () => {
    assert.equal(isOfficeType(getMimeType('docx')), true);
    assert.equal(isOfficeType(getMimeType('xlsx')), true);
    assert.equal(isOfficeType(getMimeType('pptx')), true);
    assert.equal(isOfficeType('text/html'), true);
    assert.equal(isOfficeType('image/png'), false);
    assert.equal(isOfficeType('application/pdf'), false);
});

// ---------------------------------------------------------------------------
// getOutputOptions
// ---------------------------------------------------------------------------
test('getOutputOptions: image input offers images + PDF, no office', () => {
    const opts = getOutputOptions('image/png');
    const values = opts.map(o => o.value);
    assert.ok(values.includes('application/pdf'));
    assert.ok(values.every(v => isImageType(v) || v === 'application/pdf'));
    assert.ok(!values.some(isOfficeType));
});

test('getOutputOptions: pdf input offers images, PDF and office', () => {
    const opts = getOutputOptions('application/pdf');
    const values = opts.map(o => o.value);
    assert.ok(values.includes('application/pdf'));
    assert.ok(values.includes('image/jpeg'));
    assert.ok(values.some(isOfficeType));
});

test('getOutputOptions: office input offers PDF and images only', () => {
    const opts = getOutputOptions(getMimeType('docx'));
    const values = opts.map(o => o.value);
    assert.ok(values.includes('application/pdf'));
    assert.ok(values.every(v => v === 'application/pdf' || isImageType(v)));
    assert.ok(!values.some(isOfficeType));
});

test('getOutputOptions: unknown input returns the full list', () => {
    const opts = getOutputOptions('application/octet-stream');
    assert.equal(opts.length, 9);
});

// ---------------------------------------------------------------------------
// formatToExt
// ---------------------------------------------------------------------------
test('formatToExt: mapped mimes', () => {
    assert.equal(formatToExt('application/pdf'), 'pdf');
    assert.equal(formatToExt('image/jpeg'), 'jpg');
    assert.equal(formatToExt('image/svg+xml'), 'svg');
    assert.equal(formatToExt('text/plain'), 'txt');
});

test('formatToExt: office mimes matched by substring', () => {
    assert.equal(formatToExt(getMimeType('docx')), 'docx');
    assert.equal(formatToExt(getMimeType('xlsx')), 'xlsx');
    assert.equal(formatToExt(getMimeType('pptx')), 'pptx');
});

test('formatToExt: unmapped mime derives from subtype and strips suffixes', () => {
    assert.equal(formatToExt('image/avif'), 'avif');
    assert.equal(formatToExt('application/foo+xml'), 'foo');
    assert.equal(formatToExt('garbage'), 'bin');
});

// ---------------------------------------------------------------------------
// estimateKey
// ---------------------------------------------------------------------------
test('estimateKey: builds id|format|roundedQuality key', () => {
    assert.equal(
        estimateKey({ id: 7, outputFormat: 'image/png' }, 82.4),
        '7|image/png|82'
    );
    assert.equal(
        estimateKey({ id: 1, outputFormat: 'application/pdf' }, 69.6),
        '1|application/pdf|70'
    );
});

// ---------------------------------------------------------------------------
// sanitizeForPdf
// ---------------------------------------------------------------------------
test('sanitizeForPdf: normalizes smart punctuation', () => {
    assert.equal(sanitizeForPdf('\u2018a\u2019 \u201Cb\u201D'), "'a' \"b\"");
    assert.equal(sanitizeForPdf('en\u2013dash em\u2014dash'), 'en-dash em-dash');
    assert.equal(sanitizeForPdf('wait\u2026'), 'wait...');
});

test('sanitizeForPdf: tabs become four spaces and preserves newlines', () => {
    assert.equal(sanitizeForPdf('a\tb'), 'a    b');
    assert.equal(sanitizeForPdf('line1\nline2'), 'line1\nline2');
});

test('sanitizeForPdf: replaces non Latin-1 characters with ?', () => {
    assert.equal(sanitizeForPdf('emoji \u{1F600}'), 'emoji ??');
    assert.equal(sanitizeForPdf('\u0928\u092E\u0938\u094D\u0924\u0947'), '??????');
});

test('sanitizeForPdf: coerces non-string input', () => {
    assert.equal(sanitizeForPdf(123), '123');
});
