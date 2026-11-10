/**
 * Styles for the DailyStats component
 * 
 * These styles use Tailwind CSS classes and are designed to be compatible
 * with the project's design system and dark mode support.
 */

export const dailyStatsStyles = {
  // Container styles
  container: "border border-gray-200 bg-white shadow-sm",
  
  // Header styles
  header: "flex items-center justify-between p-3 border-b border-gray-200 daily-stats-header",
  
  // Date display
  date: "text-sm font-medium text-gray-700",
  
  // Content grid
  content: "grid grid-cols-2 gap-4 p-4 md:grid-cols-5 daily-stats-content",
  
  // Empty and loading states
  empty: "col-span-2 md:col-span-5 py-4 text-center text-gray-500 daily-stats-empty",
  
  // Toggle button and title
  toggle: "text-gray-500 hover:text-gray-700 daily-stats-toggle",
  title: "font-medium text-gray-500 daily-stats-title",
  
  // Stats ticker
  ticker: {
    container: "relative overflow-hidden flex-1 mx-4",
    animation: "whitespace-nowrap animate-marquee inline-block",
    item: "inline-flex items-center mr-6",
    icon: "mr-1",
    label: "text-xs text-gray-600 daily-stats-ticker-text",
    value: "text-xs font-medium ml-1 daily-stats-ticker-value"
  },
  
  // Stat item
  statItem: {
    container: "flex items-center gap-2",
    iconContainer: "flex-shrink-0 p-2 rounded-xl bg-gray-100 daily-stats-item-bg",
    label: "text-xs text-gray-500 daily-stats-item-label",
    value: "text-sm font-medium daily-stats-item-value"
  }
} as const;
