import { useAuthStore } from '../store/authStore';
import { shouldRefreshAccessToken } from './authSession';
import { beginSessionRequest } from './sessionLifecycle';
import { apiUrl } from './url';

type FetchOptions = RequestInit & { skipAuth?: boolean };

export interface ApiStreamResponse {
  response: Response;
  signal: AbortSignal;
  release: () => void;
}

export { apiUrl, publicBasePath, withPublicBasePath } from './url';

export async function apiFetch(url: string, options: FetchOptions = {}): Promise<Response> {
  const { skipAuth, ...init } = options;
  const request = beginSessionRequest(init.signal);

  async function requestWithCurrentToken(): Promise<Response> {
    const headers = new Headers(init.headers);
    const token = useAuthStore.getState().token;
    if (!skipAuth && token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    return fetch(apiUrl(url), {
      ...init,
      credentials: init.credentials ?? 'include',
      headers,
      signal: request.signal,
    });
  }

  try {
    if (!skipAuth && shouldRefreshAccessToken(useAuthStore.getState().token)) {
      await useAuthStore.getState().refreshSession();
    }

    let res = await requestWithCurrentToken();
    if (!request.isCurrent()) throw new DOMException('Aborted', 'AbortError');

    if (!skipAuth && res.status === 401) {
      const refreshed = await useAuthStore.getState().refreshSession();
      if (refreshed) {
        res = await requestWithCurrentToken();
        if (!request.isCurrent()) throw new DOMException('Aborted', 'AbortError');
        if (res.status !== 401) return res;
      }
      await useAuthStore.getState().logout({ remote: false });
      throw Object.assign(new Error('登录已过期，请重新登录'), { status: 401 });
    }

    return res;
  } finally {
    request.release();
  }
}

export async function apiStreamFetch(
  url: string,
  options: FetchOptions = {},
): Promise<ApiStreamResponse> {
  const { skipAuth, ...init } = options;
  const headers = new Headers(init.headers);
  const request = beginSessionRequest(init.signal);

  if (!skipAuth) {
    const token = useAuthStore.getState().token;
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }

  try {
    const response = await fetch(apiUrl(url), { ...init, headers, signal: request.signal });
    if (!request.isCurrent()) throw new DOMException('Aborted', 'AbortError');
    if (response.status === 401) {
      useAuthStore.getState().logout();
      throw new Error('登录已过期，请重新登录');
    }
    return { response, signal: request.signal, release: request.release };
  } catch (error) {
    request.release();
    throw error;
  }
}
