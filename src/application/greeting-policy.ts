const GREETING = /^(cze[sś][cć]|hej|siema|dzie[nń] dobry|hello|hi|hey)[!.\s]*$/i;

export function isGreetingOnly(text: string): boolean {
  return GREETING.test(text.trim());
}

export const GREETING_REPLY = 'Tell me what to change, explain, or fix in this Overleaf document.';
