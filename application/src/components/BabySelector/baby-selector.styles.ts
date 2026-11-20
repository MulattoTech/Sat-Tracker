import { cn } from "@/src/lib/utils";

/**
 * Styles for the BabySelector component
 * 
 * These styles define the visual appearance of the baby selector
 * and its various states
 */

/**
 * Container styles for the baby selector
 * 
 * @param gender - The gender of the selected baby
 * @returns A string of TailwindCSS classes
 */
export const babySelectorContainer = (gender: 'MALE' | 'FEMALE' | null | undefined) => {
  return cn(
    "h-auto min-w-0 max-w-full py-2 px-2 text-white transition-colors duration-200 flex items-center gap-2 rounded-2xl",
    gender === 'MALE' ? 'bg-blue-700' : gender === 'FEMALE' ? 'bg-rose-700' : 'bg-teal-800'
  );
};

/**
 * Content container styles for the baby selector
 * 
 * @returns A string of TailwindCSS classes
 */
export const babySelectorContent = () => {
  return cn(
    "flex min-w-0 flex-1 flex-col items-start cursor-pointer text-left"
  );
};

/**
 * Name container styles for the baby selector
 * 
 * @returns A string of TailwindCSS classes
 */
export const babySelectorNameContainer = () => {
  return cn(
    "flex min-w-0 items-center ml-1 space-x-1"
  );
};

/**
 * Name text styles for the baby selector
 * 
 * @returns A string of TailwindCSS classes
 */
export const babySelectorName = () => {
  return cn(
    "text-sm font-medium break-words"
  );
};

/**
 * Age text styles for the baby selector
 * 
 * @returns A string of TailwindCSS classes
 */
export const babySelectorAge = () => {
  return cn(
    "text-xs ml-1"
  );
};

/**
 * Dropdown button styles for the baby selector
 * 
 * @returns A string of TailwindCSS classes
 */
export const babySelectorDropdownButton = () => {
  return cn(
    "h-11 w-11 shrink-0 rounded-full flex items-center justify-center",
    "bg-white/10 hover:bg-white/20 transition-colors duration-200",
    "ml-1 p-1"
  );
};

/**
 * Dropdown item styles for the baby selector
 * 
 * @param gender - The gender of the baby
 * @returns A string of TailwindCSS classes
 */
export const babySelectorDropdownItem = (gender: 'MALE' | 'FEMALE' | null | undefined) => {
  return cn(
    gender === 'MALE' ? 'bg-blue-500/10 hover:bg-blue-500/20' : 
    gender === 'FEMALE' ? 'bg-pink-500/10 hover:bg-pink-500/20' : ''
  );
};
