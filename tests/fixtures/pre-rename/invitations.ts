// parseTicket from src/net/mesh/invitations.ts on main at 2ab04f8, before the Klaud → Beluga rename:
// how an older Klaud reads a friend or group invitation. Never edit it; tests/rename-compat.test.ts uses it.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 12;

/** What someone typed or pasted: a link's secret or a code. */
export type Ticket = { readonly via: 'link'; readonly secret: string } | { readonly via: 'code'; readonly code: string };

/** A typed code, read loosely: any case, dashes or spaces anywhere, O for 0, I or L for 1. */
function readCode(typed: string): string | undefined {
  const compact = typed
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return compact.length === CODE_LENGTH && [...compact].every((c) => ALPHABET.includes(c)) ? compact : undefined;
}

/** Read an invitation out of pasted text ("klaud://add#…", "klaud://add?code=…", "K7QM-4XPA-R2TD", "k7qm 4xpa r2td"…). */
export function parseTicket(text: string): Ticket | undefined {
  const link = /klaud:\/\/(?:add|join)\/?#([\w-]{22})(?![\w-])/.exec(text);
  if (link) return { via: 'link', secret: link[1]! };
  const codeLink = /klaud:\/\/(?:add|join)\/?\?code=([0-9A-Za-z%+-]{12,40})/.exec(text);
  if (codeLink) {
    let raw = codeLink[1]!;
    try {
      raw = decodeURIComponent(raw.replace(/\+/g, ' '));
    } catch {
      return undefined;
    }
    const code = readCode(raw);
    return code ? { via: 'code', code } : undefined;
  }
  const code = readCode(text);
  return code ? { via: 'code', code } : undefined;
}
