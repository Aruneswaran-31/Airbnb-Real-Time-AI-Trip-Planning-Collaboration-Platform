'use strict';

/**
 * Thin OpenAI-compatible chat-completions client.
 *
 * The AI Concierge works with zero external services (deterministic grounded
 * generator), and automatically upgrades to an LLM when AI_API_KEY is configured.
 * Any provider exposing /chat/completions works: AI_BASE_URL + AI_MODEL.
 */

const config = require('../config');
const logger = require('../logger');

function isConfigured() {
  return Boolean(config.ai.apiKey);
}

async function chat({ system, user, temperature = 0.2, maxTokens = 320 }) {
  if (!isConfigured()) return { ok: false, reason: 'not_configured' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ai.timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(`${config.ai.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.ai.apiKey}`,
      },
      body: JSON.stringify({
        model: config.ai.model,
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      logger.warn('llm request failed', { status: response.status, body: text.slice(0, 400) });
      return { ok: false, reason: `http_${response.status}` };
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) return { ok: false, reason: 'empty_response' };

    return { ok: true, text, model: data.model || config.ai.model, latencyMs: Date.now() - startedAt };
  } catch (err) {
    logger.warn('llm request errored', { message: err.message });
    return { ok: false, reason: err.name === 'AbortError' ? 'timeout' : 'request_error' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { chat, isConfigured };
