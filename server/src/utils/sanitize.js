'use strict';

/**
 * Strip control characters and HTML-looking markup from free text.
 * Chat bodies are rendered as text in the client, but we still neutralise
 * markup server-side so stored content can never become executable.
 */
function sanitizeText(value, { maxLength = 2000 } = {}) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\u0000/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim()
    .slice(0, maxLength);
}

/** Escape for inclusion in a plain-text / HTML log sink. */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

module.exports = { sanitizeText, escapeHtml, slugify };
