/**
 * A person's name as the phone shows it. A Mac may only know its account's user name
 * ("kayrauckilinc"); that reads better capitalized ("Kayrauckilinc"). A real name is left alone.
 */
export function displayName(raw: string | undefined): string {
  const name = (raw ?? '').trim();
  if (!name) return '';
  if (/^[a-z][a-z0-9._-]*$/.test(name)) {
    const word = name.split(/[._-]/)[0]!;
    return word.charAt(0).toUpperCase() + word.slice(1);
  }
  return name;
}
