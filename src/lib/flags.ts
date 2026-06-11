const countryCodes: { [key: string]: string } = {
  "Mexico": "mx",
  "South Africa": "za",
  "South Korea": "kr",
  "Czech Republic": "cz",
  "Canada": "ca",
  "Bosnia & Herzegovina": "ba",
  "Qatar": "qa",
  "Switzerland": "ch",
  "Brazil": "br",
  "Morocco": "ma",
  "Haiti": "ht",
  "Scotland": "gb-sct",
  "USA": "us",
  "Paraguay": "py",
  "Australia": "au",
  "Turkey": "tr",
  "Germany": "de",
  "Curaçao": "cw",
  "Ivory Coast": "ci",
  "Ecuador": "ec",
  "Netherlands": "nl",
  "Japan": "jp",
  "Sweden": "se",
  "Tunisia": "tn",
  "Belgium": "be",
  "Egypt": "eg",
  "Iran": "ir",
  "New Zealand": "nz",
  "Spain": "es",
  "Cape Verde": "cv",
  "Saudi Arabia": "sa",
  "Uruguay": "uy",
  "France": "fr",
  "Senegal": "sn",
  "Iraq": "iq",
  "Norway": "no",
  "Argentina": "ar",
  "Algeria": "dz",
  "Austria": "at",
  "Jordan": "jo",
  "Portugal": "pt",
  "DR Congo": "cd",
  "Uzbekistan": "uz",
  "Colombia": "co",
  "England": "gb-eng",
  "Croatia": "hr",
  "Ghana": "gh",
  "Panama": "pa"
};

/**
 * Retorna la URL de la bandera del país usando FlagCDN.
 * Si es un marcador de posición (ej. W74, 2A), retorna null.
 */
export function getFlagUrl(teamName: string): string | null {
  const code = countryCodes[teamName];
  if (!code) return null;
  return `https://flagcdn.com/w40/${code}.png`;
}
