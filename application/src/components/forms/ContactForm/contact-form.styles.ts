/**
 * Styles for the ContactForm component
 * 
 * These styles use Tailwind CSS classes and are designed to be compatible
 * with the project's design system and dark mode support.
 */

export const contactFormStyles = {
  // Form container
  formContainer: "flex flex-col space-y-4",
  
  // Form sections
  section: "space-y-4",
  sectionTitle: "text-lg font-semibold text-gray-900 dark:text-gray-100",
  
  // Form fields
  fieldGroup: "space-y-2",
  fieldLabel: "block text-sm font-medium text-gray-700 dark:text-gray-300",
  fieldRequired: "text-red-500 ml-1",
  fieldHint: "text-xs text-gray-500 dark:text-gray-400 mt-1",
  fieldError: "text-xs text-red-500 mt-1",
  
  // Input fields
  input: "w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:border-teal-500 dark:focus:border-teal-400 focus:outline-none focus:ring-1 focus:ring-teal-500 dark:focus:ring-teal-400",
  
  // Form actions
  actionsContainer: "flex justify-end space-x-3 mt-6",
  cancelButton: "px-4 py-2 rounded-md border border-gray-300 dark:border-gray-700 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800",
  saveButton: "px-4 py-2 rounded-md bg-gradient-to-r from-teal-500 to-emerald-500 text-sm font-medium text-white shadow-sm hover:shadow-md transition-shadow duration-200",
  deleteButton: "px-4 py-2 rounded-md bg-gradient-to-r from-red-500 to-rose-500 text-sm font-medium text-white shadow-sm hover:shadow-md transition-shadow duration-200",
  
  // Loading state
  loadingOverlay: "absolute inset-0 flex items-center justify-center bg-white/80 dark:bg-gray-900/80 rounded-md",
  loadingSpinner: "h-8 w-8 text-teal-500 dark:text-teal-400 animate-spin",
} as const;
