# Transcend erasure integration (experimental)

This adapter connects one Transcend server-webhook integration to the package's
durable **ERASURE** operation. ACCESS, preferences, identity enrichment, and manual
vendor workflows are deliberately rejected. This is an independently implemented
adapter, not a Transcend partnership, certification, or confirmation that other
systems have erased their data.

## Supported contract and validation evidence

The contract was checked against the official documentation on 2026-10-11:

- [New DSR job](https://docs.transcend.io/docs/api-reference/webhook/new-privacy-request-job):
  inbound webhook fields, `x-sombra-token`, and reusable `x-transcend-nonce`.
- [Verify Webhook Signature](https://docs.transcend.io/docs/articles/dsr-automation/api-integration/receiving-a-webhook-from-transcend):
  ES384 public-key verification and `coreIdentifier` scope.
- [Official TypeScript verification example](https://github.com/transcend-io/examples/blob/fe2a4d8cbb12ad9dd1752e5ecf8fd8d5a05f7a52/typescript/src/helpers/verifyWebhook.ts):
  exact configured Sombra audience checking.
- [Respond to an erasure request](https://docs.transcend.io/docs/api-reference/PUT/v1/data-silo):
  `PUT /v1/data-silo`, `{}` for the profile in the nonce on current Sombra,
  HTTP 200 acceptance, and non-retryable HTTP 409.
- [Server custom-header support](https://docs.transcend.io/docs/changelog/2019-11-21T19%3A34%3A31.609Z):
  configuring an additional authentication header for this integration.

Use Transcend-hosted multi-tenant Sombra or Sombra **7.199.0 or later**. Older
gateways requiring the deprecated `profiles` callback field are unsupported.
Synthetic fixtures exercise ES384 verification, malformed input, replay,
concurrent submissions, tenant mapping, restart/checkpoint recovery, local
artifact failure, callback failure, and response classification. A localhost
HTTP server verifies the outgoing method, path, header, and body. No live
Transcend account, customer webhook, or vendor-side erasure was tested.

## Configure the trusted boundary

Create a dedicated Transcend server integration with ERASURE enabled. Configure
its webhook URL on your HTTPS server and add
`x-data-subject-webhook-secret` with a random secret of at least 32 bytes. Use a
different secret per binding and never expose it to a browser. Pin the Sombra
public key obtained through the authenticated operator configuration; the adapter
never follows key URLs or callback URLs supplied by an incoming webhook. Up to
five P-384 public keys can be configured for an overlapping rotation.

The Sombra JWT is a signed **bearer token**, not a signature of the raw HTTP body.
This implementation checks ES384, the exact audience, and scope; it checks `exp`,
`nbf`, and `iat` when present, matching the public JWT contract. The public
contract does not require those time claims, so their absence is not rejected.
TLS and the additional operator-configured secret protect this bearer channel.
Job idempotency prevents repeated execution of the same provider identity; it is
not a claim that a stolen bearer credential cannot submit a different request.

Organization and data-silo identifiers select a preconfigured binding. The
binding owns the local tenant, expected identifier type, and data-subject type.
`resolveSubject` must map that identifier inside that tenant and must not trust
tenant or subject IDs supplied in webhook fields. Unknown subjects fail closed;
the host can investigate them without claiming that a deletion took place.
Test webhooks are rejected by default; use a separate synthetic-data binding
with `allowTestRequests: true` for them.

## Connect to the durable queue

Apply the P1 and P2 migrations and construct `PostgresJobStore` and the P1 durable
`DataSubjectService` as described in their migration documentation. The service
must use `PrismaExecutionStore` and transaction-bound executors. Its request key
is derived by this adapter; the queue alone does not provide data-execution
idempotency.

```ts
import {
  TranscendErasureAdapter,
  TRANSCEND_ERASURE_JOB,
} from '@nestarc/data-subject';

const adapter = new TranscendErasureAdapter({
  jobs,
  service,
  // Load a stable, separately managed 32-byte key. Never generate it per worker.
  nonceEncryptionKey,
  bindings: [{
    id: 'production-eu',
    organizationId: configuredOrganizationId,
    dataSiloId: configuredDataSiloId,
    tenantId: 'tenant-from-server-configuration',
    audience: configuredSombraAudience,
    publicKeys: [configuredSombraPublicKeyPem],
    webhookSecret,
    sombraOrigin: 'https://your-configured-sombra-origin.example',
    apiKey: integrationScopedTranscendApiKey,
    // sombraApiKey: selfHostedSombraApiKey,
    identifierType: 'email',
    dataSubjectType: 'customer',
    resolveSubject: async (identifier) => {
      const user = await prisma.user.findFirst({
        where: { tenantId: 'tenant-from-server-configuration', email: identifier },
        select: { id: true },
      });
      return user?.id ?? null;
    },
  }],
});

// In an HTTPS route with a raw-body limit of 64 KiB:
await adapter.receive({ body: rawBodyBuffer, headers: requestHeaders });
// Only now acknowledge HTTP 200. Do not report deletion as complete here.

// In a controlled worker; one call executes one phase, not a permanent loop:
await jobs.runNext(adapter.processStep.bind(adapter), {
  kind: TRANSCEND_ERASURE_JOB,
});
```

The receiver persists one immutable job before acknowledgment. Its identity
includes the binding, organization, data silo, request, profile, and
request-data-silo IDs. A changed subject for that identity is rejected. Repeated
receipts reuse the original mapped subject and nonce, even after erasure removes
the subject mapping. The provider's nonce is reusable; a refreshed nonce on an
otherwise identical replay does not replace the original one.

The reusable nonce is AES-256-GCM encrypted before persistence. Its authenticated
data binds every execution-affecting job field. API keys, webhook secrets, JWTs,
raw webhook bodies, and plaintext nonces are never stored in the queue. The
internal subject ID remains in the database job payload; configure database
encryption at rest and restrict administrative queue access. The same encryption key also derives a
separate checkpoint authentication key, binding the local request ID to its job.
Keep the encryption key consistent across workers and restarts. Drain or retain
access to old jobs before replacing that key. Queue retention cleanup must run
to remove expired payloads, encrypted nonces, and checkpoints; expired jobs must
not be resubmitted under new identities to bypass retention or cancellation.

## Completion and retry semantics

The first worker phase persists an authenticated execution marker without calling
the local service. The second calls the P1 durable local erasure. The third
reports its committed completion to Transcend. Each phase persists a checkpoint.
Inspect `job.result`, not just `job.state`: `completed` means the queue handler
reached a terminal outcome, including an external rejection.

| Result | Meaning | Next action |
| --- | --- | --- |
| `localStatus: completed`, `providerStatus: pending` | Local data and evidence completed; provider callback pending | Run the next queue phase |
| `localStatus: completed`, `providerStatus: accepted` | This integration's callback received HTTP 200 | Stop retrying; no claim about other data systems |
| `localStatus: completed`, `providerStatus: rejected` | Provider returned a terminal response, including 409 | Reconcile provider state manually; do not assume success |
| `localStatus: failed`, `providerStatus: unreported` | Local request failed or cannot safely finish | Investigate the local request before making any provider claim |
| `localStatus: unknown`, `providerStatus: unreported` | Execution is authorized or a local commit outcome needs reconciliation | Resume its original durable key or recorded local request ID |

Network failures, timeouts, HTTP 408/429, and 5xx throw a sanitized retryable error.
The queue keeps the callback checkpoint and applies its bounded retry policy.
Use an appropriately conservative queue backoff/rate limit; this initial adapter
does not consume `Retry-After` headers. Other non-200 responses are terminal
rejections. A lost successful callback response can later produce 409: the
adapter records that ambiguity instead of inventing acceptance. Callback delivery
is at least once, not exactly once.

The callback URL is always the configured HTTPS origin plus `/v1/data-silo`.
Redirects are rejected and the default transport aborts after ten seconds
(configurable up to thirty). Request links, completion links, URLs, and extra
headers from the webhook are never forwarded. A custom `http` transport is a
trusted dependency and must honor the supplied abort signal and redirect rule.

The P1 service transaction is independent of the queue checkpoint transaction.
A worker crash after local commit but before checkpoint commit can repeat the
local **durable request key**, which reconciles the existing request instead of
repeating entity mutations. Do not bind P1 business executors to the outer queue
transaction. Keep queue transaction limits above the bounded P1 execution and
callback timeout, and give the connection pool enough capacity for the nested
independent service transaction. This adapter runs the existing atomic P1 path;
it does not turn an arbitrarily large erasure into resumable batches.

Cancelling after local completion only stops the pending provider callback; it
does not restore erased data. The initial execution marker conservatively sets
`hasCommittedChanges: true` **before** the local call can run. Thus cancellation
can report `partial: true` even when local execution has not started. This means
changes are possible and the original local key must be reconciled, not that
erasure is proven. This marker also survives a local commit followed by rollback
of its queue checkpoint. An indeterminate local commit remains explicitly
unknown until the original local request is reconciled.
A reservation failure marked `not_started` retains the execution marker and
uses the queue's bounded backoff to retry the original key: its candidate local
request ID may never have been inserted. Errors after a successful reservation
use the known local request ID; a missing persisted request then requires
investigation rather than silently creating a new deletion.
Never delete or edit a queued job to manufacture a new erasure attempt. Use queue
retry from the committed checkpoint after fixing a transient failure, or reconcile
a terminal local/provider rejection explicitly.

## Reproduce the fixture checks

```sh
npx jest test/integration/platform-transcend.test.ts --runInBand
DATA_SUBJECT_HTTP_FIXTURE=1 npx jest test/integration/platform-transcend.test.ts --runInBand
```

The second command additionally requires permission to bind an ephemeral
127.0.0.1 port. It only contacts its own fixture server. Before production use,
validate actual account keys, audience, identifier mappings, callback behavior,
and retention against the customer's synthetic Transcend integration.
