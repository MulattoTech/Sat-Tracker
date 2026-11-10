import { CalendarEventData } from '../CalendarEvent/calendar-event.types';

/**
 * Type definitions for the CalendarDayView component
 */

export interface CalendarDayViewProps {
  /**
   * The selected date to display events for
   */
  date: Date;
  
  /**
   * Array of events for the selected date
   */
  events: CalendarEventData[];
  
  /**
   * Handler for when an event is clicked
   */
  onEventClick?: (event: CalendarEventData) => void;
  
  /**
   * Handler for when the add event button is clicked
   */
  onAddEvent?: (date: Date) => void;
  
  /**
   * Whether the component is in a loading state
   */
  isLoading?: boolean;
  
  /**
   * Additional CSS classes to apply
   */
  className?: string;
  
  /**
   * Handler for when the form page is closed
   */
  onClose?: () => void;
  
  /**
   * Whether the day view modal is open
   */
  isOpen: boolean;
}

/**
 * Interface for grouped events by time of day
 */
export interface EventGroups {
  morning: CalendarEventData[];
  afternoon: CalendarEventData[];
  evening: CalendarEventData[];
}
