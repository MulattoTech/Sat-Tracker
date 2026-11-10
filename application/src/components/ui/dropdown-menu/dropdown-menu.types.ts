import * as React from "react"
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu"

export interface DropdownMenuProps extends React.ComponentProps<typeof DropdownMenuPrimitive.Root> {}

export interface DropdownMenuTriggerProps extends React.ComponentProps<typeof DropdownMenuPrimitive.Trigger> {}

export interface DropdownMenuGroupProps extends React.ComponentProps<typeof DropdownMenuPrimitive.Group> {}

export interface DropdownMenuPortalProps extends React.ComponentProps<typeof DropdownMenuPrimitive.Portal> {}

export interface DropdownMenuSubProps extends React.ComponentProps<typeof DropdownMenuPrimitive.Sub> {}

export interface DropdownMenuRadioGroupProps extends React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup> {}

export interface DropdownMenuSubTriggerProps extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger> {
  inset?: boolean
}

export interface DropdownMenuSubContentProps extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent> {}

export interface DropdownMenuContentProps extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content> {}

export interface DropdownMenuItemProps extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> {
  inset?: boolean
}

export interface DropdownMenuCheckboxItemProps extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem> {
  /**
   * Whether the item is sortable (can be reordered)
   */
  sortable?: boolean;
}

export interface DropdownMenuRadioItemProps extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem> {}

export interface DropdownMenuLabelProps extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> {
  inset?: boolean
}

export interface DropdownMenuSeparatorProps extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator> {}

export interface DropdownMenuShortcutProps extends React.HTMLAttributes<HTMLSpanElement> {}
