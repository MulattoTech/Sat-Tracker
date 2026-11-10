import { CalendarEventType, RecurrencePattern } from '@prisma/client';

/**
 * Type definitions for the CalendarEvent component
 */

/**
 * Baby entity type
 */
export interface Baby {
  id: string;
  firstName: string;
  lastName: string;
  inactive?: boolean;
}

/**
 * Caretaker entity type
 */
export interface Caretaker {
  id: string;
  name: string;
  type: string | null;
}

/**
 * Contact entity type
 */
export interface Contact {
  id: string;
  name: string;
  role: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

/**
 * Calendar event data type
 */
export interface CalendarEventData {
  id: string;
  title: string;
  description: string | null;
  startTime: string;
  endTime: string | null;
  allDay: boolean;
  type: CalendarEventType;
  location: string | null;
  color: string | null;
  
  // Recurrence fields
  recurring: boolean;
  recurrencePattern: RecurrencePattern | null;
  recurrenceEnd: string | null;
  customRecurrence: string | null;
  
  // Notification fields
  reminderTime: number | null;
  notificationSent: boolean;
  
  // Timestamps
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  
  // Related entities
  babies: Baby[];
  caretakers: Caretaker[];
  contacts: Contact[];
}

/**
 * Props for the CalendarEvent component
 */
export interface CalendarEventProps {
  /**
   * The event data to display
   */
  event: CalendarEventData;
  
  /**
   * Optional handler for when the event is clicked
   */
  onClick?: (event: CalendarEventData) => void;
  
  /**
   * Whether to show the event in compact mode
   */
  compact?: boolean;
  
  /**
   * Additional CSS classes
   */
  className?: string;
}
