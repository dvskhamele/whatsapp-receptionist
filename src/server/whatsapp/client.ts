import { env } from '@/lib/env';
import { AppError } from '@/lib/errors/app-error';
import { fetchWithTimeout } from '@/lib/http/fetch-with-timeout';
import { logger } from '@/lib/logging/logger';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { readCredentialSecret } from '@/server/integrations/credential-encryption';
import { WHATSAPP_PROVIDER } from '@/server/whatsapp/webhook-events';

export type SendWhatsAppTextInput = {
  to: string;
  body: string;
  previewUrl?: boolean;
};

export type SendWhatsAppTextResult = {
  providerMessageId: string;
  rawResponse: unknown;
};

export type WhatsAppTemplateTextParameter = {
  type: 'text';
  text: string;
};

export type WhatsAppTemplateParameter = WhatsAppTemplateTextParameter;

export type WhatsAppTemplateComponent = {
  type: 'header' | 'body' | 'button';
  subType?: 'quick_reply' | 'url';
  index?: string | number;
  parameters?: WhatsAppTemplateParameter[];
};

export type SendWhatsAppTemplateInput = {
  to: string;
  name: string;
  languageCode: string;
  components?: WhatsAppTemplateComponent[];
};

export type SendWhatsAppTemplateResult = SendWhatsAppTextResult;

export interface WhatsAppMessageSender {
  sendText(input: SendWhatsAppTextInput): Promise<SendWhatsAppTextResult>;

  sendTemplate(input: SendWhatsAppTemplateInput): Promise<SendWhatsAppTemplateResult>;
}

type FetchLike = typeof fetch;

type MetaWhatsAppClientConfig = {
  accessToken?: string;
  phoneNumberId?: string;
  graphApiVersion?: string;
  fetcher?: FetchLike;

  /**
   * Called when Meta rejects the access token.
   * This invalidates the tenant credential cache so a rotated/replaced
   * credential can be picked up on the next request.
   */
  onAuthFailure?: () => void;
};

/**
 * Direct Meta WhatsApp Cloud API client.
 *
 * Endpoint:
 *
 * POST
 * https://graph.facebook.com/{GRAPH_API_VERSION}/{PHONE_NUMBER_ID}/messages
 *
 * Authentication:
 *
 * Authorization: Bearer {ACCESS_TOKEN}
 */
export class MetaWhatsAppClient implements WhatsAppMessageSender {
  constructor(private readonly config: MetaWhatsAppClientConfig = {}) {}

  async sendText(input: SendWhatsAppTextInput): Promise<SendWhatsAppTextResult> {
    return this.sendMessage({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: input.to,
      type: 'text',
      text: {
        body: input.body,
        preview_url: input.previewUrl ?? false,
      },
    });
  }

  async sendTemplate(input: SendWhatsAppTemplateInput): Promise<SendWhatsAppTemplateResult> {
    return this.sendMessage({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: input.to,
      type: 'template',
      template: {
        name: input.name,
        language: {
          code: input.languageCode,
        },
        ...(input.components && input.components.length > 0
          ? {
              components: toProviderTemplateComponents(input.components),
            }
          : {}),
      },
    });
  }

  private async sendMessage(body: Record<string, unknown>): Promise<SendWhatsAppTextResult> {
    const accessToken = this.config.accessToken ?? env.WHATSAPP_API_KEY;

    if (!accessToken?.trim()) {
      throw new AppError('internal', 'WhatsApp access token is not configured', {
        expose: false,
      });
    }

    const phoneNumberId = this.config.phoneNumberId?.trim();

    if (!phoneNumberId) {
      throw new AppError('internal', 'WhatsApp phone number ID is not configured', {
        expose: false,
      });
    }

    const graphApiVersion = (this.config.graphApiVersion ?? env.META_GRAPH_API_VERSION).trim();

    if (!graphApiVersion) {
      throw new AppError('internal', 'Meta Graph API version is not configured', {
        expose: false,
      });
    }

    const url = new URL(
      `/${encodeURIComponent(phoneNumberId)}/messages`,
      `https://graph.facebook.com/${graphApiVersion}`,
    );

    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body),
      },
      {
        label: 'WhatsApp send',
        ...(this.config.fetcher !== undefined
          ? {
              fetchImpl: this.config.fetcher,
            }
          : {}),
      },
    );

    const rawResponse = await readJsonResponse(response);

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        this.config.onAuthFailure?.();
      }

      throw new AppError('upstream_error', 'WhatsApp send failed', {
        cause: {
          status: response.status,
          body: rawResponse,
        },
        expose: false,
      });
    }

    const providerMessageId = extractProviderMessageId(rawResponse);

    if (!providerMessageId) {
      throw new AppError('upstream_error', 'WhatsApp send response did not include a message id', {
        cause: rawResponse,
        expose: false,
      });
    }

    return {
      providerMessageId,
      rawResponse,
    };
  }
}

/**
 * Per-tenant Meta WhatsApp credentials.
 *
 * accessToken:
 *   Encrypted Meta access token stored in integrations.credentials.
 *
 * phoneNumberId:
 *   Meta WhatsApp Phone Number ID stored in
 *   integrations.external_account_id.
 *
 * The `global` source is retained only for backwards compatibility.
 */
export type WhatsAppCredentials = {
  readonly accessToken: string;
  readonly phoneNumberId: string;
  readonly source: 'tenant' | 'global';
};

export interface WhatsAppCredentialsResolver {
  resolve(tenantId: string): Promise<WhatsAppCredentials>;

  invalidate(tenantId: string): void;
}

export interface WhatsAppCredentialsStore {
  findActiveCredentials(tenantId: string): Promise<Record<string, unknown> | null>;
}

type CredentialsLogger = {
  warn(context: Record<string, unknown>, message: string): void;
};

/**
 * Five minutes.
 */
const CREDENTIALS_CACHE_TTL_MS = 5 * 60 * 1000;

type CredentialsCacheEntry = {
  readonly credentials: WhatsAppCredentials;
  readonly expiresAt: number;
};

export class TenantWhatsAppCredentialsResolver implements WhatsAppCredentialsResolver {
  private readonly cache = new Map<string, CredentialsCacheEntry>();

  private readonly log: CredentialsLogger;

  constructor(
    private readonly store: WhatsAppCredentialsStore,
    private readonly options: {
      ttlMs?: number;
      globalApiKey?: string;
      now?: () => number;
      logger?: CredentialsLogger;
    } = {},
  ) {
    this.log = options.logger ?? logger;
  }

  async resolve(tenantId: string): Promise<WhatsAppCredentials> {
    const now = (this.options.now ?? Date.now)();

    const cached = this.cache.get(tenantId);

    if (cached && cached.expiresAt > now) {
      return cached.credentials;
    }

    const credentials = await this.load(tenantId);

    this.cache.set(tenantId, {
      credentials,
      expiresAt: now + (this.options.ttlMs ?? CREDENTIALS_CACHE_TTL_MS),
    });

    return credentials;
  }

  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  private async load(tenantId: string): Promise<WhatsAppCredentials> {
    const credentials = await this.store.findActiveCredentials(tenantId);

    const tenantAccessToken = credentials ? readCredentialSecret(credentials, 'api_key') : null;

    const externalAccountId = credentials?.external_account_id;

    /**
     * Normal Direct Meta configuration:
     *
     * integrations.credentials.api_key
     *       =
     * encrypted Meta access token
     *
     * integrations.external_account_id
     *       =
     * Meta Phone Number ID
     */
    if (tenantAccessToken && typeof externalAccountId === 'string' && externalAccountId.trim()) {
      return {
        accessToken: tenantAccessToken,
        phoneNumberId: externalAccountId.trim(),
        source: 'tenant',
      };
    }

    /**
     * Legacy global fallback.
     *
     * The Direct Meta POC should use the tenant path above.
     *
     * We intentionally do NOT reference
     * env.WHATSAPP_PHONE_NUMBER_ID because
     * that variable does not exist in env.ts and
     * Phone Number ID is supposed to be stored per tenant.
     */
    const globalApiKey = (this.options.globalApiKey ?? env.WHATSAPP_API_KEY ?? '').trim();

    if (!globalApiKey) {
      throw new AppError(
        'internal',
        'No WhatsApp access token and phone number ID are configured for this tenant',
        {
          expose: false,
        },
      );
    }

    /**
     * There is no global Phone Number ID in the current
     * environment schema.
     *
     * Therefore we must not silently send a message
     * using an unknown/global number.
     */
    throw new AppError(
      'internal',
      'No Meta WhatsApp integration with access token and phone number ID is configured for this tenant',
      {
        expose: false,
      },
    );
  }
}

export class SupabaseWhatsAppCredentialsStore implements WhatsAppCredentialsStore {
  private client: ReturnType<typeof createSupabaseAdminClient> | null = null;

  async findActiveCredentials(tenantId: string): Promise<Record<string, unknown> | null> {
    const { data, error } = await this.supabase()
      .from('integrations')
      .select('credentials, external_account_id')
      .eq('tenant_id', tenantId)
      .eq('provider', WHATSAPP_PROVIDER)
      .eq('status', 'active')
      .maybeSingle();

    if (error) {
      throw new AppError('upstream_error', 'Failed to read WhatsApp integration credentials', {
        cause: error,
        expose: false,
      });
    }

    const row = data as {
      credentials: Record<string, unknown> | null;
      external_account_id: string | null;
    } | null;

    if (!row) {
      return null;
    }

    return {
      ...(row.credentials ?? {}),
      external_account_id: row.external_account_id,
    };
  }

  private supabase(): ReturnType<typeof createSupabaseAdminClient> {
    this.client ??= createSupabaseAdminClient();

    return this.client;
  }
}

export interface WhatsAppMessageSenderResolver {
  resolveSender(tenantId: string): Promise<WhatsAppMessageSender>;
}

export class TenantWhatsAppMessageSenderResolver implements WhatsAppMessageSenderResolver {
  constructor(
    private readonly credentials: WhatsAppCredentialsResolver,
    private readonly config: {
      graphApiVersion?: string;
      fetcher?: FetchLike;
    } = {},
  ) {}

  async resolveSender(tenantId: string): Promise<WhatsAppMessageSender> {
    const resolved = await this.credentials.resolve(tenantId);

    return new MetaWhatsAppClient({
      accessToken: resolved.accessToken,
      phoneNumberId: resolved.phoneNumberId,
      ...(this.config.graphApiVersion !== undefined
        ? {
            graphApiVersion: this.config.graphApiVersion,
          }
        : {}),
      ...(this.config.fetcher !== undefined
        ? {
            fetcher: this.config.fetcher,
          }
        : {}),
      onAuthFailure: () => this.credentials.invalidate(tenantId),
    });
  }
}

let sharedCredentialsResolver: WhatsAppCredentialsResolver | null = null;

/**
 * Shared process-level resolver.
 */
export function whatsAppCredentialsResolver(): WhatsAppCredentialsResolver {
  sharedCredentialsResolver ??= new TenantWhatsAppCredentialsResolver(
    new SupabaseWhatsAppCredentialsStore(),
  );

  return sharedCredentialsResolver;
}

/**
 * Call when a tenant connects, updates,
 * or disconnects their WhatsApp number.
 */
export function invalidateWhatsAppCredentials(tenantId: string): void {
  sharedCredentialsResolver?.invalidate(tenantId);
}

export function createWhatsAppMessageSenderResolver(
  credentials: WhatsAppCredentialsResolver = whatsAppCredentialsResolver(),
): WhatsAppMessageSenderResolver {
  return new TenantWhatsAppMessageSenderResolver(credentials);
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function extractProviderMessageId(rawResponse: unknown): string | null {
  if (
    typeof rawResponse !== 'object' ||
    rawResponse === null ||
    !('messages' in rawResponse) ||
    !Array.isArray(rawResponse.messages)
  ) {
    return null;
  }

  const firstMessage = rawResponse.messages[0];

  if (
    typeof firstMessage !== 'object' ||
    firstMessage === null ||
    !('id' in firstMessage) ||
    typeof firstMessage.id !== 'string'
  ) {
    return null;
  }

  return firstMessage.id;
}

function toProviderTemplateComponents(
  components: WhatsAppTemplateComponent[],
): Array<Record<string, unknown>> {
  return components.map((component) => ({
    type: component.type,

    ...(component.subType
      ? {
          sub_type: component.subType,
        }
      : {}),

    ...(component.index !== undefined
      ? {
          index: component.index,
        }
      : {}),

    ...(component.parameters && component.parameters.length > 0
      ? {
          parameters: component.parameters,
        }
      : {}),
  }));
}
