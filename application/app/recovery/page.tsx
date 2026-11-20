import { ThemeProvider } from '@/src/context/theme';
import { RecoveryPanel } from '@/src/components/BackupRestore/RecoveryPanel';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default function RecoveryPage() {
  if (process.env.SAT_TRACKER_RECOVERY_MODE !== '1') notFound();
  return <ThemeProvider><RecoveryPanel /></ThemeProvider>;
}
