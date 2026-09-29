// Workbook category order. Categories with no words are kept here for
// completeness but never shown (the UI only lists categories that have words).
export const CATEGORIES = [
  { name: 'Salutations', range: ['ASD-0262', 'ASD-0354'] },
  { name: 'Prendre des nouvelles', range: ['ASD-0253', 'ASD-0261'] },
  { name: 'Couleurs', range: ['ASD-0038', 'ASD-0088'] },
  { name: 'Nombres', range: ['ASD-0223', 'ASD-0242'] },
  { name: 'Famille', range: ['ASD-0089', 'ASD-0221'] },
  { name: 'Corps', range: ['ASD-0008', 'ASD-0037'] },
  { name: 'Vêtements', range: null },
  { name: 'Nourriture et boissons', range: ['ASD-0243', 'ASD-0252'] },
  { name: 'Maison', range: ['ASD-0222', 'ASD-0222'] },
  { name: 'Extérieur', range: null },
  { name: 'Animaux', range: ['ASD-0001', 'ASD-0007'] },
  { name: 'École', range: ['ASD-0355', 'ASD-0363'] },
];

/** 1-based order of a known category, or null. */
export function knownCategoryOrder(name) {
  const i = CATEGORIES.findIndex((c) => c.name === name);
  return i === -1 ? null : i + 1;
}

/** Category name from the ID ranges, or null when the id is outside every range. */
export function categoryFromId(id) {
  for (const c of CATEGORIES) {
    if (c.range && id >= c.range[0] && id <= c.range[1]) return c.name;
  }
  return null;
}

/**
 * Assigns category_order and position to words.
 * Unknown categories are appended after the known ones, in order of first appearance.
 */
export function orderWords(words) {
  const extra = [];
  for (const w of words) {
    if (knownCategoryOrder(w.category) === null && !extra.includes(w.category)) extra.push(w.category);
  }
  const orderOf = (name) => knownCategoryOrder(name) ?? CATEGORIES.length + 1 + extra.indexOf(name);
  const sorted = words
    .map((w) => ({ ...w, category_order: orderOf(w.category) }))
    .sort((a, b) => a.category_order - b.category_order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  sorted.forEach((w, i) => { w.position = i + 1; });
  return sorted;
}
