import { describe, expect, it } from 'vitest';
import { documentLook, kindWords } from '../src/core/sentinel/columns.js';
import { brief, setup } from './sentinel-fakes.js';

/** A kept table's documents in Beluga's viewer (BLG-381): storage objects fetched for it, and what each kind is. */

const ENV = { SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key' };

function withStorage(objects: Readonly<Record<string, { readonly body: Uint8Array<ArrayBuffer> | string; readonly type?: string; readonly status?: number }>>) {
  const asked: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push(`${init?.method ?? 'GET'} ${url}`);
    const sign = /\/storage\/v1\/object\/sign\/([^?]+)$/.exec(url);
    if (sign && init?.method === 'POST') return new Response(JSON.stringify({ signedURL: `/object/sign/${sign[1]}?token=t` }), { status: 200 });
    const got = Object.entries(objects).find(([key]) => url.includes(`/object/sign/${key}?token=t`))?.[1];
    if (!got) return new Response('missing', { status: 404 });
    return new Response(got.body, { status: got.status ?? 200, headers: got.type ? { 'content-type': got.type } : {} });
  }) as typeof fetch;
  const s = setup({ fetch: fetchFn, envFor: () => ENV });
  const sn = s.sentinels.create(brief);
  const run = s.sentinels.addHistory(sn.id, { by: 'schedule', trigger: { kind: 'schedule', summary: 'On its schedule' }, state: 'done', startedAt: Date.now() - 1000, endedAt: Date.now(), headline: 'Kept files', steps: [], tasks: [] }, { outputs: [] });
  s.sentinels.demoKeep(sn.id, run.id, [
    {
      name: 'files',
      label: 'Files',
      better: 'none',
      columns: ['file'],
      columnTypes: [{ key: 'file', type: 'storage', bucket: 'docs', path: 'path' }],
      rows: [{ file: 'docs/a/report.md' }, { file: 'docs/a/build.zip' }, { file: 'docs/a/blob' }],
    },
  ]);
  return { ...s, sn, asked };
}

describe('documents in the viewer', () => {
  it('fetches a storage object through a link signed for a minute, as a kept document reads', async () => {
    const s = withStorage({ 'docs/a/report.md': { body: '# Report\n\nAll good.', type: 'text/markdown; charset=utf-8' }, 'docs/a/build.zip': { body: new Uint8Array([80, 75, 5, 6]) }, 'docs/a/blob': { body: new Uint8Array([1, 2, 3]), type: 'image/png' } });
    const md = await s.sentinels.storageDocument(s.sn.id, 'files', 'file', 'docs/a/report.md');
    expect(md).toMatchObject({ name: 'report.md', mime: 'text/markdown', size: 19, text: '# Report\n\nAll good.', bucket: 'docs', path: 'a/report.md' });
    expect(s.asked).toEqual(['POST https://abc.supabase.co/storage/v1/object/sign/docs/a/report.md', 'GET https://abc.supabase.co/storage/v1/object/sign/docs/a/report.md?token=t']);
    // Bytes as base64; Storage's own type when the name says nothing.
    expect(await s.sentinels.storageDocument(s.sn.id, 'files', 'file', 'docs/a/build.zip')).toMatchObject({ name: 'build.zip', mime: 'application/zip', base64: 'UEsFBg==' });
    expect(await s.sentinels.storageDocument(s.sn.id, 'files', 'file', 'docs/a/blob')).toMatchObject({ mime: 'image/png', size: 3 });
    // Only a cell its latest rows hold, and only of a storage column.
    await expect(s.sentinels.storageDocument(s.sn.id, 'files', 'file', 'docs/other.md')).rejects.toThrow(/has no file/);
    // Saving a copy to open needs a run folder (none in memory): it says so.
    await expect(s.sentinels.storagePath(s.sn.id, 'files', 'file', 'docs/a/build.zip')).rejects.toThrow(/Couldn’t save build.zip/);
  });

  it('says when Storage refuses the object', async () => {
    const s = withStorage({ 'docs/a/report.md': { body: 'nope', status: 403 } });
    await expect(s.sentinels.storageDocument(s.sn.id, 'files', 'file', 'docs/a/report.md')).rejects.toThrow('Supabase Storage answered 403 for report.md');
  });

  it('knows how to show each kind, and says what the others are', () => {
    expect(['text/html', 'text/markdown', 'application/json', 'text/csv', 'image/svg+xml', 'application/pdf', 'video/mp4', 'audio/mpeg', 'application/zip'].map(documentLook)).toEqual(['html', 'markdown', 'json', 'text', 'image', 'pdf', 'video', 'audio', 'other']);
    expect(kindWords('build.zip', 'application/zip')).toBe('ZIP archive');
    expect(kindWords('a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('Word document');
    expect(kindWords('shot.png', 'image/png')).toBe('PNG image');
    expect(kindWords('Beluga.dmg', 'application/octet-stream')).toBe('DMG file');
    expect(kindWords('blob', 'application/octet-stream')).toBe('File');
  });
});
