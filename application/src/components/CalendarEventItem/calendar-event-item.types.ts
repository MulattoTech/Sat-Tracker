import { CalendarEventData } from '@/src/components/CalendarEvent/calendar-event.types';

/**
 * Type definitions for the CalendarEventItem component
 */

/**
 * Props for the CalendarEventItem component
 */
export interface CalendarEventItemProps {
  /**
   * The event data to display
   */
  event: CalendarEventData;
  
  /**
   * Optional handler for when the event is clicked
   */
  onClick?: (event: CalendarEventData) => void;
  
  /**
   * Additional CSS classes
   */
  className?: string;
}
