import React from 'react';
import { cn } from "@/src/lib/utils";
import { activityTileStyles as styles } from './activity-tile.styles';
import { ActivityTileContentProps } from './activity-tile.types';
import { useActivityDescription } from './activity-tile-utils';
import { useTheme } from '@/src/context/theme';

/**
 * ActivityTileContent component displays the title and description of an activity
 */
export function ActivityTileContent({ 
  activity, 
  title, 
  description, 
  className
}: ActivityTileContentProps) {
  const { theme } = useTheme();
  // Use the new hook to get the activity description
  const { getActivityDescription } = useActivityDescription();
  const activityDesc = getActivityDescription(activity);
  
  const displayTitle = title || activityDesc.type;
  const displayDescription = description || activityDesc.details;
  
  return (
    <div className={cn(styles.content.base, className)}>
      <div className={styles.content.typeContainer}>
        <span className={cn(styles.content.typeLabel, "activity-tile-label")}>
          {displayTitle}
        </span>
        <span className={cn(styles.content.description, "activity-tile-description")}>
          {displayDescription}
        </span>
      </div>
    </div>
  );
}
