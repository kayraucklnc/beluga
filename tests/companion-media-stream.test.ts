import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { type FetchPiece, PieceCache, mediaPath, parseHead, parseRange, refOfPath, serveMediaSocket } from '../src/companion/media-stream.js';

/** A file on "the Mac", served the way FileServer.piece does: `piece` bytes from `off`. */
function mac(size: number, piece: number, mime = 'video/mp4') {
  const file = Buffer.alloc(size);
  for (let i = 0; i < size; i++) file[i] = i % 251;
  const asked: number[] = [];
  const fetch: FetchPiece = async (ref, off) => {
    if (ref !== 'out:clip') throw new Error('That file is no longer offered; pull to refresh');
    asked.push(off);
    return { bytes: file.subarray(off, off + piece), size, mime };
  };
  return { file, fetch, asked };
}

const servers: net.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function serve(cache: PieceCache, token = 'tok123'): Promise<string> {
  const server = net.createServer((socket) => serveMediaSocket(socket, { token, cache }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return `http://127.0.0.1:${port}/${token}`;
}

describe('ranges', () => {
  it('reads one byte range the way players ask', () => {
    expect(parseRange(undefined, 100)).toBeUndefined();
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=0-1, 5-6', 100)).toEqual({ start: 0, end: 1 });
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=20-10', 100)).toBe('unsatisfiable');
    expect(parseRange('items=0-1', 100)).toBeUndefined();
  });

  it('parses a request head and only takes this server’s token and real refs', () => {
    expect(parseHead('GET /a/b HTTP/1.1\r\nRange: bytes=0-\r\nHost: x')).toEqual({ method: 'GET', path: '/a/b', headers: { range: 'bytes=0-', host: 'x' } });
    expect(parseHead('nonsense')).toBeUndefined();
    expect(refOfPath(`/tok${mediaPath('out:abc_-1', 'clip.MOV')}`, 'tok')).toBe('out:abc_-1');
    expect(mediaPath('out:abc', 'Screen Recording.MOV')).toBe('/out%3Aabc/media.mov');
    expect(refOfPath('/other/out%3Aabc/media.mp4', 'tok')).toBeUndefined();
    expect(refOfPath('/tok/..%2F..%2Fetc/media.mp4', 'tok')).toBeUndefined();
    expect(refOfPath('/tok/%E0%A4%A/media.mp4', 'tok')).toBeUndefined();
  });
});

describe('the piece cache', () => {
  it('fetches a piece once, however many ask, and lets the oldest go past its size', async () => {
    const m = mac(1000, 100);
    const cache = new PieceCache(m.fetch, 250, 100);
    await Promise.all([cache.get('out:clip', 0), cache.get('out:clip', 0)]);
    expect(m.asked).toEqual([0]);
    await cache.get('out:clip', 1);
    await cache.get('out:clip', 2);
    // 300 bytes > 250: the least recently used (piece 0) went.
    expect(cache.has('out:clip', 0)).toBe(false);
    expect(cache.has('out:clip', 2)).toBe(true);
    expect(cache.size).toBeLessThanOrEqual(250);
  });

  it('fetches a failed piece again', async () => {
    let fail = true;
    const cache = new PieceCache(async (_ref, off) => {
      if (fail) throw new Error('away');
      return { bytes: new Uint8Array(10), size: 10, mime: 'video/mp4' };
    }, 1000, 10);
    await expect(cache.get('out:clip', 0)).rejects.toThrow('away');
    fail = false;
    await expect(cache.get('out:clip', 0)).resolves.toMatchObject({ size: 10 });
  });
});

describe('the loopback media server', () => {
  it('serves a byte range across pieces with 206, and only the pieces it needs', async () => {
    const m = mac(1000, 100);
    const base = await serve(new PieceCache(m.fetch, 10_000, 100));
    const res = await fetch(`${base}${mediaPath('out:clip', 'a.mov')}`, { headers: { Range: 'bytes=150-349' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 150-349/1000');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-type')).toBe('video/mp4');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(m.file.subarray(150, 350))).toBe(true);
    // Pieces 1–3 only (read ahead stops at the range's end), never the whole file.
    expect([...new Set(m.asked)].sort((a, b) => a - b)).toEqual([100, 200, 300]);
  });

  it('serves the whole file with 200, a range from the end, and HEAD', async () => {
    const m = mac(450, 100, 'video/quicktime');
    const base = await serve(new PieceCache(m.fetch, 10_000, 100));
    const url = `${base}${mediaPath('out:clip', 'a.mov')}`;
    const all = await fetch(url);
    expect(all.status).toBe(200);
    expect(all.headers.get('content-length')).toBe('450');
    expect(Buffer.from(await all.arrayBuffer()).equals(m.file)).toBe(true);
    const tail = await fetch(url, { headers: { Range: 'bytes=-50' } });
    expect(tail.status).toBe(206);
    expect(Buffer.from(await tail.arrayBuffer()).equals(m.file.subarray(400))).toBe(true);
    const h = await fetch(url, { method: 'HEAD' });
    expect(h.status).toBe(200);
    expect(h.headers.get('content-type')).toBe('video/quicktime');
  });

  it('says 416 past the end, 404 without the token, 502 when the Mac refuses', async () => {
    const m = mac(100, 100);
    const base = await serve(new PieceCache(m.fetch, 10_000, 100));
    expect((await fetch(`${base}${mediaPath('out:clip', 'a.mp4')}`, { headers: { Range: 'bytes=500-' } })).status).toBe(416);
    expect((await fetch(`${base.replace('tok123', 'nope00')}${mediaPath('out:clip', 'a.mp4')}`)).status).toBe(404);
    const refused = await fetch(`${base}${mediaPath('out:gone', 'a.mp4')}`);
    expect(refused.status).toBe(502);
    expect(await refused.text()).toContain('no longer offered');
  });

  it('fetches no faster than the player reads, and stops when it hangs up (never the whole file)', async () => {
    const P = 64 * 1024;
    const m = mac(P * 200, P);
    const base = await serve(new PieceCache(m.fetch, 64 * 1024 * 1024, P));
    const u = new URL(`${base}${mediaPath('out:clip', 'a.mp4')}`);
    const s = net.connect(Number(u.port), '127.0.0.1', () => s.write(`GET ${u.pathname} HTTP/1.1\r\nHost: x\r\nRange: bytes=0-\r\n\r\n`));
    // The player's buffer is full: it stops reading.
    await new Promise<void>((resolve) => s.once('data', () => (s.pause(), resolve())));
    await new Promise((r) => setTimeout(r, 300));
    const paused = new Set(m.asked).size;
    // What fits in the sockets' buffers and the read ahead, not 200 pieces.
    expect(paused).toBeLessThan(80);
    s.destroy();
    await new Promise((r) => setTimeout(r, 100));
    expect(new Set(m.asked).size).toBeLessThanOrEqual(paused + 3);
  });
});
