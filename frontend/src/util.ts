/** Turn a title into a URL/file-safe slug: "Counter-Strike 2" → "counter-strike-2". */
export const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
