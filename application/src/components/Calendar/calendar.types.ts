import { CalendarEventData } from '@/src/components/CalendarEvent/calendar-event.types';

/**
 * Type definitions for the Calendar component
 */

/**
 * Props for the Calendar component
 */
export interface CalendarProps {
  /**
   * The ID of the currently selected baby
   */
  selectedBabyId: string | undefined;
  
  /**
   * The user's timezone for date calculations
   */
  userTimezone: string;
  
  /**
   * Optional callback when a date is selected
   */
  onDateSelect?: (date: Date | null) => void;
}

/**
 * Calendar day item with associated data
 */
export interface CalendarDayItem {
  /**
   * The date for this calendar day
   */
  date: Date;
  
  /**
   * Whether this day is in the current month
   */
  isCurrentMonth: boolean;
  
  /**
   * Whether this day is today
   */
  isToday: boolean;
  
  /**
   * Whether this day is selected
   */
  isSelected: boolean;
  
  /**
   * Activities and events for this day
   */
  items: any[];
}

/**
 * Calendar state interface
 */
export interface CalendarState {
  /**
   * The current date being viewed (month/year)
   */
  currentDate: Date;
  
  /**
   * The currently selected date
   */
  selectedDate: Date | null;
  
  /**
   * All days to display in the calendar grid
   */
  calendarDays: Date[];
  
  /**
   * Calendar events from the calendar-event API
   */
  events: CalendarEventData[];
  
  /**
   * Whether events are currently loading (Optional)
   */
  isLoadingEvents?: boolean;
}
