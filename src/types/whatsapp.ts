import { z } from 'zod';

/**
 * Meta WhatsApp Cloud API webhook payload.
 *
 * The schema validates the fields required by the existing
 * WhatsApp webhook service while allowing Meta to include
 * additional fields in webhook payloads.
 */
export const WhatsAppWebhookPayloadSchema = z
  .object({
    object: z.literal('whatsapp_business_account'),

    entry: z.array(
      z
        .object({
          id: z.string(),

          changes: z.array(
            z
              .object({
                field: z.literal('messages'),

                value: z
                  .object({
                    messaging_product: z.literal('whatsapp'),

                    metadata: z.object({
                      display_phone_number: z.string(),
                      phone_number_id: z.string(),
                    }),

                    /**
                     * Meta can send messages, statuses, or both
                     * depending on the webhook event.
                     */
                    messages: z
                      .array(
                        z.object({
                          from: z.string(),
                          id: z.string(),
                          timestamp: z.string(),

                          type: z.enum(['text', 'image', 'audio', 'document', 'location']),

                          text: z
                            .object({
                              body: z.string(),
                            })
                            .optional(),

                          audio: z
                            .object({
                              id: z.string(),
                              mime_type: z.string().optional(),
                              sha256: z.string().optional(),
                              voice: z.boolean().optional(),
                            })
                            .optional(),
                        }),
                      )
                      .optional(),

                    statuses: z
                      .array(
                        z
                          .object({
                            id: z.string(),

                            status: z.enum(['sent', 'delivered', 'read', 'failed']).optional(),

                            timestamp: z.string().optional(),

                            recipient_id: z.string().optional(),
                          })
                          .passthrough(),
                      )
                      .optional(),
                  })
                  .passthrough(),
              })
              .passthrough(),
          ),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type WhatsAppWebhookPayload = z.infer<typeof WhatsAppWebhookPayloadSchema>;
