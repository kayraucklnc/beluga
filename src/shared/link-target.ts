/** Where a link in the chat goes. `href` is a Markdown link target not resolved yet. */
export type LinkTarget =
  | { readonly kind: 'local'; readonly path: string; readonly dir: boolean; readonly line?: number }
  | { readonly kind: 'peer'; readonly owner: string; readonly share: string; readonly path: string; readonly line?: number }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'attachment'; readonly owner: string; readonly file: string; readonly label: string }
  | { readonly kind: 'href'; readonly href: string };
