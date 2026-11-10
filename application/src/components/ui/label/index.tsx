"use client"

import * as React from "react"
import * as LabelPrimitive from "@radix-ui/react-label"
import { cn } from "@/src/lib/utils"
import { labelVariants } from "./label.types"
import { LabelProps } from "./label.types"
import { useTheme } from "@/src/context/theme"
import "./label.css"

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  LabelProps
>(({ className, ...props }, ref) => {
  const { theme } = useTheme();
  
  return (
    <LabelPrimitive.Root
      ref={ref}
      className={cn(labelVariants(), className, "label-dark")}
      {...props}
    />
  );
});

Label.displayName = LabelPrimitive.Root.displayName

export { Label }
