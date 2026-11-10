import * as React from "react"
import * as SelectPrimitive from "@radix-ui/react-select"

export interface SelectProps extends React.ComponentProps<typeof SelectPrimitive.Root> {}

export interface SelectGroupProps extends React.ComponentProps<typeof SelectPrimitive.Group> {}

export interface SelectValueProps extends React.ComponentProps<typeof SelectPrimitive.Value> {}

export interface SelectTriggerProps extends React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> {}

export interface SelectScrollUpButtonProps extends React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton> {}

export interface SelectScrollDownButtonProps extends React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton> {}

export interface SelectContentProps extends React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content> {}

export interface SelectLabelProps extends React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label> {}

export interface SelectItemProps extends React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item> {}

export interface SelectSeparatorProps extends React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator> {}
