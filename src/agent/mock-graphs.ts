import { GRAPH_FENCE } from '../shared/graph-spec.js';

/**
 * The demo's graph (`klaud demo`, README recordings, screenshots): how a payment goes through
 * the demo project's small API, with the two risky spots marked and a walkthrough.
 */
export const PAYMENT_FLOW = {
  title: 'How a payment goes through',
  summary: 'From the checkout button to a paid order: the API, Stripe and the webhook',
  direction: 'right',
  nodes: [
    { id: 'customer', type: 'actor', label: 'Customer', sublabel: 'on the checkout page' },
    { id: 'web', type: 'client', label: 'Web app', sublabel: 'content/checkout', tag: 'React' },
    { id: 'api', type: 'group', label: 'API', sublabel: 'src/server.ts' },
    {
      id: 'server',
      type: 'service',
      label: 'Express server',
      sublabel: 'routes /api/*',
      group: 'api',
      status: 'done',
      details: 'Every request comes in here. `/api/payments/*` is meant to sit behind `requireUser()`.',
      links: [{ label: 'src/server.ts', href: 'src/server.ts' }],
    },
    {
      id: 'auth',
      type: 'function',
      label: 'requireUser()',
      sublabel: 'checks the session cookie',
      group: 'api',
      status: 'todo',
      emphasis: true,
      details: '**Not wired in yet.** `src/server.ts` still has `// TODO: add auth`, so anyone can call the payment routes.\n\n- read the `session` cookie\n- 401 when it is missing or expired',
      links: [{ label: 'src/auth.ts', href: 'src/auth.ts' }],
    },
    { id: 'payments', type: 'service', label: 'Payments', sublabel: 'createIntent(), refunds', group: 'api', status: 'done', links: [{ label: 'src/payments.ts', href: 'src/payments.ts' }] },
    {
      id: 'webhooks',
      type: 'function',
      label: 'Webhook handler',
      sublabel: 'src/webhooks.ts',
      status: 'blocked',
      emphasis: true,
      details: 'Stripe retries a webhook until it gets a 2xx. `handle()` isn’t **idempotent**, so a retry can mark an order paid twice and send two receipts.\n\nFix: remember each `event.id` and skip ones already seen.',
      links: [{ label: 'src/webhooks.ts', href: 'src/webhooks.ts' }],
    },
    { id: 'stripe', type: 'external', label: 'Stripe', sublabel: 'PaymentIntents API', tag: 'API' },
    {
      id: 'db',
      type: 'database',
      label: 'orders',
      sublabel: 'Postgres',
      fields: [
        { name: 'id', type: 'uuid', key: 'pk' },
        { name: 'user_id', type: 'uuid', key: 'fk' },
        { name: 'amount_cents', type: 'int' },
        { name: 'status', type: 'text', note: 'pending → paid → refunded' },
        { name: 'stripe_intent', type: 'text' },
      ],
    },
    { id: 'retries', type: 'queue', label: 'Retry queue', sublabel: '5 attempts, backoff' },
  ],
  edges: [
    { from: 'customer', to: 'web', label: 'Pay', kind: 'flow' },
    { from: 'web', to: 'server', label: 'POST /api/payments', kind: 'call' },
    { from: 'server', to: 'auth', label: 'session?', kind: 'call', emphasis: true },
    { from: 'server', to: 'payments', label: 'createIntent()', kind: 'call' },
    { from: 'payments', to: 'stripe', label: 'create intent', kind: 'call' },
    { from: 'payments', to: 'db', label: 'INSERT pending', kind: 'data' },
    { from: 'stripe', to: 'webhooks', label: 'payment_intent.succeeded', kind: 'async' },
    { from: 'webhooks', to: 'db', label: 'UPDATE paid', kind: 'data' },
    { from: 'webhooks', to: 'retries', label: 'on failure', kind: 'async' },
  ],
  steps: [
    { title: 'The customer pays', text: 'The checkout page posts the cart to the API.', focus: ['customer', 'web', 'server'] },
    { title: 'Who is asking?', text: 'requireUser() should check the session first. It’s written but not wired in, so this step is skipped today.', focus: ['server', 'auth'] },
    { title: 'Payments asks Stripe', text: 'A PaymentIntent is created and the order is saved as pending.', focus: ['payments', 'stripe', 'db'] },
    { title: 'Stripe calls back', text: 'When the card goes through, Stripe sends a webhook and the order is marked paid.', focus: ['stripe', 'webhooks', 'db'] },
    { title: 'When it fails', text: 'Failures go to the retry queue. Retries aren’t idempotent yet: the one fix to make before launch.', focus: ['webhooks', 'retries'] },
  ],
};

export const MOCK_GRAPH_ANSWER = [
  'Here’s how a payment goes through the API. Two spots need work before launch: `requireUser()` isn’t wired in, and webhook retries can double-charge.',
  '',
  '```' + GRAPH_FENCE,
  JSON.stringify(PAYMENT_FLOW, null, 1),
  '```',
].join('\n');
