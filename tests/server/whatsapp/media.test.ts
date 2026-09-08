import { describe, expect, it } from 'vitest';

import { MetaWhatsAppMediaClient } from '@/server/whatsapp/media';

describe('MetaWhatsAppMediaClient', () => {
  it('retrieves metadata and downloads media bytes with Bearer authorization', async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const client = new MetaWhatsAppMediaClient({
      graphApiVersion: 'v23.0',
      accessToken: 'test_access_token',
      fetcher: async (url, init) => {
        requests.push({
          url: url.toString(),
          headers: new Headers(init?.headers),
        });

        if (url.toString().includes('graph.facebook.com')) {
          return Response.json({
            id: 'media_1',
            url: 'https://lookaside.fbsbx.com/media_1',
            mime_type: 'audio/ogg',
            sha256: 'hash_1',
          });
        }

        return new Response(new Uint8Array([1, 2, 3]), {
          headers: {
            'content-type': 'audio/ogg',
            'content-length': '3',
          },
        });
      },
    });

    const media = await client.downloadMedia({ mediaId: 'media_1' });

    expect(media).toMatchObject({
      mediaId: 'media_1',
      contentType: 'audio/ogg',
      sha256: 'hash_1',
    });
    expect(Array.from(media.bytes)).toEqual([1, 2, 3]);
    expect(requests.map((request) => request.url)).toEqual([
      'https://graph.facebook.com/v23.0/media_1',
      'https://lookaside.fbsbx.com/media_1',
    ]);
    expect(
      requests.every(
        (request) => request.headers.get('Authorization') === 'Bearer test_access_token',
      ),
    ).toBe(true);
  });

  it('rejects files over the configured size limit', async () => {
    const client = new MetaWhatsAppMediaClient({
      graphApiVersion: 'v23.0',
      accessToken: 'test_access_token',
      maxBytes: 2,
      fetcher: async (url) => {
        if (url.toString().includes('graph.facebook.com')) {
          return Response.json({
            url: 'https://lookaside.fbsbx.com/media_1',
          });
        }

        return new Response(new Uint8Array([1, 2, 3]), {
          headers: {
            'content-type': 'audio/ogg',
          },
        });
      },
    });

    await expect(client.downloadMedia({ mediaId: 'media_1' })).rejects.toMatchObject({
      code: 'bad_request',
    });
  });
});
