import { type VariantProps } from "class-variance-authority"
import * as React from "react"
import { checkboxVariants } from "./checkbox.styles"

/**
 * Props for the Checkbox component
 *
 * @extends React.InputHTMLAttributes<HTMLInputElement> - Includes all standard input HTML attributes
 * @extends VariantProps<typeof checkboxVariants> - Includes variant and size props from checkboxVariants
 */
export interface CheckboxProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'checked' | 'onChange' | 'size'>,
    VariantProps<typeof checkboxVariants> {
  /**
   * The checked state of the checkbox
   */
  checked?: boolean;
  
  /**
   * Callback function called when the checked state changes
   */
  onCheckedChange?: (checked: boolean) => void;
}
