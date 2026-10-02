/** Never store secrets or financial identifiers in memory. Conservative on purpose. */
const SENSITIVE = /\b(password|passcode|pin|ssn|social security|credit card|card number|cvv|iban|routing number|account number|api[-_ ]?key|secret key|private key)\b/i;

export function isSensitiveMemory(s: string): boolean {
  return SENSITIVE.test(s) || /\d{12,19}/.test(s.replace(/[\s-]/g, ""));
}
