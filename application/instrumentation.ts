export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NEXT_PHASE !== 'phase-production-build') {
    const [{ default: prisma }, { startOcrRetention }] = await Promise.all([
      import('./app/api/db'), import('./src/lib/ocr/retention'),
    ]);
    startOcrRetention(prisma);
  }
}
