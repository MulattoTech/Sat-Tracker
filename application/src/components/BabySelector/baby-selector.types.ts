/**
 * Types for the BabySelector component
 */
import { Baby } from '@prisma/client';

/**
 * Props for the BabySelector component
 */
export interface BabySelectorProps {
  /**
   * The currently selected baby
   */
  selectedBaby: Baby | null;
  
  /**
   * Function to call when a baby is selected
   */
  onBabySelect: (baby: Baby) => void;
  
  /**
   * List of available babies
   */
  babies: Baby[];
  
  /**
   * Set of baby IDs that are currently sleeping
   */
  sleepingBabies: Set<string>;
  
  /**
   * Function to calculate the age of a baby
   */
  calculateAge: (birthDate: Date) => string;
  
  /**
   * Function to open the baby quick stats form
   */
  onOpenQuickStats: () => void;
}
