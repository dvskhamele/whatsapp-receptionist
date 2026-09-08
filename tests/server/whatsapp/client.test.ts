import { describe, expect, it } from 'vitest';

import { AppError } from '@/lib/errors/app-error';
import { MetaWhatsAppClient } from '@/server/whatsapp/client';

describe('MetaWhatsAppClient', () => {
  it('sends free-form text messages through the Meta Graph API', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const client = new MetaWhatsAppClient({
      graphApiVersion: 'v23.0',
      phoneNumberId: 'phone_number_1',
      accessToken: 'test_access_token',
      fetcher: async (url, init) => {
        requests.push({ url: url.toString(), init: init ?? {} });

        return Response.json(
          {
            messages: [{ id: 'wamid.outbound.1' }],
          },
          { status: 201 },
        );
      },
    });

    const result = await client.sendText({
      to: '393331112233',
      body: 'Ciao dal test',
    });

    expect(result.providerMessageId).toBe('wamid.outbound.1');
    expect(requests[0]?.url).toBe('https://graph.facebook.com/v23.0/phone_number_1/messages');
    expect(requests[0]?.init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer test_access_token',
    });
    expect(JSON.parse(requests[0]?.init.body as string)).toMatchObject({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '393331112233',
      type: 'text',
      text: {
        body: 'Ciao dal test',
        preview_url: false,
      },
    });
  });

  it('raises an upstream error when the provider rejects the send', async () => {
    const client = new MetaWhatsAppClient({
      graphApiVersion: 'v23.0',
      phoneNumberId: 'phone_number_1',
      accessToken: 'test_access_token',
      fetcher: async () => Response.json({ error: { message: 'Rejected' } }, { status: 400 }),
    });

    await expect(
      client.sendText({
        to: '393331112233',
        body: 'Ciao',
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('sends approved template messages through Meta Cloud API', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const client = new MetaWhatsAppClient({
      graphApiVersion: 'v23.0',
      phoneNumberId: 'phone_number_1',
      accessToken: 'test_access_token',
      fetcher: async (url, init) => {
        requests.push({ url: url.toString(), init: init ?? {} });

        return Response.json(
          {
            messages: [{ id: 'wamid.template.1' }],
          },
          { status: 200 },
        );
      },
    });

    const result = await client.sendTemplate({
      to: '393331112233',
      name: 'appointment_reminder_24h',
      languageCode: 'it',
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: 'Mario' },
            { type: 'text', text: 'domani alle 10:00' },
          ],
        },
      ],
    });

    expect(result.providerMessageId).toBe('wamid.template.1');
    expect(JSON.parse(requests[0]?.init.body as string)).toMatchObject({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '393331112233',
      type: 'template',
      template: {
        name: 'appointment_reminder_24h',
        language: {
          code: 'it',
        },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Mario' },
              { type: 'text', text: 'domani alle 10:00' },
            ],
          },
        ],
      },
    });
  });
});
