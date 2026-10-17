import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { type MessageSocket, fromStream } from '../src/net/transport.js';
import { waitFor } from './helpers.js';

let server: net.Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

/** A connected pair of framed sockets over loopback TCP (any duplex works the same). */
async function pair(maxBytes = 1024): Promise<{ a: MessageSocket; b: MessageSocket }> {
  const accepted = new Promise<net.Socket>((resolve) => {
    server = net.createServer(resolve);
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const port = (server?.address() as net.AddressInfo).port;
  const a = fromStream(net.connect(port, '127.0.0.1'), { maxBytes });
  await new Promise((resolve) => a.once('open', () => resolve(undefined)));
  const b = fromStream(await accepted, { maxBytes, open: true });
  return { a, b };
}

describe('framed stream transport', () => {
  it('delivers messages in order, including ones split across chunks', async () => {
    const { a, b } = await pair(100_000);
    const got: string[] = [];
    b.on('message', (m) => got.push(m));
    const big = 'é'.repeat(30_000);
    a.send('one');
    a.send(big);
    a.send('three');
    await waitFor(() => got.length === 3);
    expect(got).toEqual(['one', big, 'three']);
  });

  it('carries close codes to the other side', async () => {
    const { a, b } = await pair();
    const codes: number[] = [];
    a.on('close', (c) => codes.push(c));
    b.on('close', (c) => codes.push(c));
    b.close(4010, 'removed');
    await waitFor(() => codes.length === 2);
    expect(codes).toEqual([4010, 4010]);
    expect(a.isOpen).toBe(false);
    a.send('ignored after close');
  });

  it('answers pings and refuses oversized frames from the header alone', async () => {
    const { a, b } = await pair(10);
    let pongs = 0;
    a.on('pong', () => pongs++);
    a.ping();
    await waitFor(() => pongs === 1);
    const closed = new Promise<number>((resolve) => a.on('close', resolve));
    a.send('x'.repeat(11));
    expect(await closed).toBe(1009);
    expect(b.isOpen).toBe(false);
  });

  it('reports 1006 when the stream just drops', async () => {
    const { a, b } = await pair();
    const closed = new Promise<number>((resolve) => a.on('close', resolve));
    b.terminate();
    expect(await closed).toBe(1006);
  });
});
