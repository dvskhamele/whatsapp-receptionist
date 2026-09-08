'use client';

import { useState, type FormEvent } from 'react';

import { FormFeedback } from '@/components/forms/FormFeedback';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

type FormStatus = 'idle' | 'submitting' | 'success' | 'error';

export function LoginForm() {
  const [status, setStatus] = useState<FormStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const emailValue = formData.get('email');

    if (typeof emailValue !== 'string' || !emailValue.trim()) {
      setStatus('error');
      setMessage('Please enter a valid email address.');
      return;
    }

    const email = emailValue.trim().toLowerCase();

    setStatus('submitting');
    setMessage(null);

    try {
      const supabase = createSupabaseBrowserClient();

      const redirectTo = `${window.location.origin}/auth/callback`;

      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: redirectTo,
        },
      });

      if (error) {
        console.error('[LoginForm] signInWithOtp error:', error);

        setStatus('error');
        setMessage(error.message);
        return;
      }

      event.currentTarget.reset();

      setStatus('success');
      setMessage(
        'If this email is associated with an account, ' +
          'you will receive a sign-in link shortly. ' +
          'Please also check your spam folder.',
      );
    } catch (error) {
      console.error('[LoginForm] unexpected error:', error);

      setStatus('error');
      setMessage('Something went wrong while requesting the sign-in link. ' + 'Please try again.');
    }
  }

  const feedbackState = {
    status,
    message,
  };

  return (
    <form onSubmit={onSubmit} className="stack stack-4" noValidate>
      <FormFeedback state={feedbackState} id="login-form-errors" />

      <div className="field">
        <label htmlFor="email" className="label">
          Email
        </label>

        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          placeholder="you@example.com"
          className="input"
          aria-describedby="login-email-helper"
          disabled={status === 'submitting'}
        />

        <p className="helper" id="login-email-helper">
          We will send you a secure sign-in link.
        </p>
      </div>

      <button type="submit" className="btn btn-primary btn-lg" disabled={status === 'submitting'}>
        {status === 'submitting' ? 'Sending...' : 'Send sign-in link'}
      </button>
    </form>
  );
}
