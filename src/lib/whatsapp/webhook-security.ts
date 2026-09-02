import { env } from '@/lib/env';
import { AppError } from '@/lib/errors/app-error';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
/** * Verifies a Meta WhatsApp Cloud API webhook signature. * * Meta sends: * * X-Hub-Signature-256: sha256=<hex-digest> *
 * * The digest is: * * HMAC-SHA256(raw request body, META_APP_SECRET) * * IMPORTANT:
 *  * The raw request body must be used. * Do not call request.json() before this function. */
export function assertWhatsAppWebhookSecret(headers: Headers, rawBody: string): void {
  const appSecret = env.META_APP_SECRET;
  if (!appSecret) {
    throw new AppError('internal', 'Meta App Secret is not configured', { expose: false });
  }
  const receivedSignature = headers.get('x-hub-signature-256');
  if (!receivedSignature) {
    throw new AppError('webhook_rejected', 'Missing Meta webhook signature');
  }
  const expectedSignature = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  const expectedHeader = `sha256=${expectedSignature}`;
  if (!safeEqual(receivedSignature, expectedHeader)) {
    throw new AppError('webhook_rejected', 'Meta webhook signature mismatch');
  }
}
/** * Creates a deterministic idempotency key for provider events. * *
 *  The existing provider type is retained during the POC so that * existing database/application code does not need a migration. */
export function createWebhookIdempotencyKey(input: {
  provider: 'whatsapp_360dialog' | 'stripe';
  externalId: string;
}): string {
  return createHash('sha256').update(`${input.provider}:${input.externalId}`).digest('hex');
}
/** * Constant-time string comparison. * * timingSafeEqual requires buffers with identical lengths,
 * * therefore length is checked before calling it. */
function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.byteLength !== rightBuffer.byteLength) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}
