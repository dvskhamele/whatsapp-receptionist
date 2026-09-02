import { jsonHandler } from '@/lib/api/json';
import { env } from '@/lib/env';
import { enforceWhatsAppWebhookRateLimit } from '@/lib/rate-limit';
import { assertWhatsAppWebhookSecret } from '@/lib/whatsapp/webhook-security';
import { createWhatsAppWebhookService } from '@/server/whatsapp/service';
import { WhatsAppWebhookPayloadSchema } from '@/types/whatsapp';
import { NextResponse, type NextRequest } from 'next/server';
export function GET(request: NextRequest): NextResponse {
  const searchParams = request.nextUrl.searchParams;
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');
  if (mode === 'subscribe' && token && challenge && token === env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 });
  }
  return NextResponse.json({ ok: false, error: { code: 'webhook_rejected' } }, { status: 403 });
}
export async function POST(request: NextRequest): Promise<NextResponse> {
  return jsonHandler(async (context) => {
    /** * IMPORTANT: * * Meta signs the exact raw HTTP request body. * Therefore we MUST read request.text() first and verify * the signature before parsing JSON. */
    const rawBody = await request.text();
    assertWhatsAppWebhookSecret(request.headers, rawBody);
    /** * Rate limiting is performed after signature verification * so unauthenticated requests cannot consume the legitimate * webhook quota. */
    await enforceWhatsAppWebhookRateLimit(request.headers);
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new Error('Invalid WhatsApp webhook JSON payload');
    }
    const parsedPayload = WhatsAppWebhookPayloadSchema.parse(payload);
    const service = createWhatsAppWebhookService();
    return service.processPayload(parsedPayload, {
      requestId: context.requestId,
      ipAddress: context.ipAddress,
    });
  }, request);
}
