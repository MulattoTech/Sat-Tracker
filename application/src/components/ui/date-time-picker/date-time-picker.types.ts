/**
 * Props for the DateTimePicker component
 */
export interface DateTimePickerProps {
  /**
   * The currently selected date and time
   */
  value: Date | null;
  
  /**
   * Callback function when date/time changes
   */
  onChange: (date: Date) => void;
  
  /**
   * Optional class name for additional styling
   */
  className?: string;
  
  /**
   * Whether the component is disabled
   */
  disabled?: boolean;
  
  /**
   * Optional placeholder text for the input
   */
  placeholder?: string;
}
