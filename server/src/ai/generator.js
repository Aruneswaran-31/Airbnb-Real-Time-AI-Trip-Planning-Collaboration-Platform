'use strict';

/**
 * Grounded answer generation for the AI Concierge.
 *
 * Two engines, one contract:
 *  - `llm`               : uses an OpenAI-compatible model, then *validates* that
 *                          every cited venue id exists in the candidate set.
 *  - `grounded-template` : deterministic, data-driven prose built only from venue
 *                          metadata (works with no API key configured).
 *
 * In both cases the response cites `sourceEvents` (venue record ids). The model
 * is never allowed to invent a venue, price or opening hour.
 */

const llm = require('./llm');

function money(cents, currency = 'USD') {
  const symbol = currency === 'USD' ? '$' : '';
  const value = (cents || 0) / 100;
  return `${symbol}${Number.isInteger(value) ? value : value.toFixed(2)}`;
}

function walkMinutes(distanceKm) {
  if (distanceKm === null || distanceKm === undefined) return null;
  return Math.max(1, Math.round((distanceKm / 4.8) * 60));
}

function describeVenue(candidate, { currency, anchorLabel }) {
  const v = candidate.venue;
  const bits = [];
  bits.push(`${v.name} (${v.venueId}, ${v.category})`);
  bits.push(`${money(v.pricePerPersonCents, currency)}/person`);
  if (candidate.distanceKm !== null && candidate.distanceKm !== undefined) {
    bits.push(`${candidate.distanceKm} km${anchorLabel ? ` from ${anchorLabel}` : ''} (~${walkMinutes(candidate.distanceKm)} min walk)`);
  }
  if (v.rating) bits.push(`${v.rating}★`);
  if (v.dietaryTags && v.dietaryTags.length) bits.push(`dietary: ${v.dietaryTags.join(', ')}`);
  if (v.hours) bits.push(`open ${v.hours.open}-${v.hours.close}`);
  if (v.transit) bits.push(`transit: ${v.transit}`);
  return bits.join(' · ');
}

/** Facts handed to the LLM. Only these records are citable. */
function buildGroundingContext(candidates, { currency, anchorLabel, constraints }) {
  const lines = candidates.map((candidate, index) => `${index + 1}. ${describeVenue(candidate, { currency, anchorLabel })} :: ${candidate.venue.description || ''}`);
  return [
    `Constraints: budget ceiling ${constraints.maxPriceCents !== null ? money(constraints.maxPriceCents, currency) : 'none'}, dietary [${(constraints.dietaryTags || []).join(', ') || 'none'}], radius ${constraints.radiusKm} km${anchorLabel ? ` around ${anchorLabel}` : ''}, slot ${constraints.slot ? `${constraints.slot.startTime}-${constraints.slot.endTime}` : 'unset'}.`,
    'Candidate venues (the only venues you may mention):',
    ...lines,
  ].join('\n');
}

function templateAnswer({ candidates, rejected, constraints, anchor, currency, question }) {
  const anchorLabel = anchor ? `${anchor.startTime} ${anchor.title}` : null;

  if (candidates.length === 0) {
    const nearMisses = (rejected || [])
      .filter((r) => r.distanceKm !== null && r.distanceKm !== undefined)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 2);

    const why = [];
    if (constraints.maxPriceCents !== null) why.push(`under ${money(constraints.maxPriceCents, currency)} per person`);
    if (constraints.dietaryTags.length) why.push(`matching ${constraints.dietaryTags.join(' + ')}`);
    if (constraints.slot) why.push(`open for ${constraints.slot.startTime}-${constraints.slot.endTime}`);
    if (anchor) why.push(`within ${constraints.radiusKm} km of your ${anchorLabel}`);

    let text = `I couldn't find a ${constraints.category || 'venue'} ${why.length ? why.join(', ') : 'that fits'} in the authored ${constraints.destination || 'destination'} dataset. I won't invent one.`;
    if (nearMisses.length) {
      text += ` Closest near-misses: ${nearMisses
        .map((r) => `${r.name} (${r.distanceKm} km) failed ${r.reasons.join(' + ')}`)
        .join('; ')}.`;
    } else if (constraints.radiusKm && anchor) {
      text += ` Try widening the radius above ${constraints.radiusKm} km, relaxing the budget, or dropping a dietary requirement.`;
    }
    return text;
  }

  const [top, ...rest] = candidates;
  const v = top.venue;
  const parts = [];
  parts.push(`**${v.name}** is your best fit${anchor ? ` — about ${walkMinutes(top.distanceKm)} minutes on foot from your ${anchorLabel}` : ''}.`);
  parts.push(`It runs ${money(v.pricePerPersonCents, currency)} per person${constraints.maxPriceCents !== null ? `, leaving ${money(constraints.maxPriceCents - v.pricePerPersonCents, currency)} of headroom under your ceiling` : ''}.`);
  if (v.dietaryTags && v.dietaryTags.length) parts.push(`Dietary tags on file: ${v.dietaryTags.join(', ')}.`);
  if (v.hours) parts.push(`It is open ${v.hours.open}-${v.hours.close}${constraints.slot ? `, which covers your ${constraints.slot.startTime}-${constraints.slot.endTime} slot with travel buffer` : ''}.`);
  if (v.rating) parts.push(`Guests rate it ${v.rating}★.`);
  if (v.transit) parts.push(`Getting there: ${v.transit}.`);
  if (v.description) parts.push(v.description);

  if (rest.length) {
    parts.push(
      `Also valid: ${rest
        .slice(0, 2)
        .map((c) => `${c.venue.name} (${money(c.venue.pricePerPersonCents, currency)} pp${c.distanceKm !== null && c.distanceKm !== undefined ? `, ${walkMinutes(c.distanceKm)} min walk` : ''})`)
        .join(' and ')}.`
    );
  }

  parts.push(`Grounded in venue records: ${[top, ...rest.slice(0, 2)].map((c) => c.venue.venueId).join(', ')}.`);
  return parts.join(' ');
}

const SYSTEM_PROMPT = `You are the AI Travel Concierge for a group trip-planning app.
Rules you must never break:
1. Only mention venues that appear in the CANDIDATE VENUES list you are given. Never invent a venue, price, rating, or opening hour.
2. The candidates already satisfy every hard constraint (budget, dietary, hours, proximity). Do not suggest anything else.
3. Answer in 2-4 short sentences, concrete and practical, using the exact prices and hours provided.
4. End with "Grounded in venue records: " followed by the venueId(s) you used, comma separated.
5. If the list is empty, say you found no venue that satisfies every constraint and suggest relaxing one named constraint. Do not invent alternatives.`;

/**
 * @returns {Promise<{answer:string, suggestedVenueId:string|null, alternatives:string[], sourceEvents:string[], engine:string, llmReason?:string}>}
 */
async function generateAnswer({ question, candidates, rejected, constraints, anchor, currency = 'USD', destination }) {
  const allowedIds = new Set(candidates.map((c) => c.venue.venueId));
  const anchorLabel = anchor ? `${anchor.startTime} ${anchor.title}` : null;

  if (llm.isConfigured() && candidates.length > 0) {
    const context = buildGroundingContext(candidates, { currency, anchorLabel, constraints });
    const result = await llm.chat({
      system: SYSTEM_PROMPT,
      user: `TRAVELER QUESTION: ${question}\n\nDESTINATION: ${destination}\nANCHOR: ${anchorLabel || 'none'}\n\n${context}`,
    });

    if (result.ok) {
      const cited = [...result.text.matchAll(/\bv_[a-z0-9_-]+/gi)].map((m) => m[0]);
      const allGrounded = cited.length > 0 && cited.every((id) => allowedIds.has(id));
      const mentionsAllowedVenue = [...allowedIds].some((id) => result.text.includes(id)) ||
        candidates.some((c) => result.text.toLowerCase().includes(c.venue.name.toLowerCase()));

      if (allGrounded && mentionsAllowedVenue) {
        const primary = cited.find((id) => allowedIds.has(id)) || candidates[0].venue.venueId;
        return {
          answer: result.text,
          suggestedVenueId: primary,
          alternatives: candidates.filter((c) => c.venue.venueId !== primary).slice(0, 2).map((c) => c.venue.venueId),
          sourceEvents: [...new Set(cited.filter((id) => allowedIds.has(id)))],
          engine: 'llm',
        };
      }

      // Ungrounded output is discarded rather than shown — grounding is a hard rule.
      return {
        answer: templateAnswer({ candidates, rejected, constraints, anchor, currency, question }),
        suggestedVenueId: candidates[0].venue.venueId,
        alternatives: candidates.slice(1, 3).map((c) => c.venue.venueId),
        sourceEvents: candidates.slice(0, 3).map((c) => c.venue.venueId),
        engine: 'grounded-template',
        llmReason: allGrounded ? 'no_candidate_cited' : 'unverified_citation',
      };
    }

    return {
      answer: templateAnswer({ candidates, rejected, constraints, anchor, currency, question }),
      suggestedVenueId: candidates[0].venue.venueId,
      alternatives: candidates.slice(1, 3).map((c) => c.venue.venueId),
      sourceEvents: candidates.slice(0, 3).map((c) => c.venue.venueId),
      engine: 'grounded-template',
      llmReason: result.reason,
    };
  }

  return {
    answer: templateAnswer({ candidates, rejected, constraints, anchor, currency, question }),
    suggestedVenueId: candidates.length ? candidates[0].venue.venueId : null,
    alternatives: candidates.slice(1, 3).map((c) => c.venue.venueId),
    sourceEvents: candidates.slice(0, 3).map((c) => c.venue.venueId),
    engine: 'grounded-template',
  };
}

module.exports = { generateAnswer, templateAnswer, buildGroundingContext, describeVenue, money, walkMinutes, SYSTEM_PROMPT };
