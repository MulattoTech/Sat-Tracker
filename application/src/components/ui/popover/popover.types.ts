import * as React from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"

/**
 * Props for the Popover component
 *
 * @extends React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Root>
 */
export interface PopoverProps extends React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Root> {
  /**
   * Controlled open state
   */
  open?: boolean;
  
  /**
   * Callback when open state changes
   */
  onOpenChange?: (open: boolean) => void;
}

/**
 * Props for the PopoverTrigger component
 *
 * @extends React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Trigger>
 */
export interface PopoverTriggerProps extends React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Trigger> {
  /**
   * When true, the trigger will render its children as a slot
   * Useful for custom trigger implementations
   *
   * @default false
   */
  asChild?: boolean
}

/**
 * Props for the PopoverContent component
 *
 * @extends React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
 */
export interface PopoverContentProps extends React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> {
  /**
   * Optional class name for additional styling
   */
  className?: string
  
  /**
   * Alignment of the popover relative to the trigger
   * 
   * @default "center"
   */
  align?: "start" | "center" | "end"
  
  /**
   * Side of the trigger where the popover will appear
   * 
   * @default "bottom"
   */
  side?: "top" | "right" | "bottom" | "left"
  
  /**
   * Distance between the popover and the trigger in pixels
   * 
   * @default 4
   */
  sideOffset?: number
}
