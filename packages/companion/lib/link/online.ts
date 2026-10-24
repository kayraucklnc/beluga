/**
 * Is this phone online at all? Asked only after the Mac couldn't be reached, so an explanation never
 * blames the Mac (or the network) for a phone with no internet. Two small, well-known endpoints at
 * once; any answer (even an error status) means online. No polling: one look, when it matters.
 */
const PROBES = ['https://www.cloudflare.com/cdn-cgi/trace', 'https://connectivitycheck.gstatic.com/generate_204'];

export async function checkOnline(timeoutMs = 4_000): Promise<boolean> {
  const one = async (url: string): Promise<boolean> => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      await fetch(url, { method: 'HEAD', signal: ctl.signal, cache: 'no-store' });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(t);
    }
  };
  const answers = await Promise.all(PROBES.map(one));
  return answers.some(Boolean);
}
