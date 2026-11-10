import { ReactNode } from 'react';

/**
 * Props for the CardVisual component
 */
export interface CardVisualProps {
  /**
   * Title of the card
   */
  title: string;
  
  /**
   * Main value to display
   */
  mainValue: string | number;
  
  /**
   * Optional comparative value
   */
  comparativeValue?: string | number;
  
  /**
   * Optional icon to display
   */
  icon?: ReactNode;
  
  /**
   * Optional className for custom styling
   */
  className?: string;
  
  /**
   * Optional description or subtitle
   */
  description?: string;
  
  /**
   * Optional trend indicator (positive, negative, neutral)
   */
  trend?: 'positive' | 'negative' | 'neutral';
}
