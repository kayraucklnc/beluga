/**
 * Sign In on a failed card (BLG-589): the choices Claude Code's own /login offers. A Claude
 * subscription or an Anthropic Console account sign in in a shell (`claude auth login --claudeai`
 * or `--console`); a 3rd-party platform is set up with its own variables, so it opens that
 * platform's page in Claude Code's docs.
 */

export type SignInHow = 'claudeai' | 'console';

/** A row of the menu (an ActionItem of components/SpecMenu; kept apart so this file stays plain TypeScript). */
interface Choice {
  readonly label: string;
  readonly hint?: string;
  readonly separate?: boolean;
  readonly submenu?: readonly Choice[];
  readonly onSelect: () => void;
}

/** Claude Code's setup page for each platform it runs on. */
export const PLATFORM_DOCS: readonly { readonly label: string; readonly url: string }[] = [
  { label: 'Amazon Bedrock', url: 'https://code.claude.com/docs/en/amazon-bedrock' },
  { label: 'Microsoft Foundry', url: 'https://code.claude.com/docs/en/microsoft-foundry' },
  { label: 'Google Vertex AI', url: 'https://code.claude.com/docs/en/google-vertex-ai' },
];

export function signInChoices(signIn: (how: SignInHow) => void, open: (url: string) => void): Choice[] {
  return [
    { label: 'Claude account with subscription', hint: 'Pro, Max, Team, Enterprise', onSelect: () => signIn('claudeai') },
    { label: 'Anthropic Console account', hint: 'API usage billing', onSelect: () => signIn('console') },
    {
      label: '3rd-party platform',
      separate: true,
      hint: 'Amazon Bedrock, Microsoft Foundry, Google Vertex AI',
      onSelect: () => undefined,
      submenu: PLATFORM_DOCS.map((p) => ({ label: p.label, onSelect: () => open(p.url) })),
    },
  ];
}
