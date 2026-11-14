import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { belugaHome } from '../../core/home.js';

/**
 * Semantic tool search's download (Settings › Experimental). Ratel (@ratel-ai/sdk) is not in Beluga's install:
 * turning the experiment on fetches the pinned packages below from npm (about 4 MB) and the bge-small embedding
 * model from Hugging Face (about 134 MB) into ~/.beluga/tool-search. Each package is checked against its npm sha512
 * and each model file against its sha256, both written here, before anything is unpacked or kept. Nothing runs npm
 * and no install script runs: a package is only unpacked with tar. What was unpacked is hashed into a list, and a
 * load checks it again, so a file changed on disk after the fetch refuses to load. Turning it off deletes the folder.
 */

export const SEMANTIC_VERSION = '0.12.0';

export interface Pin {
  readonly name: string;
  readonly version: string;
  /** npm's integrity of the tarball. */
  readonly integrity: string;
  /** The tarball's size in bytes: a bigger download stops there. */
  readonly size: number;
}

export interface ModelFile {
  /** Its path in the model's folder. */
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface ModelPin {
  /** The model's folder under models/. */
  readonly name: string;
  readonly url: (file: string) => string;
  readonly files: readonly ModelFile[];
}

/** How far the fetch is, in bytes. */
export interface FetchProgress {
  readonly done: number;
  readonly total: number;
}

export interface FetchOptions {
  readonly home?: string;
  readonly pins?: readonly Pin[];
  readonly model?: ModelPin;
  readonly fetchTo?: (url: string, to: string, max: number, onBytes: (bytes: number) => void) => Promise<void>;
  readonly onProgress?: (progress: FetchProgress) => void;
}

/** What Ratel's catalog loads (its dist/catalog.js, dist/embedding-artifact.js and what they import), and nothing more: no MCP client, no CLI. */
const COMMON: readonly Pin[] = [
  { name: '@ratel-ai/sdk', version: SEMANTIC_VERSION, integrity: 'sha512-7gapjM5oMpS5JEYstQMBltidT2eIDILHjLYQnkbvjVz9rdlRBh1uva5IyyBW/+6KEioiTBzgH5gIpQUsvkw03g==', size: 207_665 },
  { name: '@ratel-ai/telemetry', version: '0.5.0', integrity: 'sha512-eeUlzPAf/hxAaaRXfcTjDKO/z9L8yiioBbnBTaVWD08088EXsWI7MINPMx3HIAS2/njiKTlGKEqYD1G+J8wCKw==', size: 20_334 },
  { name: '@opentelemetry/api', version: '1.9.1', integrity: 'sha512-gLyJlPHPZYdAk1JENA9LeHejZe1Ti77/pTeFm/nMXmQH/HFZlcS/O2XJB+L8fkbrNSqhdtlvjBVjxwUYanNH5Q==', size: 116_186 },
  { name: '@opentelemetry/api-logs', version: '0.220.0', integrity: 'sha512-CmVa4ImJ+ynfrPMNaAXHET6Bhb44SwzmfyVJFq9ni2jgXJR/l7C6gfVFddNmHP+ZOkP9cf4f9DBe68qVLTHc9w==', size: 19_988 },
  { name: 'canonicalize', version: '4.0.0', integrity: 'sha512-FEdXzwWs+N3rZqEqpqleiY9M1A6IAf9oo1zHFABnLW9FcJ/jzsu+G/Ks3Hq3FglmPKe80GeGBw8ZXLEnwPB0vQ==', size: 6_205 },
];

/** Ratel's native addon, one per platform it builds for (no Linux musl, no Windows on Arm). */
const ADDONS: Readonly<Record<string, Pin>> = {
  'darwin-arm64': { name: '@ratel-ai/sdk-darwin-arm64', version: SEMANTIC_VERSION, integrity: 'sha512-j9v5qITeYXAFG8IG1idTmvS62gk1TrLZ4WfiqK/ATByHpv01mpnic2EU23c6+NokF7pz7IaTFHzkTGGdpJ0Eow==', size: 3_755_666 },
  'darwin-x64': { name: '@ratel-ai/sdk-darwin-x64', version: SEMANTIC_VERSION, integrity: 'sha512-Z4IEe95t3CZPeGEIfp368BIx64mQfZzou+ARk6S20BQJ47vh+vHmO+eUX8IH4fxyROprfCGDOcfA1YNufClmUA==', size: 4_035_916 },
  'linux-arm64-gnu': { name: '@ratel-ai/sdk-linux-arm64-gnu', version: SEMANTIC_VERSION, integrity: 'sha512-ZP9FXA2+ijfT4Vj7KpKRMzQiauNPDn/jtX3M0VLrv3vgkABax8kPjj7GzfvS0X9mbLZ1Uahgs4uWDyECWIww9Q==', size: 4_033_386 },
  'linux-x64-gnu': { name: '@ratel-ai/sdk-linux-x64-gnu', version: SEMANTIC_VERSION, integrity: 'sha512-TUwfHpE5kcwarDlwmqfY7ZKFvfYDBXPYDfJugxnfWcvYRMtFkSf/G3rjFogolJBiru4A5UmiMGBeRiVg9YZCmw==', size: 4_266_189 },
  'win32-x64': { name: '@ratel-ai/sdk-win32-x64-msvc', version: SEMANTIC_VERSION, integrity: 'sha512-PaBvt7aPCK/IfyejKDLKfKLYCc9kUNi/LcgQyuS1iq14TKGw/pdkZPB2gY2bJSBR/m0okSIqW6jwYvbGrK2aPg==', size: 4_227_360 },
};

const BGE_REVISION = '5c38ec7c405ec4b44b94cc5a9bb96e735b38267a';

/**
 * BAAI/bge-small-en-v1.5 at a fixed revision (BLG-358 spike): Ratel's default model, loaded from this folder so
 * nothing goes to the Hugging Face cache. Its query prefix gives the same scores as Ratel's own default.
 */
export const BGE_SMALL: ModelPin & { readonly id: string; readonly revision: string; readonly queryPrefix: string } = {
  id: 'BAAI/bge-small-en-v1.5',
  revision: BGE_REVISION,
  name: 'bge-small-en-v1.5',
  queryPrefix: 'Represent this sentence for searching relevant passages: ',
  url: (file) => `https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/${BGE_REVISION}/${file}`,
  files: [
    { path: 'config.json', size: 743, sha256: '094f8e891b932f2000c92cfc663bac4c62069f5d8af5b5278c4306aef3084750' },
    { path: 'tokenizer.json', size: 711_396, sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66' },
    { path: '1_Pooling/config.json', size: 190, sha256: 'd1caf60c96f5fba2157c0c26b76d80818fad6cf0b8eb5e73ec372ff9818eba5c' },
    { path: 'model.safetensors', size: 133_466_304, sha256: '3c9f31665447c8911517620762200d2245a2518d6e7208acc78cd9db317e21ad' },
  ],
};

const MANIFEST = 'files.json';
/** What never loads: types, source maps and docs (as scripts/build-sidecar.mjs strips them). Fewer files to check at each load. */
const NOT_LOADED = /\.(d\.[cm]?ts|[cm]?ts|map|md|markdown)$/i;
const READY = 'ready';

/** What a load gives: Ratel's catalog and its embedding-file builder, from the fetched copy only. */
export interface RatelModules {
  readonly ToolCatalog: new (options: object) => {
    register(tools: readonly object[]): Promise<void>;
    searchAsync(query: string, topK: number): Promise<ReadonlyArray<{ toolId: string }>>;
  };
  readonly experimentalBuildEmbeddingArtifact: (options: { output: string; embedding?: object; tools: readonly object[] }) => Promise<void>;
}

export const semanticDir = (home = belugaHome()): string => path.join(home, 'tool-search');
export const modelDir = (home = belugaHome(), model: Pick<ModelPin, 'name'> = BGE_SMALL): string => path.join(semanticDir(home), 'models', model.name);

/**
 * Fetches, checks and unpacks Ratel once into ~/.beluga/tool-search/<version>/node_modules (node finds each package
 * there by name), and the model into ~/.beluga/tool-search/models/<name>. Returns the version's folder. A mismatch
 * throws and keeps nothing. Other versions are removed.
 */
export async function fetchSemantic(opts: FetchOptions = {}): Promise<string> {
  const dir = semanticDir(opts.home);
  const root = path.join(dir, SEMANTIC_VERSION);
  const pins = opts.pins ?? pinsHere();
  const model = opts.model ?? BGE_SMALL;
  const models = path.join(dir, 'models', model.name);
  const fetchTo = opts.fetchTo ?? download;
  const total = pins.reduce((n, p) => n + p.size, 0) + model.files.reduce((n, f) => n + f.size, 0);
  let done = 0;
  const report = (): void => opts.onProgress?.({ done, total });
  // Each file moves the bar as its bytes come, and lands exactly on its size once checked.
  const fetchFile = async (url: string, to: string, size: number): Promise<void> => {
    const from = done;
    await fetchTo(url, to, size, (bytes) => {
      done = Math.min(from + size, done + bytes);
      report();
    });
    done = from;
  };
  const step = (bytes: number): void => {
    done += bytes;
    report();
  };
  if (!existsSync(path.join(root, READY))) {
    const part = `${root}.part`;
    await rm(part, { recursive: true, force: true });
    try {
      for (const pin of pins) {
        const into = path.join(part, 'node_modules', pin.name);
        mkdirSync(into, { recursive: true });
        const tgz = `${into}.tgz`;
        await fetchFile(tarballUrl(pin), tgz, pin.size);
        await notBigger(tgz, pin.size, pin.name);
        if ((await hashOf(tgz, 'sha512', 'base64')) !== pin.integrity.replace(/^sha512-/, '')) throw new Error(`${pin.name} ${pin.version} did not match the sha512 this Beluga expects`);
        // Unpacked only: npm never runs, so no install script does either.
        await promisify(execFile)('tar', ['-xzf', tgz, '-C', into, '--strip-components=1']);
        await rm(tgz, { force: true });
        step(pin.size);
      }
      await stripUnloaded(path.join(part, 'node_modules'));
      await writeFile(path.join(part, MANIFEST), JSON.stringify(await hashTree(path.join(part, 'node_modules'))));
      await writeFile(path.join(part, READY), `${SEMANTIC_VERSION}\n`);
      await rm(root, { recursive: true, force: true });
      await rename(part, root);
    } finally {
      await rm(part, { recursive: true, force: true });
    }
  } else step(pins.reduce((n, p) => n + p.size, 0));
  if (!existsSync(path.join(models, READY))) {
    const part = `${models}.part`;
    await rm(part, { recursive: true, force: true });
    mkdirSync(part, { recursive: true });
    try {
      for (const file of model.files) {
        const to = path.join(part, file.path);
        mkdirSync(path.dirname(to), { recursive: true });
        await fetchFile(model.url(file.path), to, file.size);
        await notBigger(to, file.size, file.path);
        if ((await hashOf(to, 'sha256', 'hex')) !== file.sha256) throw new Error(`${model.name} ${file.path} did not match the sha256 this Beluga expects`);
        step(file.size);
      }
      await writeFile(path.join(part, READY), `${model.files.map((f) => `${f.sha256}  ${f.path}`).join('\n')}\n`);
      await rm(models, { recursive: true, force: true });
      await rename(part, models);
    } finally {
      await rm(part, { recursive: true, force: true });
    }
  } else step(model.files.reduce((n, f) => n + f.size, 0));
  for (const old of readdirSync(dir)) if (old !== SEMANTIC_VERSION && old !== 'models' && !old.endsWith('.rat1')) await rm(path.join(dir, old), { recursive: true, force: true });
  return root;
}

/**
 * Before a load: every unpacked file is still what was checked at the fetch, and no file was added, and each model
 * file has its size. Throws when anything changed on disk.
 */
export async function checkSemantic(root: string, opts: Pick<FetchOptions, 'home' | 'model'> = {}): Promise<void> {
  const want = JSON.parse(await readFile(path.join(root, MANIFEST), 'utf8')) as Record<string, string>;
  const have = await hashTree(path.join(root, 'node_modules'));
  const changed = [...new Set([...Object.keys(want), ...Object.keys(have)])].filter((file) => want[file] !== have[file]);
  if (changed.length) throw new Error(`Semantic tool search's packages changed on disk (${changed.slice(0, 3).join(', ')}): turn it off and on to fetch them again`);
  const model = opts.model ?? BGE_SMALL;
  const models = path.join(semanticDir(opts.home), 'models', model.name);
  for (const file of model.files) {
    const size = await stat(path.join(models, file.path)).then((s) => s.size, () => -1);
    if (size !== file.size) throw new Error(`Semantic tool search's model changed on disk (${file.path}): turn it off and on to fetch it again`);
  }
}

/**
 * Fetches when needed, checks what is on disk, then loads dist/catalog.js and dist/embedding-artifact.js by their
 * path (not by package name, so nothing in Beluga's own install is involved).
 */
export async function loadSemantic(opts: FetchOptions = {}): Promise<RatelModules> {
  const root = await fetchSemantic(opts);
  await checkSemantic(root, opts);
  const dist = path.join(root, 'node_modules', '@ratel-ai', 'sdk', 'dist');
  const { ToolCatalog } = (await import(pathToFileURL(path.join(dist, 'catalog.js')).href)) as Pick<RatelModules, 'ToolCatalog'>;
  const { experimentalBuildEmbeddingArtifact } = (await import(pathToFileURL(path.join(dist, 'embedding-artifact.js')).href)) as Pick<RatelModules, 'experimentalBuildEmbeddingArtifact'>;
  return { ToolCatalog, experimentalBuildEmbeddingArtifact };
}

/** Turn off: the packages, the model and the embedding file go. */
export async function removeSemantic(home?: string): Promise<void> {
  await rm(semanticDir(home), { recursive: true, force: true });
}

/** The addon for this computer, or none where Ratel has no build. */
export function addonFor(platform: string = process.platform, arch: string = process.arch, glibc: boolean = linuxHasGlibc()): Pin | undefined {
  if (platform === 'linux') return glibc ? ADDONS[`linux-${arch}-gnu`] : undefined;
  return ADDONS[`${platform}-${arch}`];
}

/** The pins this computer needs: everything to load Ratel's catalog here. */
export function pinsHere(addon: Pin | undefined = addonFor()): readonly Pin[] {
  if (!addon) throw new Error(`Semantic tool search has no build for ${process.platform} ${process.arch}`);
  return [...COMMON, addon];
}

function linuxHasGlibc(): boolean {
  if (process.platform !== 'linux') return false;
  const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
  return Boolean(header?.glibcVersionRuntime);
}

const tarballUrl = (pin: Pin): string => `https://registry.npmjs.org/${pin.name}/-/${pin.name.split('/').pop()}-${pin.version}.tgz`;

/** Downloads to a 0600 file, and stops past `max` bytes: a pin's size is known. */
async function download(url: string, to: string, max: number, onBytes: (bytes: number) => void): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`could not download ${url} (${res.status})`);
  let seen = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _enc, next) {
      seen += chunk.length;
      onBytes(chunk.length);
      next(seen > max ? new Error(`${url} is bigger than this Beluga expects`) : null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as never), cap, createWriteStream(to, { mode: 0o600 }));
}

async function notBigger(file: string, max: number, what: string): Promise<void> {
  if ((await stat(file)).size > max) throw new Error(`${what} is bigger than this Beluga expects`);
}

async function hashOf(file: string, algorithm: 'sha512' | 'sha256', encoding: 'base64' | 'hex'): Promise<string> {
  const hash = createHash(algorithm);
  await pipeline(createReadStream(file), hash);
  return hash.digest(encoding);
}

async function stripUnloaded(dir: string): Promise<void> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await stripUnloaded(full);
    else if (NOT_LOADED.test(entry.name)) await rm(full, { force: true });
  }
}

/** sha256 of every file under a folder, by its path from there. The files are small (about 280, 10 MB): read whole. */
async function hashTree(top: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out[path.relative(top, full).split(path.sep).join('/')] = createHash('sha256').update(await readFile(full)).digest('hex');
    }
  };
  if (existsSync(top)) await walk(top);
  return out;
}
