/**
 * Styles for the CalendarDayView component
 * 
 * These styles use Tailwind CSS classes and are designed to be compatible
 * with the project's design system and dark mode support.
 */

export const calendarDayViewStyles = {
  // Container styles
  container: "flex flex-col h-full overflow-hidden bg-white border border-gray-200 shadow-sm w-full calendar-day-view-container",
  
  // Header styles
  header: "flex items-center justify-between p-4 border-b border-gray-200 bg-gradient-to-r from-teal-600 to-teal-700 text-white calendar-day-view-header",
  headerTitle: "text-lg font-semibold",
  
  // Content container
  content: "flex-1 overflow-y-auto p-4 min-h-0",
  
  // Loading state
  loadingContainer: "flex items-center justify-center h-full",
  loadingSpinner: "h-8 w-8 text-teal-500 calendar-day-view-loader animate-spin",
  
  // Empty state
  emptyContainer: "flex flex-col items-center justify-center h-full text-center p-6",
  emptyIcon: "h-12 w-12 text-gray-400 calendar-day-view-empty-icon mb-2",
  emptyText: "text-gray-500 calendar-day-view-empty-text text-sm",
  
  // Event groups
  eventGroup: "mb-6 last:mb-0",
  eventGroupHeader: "flex items-center mb-2",
  eventGroupIcon: "h-5 w-5 mr-2 text-gray-500 calendar-day-view-group-icon",
  eventGroupTitle: "text-sm font-medium text-gray-700 calendar-day-view-group-title",
  eventsList: "space-y-3",
  
  // Add event button
  addButtonContainer: "p-4 bg-white border-t border-gray-200 calendar-day-view-add-button-container",
  addButton: "w-full flex items-center justify-center py-2 px-4 rounded-lg bg-gradient-to-r from-teal-500 to-emerald-500 text-white font-medium shadow-sm hover:shadow-md transition-shadow duration-200",
  addButtonIcon: "h-5 w-5 mr-2",
} as const;
