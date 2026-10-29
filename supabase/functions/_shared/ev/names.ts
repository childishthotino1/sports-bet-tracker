// Matching team and player names written different ways ("Packers",
// "Green Bay Packers", "J. Jacobs"). Shared by slip pricing and the SGP rules.

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
export const lastWord = (s: string) => norm(s).split(" ").pop() ?? "";

// "Packers", "Green Bay Packers" and "GB Packers" all name the Green Bay Packers.
export function sameTeam(a: string, b: string): boolean {
  const x = norm(a), y = norm(b);
  return x === y || x.includes(y) || y.includes(x) || (lastWord(x).length > 2 && lastWord(x) === lastWord(y));
}

// "Josh Jacobs" vs "J. Jacobs" vs "Josh Jacobs Jr.": same last name and first initial.
export function samePerson(a: string, b: string): boolean {
  const x = norm(a).replace(/ (jr|sr|ii|iii|iv)$/, "").split(" "), y = norm(b).replace(/ (jr|sr|ii|iii|iv)$/, "").split(" ");
  return x[x.length - 1] === y[y.length - 1] && x[0][0] === y[0][0];
}
