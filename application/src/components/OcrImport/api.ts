export function ocrHeaders(json = false): Headers {
  const token = localStorage.getItem('authToken');
  if (!token) throw new Error('Sign in again to review document imports.');
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  if (json) headers.set('Content-Type', 'application/json');
  return headers;
}

export async function ocrRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/ocr/documents${path}`, {
    ...init, headers: ocrHeaders(typeof init.body === 'string'), cache: 'no-store',
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.success) {
    throw new Error(typeof result?.error === 'string' ? result.error : 'The document request could not be completed.');
  }
  return result.data as T;
}

export async function ocrSource(id: string, page?: number, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(`/api/ocr/documents/${encodeURIComponent(id)}/source${page ? `?page=${page}` : ''}`, {
    headers: ocrHeaders(), signal, cache: 'no-store',
  });
  if (!response.ok) throw new Error('The source document is unavailable or access has expired.');
  return response.blob();
}
