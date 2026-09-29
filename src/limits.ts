/**
 * Upper bounds on tool arguments. A single call must not be able to plant a
 * multi-megabyte memory that is replayed into context on every match.
 * Set well above observed real use (longest memory ~2.6k chars, 18 tags).
 */
export const LIMITS = {
  text: 8_000,
  content: 512 * 1024, // bytes of UTF-8 (also caps characters)
  tag: 64,
  tags: 32,
  id: 64,
  ids: 32,
  project: 512,
  path: 4_096,
  topK: 50,
} as const;
