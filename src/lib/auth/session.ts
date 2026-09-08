import { AppError } from '@/lib/errors/app-error';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export type AuthSession = {
  userId: string;
  tenantId: string;
  role: 'owner' | 'admin' | 'member';
};

export type AuthenticatedUser = {
  userId: string;
  email: string | null;
  appMetadata: Record<string, unknown>;
  userMetadata: Record<string, unknown>;
};

export async function requireAuthenticatedUser(): Promise<AuthenticatedUser> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();

  if (error || !data.user) {
    throw new AppError('unauthorized', 'Authentication required');
  }

  return {
    userId: data.user.id,
    email: data.user.email ?? null,
    appMetadata: toPlainRecord(data.user.app_metadata),
    userMetadata: toPlainRecord(data.user.user_metadata),
  };
}

export async function requireSession(): Promise<AuthSession> {
  const supabase = await createSupabaseServerClient();

  // Verify/read the JWT claims created by the Supabase Access Token Hook.
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();

  if (claimsError || !claimsData?.claims) {
    throw new AppError('unauthorized', 'Authentication required');
  }

  const claims = claimsData.claims;

  const userId = claims.sub;

  const appMetadata = toPlainRecord(claims.app_metadata);
  const tenantId = appMetadata['tenant_id'];
  const role = appMetadata['role'];

  if (typeof userId !== 'string') {
    throw new AppError('unauthorized', 'Authentication required');
  }

  if (typeof tenantId !== 'string') {
    throw new AppError('forbidden', 'Tenant claim is missing');
  }

  if (role !== 'owner' && role !== 'admin' && role !== 'member') {
    throw new AppError('forbidden', 'Role claim is missing');
  }

  return {
    userId,
    tenantId,
    role,
  };
}

function toPlainRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}
