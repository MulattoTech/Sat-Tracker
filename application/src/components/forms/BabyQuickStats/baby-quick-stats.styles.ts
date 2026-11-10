import { cn } from "@/src/lib/utils";

/**
 * Styles for the BabyQuickStats component
 * 
 * These styles define the visual appearance of the baby quick stats form
 */

/**
 * Container styles for the form content
 * 
 * @returns A string of TailwindCSS classes
 */
export const quickStatsContainer = () => {
  return cn(
    "flex flex-col"
  );
};

/**
 * Header styles for the baby info section
 * 
 * @param gender - The gender of the baby
 * @returns A string of TailwindCSS classes
 */
export const babyInfoHeader = (gender: 'MALE' | 'FEMALE' | null | undefined) => {
  return cn(
    "flex items-center justify-center p-4 rounded-lg",
    gender === 'MALE' ? 'bg-blue-100' : gender === 'FEMALE' ? 'bg-pink-100' : 'bg-gray-100'
  );
};

/**
 * Styles for the baby name heading
 * 
 * @returns A string of TailwindCSS classes
 */
export const babyNameHeading = () => {
  return cn(
    "text-2xl font-bold text-center",
    "text-gray-800"
  );
};

/**
 * Styles for the baby age text
 * 
 * @returns A string of TailwindCSS classes
 */
export const babyAgeText = () => {
  return cn(
    "text-sm text-gray-600 text-center mt-1"
  );
};

/**
 * Styles for the placeholder text when no baby is selected
 * 
 * @returns A string of TailwindCSS classes
 */
export const placeholderText = () => {
  return cn(
    "text-lg text-gray-500 text-center p-8"
  );
};

/**
 * Styles for the close button
 * 
 * @returns A string of TailwindCSS classes
 */
export const closeButtonContainer = () => {
  return cn(
    "flex justify-center"
  );
};

/**
 * Container styles for the time period selector
 * 
 * @returns A string of TailwindCSS classes
 */
export const timePeriodSelectorContainer = () => {
  return cn(
    "flex flex-col"
  );
};

/**
 * Label styles for the time period selector
 * 
 * @returns A string of TailwindCSS classes
 */
export const timePeriodSelectorLabel = () => {
  return cn(
    "text-sm font-medium text-gray-700"
  );
};

/**
 * Button group styles for the time period selector
 * 
 * @returns A string of TailwindCSS classes
 */
export const timePeriodButtonGroup = () => {
  return cn(
    "flex space-x-1 overflow-x-auto"
  );
};

/**
 * Grid styles for the stats cards
 * 
 * @returns A string of TailwindCSS classes
 */
export const statsCardsGrid = () => {
  return cn(
    "grid grid-cols-2 gap-4 mt-6",
    "sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4"
  );
};
