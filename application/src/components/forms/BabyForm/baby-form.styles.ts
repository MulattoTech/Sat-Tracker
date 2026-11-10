import { cn } from '@/src/lib/utils';

/**
 * BabyForm component styles
 * 
 * Defines the styling for the BabyForm component
 */
export const babyFormStyles = {
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
    "gap-3 sm:justify-end"
  ),

  /**
   * Form label styling
   */
  label: cn(
    "block text-sm font-medium text-gray-700 mb-1"
  ),

  /**
   * Form group styling
   */
  formGroup: cn(
    "mb-4"
  ),
};

/**
 * Returns the appropriate styles for the form label
 */
export const formLabel = () => {
  return cn(
    "block text-sm font-medium text-gray-700 mb-1"
  );
};

/**
 * Returns the appropriate styles for the form group
 */
export const formGroup = () => {
  return cn(
    "mb-4"
  );
};
