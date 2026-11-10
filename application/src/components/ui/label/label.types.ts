import * as React from "react"
import * as LabelPrimitive from "@radix-ui/react-label"
import { VariantProps, cva } from "class-variance-authority"

export const labelVariants = cva(
  "text-sm font-medium leading-none text-gray-900 peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
)

export interface LabelProps
  extends React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>,
    VariantProps<typeof labelVariants> {}
