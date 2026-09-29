export const LANGUAGES = [
  { code: 'ewondo', label: 'Ewondo' },
  { code: 'basaa', label: 'Basaa' },
  { code: 'ghomala', label: 'Ghomala de Bandjoun' },
];

export const LANGUAGE_CODES = LANGUAGES.map((l) => l.code);

export function isLanguage(value) {
  return LANGUAGE_CODES.includes(value);
}
