import { cn } from "@/src/lib/utils";

/**
 * DateTimePicker component styles
 * 
 * These styles define the appearance of the DateTimePicker component
 * and its various sub-components.
 */

// Container styles
export const dateTimePickerContainerStyles = cn(
  "flex gap-2"
);

// Button styles
export const dateTimePickerButtonStyles = cn(
  "flex items-center gap-2 px-3 py-2 border border-gray-200 rounded-md shadow-sm",
  "hover:bg-gray-50 transition-colors duration-200"
);

// Popover content styles
export const dateTimePickerPopoverContentStyles = cn(
  "p-0 z-[100] border-gray-200 shadow-lg",
  "rounded-md overflow-hidden"
);

// Calendar container styles
export const dateTimePickerCalendarContainerStyles = cn(
  // "h-[360px] w-[350px]" // Fixed dimensions as required
);

// Time entry container styles
export const dateTimePickerTimeContainerStyles = cn(
 // "h-[360px] w-[350px]" // Fixed dimensions as required
);

// Footer styles
export const dateTimePickerFooterStyles = cn(
  "flex justify-end p-3 border-t border-gray-200"
);

// Input container styles (keeping this for backward compatibility)
export const dateTimePickerInputContainerStyles = cn(
  "relative cursor-pointer"
);

// Calendar icon styles (keeping this for backward compatibility)
export const dateTimePickerCalendarIconStyles = cn(
  "absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 h-4 w-4 pointer-events-none"
);
