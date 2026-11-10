/**
 * Styles for the CalendarEvent component
 * 
 * These styles use Tailwind CSS classes and are designed to be compatible
 * with the project's design system and dark mode support.
 */

export const calendarEventStyles = {
  // Container
  container: "flex flex-col rounded-lg border border-gray-200 overflow-hidden shadow-sm hover:shadow-md transition-shadow duration-200 border-l-4 calendar-event-container",
  
  // Header
  header: "flex justify-between items-center p-4 bg-gray-50 border-b border-gray-200 calendar-event-header",
  title: "text-lg font-semibold text-gray-900 truncate calendar-event-title",
  type: "px-2 py-1 text-xs font-medium rounded-full bg-teal-100 text-teal-800 calendar-event-type",
  
  // Content
  content: "p-4 space-y-3 calendar-event-content",
  detail: "flex items-start text-sm calendar-event-detail",
  icon: "h-4 w-4 mt-0.5 mr-2 text-gray-500 flex-shrink-0 calendar-event-icon",
  endTime: "text-gray-500 calendar-event-time",
  
  // People
  people: "space-y-1 calendar-event-people",
  peopleGroup: "flex flex-wrap calendar-event-people-group",
  peopleLabel: "font-medium mr-1 calendar-event-people-label",
  peopleList: "text-gray-700 calendar-event-people-list",
  
  // Description
  description: "mt-3 pt-3 border-t border-gray-200 text-sm text-gray-700 whitespace-pre-line calendar-event-description",
  
  // Actions
  actions: "flex justify-end space-x-2 p-3 bg-gray-50 border-t border-gray-200 calendar-event-actions",
  actionButton: "px-3 py-1 text-xs font-medium rounded-md calendar-event-action-button",
  actionIcon: "h-4 w-4 calendar-event-action-icon",
} as const;
