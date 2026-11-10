import { cn } from '@/src/lib/utils';

/**
 * CaretakerForm styles
 * 
 * Defines the styles for the CaretakerForm component using TailwindCSS
 * and follows the project's design system
 */
export const caretakerFormStyles = {
  /**
   * Content container styling
   */
  content: cn(
    "space-y-6 overflow-y-auto flex-1 pb-24"
  ),

  /**
   * Footer styling
   */
  footer: cn(
    "flex flex-col sm:flex-row gap-2 sm:justify-end"
  ),
};
