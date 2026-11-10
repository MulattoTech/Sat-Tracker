/**
 * Styles for the CalendarEventItem component
 * 
 * These styles use Tailwind CSS classes and are designed to be compatible
 * with the project's design system and dark mode support.
 */

export const calendarEventItemStyles = {
  // Container styles
  container: "flex items-center p-3 rounded-lg border border-gray-200 bg-white shadow-sm hover:shadow-md transition-shadow duration-200 cursor-pointer calendar-event-item-container",
  
  // Event type color indicators
  colorIndicator: {
    base: "h-full w-1.5 rounded-full flex-shrink-0 mr-3",
    appointment: "bg-blue-500 calendar-event-item-indicator-appointment",
    caretakerSchedule: "bg-green-500 calendar-event-item-indicator-caretaker",
    reminder: "bg-amber-500 calendar-event-item-indicator-reminder",
    custom: "bg-purple-500 calendar-event-item-indicator-custom",
  },
  
  // Content container
  content: "flex-1 min-w-0", // min-width prevents text overflow issues
  
  // Title styles
  title: "text-sm font-medium text-gray-900 truncate calendar-event-item-title",
  
  // Time and details
  details: "flex items-center mt-1 text-xs text-gray-600 calendar-event-item-details",
  
  // Icon styles
  icon: {
    base: "h-3.5 w-3.5 mr-1.5",
    time: "text-gray-500 calendar-event-item-icon-time",
    location: "text-gray-500 calendar-event-item-icon-location",
    recurring: "text-amber-600 calendar-event-item-icon-recurring",
  },
  
  // Location text
  location: "ml-2 truncate",
  
  // Badges container
  badgesContainer: "flex items-center ml-auto pl-2",
  
  // Badge styles
  badge: {
    base: "flex items-center justify-center h-5 w-5 rounded-full text-xs font-medium text-white",
    baby: "bg-teal-500 calendar-event-item-badge-baby",
    caretaker: "bg-indigo-500 calendar-event-item-badge-caretaker",
    contact: "bg-rose-500 calendar-event-item-badge-contact",
  },
  
  // Badge with count
  badgeCount: "ml-1 text-xs font-medium text-gray-600 calendar-event-item-badge-count",
} as const;
