import { type VariantProps } from "class-variance-authority"
import * as React from "react"
import { buttonVariants } from "./button.styles"

/**
 * Props for the Button component
 *
 * @extends React.ButtonHTMLAttributes<HTMLButtonElement> - Includes all standard button HTML attributes
 * @extends VariantProps<typeof buttonVariants> - Includes variant and size props from buttonVariants
 */
export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /**
   * When true, the button will render its children as a slot
   * Useful for custom button implementations like rendering as a link
   *
   * @example
   * ```tsx
   * <Button asChild>
   *   <Link href="/dashboard">Dashboard</Link>
   * </Button>
   * ```
   *
   * @default false
   */
  asChild?: boolean
}