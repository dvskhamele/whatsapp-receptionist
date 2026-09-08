import { beforeEach, describe, expect, it } from 'vitest';

import { AppError } from '@/lib/errors/app-error';
import { encryptSecret } from '@/server/integrations/credential-encryption';
import {
  TenantWhatsAppCredentialsResolver,
  TenantWhatsAppMessageSenderResolver,
  type WhatsAppCredentialsStore,
} from '@/server/whatsapp/client';
import { WhatsAppOutboxWorker } from '@/server/whatsapp/outbox';
import type {
  ClaimedWhatsAppOutboxJob,
  WhatsAppOutboxRepository,
} from '@/server/whatsapp/outbox-repository';

const ENCRYPTION_KEY = 'test-secret-with-at-least-32-characters';
const GRAPH_API_VERSION = 'v23.0';
const now = new Date('2026-04-25T08:00:00.000Z');

describe('Meta WhatsApp tenant credentials', () => {
  beforeEach(() => {
    process.env.INTEGRATION_CREDENTIALS_ENCRYPTION_KEY = ENCRYPTION_KEY;
  });

  it('sends each outbox job with its tenant access token and phone number ID', async () => {
    const store = new FakeCredentialsStore({
      tenant_a: 'token_tenant_a',
      tenant_b: 'token_tenant_b',
    });
    const provider = new RecordingWhatsAppProvider();
    const repository = new FakeOutboxRepository([
      outboxJob({ id: 'job_a', tenantId: 'tenant_a', recipientIdentifier: '393330000001' }),
      outboxJob({ id: 'job_b', tenantId: 'tenant_b', recipientIdentifier: '393330000002' }),
    ]);
    const worker = new WhatsAppOutboxWorker(repository, senderResolver(store, provider));

    const result = await worker.processReadyJobs({ now });

    expect(result.sentJobs).toBe(2);
    expect(provider.requests).toEqual([
      {
        authorization: 'Bearer token_tenant_a',
        url: 'https://graph.facebook.com/v23.0/phone_tenant_a/messages',
      },
      {
        authorization: 'Bearer token_tenant_b',
        url: 'https://graph.facebook.com/v23.0/phone_tenant_b/messages',
      },
    ]);
    expect(store.tenantIds).toEqual(['tenant_a', 'tenant_b']);
  });

  it('caches credentials for subsequent jobs of the same tenant', async () => {
    const store = new FakeCredentialsStore({ tenant_a: 'token_tenant_a' });
    const provider = new RecordingWhatsAppProvider();
    const repository = new FakeOutboxRepository([
      outboxJob({ id: 'job_1', tenantId: 'tenant_a' }),
      outboxJob({ id: 'job_2', tenantId: 'tenant_a' }),
    ]);

    await new WhatsAppOutboxWorker(repository, senderResolver(store, provider)).processReadyJobs({
      now,
    });

    expect(store.tenantIds).toEqual(['tenant_a']);
  });

  it('rejects a tenant without a complete Meta integration', async () => {
    const resolver = new TenantWhatsAppCredentialsResolver(new FakeCredentialsStore({}));

    await expect(resolver.resolve('tenant_missing')).rejects.toBeInstanceOf(AppError);
  });
});

function senderResolver(
  store: WhatsAppCredentialsStore,
  provider: RecordingWhatsAppProvider,
): TenantWhatsAppMessageSenderResolver {
  return new TenantWhatsAppMessageSenderResolver(new TenantWhatsAppCredentialsResolver(store), {
    graphApiVersion: GRAPH_API_VERSION,
    fetcher: provider.fetcher,
  });
}

function outboxJob(overrides: Partial<ClaimedWhatsAppOutboxJob> = {}): ClaimedWhatsAppOutboxJob {
  return {
    id: 'job_1',
    tenantId: 'tenant_a',
    messageId: 'message_1',
    recipientIdentifier: '393331112233',
    customerServiceWindowExpiresAt: new Date('2026-04-25T08:30:00.000Z'),
    payload: {
      type: 'text',
      text: { body: 'Ciao, sono Ambrogio', previewUrl: false },
      metadata: {},
    },
    attemptCount: 1,
    maxAttempts: 5,
    ...overrides,
  };
}

class FakeCredentialsStore implements WhatsAppCredentialsStore {
  readonly tenantIds: string[] = [];

  constructor(private readonly tokensByTenant: Record<string, string>) {}

  async findActiveCredentials(tenantId: string): Promise<Record<string, unknown> | null> {
    this.tenantIds.push(tenantId);
    const accessToken = this.tokensByTenant[tenantId];

    return accessToken
      ? {
          api_key_encrypted: encryptSecret(accessToken),
          external_account_id: `phone_${tenantId}`,
        }
      : null;
  }
}

class RecordingWhatsAppProvider {
  readonly requests: Array<{ authorization: string | null; url: string }> = [];

  readonly fetcher = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    this.requests.push({
      authorization: new Headers(init?.headers).get('Authorization'),
      url: url.toString(),
    });

    return Response.json({ messages: [{ id: `wamid.${this.requests.length}` }] }, { status: 201 });
  };
}

class FakeOutboxRepository implements WhatsAppOutboxRepository {
  constructor(private readonly jobs: ClaimedWhatsAppOutboxJob[]) {}

  async claimReadyJobs(): Promise<ClaimedWhatsAppOutboxJob[]> {
    return this.jobs;
  }

  async markJobSent(): Promise<void> {}

  async scheduleJobRetry(): Promise<void> {}

  async markJobDeadLetter(): Promise<void> {}
}
