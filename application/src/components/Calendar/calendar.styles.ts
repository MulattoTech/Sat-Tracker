/**
 * Styles for the Calendar component
 * 
 * These styles use Tailwind CSS classes and are designed to be compatible
 * with the project's design system and dark mode support.
 */

export const calendarStyles = {
  // Container
  container: "relative z-0 flex flex-col h-full",
  
  // Header
  header: "flex items-center justify-between p-2 bg-gradient-to-r from-teal-600 to-teal-700 text-white border-t border-gray-200 dark:border-gray-700",
  headerTitle: "text-lg font-semibold",
  headerButton: "text-white hover:bg-teal-500/20",
  todayButton: "text-xs text-white/80 hover:text-white hover:bg-teal-500/20 py-0 h-6",
  
  // Content area
  contentContainer: "flex flex-1 overflow-hidden",
  
  // Calendar grid
  calendarGrid: "flex-1 overflow-hidden border-0 rounded-t-none",
  calendarGridInner: "h-full overflow-y-auto flex flex-col",
  
  // Weekday header
  weekdaysHeader: "grid grid-cols-7 text-center bg-gray-100 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700",
  weekdayCell: "py-2 text-xs font-medium text-gray-500 dark:text-gray-400",
  
  // Calendar days grid
  daysGrid: "grid grid-cols-7 h-[calc(100%-32px)]",
  
  // Day cell
  dayCell: "flex flex-col h-full min-h-[60px] p-1 border border-gray-200 dark:border-gray-700 cursor-pointer",
  dayCellToday: "bg-teal-50 dark:bg-teal-900/20 border-teal-300 dark:border-teal-700",
  dayCellNotCurrentMonth: "bg-gray-50 dark:bg-gray-900/50 text-gray-400 dark:text-gray-600",
  dayCellCurrentMonth: "dark:bg-gray-800/30",
  dayCellSelected: "ring-2 ring-teal-500 dark:ring-teal-400 ring-inset",
  
  dayNumber: "text-xs",
  dayNumberToday: "font-bold text-teal-700 dark:text-teal-300",
  
  // Activity indicators
  activityIndicators: "flex flex-wrap gap-1 mt-auto",
  activityDot: "w-2 h-2 rounded-full",
  
  // Day view container
  dayViewContainer: "flex-1 ml-0 md:ml-4 flex-col",
  
  // Mobile add button
  mobileAddButton: "md:hidden fixed bottom-4 right-4",
  mobileAddButtonInner: "rounded-full w-12 h-12 shadow-lg",
  mobileAddButtonIcon: "h-6 w-6",
} as const;
