/* =====================================================================
   STUDIO PRO — PURE UTILITY MODULE
   ---------------------------------------------------------------------
   Pure, side-effect-free helpers shared between the browser app
   (index.html) and the unit-test suite (test/utils.test.js).

   This file is written as a classic script so that, when loaded via
   <script src="src/utils.js"></script>, every function below is exposed
   on the global scope (window/globalThis) exactly as it was when the
   definitions lived inline in index.html. It is *also* exported through
   CommonJS (module.exports) so the same source can be unit-tested under
   Node without a DOM.
   ===================================================================== */
(function (root, factory) {
    const api = factory();
    // CommonJS / Node (used by the test suite)
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    // Browser: expose each helper as a global, preserving the original
    // behaviour of the inline function declarations in index.html.
    if (root) {
        for (const key of Object.keys(api)) {
            root[key] = api[key];
        }
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function escapeHtml(s) {
        if (!s) return '';
        return s.replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m] || m);
    }

    function formatBytes(b) {
        if (b === 0) return '0 B';
        const k = 1024,
            s = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(b) / Math.log(k));
        return parseFloat((b / Math.pow(k, i)).toFixed(2)) + ' ' + s[i];
    }

    function getFileExtension(name) {
        return name.split('.').pop().toLowerCase();
    }

    function getMimeType(ext) {
        const map = {
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            png: 'image/png',
            webp: 'image/webp',
            bmp: 'image/bmp',
            ico: 'image/ico',
            avif: 'image/avif',
            gif: 'image/gif',
            tiff: 'image/tiff',
            tif: 'image/tiff',
            heic: 'image/heic',
            heif: 'image/heic',
            svg: 'image/svg+xml',
            pdf: 'application/pdf',
            docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            html: 'text/html',
            htm: 'text/html'
        };
        return map[ext] || 'application/octet-stream';
    }

    function isImageType(mime) {
        return mime.startsWith('image/');
    }

    function isOfficeType(mime) {
        return mime.includes('wordprocessingml') || mime.includes('spreadsheetml') || mime.includes('presentationml') ||
            mime === 'text/html';
    }

    function getOutputOptions(inputMime) {
        const allFormats = [
            { value: 'image/png', label: 'PNG' },
            { value: 'image/jpeg', label: 'JPG' },
            { value: 'image/webp', label: 'WebP' },
            { value: 'image/bmp', label: 'BMP' },
            { value: 'image/gif', label: 'GIF' },
            { value: 'application/pdf', label: 'PDF' },
            { value: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'DOCX' },
            { value: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'XLSX' },
            { value: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', label: 'PPTX' }
        ];
        const isImage = isImageType(inputMime);
        const isPdf = inputMime === 'application/pdf';
        const isOffice = isOfficeType(inputMime);
        if (isImage) return allFormats.filter(f => isImageType(f.value) || f.value === 'application/pdf');
        if (isPdf) return allFormats.filter(f => isImageType(f.value) || f.value === 'application/pdf' || isOfficeType(f
            .value));
        if (isOffice) return allFormats.filter(f => f.value === 'application/pdf' || isImageType(f.value));
        return allFormats;
    }

    function formatToExt(mime) {
        const map = {
            'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png',
            'image/webp': 'webp', 'image/bmp': 'bmp', 'image/gif': 'gif',
            'image/tiff': 'tiff', 'image/svg+xml': 'svg', 'text/plain': 'txt',
        };
        if (map[mime]) return map[mime];
        if (mime.includes('wordprocessingml')) return 'docx';
        if (mime.includes('spreadsheetml')) return 'xlsx';
        if (mime.includes('presentationml')) return 'pptx';
        return (mime.split('/')[1] || 'bin').replace(/\+.*/, '');
    }

    function estimateKey(item, quality) {
        return `${item.id}|${item.outputFormat}|${Math.round(quality)}`;
    }

    function sanitizeForPdf(str) {
        return String(str)
            .replace(/[\u2018\u2019]/g, "'")
            .replace(/[\u201C\u201D]/g, '"')
            .replace(/[\u2013\u2014]/g, '-')
            .replace(/\u2026/g, '...')
            .replace(/\t/g, '    ')
            // drop anything not in basic Latin-1 printable range
            .replace(/[^\x09\x0A\x0D\x20-\xFF]/g, '?');
    }

    return {
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
    };
});
