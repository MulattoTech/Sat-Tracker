'use client';

import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from '@/src/lib/utils';

import { PopoverProps, PopoverTriggerProps, PopoverContentProps } from './popover.types';

/**
 * Popover component
 * 
 * A custom popover component with styled appearance that follows the project's design system.
 * It's designed to be cross-platform compatible with minimal changes required for React Native.
 *
 * Features:
 * - Configurable positioning
 * - Support for custom triggers
 * - Accessible focus management
 * - Responsive design
 *
 * @example
 * ```tsx
 * <Popover>
 *   <PopoverTrigger>Open Popover</PopoverTrigger>
 *   <PopoverContent>Popover content</PopoverContent>
 * </Popover>
 * ```
 */
const Popover = PopoverPrimitive.Root as React.FC<PopoverProps>;

/**
 * PopoverTrigger component
 * 
 * The trigger element that opens the popover when clicked.
 */
const PopoverTrigger = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Trigger>,
  PopoverTriggerProps
>(({ asChild, ...props }, ref) => (
  <PopoverPrimitive.Trigger ref={ref} asChild={asChild} {...props} />
));
PopoverTrigger.displayName = PopoverPrimitive.Trigger.displayName;

/**
 * PopoverContent component
 * 
 * The content of the popover that appears when the trigger is clicked.
 */
const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  PopoverContentProps
>(({ className, align = "center", side = "bottom", sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      side={side}
      className={cn(
        "z-50 w-72 rounded-md border border-gray-200 bg-white p-4 shadow-md outline-none animate-in data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        className
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverContent };
export type { PopoverProps, PopoverTriggerProps, PopoverContentProps };
