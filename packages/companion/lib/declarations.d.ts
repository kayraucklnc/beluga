/** The worklet's bundle (bare-pack output; an empty module until `npm run worklet:bundle`). */
declare module '*.bundle.mjs' {
  const bundle: string | Uint8Array | undefined;
  export default bundle;
}
