// Which option each Answer key on the deck is responsible for.
//
// There is one Answer action rather than four, so the option a key picks is a
// property of the key, not of the action. A key may pin itself to a number; a
// key that does not takes the next free one in the order keys were added, so
// dropping several on the deck works without configuring anything.

export const MAX_ANSWER_KEYS = 4;

function pinned(settings, max) {
  const n = parseInt(settings && settings.answerIndex, 10);
  return n >= 1 && n <= max ? n - 1 : null;
}

/**
 * @param keys      Map of context -> { uuid, settings }, in insertion order.
 * @param actionId  The Answer action's UUID.
 * @returns Map of context -> zero-based option index.
 */
export function assignAnswerIndexes(keys, actionId, max = MAX_ANSWER_KEYS) {
  const answers = [...keys].filter(([, key]) => key.uuid === actionId);

  // Pinned keys claim their number first, so an unpinned key never steals it.
  const taken = new Set();
  const result = new Map();
  for (const [context, key] of answers) {
    const index = pinned(key.settings, max);
    if (index !== null && !taken.has(index)) {
      taken.add(index);
      result.set(context, index);
    }
  }

  // Everything else fills the gaps in the order the keys were added.
  let next = 0;
  for (const [context, key] of answers) {
    if (result.has(context)) continue;
    while (taken.has(next)) next++;
    // Beyond the last option a key has nothing to answer; -1 paints it blank
    // rather than quietly duplicating another key.
    const index = next < max ? next : -1;
    if (index !== -1) {
      taken.add(index);
      next++;
    }
    result.set(context, index);
    void key;
  }

  return result;
}
