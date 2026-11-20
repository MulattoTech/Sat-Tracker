/** Keep this module free of database, filesystem and crypto imports for Next's proxy. */
export function recoveryPathAllowed(method: string, pathname: string): boolean {
  if (method === 'GET' || method === 'HEAD') {
    if (['/recovery', '/recovery/', '/api/recovery/status', '/favicon.ico', '/sat-tracker.svg'].includes(pathname)) return true;
    if (pathname.startsWith('/_next/static/') && !/[\\\0]/.test(pathname) &&
      !/%(?:2e|2f|5c|00)/i.test(pathname) && !pathname.split('/').includes('..')) return true;
  }
  return method === 'POST' && ['/api/recovery/inspect', '/api/recovery/commit'].includes(pathname);
}
