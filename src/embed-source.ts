/**
 * The exact string a memory's vector is embedded from. Tags are embedded with
 * the text so they widen the search surface. Store, update, the backfill and the
 * unsearchable count all compare against this one definition.
 */
export function embedSource(text: string, tags: string | null | undefined): string {
  return tags ? `${text} ${tags}` : text;
}
