import { cn } from '@/src/lib/utils';

export const childAgeDisplayStyles = (className?: string) => cn(
  'block min-w-0 text-xs leading-relaxed whitespace-normal break-words', className,
);
