/**
 * The one place a user's search box becomes an FTS5 `MATCH` argument.
 *
 * **A raw user string cannot be passed to `MATCH`.** FTS5 has a query language: `-` means NOT,
 * `*` is a prefix wildcard, `:` is a column filter, `^` anchors, `OR`/`AND`/`NOT`/`NEAR` are
 * operators, and an unbalanced quote is a syntax error. Searching for a sample id like `S-4471`
 * therefore does not return nothing — it *throws*, turning a search into a 500. MongoDB's
 * `$text` has no such problem, so this is a hazard the migration introduces and has to answer
 * for.
 *
 * ── Why extraction rather than escaping ────────────────────────────────────────────────
 *
 * The tempting fix is to wrap the whole string in quotes and double any quote inside it. That
 * is genuinely safe against injection, and it was what `file.repository.d1.ts` did — but it is
 * not safe against *errors*, because a token made only of punctuation (`***`, `--`, `!`) quotes
 * to a phrase containing no tokens at all, and what FTS5 does with an empty phrase is a
 * version-dependent detail this codebase should not be betting a 500 on.
 *
 * Extracting `[\p{L}\p{N}_]+` runs cannot produce that. Every metacharacter is gone before a
 * quote is ever added, so the quoting is belt-and-braces rather than the defence. A string with
 * no word characters in it yields `null`, which callers turn into "no results" — never into
 * "no filter", which would show the user rows their query never asked for.
 *
 * ── One phrase per typed word, OR-ed between words ─────────────────────────────────────
 *
 * The unit is the **whitespace-separated word the user typed**, not the token. Each word
 * becomes one quoted phrase containing its word-runs in order, and the phrases are OR-ed.
 *
 *     S-4471            →  "S 4471"
 *     exosome plasma    →  "exosome" OR "plasma"
 *     col:value         →  "col value"
 *
 * Both halves of that matter, and getting either backwards is a bug users notice:
 *
 *   • **OR between words**, because that is what MongoDB's `$text` does with space-separated
 *     terms. FTS5 defaults to AND, so keeping the default would quietly return far fewer
 *     results than the Mongo path for the same query — reported as "search got worse after the
 *     migration" and never connected to the engine swap.
 *
 *   • **A phrase within a word**, because a research drive is full of identifiers like
 *     `S-4471`, `EXP-2026-014` and `RNA_seq_03`. Splitting those into OR-ed tokens makes a
 *     search for `S-4471` match every file whose sample id starts `S-`, which is not a search
 *     result, it is the whole drive. This was found by a test: the index held `S-2222`, a
 *     search for `S-1111` matched it on the shared `S`, and the assertion that a stale term
 *     stops matching failed for the right reason.
 *
 * ── The caps ────────────────────────────────────────────────────────────────────────────
 *
 * Denial-of-service bounds, not usability ones. `MATCH` cost scales with the number of OR
 * branches and with phrase length, and a pasted paragraph is not a search. Both limits are far
 * past any real query and far short of anything that hurts.
 */

/** Word-ish runs: letters, digits and underscore, Unicode-aware so non-ASCII names survive. */
const TOKEN = /[\p{L}\p{N}_]+/gu;

/** How many typed words become OR branches. */
export const MAX_FTS_TERMS = 32;

/** How many runs one word contributes to its phrase, for a pathological `a-b-c-…` input. */
export const MAX_TOKENS_PER_TERM = 16;

/**
 * A safe `MATCH` argument, or `null` when the input holds nothing searchable.
 *
 * `null` means "this query can match nothing", never "skip the text filter".
 */
export function toFtsQuery(text: string): string | null {
  const phrases: string[] = [];

  for (const word of text.split(/\s+/)) {
    if (phrases.length >= MAX_FTS_TERMS) break;
    const tokens = word.match(TOKEN);
    // A word made entirely of punctuation contributes nothing rather than an empty phrase,
    // which is the shape FTS5 is least predictable about.
    if (!tokens || tokens.length === 0) continue;
    phrases.push(`"${tokens.slice(0, MAX_TOKENS_PER_TERM).join(' ')}"`);
  }

  return phrases.length > 0 ? phrases.join(' OR ') : null;
}
