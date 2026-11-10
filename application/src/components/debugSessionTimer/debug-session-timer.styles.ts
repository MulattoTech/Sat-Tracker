import { cn } from "@/src/lib/utils";

/**
 * Styles for the DebugSessionTimer component
 * 
 * These styles define the visual appearance of the debug timer
 * and its various states (dragging, hovering, etc.)
 */

/**
 * Container styles for the debug timer
 * 
 * @param isDragging - Whether the timer is currently being dragged
 * @param x - Horizontal position in pixels
 * @param y - Vertical position in pixels
 * @returns A string of TailwindCSS classes
 */
export const debugTimerContainer = (isDragging: boolean, x: number, y: number) => {
  return cn(
    "fixed z-[9999] bg-black/80 text-white rounded-lg shadow-lg",
    "w-[220px] select-none font-mono text-xs",
    "transition-shadow duration-200 hover:shadow-xl",
    isDragging ? "cursor-grabbing" : "cursor-grab"
  );
};

/**
 * Header styles for the debug timer
 * 
 * @returns A string of TailwindCSS classes
 */
export const debugTimerHeader = () => {
  return cn(
    "flex justify-between items-center p-2",
    "bg-black/30 rounded-t-lg",
    "border-b border-white/10 font-bold"
  );
};

/**
 * Close button styles for the debug timer
 * 
 * @returns A string of TailwindCSS classes
 */
export const debugTimerCloseButton = () => {
  return cn(
    "bg-transparent border-none text-white/70 cursor-pointer",
    "p-1 flex items-center justify-center rounded",
    "transition-all duration-200 hover:text-white hover:bg-white/10"
  );
};

/**
 * Content container styles for the debug timer
 * 
 * @returns A string of TailwindCSS classes
 */
export const debugTimerContent = () => {
  return cn("p-3");
};

/**
 * Row styles for the debug timer content
 * 
 * @param isLast - Whether this is the last row in the content
 * @returns A string of TailwindCSS classes
 */
export const debugTimerRow = (isLast: boolean = false) => {
  return cn(
    "flex justify-between",
    !isLast && "mb-2"
  );
};

/**
 * Label styles for the debug timer rows
 * 
 * @returns A string of TailwindCSS classes
 */
export const debugTimerLabel = () => {
  return cn("text-white/70");
};

/**
 * Value styles for the debug timer rows
 * 
 * @returns A string of TailwindCSS classes
 */
export const debugTimerValue = () => {
  return cn("font-bold");
};
