import { supabase } from '../services/supabase';

export interface ApiError extends Error {
  code?: string;
  status?: number;
}

export async function callFunction<T = unknown>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });

  if (error) {
    let message = '';
    let code: string | undefined;
    const errObj = error as {
      name?: string;
      message?: string;
      context?: Response;
    };

    // 1. Try reading the response body from context if available
    if (errObj.context) {
      try {
        const cloned = typeof errObj.context.clone === 'function' ? errObj.context.clone() : errObj.context;
        const parsed = await cloned.json();
        if (parsed?.error) message = String(parsed.error);
        if (parsed?.code) code = String(parsed.code);
      } catch {
        try {
          const text = await errObj.context.text();
          if (text && text.length < 300) message = text;
        } catch {
          /* ignore body read failure */
        }
      }
    }

    // 2. If no body message was extracted, evaluate standard error types
    if (!message) {
      if (errObj.name === 'FunctionsFetchError' || errObj.message?.includes('Failed to send a request')) {
        message = 'Unable to connect to the attendance server. Please check your network and try again.';
      } else if (errObj.name === 'FunctionsRelayError') {
        message = 'The attendance service is temporarily unavailable. Please try again in a few seconds.';
      } else if (errObj.message && !errObj.message.includes('non-2xx')) {
        message = errObj.message;
      } else {
        message = 'Something went wrong while processing your request. Please try again.';
      }
    }

    const customErr = new Error(message) as ApiError;
    if (code) customErr.code = code;
    throw customErr;
  }

  return data as T;
}

