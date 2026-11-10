/**
 * Styles for the CalendarEventForm component
 * 
 * These styles use Tailwind CSS classes and are designed to be compatible
 * with the project's design system and dark mode support.
 */

export const calendarEventFormStyles = {
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
  textarea: "w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:border-teal-500 dark:focus:border-teal-400 focus:outline-none focus:ring-1 focus:ring-teal-500 dark:focus:ring-teal-400 min-h-[100px] resize-y",
  select: "w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:border-teal-500 dark:focus:border-teal-400 focus:outline-none focus:ring-1 focus:ring-teal-500 dark:focus:ring-teal-400",
  
  // Checkbox and radio
  checkboxContainer: "flex items-center",
  checkbox: "h-4 w-4 rounded border-gray-300 dark:border-gray-700 text-teal-600 dark:text-teal-500 focus:ring-teal-500 dark:focus:ring-teal-400",
  checkboxLabel: "ml-2 block text-sm text-gray-700 dark:text-gray-300",
  
  // Date and time pickers
  dateTimeContainer: "md:space-x-4 space-y-4 md:space-y-0", // Changed from grid to flex
  datePickerContainer: "relative w-full", // Added w-full
  datePicker: "w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:border-teal-500 dark:focus:border-teal-400 focus:outline-none focus:ring-1 focus:ring-teal-500 dark:focus:ring-teal-400",
  datePickerIcon: "absolute right-3 top-2.5 h-4 w-4 text-gray-400 dark:text-gray-500",
  
  // Color picker
  colorPickerContainer: "flex items-center space-x-2",
  colorPickerPreview: "h-6 w-6 rounded-full border border-gray-300 dark:border-gray-700",
  colorPicker: "w-8 h-8 overflow-hidden rounded-md border border-gray-300 dark:border-gray-700",
  colorPickerInput: "w-10 h-10 cursor-pointer opacity-0 transform -translate-x-1 -translate-y-1",
  
  // Multi-select
  multiSelectContainer: "space-y-2",
  multiSelectList: "max-h-32 overflow-y-auto rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 p-1",
  multiSelectItem: "flex items-center px-2 py-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700",
  multiSelectItemSelected: "bg-teal-50 dark:bg-teal-900/20",
  multiSelectItemLabel: "ml-2 text-sm text-gray-700 dark:text-gray-300",
  selectedItemsContainer: "flex flex-wrap gap-2 mt-2",
  selectedItem: "flex items-center rounded-full bg-teal-100 dark:bg-teal-900/30 px-2 py-1 text-xs text-teal-800 dark:text-teal-300",
  selectedItemRemove: "ml-1 h-3 w-3 text-teal-600 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-200",
  
  // Recurrence selector
  recurrenceContainer: "space-y-4",
  recurrencePatternContainer: "grid grid-cols-2 md:grid-cols-3 gap-2",
  recurrencePatternButton: "flex items-center justify-center px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800",
  recurrencePatternButtonSelected: "border-teal-500 dark:border-teal-400 bg-teal-50 dark:bg-teal-900/20 text-teal-700 dark:text-teal-300",
  
  // Reminder selector
  reminderContainer: "space-y-2",
  reminderSelect: "w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:border-teal-500 dark:focus:border-teal-400 focus:outline-none focus:ring-1 focus:ring-teal-500 dark:focus:ring-teal-400",
  
  // Form actions
  actionsContainer: "flex justify-end space-x-3 mt-6",
  cancelButton: "px-4 py-2 rounded-md border border-gray-300 dark:border-gray-700 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800",
  saveButton: "px-4 py-2 rounded-md bg-gradient-to-r from-teal-500 to-emerald-500 text-sm font-medium text-white shadow-sm hover:shadow-md transition-shadow duration-200",
  deleteButton: "px-4 py-2 rounded-md bg-gradient-to-r from-red-500 to-rose-500 text-sm font-medium text-white shadow-sm hover:shadow-md transition-shadow duration-200",
  
  // Loading state
  loadingOverlay: "absolute inset-0 flex items-center justify-center bg-white/80 dark:bg-gray-900/80 rounded-md",
  loadingSpinner: "h-8 w-8 text-teal-500 dark:text-teal-400 animate-spin",
} as const;
