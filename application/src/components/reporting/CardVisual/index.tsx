'use client';

import React from 'react';
import { 
  cardVisualContainer, 
  cardVisualTitle, 
  cardVisualMainValue, 
  cardVisualComparativeValue,
  cardVisualDescription,
  cardVisualIconContainer
} from './card-visual.styles';
import { CardVisualProps } from './card-visual.types';
import { cn } from '@/src/lib/utils';
import { useTheme } from '@/src/context/theme';
import './card-visual.css';

/**
 * CardVisual Component
 * 
 * A square reporting visual similar to Power BI's card visual that displays
 * a title, main number, and optional comparative number.
 *
 * @example
 * ```tsx
 * <CardVisual
 *   title="Average Wake Window"
 *   mainValue="1h 45m"
 *   comparativeValue="1h 30m (prev)"
 *   trend="positive"
 * />
 * ```
 */
const CardVisual: React.FC<CardVisualProps> = ({
  title,
  mainValue,
  comparativeValue,
  icon,
  className,
  description,
  trend
}) => {
  const { theme } = useTheme();
  return (
    <div className={cn(
      cardVisualContainer({ trend }), 
      className, 
      "card-visual-container",
      trend === 'positive' && "card-visual-trend-positive",
      trend === 'negative' && "card-visual-trend-negative"
    )}>
      <div className="relative">
        <h3 className={cn(cardVisualTitle(), "card-visual-title")}>
          {title}
        </h3>
        
        {icon && (
          <div className={cn(cardVisualIconContainer(), "card-visual-icon")}>
            {icon}
          </div>
        )}
      </div>
      
      <div className="mt-auto">
        <div className={cn(cardVisualMainValue(), "card-visual-main-value")}>
          {mainValue}
        </div>
        
        {comparativeValue && (
          <div className={cn(cardVisualComparativeValue(), "card-visual-comparative-value")}>
            {comparativeValue}
          </div>
        )}
        
        {description && (
          <div className={cn(cardVisualDescription(), "card-visual-description")}>
            {description}
          </div>
        )}
      </div>
    </div>
  );
};

export default CardVisual;
