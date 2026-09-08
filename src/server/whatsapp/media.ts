import { env } from '@/lib/env';
import { AppError } from '@/lib/errors/app-error';
import { fetchWithTimeout } from '@/lib/http/fetch-with-timeout';
import {
  whatsAppCredentialsResolver,
  type WhatsAppCredentialsResolver,
} from '@/server/whatsapp/client';

export type DownloadWhatsAppMediaInput = {
  mediaId: string;
  expectedMimeType?: string | null;
  /** Tenant proprietario del media, used to resolve the Meta access token. */
  tenantId?: string;
};

export type DownloadedWhatsAppMedia = {
  mediaId: string;
  bytes: Uint8Array;
  contentType: string;
  sha256: string | null;
  rawMetadata: unknown;
};

export interface WhatsAppMediaDownloader {
  downloadMedia(input: DownloadWhatsAppMediaInput): Promise<DownloadedWhatsAppMedia>;
}

type FetchLike = typeof fetch;

export class MetaWhatsAppMediaClient implements WhatsAppMediaDownloader {
  constructor(
    private readonly config: {
      graphApiVersion?: string;
      accessToken?: string;
      maxBytes?: number;
      fetcher?: FetchLike;
      credentials?: WhatsAppCredentialsResolver;
    } = {},
  ) {}

  async downloadMedia(input: DownloadWhatsAppMediaInput): Promise<DownloadedWhatsAppMedia> {
    const accessToken = await this.resolveAccessToken(input.tenantId);
    const metadata = await this.fetchMediaMetadata(input.mediaId, accessToken);
    const mediaUrl = extractMediaUrl(metadata);

    if (!mediaUrl) {
      throw new AppError('upstream_error', 'WhatsApp media metadata has no URL', {
        cause: metadata,
        expose: false,
      });
    }

    const mediaResponse = await fetchWithTimeout(
      mediaUrl,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
      {
        label: 'WhatsApp media download',
        ...(this.config.fetcher !== undefined ? { fetchImpl: this.config.fetcher } : {}),
      },
    );

    if (!mediaResponse.ok) {
      throw new AppError('upstream_error', 'WhatsApp media download failed', {
        cause: {
          status: mediaResponse.status,
          body: await readJsonResponse(mediaResponse),
        },
        expose: false,
      });
    }

    const contentLength = Number(mediaResponse.headers.get('content-length'));
    const maxBytes = this.config.maxBytes ?? env.WHATSAPP_MEDIA_MAX_BYTES;

    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new AppError('bad_request', 'WhatsApp media file is too large', {
        expose: false,
      });
    }

    const bytes = new Uint8Array(await mediaResponse.arrayBuffer());

    if (bytes.byteLength > maxBytes) {
      throw new AppError('bad_request', 'WhatsApp media file is too large', {
        expose: false,
      });
    }

    return {
      mediaId: input.mediaId,
      bytes,
      contentType:
        mediaResponse.headers.get('content-type') ??
        extractMediaMimeType(metadata) ??
        input.expectedMimeType ??
        'application/octet-stream',
      sha256: extractMediaSha256(metadata),
      rawMetadata: metadata,
    };
  }

  private async resolveAccessToken(tenantId: string | undefined): Promise<string> {
    if (this.config.accessToken) {
      return this.config.accessToken;
    }

    if (tenantId && this.config.credentials) {
      return (await this.config.credentials.resolve(tenantId)).accessToken;
    }

    throw new AppError('internal', 'Meta WhatsApp access token is not configured', {
      expose: false,
    });
  }

  private async fetchMediaMetadata(mediaId: string, accessToken: string): Promise<unknown> {
    const response = await fetchWithTimeout(
      new URL(
        `/${this.config.graphApiVersion ?? env.META_GRAPH_API_VERSION}/${encodeURIComponent(mediaId)}`,
        'https://graph.facebook.com',
      ),
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
      {
        label: 'WhatsApp media metadata',
        ...(this.config.fetcher !== undefined ? { fetchImpl: this.config.fetcher } : {}),
      },
    );

    const body = await readJsonResponse(response);

    if (!response.ok) {
      throw new AppError('upstream_error', 'WhatsApp media metadata failed', {
        cause: {
          status: response.status,
          body,
        },
        expose: false,
      });
    }

    return body;
  }
}

export function createWhatsAppMediaDownloader(
  credentials: WhatsAppCredentialsResolver = whatsAppCredentialsResolver(),
): WhatsAppMediaDownloader {
  return new MetaWhatsAppMediaClient({ credentials });
}

export function extensionForMimeType(contentType: string): string {
  const normalized = contentType.toLowerCase().split(';')[0]?.trim();

  switch (normalized) {
    case 'audio/ogg':
    case 'audio/opus':
      return 'ogg';
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'mp3';
    case 'audio/mp4':
      return 'm4a';
    case 'audio/aac':
      return 'aac';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav';
    default:
      return 'bin';
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function extractMediaUrl(metadata: unknown): string | null {
  if (
    typeof metadata === 'object' &&
    metadata !== null &&
    'url' in metadata &&
    typeof metadata.url === 'string'
  ) {
    return metadata.url;
  }

  return null;
}

function extractMediaMimeType(metadata: unknown): string | null {
  if (
    typeof metadata === 'object' &&
    metadata !== null &&
    'mime_type' in metadata &&
    typeof metadata.mime_type === 'string'
  ) {
    return metadata.mime_type;
  }

  return null;
}

function extractMediaSha256(metadata: unknown): string | null {
  if (
    typeof metadata === 'object' &&
    metadata !== null &&
    'sha256' in metadata &&
    typeof metadata.sha256 === 'string'
  ) {
    return metadata.sha256;
  }

  return null;
}
