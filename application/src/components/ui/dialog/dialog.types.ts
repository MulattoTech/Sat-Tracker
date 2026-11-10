import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"

export interface DialogProps extends React.ComponentProps<typeof DialogPrimitive.Root> {}

export interface DialogTriggerProps extends React.ComponentProps<typeof DialogPrimitive.Trigger> {}

export interface DialogPortalProps extends React.ComponentProps<typeof DialogPrimitive.Portal> {}

export interface DialogCloseProps extends React.ComponentProps<typeof DialogPrimitive.Close> {}

export interface DialogOverlayProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay> {}

export interface DialogContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  hideClose?: boolean;
}

export interface DialogHeaderProps extends React.HTMLAttributes<HTMLDivElement> {}

export interface DialogFooterProps extends React.HTMLAttributes<HTMLDivElement> {}

export interface DialogTitleProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title> {}

export interface DialogDescriptionProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description> {}
